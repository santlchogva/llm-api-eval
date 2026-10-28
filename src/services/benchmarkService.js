/**
 * BenchmarkService - Token 级速度测试引擎
 *
 * 与 RPM 压测（请求频率维度）互补，衡量模型真实的生成速度：
 *   1. 单流解码测速：多轮流式请求，统计每轮 TTFT 与解码 tok/s，取均值
 *   2. 并发吞吐测速：N 路并发流式请求，统计总吞吐 tok/s 与单路速率
 *   3. 预填充测速：长提示词 + 极短输出，用 TTFT 近似 prefill 耗时，计算 prefill tok/s
 *   4. 首 token 延迟：短提示 TTFT 均值
 *
 * token 计数优先使用接口返回的 usage 字段（OpenAI stream_options.include_usage /
 * Anthropic message_delta.usage / Gemini usageMetadata），缺失时按字符估算并标记 estimated。
 */
const axios = require('axios');
const db = require('../../database');
const SSEParser = require('../utils/sseParser');
const logger = require('../utils/logger');
const { extractErrorMessage, normalizeStreamError } = require('./aiService');
const { estimateTokens } = require('../utils/tokenEstimator');

const DEFAULT_TIMEOUT = 300000;

/** 构造指定估算 token 数的长提示词（用于预填充测速） */
function buildLongPrompt(targetTokens) {
  const paragraph =
    '人工智能正在深刻改变软件开发的方式，从代码补全到架构设计，从自动化测试到智能运维，' +
    '大模型已经成为工程师日常工作中不可或缺的助手。评估一个模型服务的真实性能，' +
    '需要同时关注首 token 延迟、解码速度和并发吞吐等多个维度。';
  const perParagraph = estimateTokens(paragraph);
  const repeats = Math.max(1, Math.ceil(targetTokens / perParagraph));
  return `请阅读以下材料并用一句话总结：\n\n${paragraph.repeat(repeats)}`;
}

/**
 * 发起一次流式请求并采集 token 级指标
 * @param {AbortSignal} [signal] - 中断信号，停止测速时用于掐断在途请求
 * @returns {Promise<{ttftMs, durationMs, decodeMs, promptTokens, completionTokens, estimated, content}>}
 */
function streamOnce(providerType, cfg, prompt, maxTokens, signal) {
  const provider = providerType.toLowerCase();
  const timeout = cfg.timeout || DEFAULT_TIMEOUT;

  let url, body, headers;
  if (provider === 'openai') {
    url = `${cfg.url}/v1/chat/completions`;
    body = {
      model: cfg.modelName,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      max_tokens: maxTokens,
      stream_options: { include_usage: true },
    };
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` };
  } else if (provider === 'responses' || provider === 'openai-responses') {
    url = `${cfg.url}/v1/responses`;
    body = { model: cfg.modelName, input: prompt, stream: true };
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` };
  } else if (provider === 'anthropic' || provider === 'claude') {
    url = `${cfg.url}/v1/messages`;
    body = {
      model: cfg.modelName,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    };
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    };
  } else if (provider === 'gemini') {
    url = `${cfg.url}/v1beta/models/${cfg.modelName}:streamGenerateContent?key=${cfg.apiKey}&alt=sse`;
    body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
    headers = { 'Content-Type': 'application/json' };
  } else {
    return Promise.reject(new Error(`不支持的接口类型: ${providerType}`));
  }

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let firstChunkTime = null;
    let content = '';
    let promptTokens = null;
    let completionTokens = null;

    axios
      .post(url, body, { timeout, headers, responseType: 'stream', signal: signal || undefined })
      .then((response) => {
        SSEParser.parseStream(
          response.data,
          (data) => {
            if (!firstChunkTime) firstChunkTime = Date.now();

            if (provider === 'openai') {
              if (data.usage) {
                promptTokens = data.usage.prompt_tokens ?? promptTokens;
                completionTokens = data.usage.completion_tokens ?? completionTokens;
              }
            } else if (provider === 'responses' || provider === 'openai-responses') {
              const usage = data.usage || (data.type === 'response.completed' ? data.response?.usage : null);
              if (usage) {
                promptTokens = usage.input_tokens ?? promptTokens;
                completionTokens = usage.output_tokens ?? completionTokens;
              }
            } else if (provider === 'anthropic' || provider === 'claude') {
              if (data.type === 'message_start') {
                promptTokens = data.message?.usage?.input_tokens ?? promptTokens;
              }
              if (data.type === 'message_delta' && data.usage) {
                completionTokens = data.usage.output_tokens ?? completionTokens;
              }
            } else if (provider === 'gemini') {
              if (data.usageMetadata) {
                promptTokens = data.usageMetadata.promptTokenCount ?? promptTokens;
                completionTokens = data.usageMetadata.candidatesTokenCount ?? completionTokens;
              }
            }

            const text = SSEParser.extractContent(data, provider === 'anthropic' ? 'claude' : provider);
            if (text) content += text;
          },
          () => {
            const endTime = Date.now();
            const ttftMs = firstChunkTime ? firstChunkTime - startTime : endTime - startTime;
            const durationMs = endTime - startTime;
            const decodeMs = Math.max(1, durationMs - ttftMs);

            let estimated = false;
            if (completionTokens == null) {
              completionTokens = estimateTokens(content);
              estimated = true;
            }
            if (promptTokens == null) {
              promptTokens = estimateTokens(prompt);
              estimated = true;
            }

            resolve({ ttftMs, durationMs, decodeMs, promptTokens, completionTokens, estimated, content });
          },
          (error) => reject(error)
        );
      })
      .catch((error) => {
        normalizeStreamError(error).then(reject);
      });
  });
}

