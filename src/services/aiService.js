const axios = require('axios');
const config = require('../config');
const SSEParser = require('../utils/sseParser');
const { estimateTokens } = require('../utils/tokenEstimator');
const { httpAgent, httpsAgent } = require('../utils/httpAgent');

const DEFAULT_TIMEOUT = 150000;

/**
 * 合并 token 用量（同一请求的多次数据块可能分别携带输入/输出 token）
 */
function mergeUsage(current, incoming) {
  if (!incoming) return current;
  const base = current || { promptTokens: null, completionTokens: null, cachedTokens: null };
  return {
    promptTokens: incoming.promptTokens ?? base.promptTokens,
    completionTokens: incoming.completionTokens ?? base.completionTokens,
    cachedTokens: incoming.cachedTokens ?? base.cachedTokens,
  };
}

/**
 * 从错误对象中提取详细的错误消息
 * @param {Error} error - 错误对象
 * @returns {string} 提取的错误消息
 */
function extractErrorMessage(error) {
  // 网络错误优先处理
  if (error.code === 'ECONNABORTED') return '请求超时';
  if (error.code === 'ENOTFOUND') return '域名解析失败';
  if (error.code === 'ECONNREFUSED') return '连接被拒绝';
  if (error.code === 'ESTREAM_IDLE') return error.message;

  // API 响应错误
  if (error.response) {
    const status = error.response.status;
    const data = error.response.data;

    // 按优先级尝试提取错误消息
    const message =
      data?.error?.message ||      // OpenAI 格式
      data?.message ||              // 通用格式
      data?.error ||                // 简单错误字符串
      data?.detail ||               // FastAPI 格式
      data?.msg;                    // 其他格式

    if (message) {
      return typeof message === 'string' ? message : JSON.stringify(message);
    }

    // 如果没有标准错误字段,尝试提取响应体的关键信息
    if (data && typeof data === 'object') {
      const keys = Object.keys(data);
      if (keys.length > 0) {
        // 返回第一个有意义的字段值
        const firstKey = keys[0];
        const value = data[firstKey];
        return `${firstKey}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
      }
    }

    // 最后回退: 状态码 + 状态文本
    return `HTTP ${status}: ${error.response.statusText || '未知错误'}`;
  }

  // 其他错误
  return error.message || '未知错误';
}

/**
 * 归一化流式请求的错误响应体
 *
 * responseType 为 stream 时，axios 把 error.response.data 交给我们时是**未消费的流**，
 * 直接交给 extractErrorMessage 会退化成 `_events: {...}` 这类内部字段名，
 * 导致 429/5xx 等真实错误原因完全不可读。这里把流读出来并解析成 JSON。
 *
 * @param {Error} error - axios 错误对象
 * @returns {Promise<Error>} 处理后的同一个错误对象
 */
function normalizeStreamError(error) {
  const data = error && error.response && error.response.data;
  if (!data || typeof data.on !== 'function') {
    return Promise.resolve(error);
  }

  return new Promise((resolve) => {
    let raw = '';
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (raw) {
        try {
          error.response.data = JSON.parse(raw);
        } catch (e) {
          error.response.data = raw;
        }
      }
      resolve(error);
    };

    // 兜底定时器：流迟迟不结束时也要能返回
    const timer = setTimeout(finish, 3000);
    if (typeof timer.unref === 'function') timer.unref();

    data.on('data', (chunk) => {
      raw += chunk.toString();
    });
    data.on('end', finish);
    data.on('error', finish);
  });
}

/**
 * AI 服务基类
 *
 * 四种协议（gemini / openai / responses / claude）的请求-解析流程完全同构：
 * 子类只负责"这一家协议长什么样"（URL、请求体、请求头），
 * 基类负责"怎么发、怎么解析、怎么掐断、怎么判定流挂死"。
 */
class AIServiceBase {
  constructor(config) {
    this.config = config;
    // 当前轮次的请求中断信号：停止压测时用它掐断在途请求，
    // 否则点击停止后已发出的请求仍会跑满 timeout（默认 150 秒）。
    this.abortSignal = null;
  }

  /**
   * 设置本轮压测的请求中断信号
   * @param {AbortSignal|null} signal
   */
  setAbortSignal(signal) {
    this.abortSignal = signal || null;
  }

  /** 协议标识，用于 SSEParser 的响应/用量提取 */
  get protocol() {
    throw new Error('protocol 必须由子类实现');
  }

  /**
   * 构造一次请求的三要素
   * @param {string} prompt 用户提示词
   * @param {boolean} isStream 是否流式
   * @returns {{url:string, body:Object, headers:Object}}
   */
  buildRequest(prompt, isStream) {
    throw new Error('buildRequest 必须由子类实现');
  }

  async sendRequest(prompt) {
    const isStream = this.config.requestType === 'stream';
    const { url, body, headers } = this.buildRequest(prompt, isStream);
    if (isStream) {
      return this._streamRequest(url, body, headers);
    }
    return this._nonStreamRequest(url, body, headers);
  }

  /**
   * 非流式请求：axios timeout 覆盖整个请求，无空闲挂死问题
   */
  async _nonStreamRequest(url, body, headers) {
    const response = await axios.post(url, body, {
      timeout: this.config.timeout || DEFAULT_TIMEOUT,
      headers,
      httpAgent,
      httpsAgent,
      signal: this.abortSignal || undefined,
    });

    return {
      success: true,
      data: response.data,
      content: SSEParser.extractNonStreamContent(response.data, this.protocol),
      status: response.status,
      usage: SSEParser.extractUsage(response.data, this.protocol),
    };
  }

  /**
   * 流式请求
   *
   * 与非流式不同，axios 的 timeout 只保证"响应头到达"，流开始后若上游
   * 挂死（连接不断但永远不再出数据），请求会永久悬挂并占用并发名额。
   * 这里用空闲看门狗兜底：每收到一个数据块重置计时，超过阈值未收到
   * 任何数据就销毁连接并按失败返回。
   */
  _streamRequest(url, body, headers, allowRetry = true) {
    return new Promise((resolve, reject) => {
      let fullContent = '';
      let firstByteTime = null;
      let usage = null;
      let idleTimer = null;
      let settled = false;
      const startTime = Date.now();
      const idleMs = this.config.streamIdleTimeout || config.stressTest.streamIdleTimeout;

      const clearIdle = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearIdle();
        fn(arg);
      };

      const armIdle = (stream) => {
        if (settled || !idleMs || idleMs <= 0) return;
        clearIdle();
        idleTimer = setTimeout(() => {
          if (settled) return;
          const err = new Error(`流式响应空闲超时：${Math.round(idleMs / 1000)} 秒未收到任何数据，连接已被掐断`);
          err.code = 'ESTREAM_IDLE';
          // 销毁连接触发 error/close，走统一的失败路径
          try {
            stream.destroy(err);
          } catch (e) {
            settle(reject, err);
          }
        }, idleMs);
        if (typeof idleTimer.unref === 'function') idleTimer.unref();
      };

      axios.post(url, body, {
        timeout: this.config.timeout || DEFAULT_TIMEOUT,
        headers,
        responseType: 'stream',
        httpAgent,
        httpsAgent,
        signal: this.abortSignal || undefined,
      })
        .then((response) => {
          const stream = response.data;
          armIdle(stream);
          // 每个数据块都重置空闲计时（SSEParser 已挂自己的 data 监听，互不冲突）
          stream.on('data', () => armIdle(stream));

          SSEParser.parseStream(
            stream,
            (data) => {
              if (!firstByteTime) {
                firstByteTime = Date.now();
              }
              usage = mergeUsage(usage, SSEParser.extractUsage(data, this.protocol));
              const content = SSEParser.extractContent(data, this.protocol);
              if (content) {
                fullContent += content;
              }
            },
            () => {
              settle(resolve, {
                success: true,
                content: fullContent,
                status: response.status,
                usage,
                ttfb: firstByteTime ? firstByteTime - startTime : null,
              });
            },
            (error) => {
              settle(reject, error);
            }
          );
        })
        .catch((error) => {
          normalizeStreamError(error).then((normalized) => {
            // 部分网关不支持 stream_options：去掉该参数后重试一次
            const unsupported = normalized.response?.status === 400 &&
              allowRetry &&
              body.stream_options &&
              JSON.stringify(normalized.response?.data || '').includes('stream_options');
            if (unsupported) {
              const fallbackBody = { ...body };
              delete fallbackBody.stream_options;
              this._streamRequest(url, fallbackBody, headers, false).then(resolve).catch(reject);
              return;
            }
            reject(normalized);
          });
        });
    });
  }
}

/**
 * Gemini AI 服务
 */
class GeminiService extends AIServiceBase {
  get protocol() {
    return 'gemini';
  }

  buildRequest(prompt, isStream) {
    const { url, modelName, apiKey } = this.config;
    const action = isStream ? 'streamGenerateContent' : 'generateContent';
    const fullUrl = isStream
      ? `${url}/v1beta/models/${modelName}:${action}?key=${apiKey}&alt=sse`
      : `${url}/v1beta/models/${modelName}:${action}?key=${apiKey}`;

    return {
      url: fullUrl,
      body: {
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
      },
      headers: {
        'Content-Type': 'application/json',
      },
    };
  }
}

/**
 * OpenAI Chat Completions 服务
 */
class OpenAIService extends AIServiceBase {
  get protocol() {
    return 'openai';
  }

  buildRequest(prompt, isStream) {
    const { url, modelName, apiKey } = this.config;
    const body = {
      model: modelName,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      stream: isStream,
    };

    if (isStream) {
      // 请求接口在流末尾返回 usage，便于统计 TPM
      body.stream_options = { include_usage: true };
    }

    return {
      url: `${url}/v1/chat/completions`,
      body,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    };
  }
}

/**
 * OpenAI Responses 服务 (/v1/responses)
 */
class OpenAIResponsesService extends AIServiceBase {
  get protocol() {
    return 'responses';
  }

  buildRequest(prompt, isStream) {
    const { url, modelName, apiKey } = this.config;
    return {
      url: `${url}/v1/responses`,
      body: {
        model: modelName,
        input: prompt,
        stream: isStream,
      },
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    };
  }
}

/**
 * Claude AI 服务 (Anthropic)
 */
class ClaudeService extends AIServiceBase {
  get protocol() {
    return 'claude';
  }

  buildRequest(prompt, isStream) {
    const { url, modelName, apiKey } = this.config;
    return {
      url: `${url}/v1/messages`,
      body: {
        model: modelName,
        max_tokens: 4096, // Claude 需要指定最大 tokens
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        stream: isStream,
      },
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    };
  }
}

/**
 * AI 服务工厂
 */
class AIServiceFactory {
  static create(providerType, config) {
    switch (providerType.toLowerCase()) {
      case 'gemini':
        return new GeminiService(config);
      case 'openai':
        return new OpenAIService(config);
      case 'responses':
      case 'openai-responses':
        return new OpenAIResponsesService(config);
      case 'claude':
      case 'anthropic':
        return new ClaudeService(config);
      default:
        throw new Error(`不支持的接口类型: ${providerType}`);
    }
  }
}

/**
 * 统一的 AI 请求接口
 */
class AIRequestService {
  constructor(providerType, config) {
    this.service = AIServiceFactory.create(providerType, config);
    this.providerType = providerType;
    this.requestType = config.requestType || 'non-stream';
  }

  /**
   * 设置本轮压测的请求中断信号
   * 停止压测时由 stressTestService 调用，用于掐断尚未返回的在途请求
   * @param {AbortSignal|null} signal
   */
  setAbortSignal(signal) {
    if (this.service && typeof this.service.setAbortSignal === 'function') {
      this.service.setAbortSignal(signal);
    }
  }

  async execute(prompt) {
    const startTime = Date.now();

    try {
      const result = await this.service.sendRequest(prompt);
      const responseTime = Date.now() - startTime;

      const tokens = this._buildTokens(result, prompt);

      return {
        success: true,
        responseTime,
        status: result.status,
        content: result.content,
        data: result.data,
        requestType: this.requestType,
        ttfb: result.ttfb || null,
        tokens,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;

      // 主动中断（用户停止压测）：不计入失败请求，
      // 否则这批被掐断的请求会拉低成功率、把 SLA 误判为不达标。
      if (this._isAborted(error)) {
        return {
          success: false,
          aborted: true,
          responseTime,
          status: undefined,
          error: '请求已中断',
          errorCode: 'ABORTED',
          requestType: this.requestType,
          tokens: null,
        };
      }

      // 使用统一的错误消息提取函数
      const errorMessage = extractErrorMessage(error);

      return {
        success: false,
        responseTime,
        status: error.response?.status,
        error: errorMessage,
        errorCode: error.code || null,
        requestType: this.requestType,
        tokens: null,
      };
    }
  }

  /**
   * 判断错误是否由 AbortController 主动中断引起
   * @param {Error} error
   */
  _isAborted(error) {
    // 本轮已被主动中断：期间产生的任何错误都归因于中断，
    // 避免把 TCP 重置、流提前关闭等衍生错误记成请求失败。
    const signal = this.service && this.service.abortSignal;
    if (signal && signal.aborted) return true;

    if (!error) return false;
    if (error.code === 'ERR_CANCELED' ||
        error.name === 'CanceledError' ||
        error.name === 'AbortError') {
      return true;
    }
    // 流式响应开始后被中断时，错误由底层 stream 抛出，形态不统一
    const message = String(error.message || '').toLowerCase();
    return message.includes('aborted') || message.includes('canceled');
  }

  /**
   * 归一化 token 用量（接口未返回 usage 时按文本估算）
   */
  _buildTokens(result, prompt) {
    const usage = result.usage || null;
    let estimated = false;

    let promptTokens = usage?.promptTokens ?? null;
    if (promptTokens == null) {
      promptTokens = estimateTokens(prompt);
      estimated = true;
    }

    let completionTokens = usage?.completionTokens ?? null;
    if (completionTokens == null) {
      const content = typeof result.content === 'string' ? result.content : '';
      if (!content) return null; // 无内容也无 usage，放弃统计
      completionTokens = estimateTokens(content);
      estimated = true;
    }

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      // 缓存命中 token 数：仅接口明确返回时才有值（估算无缓存概念）
      cachedTokens: usage?.cachedTokens ?? null,
      estimated,
    };
  }
}

module.exports = {
  AIServiceFactory,
  AIRequestService,
  GeminiService,
  OpenAIService,
  OpenAIResponsesService,
  ClaudeService,
  extractErrorMessage,
  normalizeStreamError,
};