class BenchmarkService {
  constructor() {
    this.clients = new Set();
    this.isRunning = false;
    this.stopRequested = false;
    this.owner = null; // 启动方会话，用于停止权限判定与广播隔离
    this.state = this._emptyState();
    // 当前轮次的中断控制器
    this.abortController = null;
    this.abortSignal = null;
  }

  _emptyState() {
    return {
      isRunning: false,
      phase: null, // decode | concurrency | prefill | done
      phases: {
        decode: { status: 'pending', runs: [] },
        concurrency: { status: 'pending', streams: [] },
        prefill: { status: 'pending', result: null },
      },
      config: null,
      startTime: null,
      report: null,
      error: null,
    };
  }

  // ===== WebSocket 客户端管理 =====
  addClient(ws) {
    this.clients.add(ws);
    this._send(ws, { type: 'benchmarkState', data: this.getState() });
  }

  removeClient(ws) {
    this.clients.delete(ws);
  }

  _send(ws, message) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(message));
    } catch (e) { /* 忽略发送失败 */ }
  }

  /**
   * 广播消息
   * 速度测试的数据属于启动方，默认只发给启动方用户，避免他人围观
   */
  broadcast(message) {
    const owner = this.owner;
    const data = JSON.stringify(message);
    this.clients.forEach((ws) => {
      if (owner && ws.userId && String(ws.userId) !== String(owner)) return;
      try {
        if (ws.readyState === 1) ws.send(data);
      } catch (e) { /* 忽略发送失败 */ }
    });
  }

  getState() {
    return {
      isRunning: this.isRunning,
      phase: this.state.phase,
      phases: this.state.phases,
      config: this.state.config
        ? { ...this.state.config, apiKey: '***' }
        : null,
      startTime: this.state.startTime,
      report: this.state.report,
      error: this.state.error,
    };
  }

  /**
   * 启动速度测试
   * @param {Object} config - { providerType, url, modelName, apiKey, runs, concurrency, outputTokens, prefillTokens }
   */
  start(config, owner = null) {
    if (this.isRunning) {
      return { success: false, error: '已有速度测试正在进行中' };
    }

    const { providerType, url, modelName, apiKey } = config;
    if (!providerType || !url || !modelName || !apiKey) {
      return { success: false, error: '缺少必填参数（providerType/url/modelName/apiKey）' };
    }
    if (!['openai', 'responses', 'openai-responses', 'anthropic', 'claude', 'gemini'].includes(providerType)) {
      return { success: false, error: '不支持的接口类型' };
    }

    const normalized = {
      providerType,
      url: url.trim().replace(/\/+$/, ''),
      modelName: modelName.trim(),
      apiKey: apiKey.trim(),
      runs: Math.min(10, Math.max(1, parseInt(config.runs) || 3)),
      concurrency: Math.min(16, Math.max(2, parseInt(config.concurrency) || 4)),
      outputTokens: Math.min(8192, Math.max(64, parseInt(config.outputTokens) || 512)),
      prefillTokens: Math.min(128000, Math.max(0, parseInt(config.prefillTokens) || 8000)),
      decodePrompt: (config.decodePrompt || '请用中文写一段约三百字的人工智能技术发展综述。').trim(),
    };

    this.isRunning = true;
    this.stopRequested = false;
    this.owner = owner;
    this.state = this._emptyState();

    // 本轮的中断控制器：停止时立刻掐断在途请求，
    // 否则已发出的请求会跑满 timeout（默认 300 秒）
    this.abortController = new AbortController();
    this.abortSignal = this.abortController.signal;
    this.state.config = normalized;
    this.state.startTime = new Date().toISOString();
    if (normalized.prefillTokens <= 0) {
      this.state.phases.prefill.status = 'skipped';
    }

    logger.info('开始速度测试', {
      provider: providerType,
      model: normalized.modelName,
      runs: normalized.runs,
      concurrency: normalized.concurrency,
    });

    this.broadcast({ type: 'benchmarkStarted', data: this.getState() });
    this._run(normalized).catch((error) => {
      logger.error('速度测试执行异常', { error: error.message });
    });

    return { success: true, message: '速度测试已启动' };
  }

  stop(userId = null, force = false) {
    if (!this.isRunning) {
      return { success: false, error: '当前没有正在运行的速度测试' };
    }

    if (this.owner && userId != null && String(this.owner) !== String(userId) && !force) {
      logger.warn('速度测试停止被拒绝：非启动方用户', { owner: this.owner, userId });
      return {
        success: false,
        ownerMismatch: true,
        error: '当前速度测试由其他用户启动，你的停止请求未生效',
      };
    }

    this.stopRequested = true;

    // 立刻掐断在途请求，而不是等它自然结束
    if (this.abortController) {
      this.abortController.abort();
    }

    return { success: true, message: '测试已停止' };
  }

  /**
   * 按用户归属返回状态：非启动方拿到脱敏版本
   * @param {number|string|null} [userId]
   */
  getStateFor(userId = null) {
    const state = this.getState();
    if (!this.owner || userId == null || String(this.owner) === String(userId)) {
      return { ...state, owner: this.owner ? 'self' : null };
    }

    return {
      ...state,
      owner: 'other',
      config: null,
      report: null,
      phases: {
        decode: { status: 'pending', runs: [] },
        concurrency: { status: 'pending', streams: [] },
        prefill: { status: 'pending', result: null },
      },
    };
  }

  async _run(cfg) {
    const startedAt = Date.now();
    try {
      // ===== 阶段 1：单流解码测速 =====
      this.state.phase = 'decode';
      this.state.phases.decode.status = 'running';
      this._broadcastState();

      for (let i = 0; i < cfg.runs; i++) {
        this._checkStop();
        const runResult = await this._measure(() =>
          streamOnce(cfg.providerType, cfg, cfg.decodePrompt, cfg.outputTokens, this.abortSignal)
        );
        const tokPerSec = runResult.completionTokens / (runResult.decodeMs / 1000);
        const run = {
          run: i + 1,
          ttftMs: runResult.ttftMs,
          durationMs: runResult.durationMs,
          completionTokens: runResult.completionTokens,
          tokPerSec: Math.round(tokPerSec * 10) / 10,
          estimated: runResult.estimated,
        };
        this.state.phases.decode.runs.push(run);
        this.broadcast({ type: 'benchmarkProgress', data: { phase: 'decode', run } });
      }
      this.state.phases.decode.status = 'done';
      this._broadcastState();

      // ===== 阶段 2：并发吞吐测速 =====
      this._checkStop();
      this.state.phase = 'concurrency';
      this.state.phases.concurrency.status = 'running';
      this._broadcastState();

      const wallStart = Date.now();
      const results = await Promise.all(
        Array.from({ length: cfg.concurrency }, (_, i) =>
          this._measure(() =>
            streamOnce(cfg.providerType, cfg, cfg.decodePrompt, cfg.outputTokens, this.abortSignal)
          ).then((r) => ({ index: i + 1, ...r }))
        )
      );
      const wallTimeMs = Date.now() - wallStart;

      const streams = results.map((r) => ({
        stream: r.index,
        ttftMs: r.ttftMs,
        completionTokens: r.completionTokens,
        tokPerSec: Math.round((r.completionTokens / (r.decodeMs / 1000)) * 10) / 10,
        estimated: r.estimated,
      }));
      const totalTokens = results.reduce((s, r) => s + r.completionTokens, 0);
      const totalTokPerSec = Math.round((totalTokens / (wallTimeMs / 1000)) * 10) / 10;

      this.state.phases.concurrency.streams = streams;
      this.state.phases.concurrency.status = 'done';
      this._broadcastState();
      this.broadcast({
        type: 'benchmarkProgress',
        data: { phase: 'concurrency', streams, totalTokPerSec, wallTimeMs, totalTokens },
      });

      // ===== 阶段 3：预填充测速 =====
      let prefillResult = null;
      if (cfg.prefillTokens > 0) {
        this._checkStop();
        this.state.phase = 'prefill';
        this.state.phases.prefill.status = 'running';
        this._broadcastState();

        const longPrompt = buildLongPrompt(cfg.prefillTokens);
        const r = await this._measure(() =>
          streamOnce(cfg.providerType, cfg, longPrompt, 32, this.abortSignal)
        );
        prefillResult = {
          promptTokens: r.promptTokens,
          ttftMs: r.ttftMs,
          tokPerSec: Math.round((r.promptTokens / (r.ttftMs / 1000)) * 10) / 10,
          estimated: r.estimated,
        };
        this.state.phases.prefill.result = prefillResult;
        this.state.phases.prefill.status = 'done';
        this._broadcastState();
        this.broadcast({ type: 'benchmarkProgress', data: { phase: 'prefill', result: prefillResult } });
      }

      // ===== 汇总报告 =====
      const decodeRuns = this.state.phases.decode.runs;
      const avgTokPerSec =
        Math.round((decodeRuns.reduce((s, r) => s + r.tokPerSec, 0) / decodeRuns.length) * 10) / 10;
      const avgTtftMs = Math.round(decodeRuns.reduce((s, r) => s + r.ttftMs, 0) / decodeRuns.length);
      const perStreamAvg =
        Math.round((streams.reduce((s, r) => s + r.tokPerSec, 0) / streams.length) * 10) / 10;

      const report = {
        baseUrl: cfg.url,
        modelName: cfg.modelName,
        providerType: cfg.providerType,
        createdAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        config: {
          runs: cfg.runs,
          concurrency: cfg.concurrency,
          outputTokens: cfg.outputTokens,
          prefillTokens: cfg.prefillTokens,
        },
        decode: {
          runs: decodeRuns,
          avgTokPerSec,
          avgTtftMs,
          targetTokens: cfg.outputTokens,
        },
        concurrency: {
          streams,
          totalTokPerSec,
          perStreamAvg,
          totalTokens,
          wallTimeMs,
          concurrency: cfg.concurrency,
          targetTokens: cfg.outputTokens,
        },
        prefill: prefillResult,
        shortTtftMs: avgTtftMs,
        estimated: decodeRuns.some((r) => r.estimated) || streams.some((s) => s.estimated),
      };

      const reportId = db.saveBenchmarkReport({
        userId: this.owner,
        baseUrl: cfg.url,
        modelName: cfg.modelName,
        providerType: cfg.providerType,
        status: 'completed',
        duration: report.durationMs,
        config: report.config,
        result: report,
      });
      report.id = reportId;

      this.state.report = report;
      this.state.phase = 'done';
      this.isRunning = false;
      logger.info('速度测试完成', { reportId, avgTokPerSec, totalTokPerSec });
      this.broadcast({ type: 'benchmarkCompleted', data: report });
      this._broadcastState();
    } catch (error) {
      this.isRunning = false;
      // 主动停止：__STOPPED__ 来自 _checkStop，
      // 其余形态来自 AbortController 掐断请求后抛出的取消错误
      const aborted = this.stopRequested ||
        error.code === 'ERR_CANCELED' ||
        error.name === 'CanceledError' ||
        error.name === 'AbortError';
      if (error.message === '__STOPPED__' || aborted) {
        this.state.phase = 'done';
        this.state.error = '已被手动停止';
        this._savePartial('stopped', Date.now() - startedAt);
        this.broadcast({ type: 'benchmarkStopped', data: this.getState() });
      } else {
        const message = extractErrorMessage(error);
        this.state.error = message;
        this._savePartial('failed', Date.now() - startedAt);
        logger.error('速度测试失败', { error: message });
        this.broadcast({ type: 'benchmarkError', data: { error: message, state: this.getState() } });
      }
      this._broadcastState();
    } finally {
      // 无论成功、停止还是失败，本轮信号都作废
      this.abortController = null;
      this.abortSignal = null;
    }
  }

  /** 保存部分结果（停止或失败时） */
  _savePartial(status, durationMs) {
    try {
      const cfg = this.state.config;
      if (!cfg) return;
      const decodeRuns = this.state.phases.decode.runs;
      if (decodeRuns.length === 0 && status === 'failed') return; // 无任何结果不存档

      const report = {
        baseUrl: cfg.url,
        modelName: cfg.modelName,
        providerType: cfg.providerType,
        createdAt: new Date().toISOString(),
        durationMs,
        partial: true,
        config: {
          runs: cfg.runs,
          concurrency: cfg.concurrency,
          outputTokens: cfg.outputTokens,
          prefillTokens: cfg.prefillTokens,
        },
        decode: decodeRuns.length
          ? {
              runs: decodeRuns,
              avgTokPerSec:
                Math.round((decodeRuns.reduce((s, r) => s + r.tokPerSec, 0) / decodeRuns.length) * 10) / 10,
              avgTtftMs: Math.round(decodeRuns.reduce((s, r) => s + r.ttftMs, 0) / decodeRuns.length),
              targetTokens: cfg.outputTokens,
            }
          : null,
        concurrency: this.state.phases.concurrency.streams.length
          ? {
              streams: this.state.phases.concurrency.streams,
              concurrency: cfg.concurrency,
              targetTokens: cfg.outputTokens,
            }
          : null,
        prefill: this.state.phases.prefill.result,
        shortTtftMs: decodeRuns.length
          ? Math.round(decodeRuns.reduce((s, r) => s + r.ttftMs, 0) / decodeRuns.length)
          : null,
      };

      const reportId = db.saveBenchmarkReport({
        userId: this.owner,
        baseUrl: cfg.url,
        modelName: cfg.modelName,
        providerType: cfg.providerType,
        status,
        duration: durationMs,
        config: report.config,
        result: report,
      });
      report.id = reportId;
      this.state.report = report;
    } catch (e) {
      logger.error('保存部分测速结果失败', { error: e.message });
    }
  }

  async _measure(fn) {
    this._checkStop();
    return fn();
  }

  _checkStop() {
    if (this.stopRequested) {
      throw new Error('__STOPPED__');
    }
  }

  _broadcastState() {
    this.broadcast({ type: 'benchmarkState', data: this.getState() });
  }
}

module.exports = new BenchmarkService();
