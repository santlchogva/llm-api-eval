const { AIRequestService } = require('./aiService');
const config = require('../config');
const log = require('../utils/logger');
const db = require('../../database');
const crypto = require('crypto');
const CircularBuffer = require('../utils/circularBuffer');
const MemoryMonitor = require('../utils/memoryMonitor');
const { Histogram, SlidingWindow } = require('../utils/stats');
const { sendWebhook } = require('../utils/webhook');
const { AppError } = require('../middlewares/errorHandler');

const PERCENTILES = [50, 90, 95, 99];
const TOKEN_WINDOW_MS = 60000;      // TPM 滑动窗口长度
const PERCENTILE_REFRESH_MS = 1000; // 分位数刷新节流，避免高频压测下反复遍历直方图
const SEEK_MIN_PHASE_SAMPLES = 5;   // 寻优档位判定所需的最少样本数
const SEEK_MAX_PHASE_EXTENSION = 3; // 样本不足时最多把档位延长到 N 倍时长
// 支持预热期的模式：寻优 / 阶梯 / 探测模式自带"逐档"节奏，不做全局预热
const WARMUP_MODES = ['fixed', 'auto', 'concurrency'];

/**
 * 压测服务类
 *
 * 支持六种加压模型：
 *   - fixed            固定 RPM（开环）
 *   - auto             RPM 递增（阶梯 / 线性），探测拐点
 *   - concurrency      恒定并发（闭环），还原真实用户并发行为
 *   - concurrency-ramp 并发阶梯，寻找 TPM 饱和点
 *   - seek             自动寻优，二分逼近最大可持续 RPM
 *   - probe            能力探测：自动跑两轮，分别求最大可持续 RPM 与 TPM
 *
 * 达标判定统一走 SLA 口径（成功率 + TTFT P99 + TPOT P99），
 * 而不是"平均响应时间"——后者会随输出长度漂移，无法用来定位 RPM 上限。
 */
class StressTestService {
  constructor() {
    this.testState = this.getInitialState();
    this.timers = {
      requestTimer: null,
      minuteStatsTimer: null,
      rpmUpdateTimer: null,
      seekTimer: null,
      ladderTimer: null,
      durationTimer: null,
      broadcastThrottleTimer: null,
      warmupTimer: null,
    };
    this.aiService = null;
    this.clients = new Set(); // WebSocket 客户端
    this.pendingBroadcast = false; // 节流标志
    this.lastBroadcastTime = 0; // 上次广播时间
    this.broadcastInterval = 200; // 广播间隔（毫秒）

    // 使用循环缓冲区存储数据，避免内存无限增长
    this.responseTimes = new CircularBuffer(1000);       // 成功请求响应时间（近期窗口）
    this.failureResponseTimes = new CircularBuffer(500); // 失败请求响应时间
    this.errorLogs = new CircularBuffer(100);            // 错误日志缓冲区
    this.requestLogs = new CircularBuffer(500);          // 请求日志缓冲区

    // 全量直方图：分位数基于整场压测的样本，而非仅最近 N 次
    this.latencyHistogram = new Histogram({ maxValue: 600000, bucketMs: 10 });
    this.failureLatencyHistogram = new Histogram({ maxValue: 600000, bucketMs: 10 });
    this.ttfbHistogram = new Histogram({ maxValue: 120000, bucketMs: 5 });
    // TPOT：每输出 token 的耗时（ms），解码阶段的核心质量指标
    this.tpotHistogram = new Histogram({ maxValue: 60000, bucketMs: 1 });

    // 最近 60 秒的完成样本（含 token 用量），用于计算实时 TPM 与实际完成 RPM
    this.completionWindow = new SlidingWindow(TOKEN_WINDOW_MS);

    this.memoryMonitor = null;
    this.lastPercentileAt = 0;

    // 请求内容复用控制
    this.promptPool = [];
    this.promptSeq = 0;
    this.uniquePromptCount = 0;
    this.datasetItems = [];

    // 请求调度基准时间
    this.nextFireAt = null;

    // 当前测试轮次标识：用于丢弃上一轮遗留的在途请求与调度器，
    // 避免"停止后立刻开始新测试"时旧请求污染新测试的统计
    this.runId = 0;

    // 当前测试的启动方会话（能力探测的多轮流程共用同一个启动方）
    this.currentOwner = null;

    // 自动寻优内部状态
    this.seekState = { low: 0, high: null, step: 0, rounds: 0, lastChangeAt: 0 };
    // 当前档位的统计窗口（seek / 并发阶梯模式使用）
    this.phaseStats = null;

    // 阶段令牌：档位切换时自增，使上一档遗留的 worker 自动退出
    this.stageToken = 0;
    // 并发阶梯内部状态
    this.ladderState = null;
    // 能力探测内部状态
    this.probeState = null;
    this.probePhaseResolve = null;
    // 当前轮次的请求中断控制器：停止时用于掐断在途请求
    this.abortController = null;

    // 待推送的请求日志队列：攒批后随广播 tick 一起下发，
    // 避免每个请求完成都单独发一条 WebSocket 消息（高 RPM 下每秒数百条）
    this.pendingLogQueue = [];
  }

  /**
   * 空的延迟统计结构
   */
  _emptyLatency() {
    return { count: 0, avg: 0, min: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
  }

  /**
   * 获取初始状态
   */
  getInitialState() {
    return {
      isRunning: false,
      // 当前测试的归属会话：用于停止权限判定与广播隔离
      owner: null,
      mode: 'fixed',
      currentRPM: 0,
      targetRPM: 0,
      // 评估结果
      maxSustainableRPM: null,
      maxSustainableTPM: null,
      recommendedRPM: null,
      recommendedTPM: null,
      probeResult: null,
      rampHistory: [],
      // 并发阶梯进度
      ladder: { active: false, steps: [], index: 0, current: 0 },
      stats: {
        totalRequests: 0,
        successCount: 0,
        failureCount: 0,
        skippedRequests: 0,
        errors: {},
        avgResponseTime: 0,
        successRate: 100,
        failureRate: 0,
        consecutiveFailures: 0,
        rpmHistory: [],
        minuteStats: [],
        // Token 维度统计（TPM）
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        // 缓存命中 token 数（上游返回 prompt cache 相关字段时累计，0 表示无数据）
        totalCachedTokens: 0,
        cacheHitRate: null,
        avgTPM: 0,
        inputTPM: 0,
        outputTPM: 0,
        avgTokenSpeed: 0, // 平均生成速度 tok/s
        // 延迟分位数（全量直方图）
        latency: this._emptyLatency(),
        failureLatency: this._emptyLatency(),
        ttfb: this._emptyLatency(),
        // TPOT：每输出 token 耗时（ms），仅流式请求可测
        tpot: this._emptyLatency(),
        // 近 60 秒滑动窗口
        tpmWindow: { total: 0, input: 0, output: 0, samples: 0, windowMs: TOKEN_WINDOW_MS },
        actualRPM: 0,
        // 并发
        inFlight: 0,
        peakConcurrency: 0,
        avgConcurrency: 0,
        // 测试结束时仍未返回、已被排除在统计之外的请求数
        abandonedInFlight: 0,
        // 响应断言失败数（响应成功但内容不符合断言）
        assertionFailures: 0,
        // 请求复用
        promptReuseRatio: 0,
        actualPromptReuseRatio: 0,
        uniquePromptCount: 0,
        // 当前档位吞吐（按档位时长折算，用于并发阶梯判定饱和点）
        stageThroughput: { rpm: 0, inputTPM: 0, outputTPM: 0, totalTPM: 0, durationMs: 0, requests: 0 },
        // SLA 达标情况
        sla: { met: false, successMet: false, ttftMet: false, tpotMet: false, reasons: [] },
      },
      // 预热期：预热阶段的请求不计入正式统计，避免冷连接拖高 P99
      warmup: { active: false, totalMs: 0, endsAt: null },
      config: {
        url: '',
        modelName: '',
        apiKey: '',
        testPrompt: '',
        promptMode: 'fixed',
        randomPrompts: [],
        promptTemplate: '',
        requestType: 'stream',
        testDuration: 0,
        warmupDuration: 0,
        providerType: 'gemini',
        ttftThreshold: config.stressTest.ttftThreshold,
        maxInFlight: config.stressTest.maxInFlight,
        promptReuseRatio: 0,
        concurrency: 0,
        datasetId: null,
        datasetName: null,
        rampConfig: null,
        seekConfig: null,
        // 响应断言：成功响应还需满足的内容校验，失败计入失败数
        assertions: [],
        // 测试结束后的 webhook 通知地址
        webhookUrl: '',
        // 计费单价（元/美元等，按每百万 token 计），用于估算本轮压测成本
        inputPrice: 0,
        outputPrice: 0,
        // 并发阶梯档位（空表示恒定并发单档）
        ladderSteps: [],
        ladderStepMs: config.stressTest.concurrencyRamp.stepDuration * 1000,
        // 探测轴向：rpm = 求 RPM 上限；tpm = 求 TPM 上限
        rampAxis: null,
      },
      thresholds: {
        successThreshold: config.stressTest.successThreshold,
        maxFailures: config.stressTest.maxConsecutiveFailures,
        latencyThreshold: config.stressTest.responseTimeThreshold,
        // SLA 达标阈值（判"这一档能不能承载"的统一口径）
        sla: {
          successThreshold: config.stressTest.sla.successThreshold,
          ttftP99Threshold: config.stressTest.sla.ttftP99Threshold,
          tpotP99Threshold: config.stressTest.sla.tpotP99Threshold,
          capacityRatio: config.stressTest.sla.capacityRatio,
        },
      },
      startTime: null,
      lastIncrementTime: null,
      lastMinuteTime: null,
      currentMinuteStats: {
        successCount: 0,
        failureCount: 0,
        timestamp: null,
        totalRequests: 0,
        successRate: 100,
        failureRate: 0,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        // 本分钟成功请求的耗时聚合，用于分钟级平均延迟折线图
        latencySum: 0,
        latencyCount: 0,
      },
    };
  }

  /**
   * 添加 WebSocket 客户端
   */
  addClient(ws) {
    this.clients.add(ws);
  }

  /**
   * 移除 WebSocket 客户端
   */
  removeClient(ws) {
    this.clients.delete(ws);
  }

  /**
   * 广播消息
   *
   * 默认只发给"当前测试的归属用户"：压测进度、请求日志、停止通知都属于
   * 启动者的数据，其他人不该收到（否则别人的浏览器会一起弹停止提示、
   * 一起显示实时统计）。
   *
   * 没有归属信息时（空闲、历史遗留连接）发给所有客户端。
   *
   * @param {Object} message
   * @param {{toAll?:boolean}} [options] - toAll=true 时忽略归属，发给所有连接
   */
  broadcast(message, { toAll = false } = {}) {
    const owner = this.testState.owner;
    this.clients.forEach(client => {
      if (client.readyState !== 1) return; // WebSocket.OPEN
      if (!toAll && owner && client.userId && client.userId !== owner) return;
      try {
        client.send(JSON.stringify(message));
      } catch (error) {
        log.error('广播消息失败', { error: error.message });
      }
    });
  }

  /**
   * 逐个客户端构造消息
   * 用于"按用户脱敏"的状态下发：归属者拿到完整状态，其他人拿到脱敏状态
   * @param {(userId:string|null)=>Object} build
   */
  broadcastEach(build) {
    this.clients.forEach(client => {
      if (client.readyState !== 1) return;
      try {
        client.send(JSON.stringify(build(client.userId || null)));
      } catch (error) {
        log.error('广播消息失败', { error: error.message });
      }
    });
  }

  /**
   * 节流广播统计更新
   */
  broadcastStatsThrottled() {
    const now = Date.now();

    // 如果距离上次广播时间小于间隔，则标记待广播
    if (now - this.lastBroadcastTime < this.broadcastInterval) {
      if (!this.pendingBroadcast) {
        this.pendingBroadcast = true;
        // 延迟广播
        if (this.timers.broadcastThrottleTimer) {
          clearTimeout(this.timers.broadcastThrottleTimer);
        }
        this.timers.broadcastThrottleTimer = setTimeout(() => {
          this.executeBroadcast();
        }, this.broadcastInterval - (now - this.lastBroadcastTime));
      }
      return;
    }

    // 可以立即广播
    this.executeBroadcast();
  }

  /**
   * 执行广播
   */
  executeBroadcast() {
    this.pendingBroadcast = false;
    this.lastBroadcastTime = Date.now();

    // 先下发攒批的请求日志，再发统计快照，保证日志时序
    this.flushRequestLogs();

    // 广播总体统计更新（按用户归属逐个下发，他人的数据走脱敏版本）
    this.broadcastEach((userId) => ({
      type: 'statsUpdate',
      data: this.getStateFor(userId),
    }));

    // 广播当前分钟统计更新（实时请求数）
    this.broadcast({
      type: 'currentMinuteStatsUpdate',
      data: this.testState.currentMinuteStats,
    });
  }

  /**
   * 把攒批的请求日志一次性下发
   */
  flushRequestLogs() {
    if (this.pendingLogQueue.length === 0) return;
    const batch = this.pendingLogQueue;
    this.pendingLogQueue = [];
    this.broadcast({
      type: 'requestLogsBatch',
      data: batch,
    });
  }

  /**
   * 获取当前状态
   *
   * 注意负载控制：responseTimes 全量数组不再随状态下发（前端用请求日志
   * 自行绘图），日志只带最近 N 条——该返回值会同时用于 REST /api/status
   * 与 WebSocket 每 200ms 的 statsUpdate 广播，体积过大会拖垮高频压测。
   */
  getState() {
    // 返回状态时，包含循环缓冲区中的数据
    return {
      ...this.testState,
      // 被测接口的密钥不对外返回
      config: this.testState.config
        ? { ...this.testState.config, apiKey: '***' }
        : null,
      stats: {
        ...this.testState.stats,
        // 配置了每百万 token 单价时，实时给出预估成本
        estimatedCost: this._computeEstimatedCost(),
        errorLogs: this.errorLogs.getAll().slice(-50).reverse(), // 最新的在前
        requestLogs: this.requestLogs.getAll().slice(-100).reverse(), // 最新的在前
      },
    };
  }

  /**
   * 按用户归属返回状态
   *
   * 归属者拿到完整状态；其他用户只拿到"有人在跑"的最小信息，
   * 避免互相看到对方的接口配置、请求日志与评估结果。
   *
   * owner 字段语义：
   *   'self'  = 当前测试由调用方启动
   *   'other' = 由其他用户启动（数据已脱敏）
   *   null    = 没有归属信息（空闲）
   *
   * @param {number|string|null} [userId]
   */
  getStateFor(userId = null) {
    const state = this.getState();
    const owner = this.testState.owner;

    if (!owner || userId == null || String(owner) === String(userId)) {
      return { ...state, owner: owner ? 'self' : null };
    }

    return {
      ...state,
      owner: 'other',
      config: null,
      thresholds: null,
      probeResult: null,
      rampHistory: [],
      maxSustainableRPM: null,
      maxSustainableTPM: null,
      recommendedRPM: null,
      recommendedTPM: null,
      stats: {
        ...state.stats,
        errorLogs: [],
        requestLogs: [],
      },
    };
  }

  /**
   * 获取内存使用情况
   * @returns {Object|null} 内存使用统计
   */
  getMemoryUsage() {
    if (this.memoryMonitor) {
      return this.memoryMonitor.getMemoryUsage();
    }
    // 如果没有内存监控器，直接获取内存信息
    const memUsage = process.memoryUsage();
    const MB = 1024 * 1024;
    return {
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      external: memUsage.external,
      rss: memUsage.rss,
      heapUsedMB: Math.round(memUsage.heapUsed / MB * 100) / 100,
      heapTotalMB: Math.round(memUsage.heapTotal / MB * 100) / 100,
      rssMB: Math.round(memUsage.rss / MB * 100) / 100,
      externalMB: Math.round(memUsage.external / MB * 100) / 100,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 归一化复用率到 [0, 1]
   */
  _normalizeRatio(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.min(1, Math.max(0, num));
  }

  /**
   * 解析起始 RPM
   */
  _resolveInitialRPM(mode, testConfig) {
    const r = parseInt(testConfig.rpm);
    if (Number.isFinite(r) && r > 0) return r;
    if (mode === 'auto' || mode === 'seek') return config.stressTest.autoMode.initialRPM;
    return 1;
  }

  /**
   * 解析递增参数
   */
  _resolveRampConfig(mode, initialRPM, testConfig) {
    const auto = config.stressTest.autoMode;
    const incrementRPM = parseInt(testConfig.incrementRPM);
    const incrementIntervalSec = parseInt(testConfig.incrementInterval);
    const maxRPM = parseInt(testConfig.maxRPM);
    const rampDurationMin = parseInt(testConfig.rampDuration);

    return {
      variant: testConfig.rampVariant === 'linear' ? 'linear' : 'step',
      initialRPM,
      incrementRPM: Number.isFinite(incrementRPM) && incrementRPM > 0 ? incrementRPM : auto.incrementRPM,
      incrementInterval: Number.isFinite(incrementIntervalSec) && incrementIntervalSec > 0
        ? incrementIntervalSec * 1000
        : auto.incrementInterval,
      maxRPM: Number.isFinite(maxRPM) && maxRPM > 0 ? maxRPM : auto.maxRPM,
      rampDurationMs: Number.isFinite(rampDurationMin) && rampDurationMin > 0
        ? rampDurationMin * 60000
        : 0,
    };
  }

  /**
   * 解析自动寻优参数
   */
  _resolveSeekConfig(initialRPM, testConfig) {
    const seek = config.stressTest.seekMode;
    const incrementRPM = parseInt(testConfig.incrementRPM);
    const maxRPM = parseInt(testConfig.maxRPM);
    const stepDurationSec = parseInt(testConfig.stepDuration);

    return {
      initialRPM,
      incrementRPM: Number.isFinite(incrementRPM) && incrementRPM > 0 ? incrementRPM : seek.incrementRPM,
      minStepRPM: seek.minStepRPM,
      maxRPM: Number.isFinite(maxRPM) && maxRPM > 0 ? maxRPM : seek.maxRPM,
      stepDurationMs: Number.isFinite(stepDurationSec) && stepDurationSec > 0
        ? stepDurationSec * 1000
        : seek.stepDuration,
      maxRounds: seek.maxStepRounds,
    };
  }

  /**
   * 启动压测（对外入口）
   */
  start(testConfig, owner = null) {
    if (this.testState.isRunning) {
      throw new AppError('测试已在进行中，请先停止当前测试', 409);
    }

    // 记录启动方会话：停止权限判定、状态脱敏与广播隔离都依赖它
    this.currentOwner = owner;

    const mode = testConfig.mode || 'fixed';

    // 能力探测：串行跑两轮，分别求最大可持续 RPM 与 TPM
    if (mode === 'probe') {
      this.startProbe(testConfig);
      return { success: true, message: '能力探测已启动：将先探测 RPM 上限，再探测 TPM 上限' };
    }

    this.startSingleRun(testConfig);
    return { success: true, message: '测试已启动' };
  }

  /**
   * 启动单轮压测（probe 的多轮流程会重复调用）
   */
  startSingleRun(testConfig) {
    // 开启新一轮：轮次与阶段令牌自增后，上一轮遗留的 worker / 定时器 / 在途请求会自动失效
    this.runId += 1;
    this.stageToken += 1;

    const now = Date.now();
    const mode = testConfig.mode || 'fixed';
    const isLadder = mode === 'concurrency-ramp';
    const isConcurrencyFamily = mode === 'concurrency' || isLadder;
    const promptMode = testConfig.promptMode || 'fixed';

    const ladderSteps = isLadder ? this._resolveLadderSteps(testConfig) : [];
    const initialRPM = isConcurrencyFamily ? 0 : this._resolveInitialRPM(mode, testConfig);
    const rampConfig = (mode === 'auto') ? this._resolveRampConfig(mode, initialRPM, testConfig) : null;
    const seekConfig = (mode === 'seek') ? this._resolveSeekConfig(initialRPM, testConfig) : null;

    // 解析数据集
    this.datasetItems = [];
    let datasetName = null;
    if (promptMode === 'dataset') {
      const resolved = this._resolveDataset(testConfig);
      this.datasetItems = resolved.items;
      datasetName = resolved.name;
      if (this.datasetItems.length === 0) {
        throw new AppError('数据集为空，请选择有效的压测数据集', 400);
      }
    }

    const slaInput = testConfig.sla || {};
    const slaDefaults = config.stressTest.sla;

    // 重置状态
    this.testState = {
      ...this.getInitialState(),
      isRunning: true,
      owner: this.currentOwner || null,
      mode,
      currentRPM: initialRPM,
      targetRPM: initialRPM,
      ladder: {
        active: isLadder,
        steps: ladderSteps,
        index: 0,
        current: isLadder ? ladderSteps[0] : 0,
      },
      config: {
        url: testConfig.url,
        modelName: testConfig.modelName,
        apiKey: testConfig.apiKey,
        testPrompt: testConfig.testPrompt || '',
        promptMode,
        randomPrompts: testConfig.randomPrompts || [],
        promptTemplate: testConfig.promptTemplate || '',
        requestType: testConfig.requestType || 'stream',
        testDuration: parseInt(testConfig.testDuration) > 0 ? parseInt(testConfig.testDuration) : 0,
        warmupDuration: parseInt(testConfig.warmupDuration) > 0 ? parseInt(testConfig.warmupDuration) : 0,
        providerType: testConfig.providerType || 'gemini',
        maxInFlight: parseInt(testConfig.maxInFlight) > 0
          ? parseInt(testConfig.maxInFlight)
          : config.stressTest.maxInFlight,
        promptReuseRatio: this._normalizeRatio(testConfig.promptReuseRatio),
        concurrency: isConcurrencyFamily
          ? (isLadder
              ? ladderSteps[0]
              : Math.min(
                  config.stressTest.concurrencyMode.maxWorkers,
                  Math.max(1, parseInt(testConfig.concurrency) || config.stressTest.concurrencyMode.defaultWorkers)
                ))
          : 0,
        datasetId: testConfig.datasetId || null,
        datasetName,
        rampConfig,
        seekConfig,
        // 响应断言：type ∈ contains / not_contains / regex / min_length
        assertions: this._resolveAssertions(testConfig.assertions),
        webhookUrl: typeof testConfig.webhookUrl === 'string' ? testConfig.webhookUrl.trim() : '',
        // 每百万 token 单价（币种与用户计费口径一致），>0 时参与成本估算
        inputPrice: this._priceValue(testConfig.inputPrice),
        outputPrice: this._priceValue(testConfig.outputPrice),
        ladderSteps,
        ladderStepMs: parseInt(testConfig.stepDuration) > 0
          ? parseInt(testConfig.stepDuration) * 1000
          : config.stressTest.concurrencyRamp.stepDuration * 1000,
        // 探测轴向：rpm = 求 RPM 上限；tpm = 求 TPM 上限
        rampAxis: testConfig.rampAxis || (isLadder ? 'tpm' : (mode === 'seek' ? 'rpm' : null)),
      },
      // 阈值配置：使用前端传递的值，未传递时使用环境变量默认值
      thresholds: {
        successThreshold: testConfig.successThreshold ?? config.stressTest.successThreshold,
        maxFailures: testConfig.maxFailures ?? config.stressTest.maxConsecutiveFailures,
        latencyThreshold: parseInt(testConfig.latencyThreshold) > 0
          ? parseInt(testConfig.latencyThreshold)
          : config.stressTest.responseTimeThreshold,
        sla: {
          successThreshold: Number.isFinite(Number(slaInput.successThreshold))
            ? Number(slaInput.successThreshold)
            : slaDefaults.successThreshold,
          ttftP99Threshold: parseInt(slaInput.ttftP99Threshold) > 0
            ? parseInt(slaInput.ttftP99Threshold)
            : slaDefaults.ttftP99Threshold,
          tpotP99Threshold: parseInt(slaInput.tpotP99Threshold) > 0
            ? parseInt(slaInput.tpotP99Threshold)
            : slaDefaults.tpotP99Threshold,
          capacityRatio: Number.isFinite(Number(slaInput.capacityRatio)) && Number(slaInput.capacityRatio) > 0
            ? Number(slaInput.capacityRatio)
            : slaDefaults.capacityRatio,
        },
      },
      startTime: now,
      lastIncrementTime: now,
      lastMinuteTime: now,
      currentMinuteStats: {
        successCount: 0,
        failureCount: 0,
        timestamp: new Date(now).toISOString(),
        totalRequests: 0,
        successRate: 100,
        failureRate: 0,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        latencySum: 0,
        latencyCount: 0,
      },
    };

    // 清空缓冲区与统计器
    this.responseTimes.clear();
    this.failureResponseTimes.clear();
    this.errorLogs.clear();
    this.requestLogs.clear();
    this.latencyHistogram.clear();
    this.failureLatencyHistogram.clear();
    this.ttfbHistogram.clear();
    this.tpotHistogram.clear();
    this.completionWindow.clear();
    this.promptPool = [];
    this.promptSeq = 0;
    this.uniquePromptCount = 0;
    this.lastPercentileAt = 0;
    this.nextFireAt = null;
    this.pendingLogQueue = [];

    // 预热期：预热阶段的样本不计入正式统计，避免 TLS 握手 / 冷连接 / 前缀缓存
    // 未建立时拖高 P99，让 SLA 判定失真。寻优 / 阶梯 / 探测模式自带逐档节奏，不适用。
    const warmupSec = this.testState.config.warmupDuration;
    if (warmupSec > 0 && WARMUP_MODES.includes(mode)) {
      this.warmupToken = (this.warmupToken || 0) + 1;
      const warmupToken = this.warmupToken;
      const endsAt = Date.now() + warmupSec * 1000;
      this.testState.warmup = { active: true, totalMs: warmupSec * 1000, endsAt, stats: { requests: 0, success: 0, failure: 0 } };
      this.timers.warmupTimer = setTimeout(() => {
        if (warmupToken === this.warmupToken && this.testState.isRunning) {
          this._completeWarmup();
        }
      }, warmupSec * 1000);
      log.info('预热期已启动', { seconds: warmupSec, mode });
    }
    this.seekState = { low: 0, high: null, step: 0, rounds: 0, lastChangeAt: 0 };
    this.ladderState = isLadder
      ? {
          token: this.stageToken,
          index: 0,
          steps: ladderSteps,
          lastProgressAt: now,
          lastPoint: null,
          bestMet: null,
        }
      : null;
    this.phaseStats = null;
    if (isLadder || mode === 'seek') {
      this.resetPhaseStats();
    }

    // 创建 AI 服务实例
    this.aiService = new AIRequestService(
      this.testState.config.providerType,
      {
        url: this.testState.config.url,
        modelName: this.testState.config.modelName,
        apiKey: this.testState.config.apiKey,
        requestType: this.testState.config.requestType,
        timeout: config.stressTest.responseTimeThreshold,
      }
    );

    // 本轮的中断控制器：停止测试时立刻掐断所有在途请求
    this.abortController = new AbortController();
    this.aiService.setAbortSignal(this.abortController.signal);

    // 启动内存监控
    const MB = 1024 * 1024;
    this.memoryMonitor = new MemoryMonitor({
      warningThreshold: 500 * MB,   // 警告阈值 500MB
      criticalThreshold: 800 * MB,  // 临界阈值 800MB
      checkInterval: 30000,         // 每 30 秒检查一次
    });
    this.memoryMonitor.start();

    log.testStart({
      mode: this.testState.mode,
      currentRPM: this.testState.currentRPM,
      modelName: this.testState.config.modelName,
      url: this.testState.config.url,
      providerType: this.testState.config.providerType,
    });

    this.startTestLoop();
  }

  /**
   * 解析并发阶梯档位
   * 优先使用显式数组，其次按"起始/上限/倍数"生成，最后回落到配置默认档位
   */
  _resolveLadderSteps(testConfig) {
    const ramp = config.stressTest.concurrencyRamp;
    const maxWorkers = config.stressTest.concurrencyMode.maxWorkers;
    let steps = [];

    if (Array.isArray(testConfig.concurrencySteps) && testConfig.concurrencySteps.length > 0) {
      steps = testConfig.concurrencySteps
        .map((n) => parseInt(n))
        .filter((n) => Number.isFinite(n) && n > 0);
    }

    if (steps.length === 0) {
      const start = parseInt(testConfig.concurrencyStart);
      const max = parseInt(testConfig.concurrencyMax);
      const multiplier = parseFloat(testConfig.concurrencyMultiplier) || 2;
      if (Number.isFinite(start) && start > 0 && Number.isFinite(max) && max >= start) {
        let c = start;
        let guard = 0;
        while (c <= max && guard < 64) {
          steps.push(c);
          c = Math.max(c + 1, Math.ceil(c * multiplier));
          guard++;
        }
      }
    }

    // 恒定并发单档：把并发值当成只有一档的阶梯
    if (steps.length === 0) {
      const single = parseInt(testConfig.concurrency);
      if (Number.isFinite(single) && single > 0) steps = [single];
    }

    if (steps.length === 0) steps = [...ramp.steps];

    return Array.from(new Set(steps))
      .filter((n) => n <= maxWorkers)
      .sort((a, b) => a - b);
  }

  /**
   * 解析压测数据集（内置数据集或前端传入的自定义条目）
   */
  _resolveDataset(testConfig) {
    if (Array.isArray(testConfig.datasetItems) && testConfig.datasetItems.length > 0) {
      return { name: testConfig.datasetName || '自定义数据集', items: testConfig.datasetItems };
    }
    if (testConfig.datasetId) {
      // 延迟引入，避免与服务注册顺序耦合
      const datasets = require('../datasets');
      const dataset = datasets.getDataset(testConfig.datasetId);
      if (dataset) {
        return { name: dataset.name, items: dataset.items };
      }
    }
    return { name: null, items: [] };
  }

  /**
   * 停止测压
   *
   * 默认只有启动方会话能停自己的测试：多会话共用同一平台时，
   * 否则谁都能一键掐掉别人正在跑的压测。确需强行停止需显式 force=true。
   *
   * @param {string|null} [sessionId] - 调用方会话
   * @param {boolean} [force] - 强制停止他人测试
   */
  stop(sessionId = null, force = false) {
    if (!this.testState.isRunning) {
      throw new AppError('没有正在进行的测试', 409);
    }

    const owner = this.testState.owner;
    const isOthers = !!(owner && sessionId && owner !== sessionId);

    if (isOthers && !force) {
      log.warn('停止请求被拒绝：非测试归属会话', { owner, sessionId });
      return {
        success: false,
        ownerMismatch: true,
        message: '当前测试由其他会话启动，你的停止请求未生效。确需停止请使用强制停止。',
      };
    }

    // 能力探测过程中手动停止：终止整个探测流程，不再进入下一轮
    if (this.probeState && this.probeState.active) {
      this.probeState.aborted = true;
    }

    let maxRPM = null;
    if (this.testState.mode === 'auto') {
      maxRPM = this.testState.currentRPM;
    } else if (this.testState.mode === 'seek') {
      maxRPM = this.seekState.low || null;
    } else if (this.testState.mode === 'concurrency-ramp') {
      maxRPM = this.ladderState && this.ladderState.bestMet ? this.ladderState.bestMet.rpm : null;
    }

    const reason = isOthers && force ? '被其他会话强制停止' : '手动停止';
    this.finish(reason, maxRPM);
    return { success: true, message: force && isOthers ? '已强制停止他人测试' : '测试已停止' };
  }

  /**
   * 结束测试：清理定时器、计算最终指标、落库并广播
   * 若处于能力探测流程中，本轮回合结束只会切换到下一轮
   */
  finish(reason, maxRPM = null) {
    if (!this.testState.isRunning) return;

    this.testState.isRunning = false;
    this.clearAllTimers();
    // 阶段令牌自增，让当前档位遗留的 worker 立即退出
    this.stageToken += 1;

    // 结束瞬间仍在途的请求，其响应必然晚于本次统计快照到达。
    // 若不丢弃，它们会在历史记录落库之后继续改动内存统计，
    // 造成"界面最终数字"与"历史记录"对不上。这里统一排除并留痕。
    const abandonedInFlight = this.testState.stats.inFlight || 0;
    if (abandonedInFlight > 0) {
      this.testState.stats.abandonedInFlight = abandonedInFlight;
      log.info('结束时有在途请求，已排除在本次统计之外', { abandonedInFlight });
    }
    this.runId += 1;

    // 掐断所有在途请求：仅置 isRunning=false 只能阻止"发新请求"，
    // 已发出的请求仍会跑满 timeout（默认 150 秒），
    // 用户会看到"点了停止，目标服务还在被压"。
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // 停止内存监控
    if (this.memoryMonitor) {
      this.memoryMonitor.stop();
      this.memoryMonitor = null;
    }

    // 结算最终指标
    this.refreshLatencyStats();
    this.updateTpmStats();
    this.updateStageThroughput();
    this.evaluateSla();

    // 寻优 / 阶梯模式若由紧急中止或手动停止结束，也要留下已探明的能力值
    if (this.testState.maxSustainableRPM === null && maxRPM !== null) {
      this.testState.maxSustainableRPM = maxRPM;
    }
    this.applyRecommendations();

    const pendingProbePhase = !!(
      this.probeState && this.probeState.active && !this.probeState.aborted && this.probePhaseResolve
    );

    // 保存测试历史
    this.saveHistory(reason, maxRPM);

    log.testStop(reason, this.testState.stats);

    // 结束前把攒批的请求日志一次性下发，保证前端日志面板完整
    this.flushRequestLogs();

    // 测试结束 webhook 通知（CI/告警系统集成点）
    if (this.testState.config.webhookUrl) {
      const stats = this.testState.stats;
      sendWebhook(this.testState.config.webhookUrl, {
        event: 'stress_test_finished',
        reason,
        mode: this.testState.mode,
        url: this.testState.config.url,
        model: this.testState.config.modelName,
        totalRequests: stats.totalRequests,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        successRate: stats.successRate,
        maxSustainableRPM: this.testState.maxSustainableRPM,
        maxSustainableTPM: this.testState.maxSustainableTPM,
        sla: stats.sla,
        finishedAt: new Date().toISOString(),
      });
    }

    // 广播测试停止消息
    this.broadcast({
      type: 'testStopped',
      data: {
        reason,
        finalStats: this.testState.stats,
        maxRPM,
        maxSustainableRPM: this.testState.maxSustainableRPM,
        maxSustainableTPM: this.testState.maxSustainableTPM,
        recommendedRPM: this.testState.recommendedRPM,
        recommendedTPM: this.testState.recommendedTPM,
      },
    });

    // 推送一次最终状态
    // 前端只在 stateUpdate/statsUpdate 里刷新状态灯、计时器与按钮，
    // 只发 testStopped 会让界面一直停在"测试进行中"（看起来像没停下来），
    // 而且 clearAllTimers() 已经取消了尚未触发的节流广播，这里必须补一条。
    this.broadcastEach((sessionId) => ({
      type: 'statsUpdate',
      data: this.getStateFor(sessionId),
    }));

    // 探测流程中：切换到下一轮
    if (pendingProbePhase) {
      const resolve = this.probePhaseResolve;
      this.probePhaseResolve = null;
      resolve(this._collectProbePhaseResult());
    }
  }

  /**
   * 汇总当前这一轮的评估结果
   */
  _collectProbePhaseResult() {
    return {
      mode: this.testState.mode,
      maxRPM: this.testState.maxSustainableRPM,
      maxTPM: this.testState.maxSustainableTPM,
      recommendedRPM: this.testState.recommendedRPM,
      recommendedTPM: this.testState.recommendedTPM,
      sla: this.testState.stats.sla,
      stageThroughput: this.testState.stats.stageThroughput,
      rampHistory: this.testState.rampHistory,
      stats: this.testState.stats,
    };
  }

  /**
   * 按 SLA 折算建议承载容量
   */
  applyRecommendations() {
    const { capacityRatio } = this.testState.thresholds.sla;
    const ratio = Number.isFinite(capacityRatio) && capacityRatio > 0 ? capacityRatio : 0.7;

    if (this.testState.maxSustainableRPM !== null) {
      this.testState.recommendedRPM = Math.max(1, Math.floor(this.testState.maxSustainableRPM * ratio));
    }
    if (this.testState.maxSustainableTPM !== null) {
      this.testState.recommendedTPM = Math.max(1, Math.floor(this.testState.maxSustainableTPM * ratio));
    }
  }

  /**
   * 清除所有定时器
   */
  clearAllTimers() {
    Object.keys(this.timers).forEach(key => {
      if (this.timers[key]) {
        clearInterval(this.timers[key]);
        clearTimeout(this.timers[key]);
        this.timers[key] = null;
      }
    });
  }

  /**
   * 获取测试请求
   *
   * 复用率（promptReuseRatio）语义：
   *   - 固定请求模式：所有请求使用同一内容，复用率恒为 1
   *   - 其他模式：先构造一个请求池，池满后按复用率决定"复用池内请求"还是"生成全新请求"，
   *     复用率 < 1 时新请求会追加唯一标记，确保不命中上游前缀缓存
   */
  getTestPrompt() {
    const cfg = this.testState.config;

    if (cfg.promptMode === 'fixed') {
      if (this.uniquePromptCount === 0) this.uniquePromptCount = 1;
      return cfg.testPrompt;
    }

    // 模板模式：每个请求独立渲染变量，天然绕过复用池
    if (cfg.promptMode === 'template') {
      this.promptSeq++;
      this.uniquePromptCount++;
      return this._renderTemplate(cfg.promptTemplate);
    }

    const poolSize = config.stressTest.promptPoolSize;
    if (this.promptPool.length >= poolSize && Math.random() < cfg.promptReuseRatio) {
      return this.promptPool[Math.floor(Math.random() * this.promptPool.length)];
    }

    let prompt = this._buildNewPrompt();
    if (cfg.promptReuseRatio < 1) {
      prompt = `${prompt}\n\n[req-${this.promptSeq}]`;
    }

    this.promptSeq++;
    this.uniquePromptCount++;
    this.promptPool.push(prompt);
    if (this.promptPool.length > poolSize) {
      this.promptPool.shift();
    }
    return prompt;
  }

  /**
   * 构造一条全新的基础请求（不含唯一标记）
   */
  _buildNewPrompt() {
    const cfg = this.testState.config;

    if (cfg.promptMode === 'dataset' && this.datasetItems.length > 0) {
      const item = this.datasetItems[this.promptSeq % this.datasetItems.length];
      return typeof item === 'string' ? item : (item.prompt || '');
    }

    if (cfg.promptMode === 'random') {
      const base = cfg.randomPrompts.length > 0
        ? cfg.randomPrompts[Math.floor(Math.random() * cfg.randomPrompts.length)]
        : null;
      return this.generateRandomPrompt(base);
    }

    return cfg.testPrompt;
  }

  /**
   * 生成随机测试请求
   */
  generateRandomPrompt(basePrompt) {
    if (!basePrompt) {
      const templates = [
        "请用{length}字左右介绍一下{topic}",
        "能否详细解释{topic}的相关知识？",
        "我想了解关于{topic}的信息，请详细说明",
      ];
      const topics = [
        "人工智能", "机器学习", "深度学习", "自然语言处理", "计算机视觉",
      ];
      const template = templates[Math.floor(Math.random() * templates.length)];
      const topic = topics[Math.floor(Math.random() * topics.length)];
      const length = [50, 100, 200][Math.floor(Math.random() * 3)];
      return template.replace('{topic}', topic).replace('{length}', length);
    } else {
      const variations = [
        basePrompt,
        basePrompt + " 请详细说明。",
        basePrompt + " 能否展开讲讲？",
        "问题：" + basePrompt,
        basePrompt + " 谢谢！",
      ];
      return variations[Math.floor(Math.random() * variations.length)];
    }
  }

  /**
   * 执行单个请求
   * @returns {Promise<{overloaded: boolean, reason?: string}>}
   */
  async executeRequest() {
    if (!this.testState.isRunning) {
      return { overloaded: false };
    }

    const runId = this.runId;
    const warmup = this.testState.warmup;
    const inWarmup = warmup && warmup.active;
    const stats = this.testState.stats;
    stats.inFlight++;
    if (stats.inFlight > stats.peakConcurrency) {
      stats.peakConcurrency = stats.inFlight;
    }

    let result;
    try {
      const prompt = this.getTestPrompt();
      result = await this.aiService.execute(prompt);
    } catch (error) {
      result = {
        success: false,
        responseTime: 0,
        status: undefined,
        error: error.message || '未知错误',
        errorCode: error.code || null,
        tokens: null,
      };
    } finally {
      stats.inFlight--;
    }

    // 归属校验：请求返回时若已开启新一轮测试，丢弃本次结果
    if (runId !== this.runId) {
      return { overloaded: false };
    }

    // 被主动中断的请求：既不算成功也不算失败，直接丢弃
    if (result && result.aborted) {
      return { overloaded: false };
    }

    // 预热期样本：单独计数，不进入正式统计。
    // 预热中途结束（warmup.active 已变 false）的在途请求按归属丢弃，
    // 避免正式统计开局先吃到几条冷启动样本。
    if (inWarmup) {
      if (warmup.active) {
        warmup.stats.requests++;
        if (result.success) {
          warmup.stats.success++;
        } else {
          warmup.stats.failure++;
        }
        this.broadcastStatsThrottled();
      }
      return { overloaded: false };
    }

    const now = Date.now();

    // token 用量（接口返回 usage 或按文本估算）
    const tokens = result.tokens || null;
    const promptTokens = tokens ? (tokens.promptTokens || 0) : 0;
    const completionTokens = tokens ? (tokens.completionTokens || 0) : 0;
    const totalTokens = tokens ? (tokens.totalTokens || (promptTokens + completionTokens)) : 0;

    // TPOT：解码耗时 ÷ 输出 token 数。只有流式请求能拿到首字节时间，非流式记为不可测
    const tpot = this._computeTpot(result, completionTokens);

    // 响应断言：接口层面成功，但内容不符合预期时按失败计
    if (result.success && this.testState.config.assertions.length > 0) {
      const assertionError = this._evaluateAssertions(result.content);
      if (assertionError) {
        result.success = false;
        result.error = assertionError;
        result.assertionFailed = true;
        stats.assertionFailures++;
      }
    }

    if (result.success) {
      stats.successCount++;
      stats.consecutiveFailures = 0;
      // 使用循环缓冲区存储响应时间（近期窗口），直方图记录全量分布
      this.responseTimes.push(result.responseTime);
      this.latencyHistogram.record(result.responseTime);
      if (result.ttfb != null) {
        this.ttfbHistogram.record(result.ttfb);
      }
      if (tpot !== null) {
        this.tpotHistogram.record(tpot);
      }
      this.testState.currentMinuteStats.successCount++;
      this.testState.currentMinuteStats.latencySum += result.responseTime;
      this.testState.currentMinuteStats.latencyCount++;
    } else {
      stats.failureCount++;
      stats.consecutiveFailures++;
      this.testState.currentMinuteStats.failureCount++;

      // 断言失败不算网络/服务故障，不计入连续失败熔断
      if (result.assertionFailed) {
        stats.consecutiveFailures = 0;
      }

      // 失败请求的耗时单独统计，避免把超时耗时混入成功请求的均值
      this.failureResponseTimes.push(result.responseTime);
      this.failureLatencyHistogram.record(result.responseTime);

      // 记录错误
      const errorKey = String(result.error || '未知错误').substring(0, 100);
      stats.errors[errorKey] = (stats.errors[errorKey] || 0) + 1;

      // 使用循环缓冲区存储错误日志
      this.errorLogs.push({
        time: new Date(now).toISOString(),
        message: result.error,
        statusCode: result.status,
      });
    }

    stats.totalRequests++;
    this.testState.currentMinuteStats.totalRequests++;

    // 档位统计（seek / 并发阶梯模式）：按档位口径统计吞吐与 SLA 指标
    if (this.phaseStats) {
      this.phaseStats.totalRequests++;
      this.phaseStats.promptTokens += promptTokens;
      this.phaseStats.completionTokens += completionTokens;
      if (result.success) {
        this.phaseStats.successCount++;
        this.phaseStats.responseTimes.push(result.responseTime);
        if (result.ttfb != null) this.phaseStats.ttftTimes.push(result.ttfb);
        if (tpot !== null) this.phaseStats.tpotTimes.push(tpot);
      } else {
        this.phaseStats.failureCount++;
      }
    }

    if (tokens) {
      stats.totalPromptTokens += promptTokens;
      stats.totalCompletionTokens += completionTokens;
      stats.totalTokens += totalTokens;
      // 上游返回缓存命中 token 时累计（失败请求若带 usage 也计入，与 prompt 口径一致）
      if (tokens.cachedTokens != null) {
        stats.totalCachedTokens += tokens.cachedTokens;
      }
      this.testState.currentMinuteStats.promptTokens += promptTokens;
      this.testState.currentMinuteStats.completionTokens += completionTokens;
      this.testState.currentMinuteStats.tokens += totalTokens;
    }

    // 无论成功失败都记录一次"完成样本"，
    // 否则失败请求（拿不到 token）不会进入窗口，"实际完成 RPM" 会恒为 0
    this.completionWindow.add(
      { prompt: promptTokens, completion: completionTokens, total: totalTokens },
      now
    );

    // 添加请求日志
    this.addRequestLog({
      status: result.success ? 'success' : 'failure',
      responseTime: result.responseTime,
      statusCode: result.status,
      error: result.error || null,
      requestType: result.requestType,
      ttfb: result.ttfb,
      tokens: result.tokens || null,
    });

    // 更新统计
    this.updateStats();

    // 检查是否过载
    return this.checkOverload();
  }

  /**
   * 计算单次请求的 TPOT（每输出 token 耗时，单位 ms）
   * 用「端到端耗时 - 首字节耗时」近似解码阶段耗时，
   * 非流式请求拿不到首字节时间，返回 null 表示不可测。
   * @returns {number|null}
   */
  _computeTpot(result, completionTokens) {
    if (!result || !result.success) return null;
    if (result.ttfb == null) return null;
    if (!Number.isFinite(completionTokens) || completionTokens <= 0) return null;

    const decodeMs = Math.max(1, result.responseTime - result.ttfb);
    return decodeMs / completionTokens;
  }

  /**
   * 添加请求日志
   */
  addRequestLog(logData) {
    const logEntry = {
      time: new Date().toISOString(),
      status: logData.status,
      responseTime: logData.responseTime,
      statusCode: logData.statusCode,
      error: logData.error || null,
      modelName: this.testState.config.modelName,
      provider: this.testState.config.providerType,
      rpm: this.testState.currentRPM,
      requestType: logData.requestType || this.testState.config.requestType || 'stream',
      ttfb: logData.ttfb || null, // 首字节时间（仅流式请求）
      tokens: logData.tokens || null, // token 用量
    };

    // 使用循环缓冲区存储请求日志
    this.requestLogs.push(logEntry);

    // 攒批下发：随下一次广播 tick 一起发送（requestLogsBatch），
    // 高 RPM 下逐条推送会产生海量 WebSocket 消息
    this.pendingLogQueue.push(logEntry);
  }

  /**
   * 预热期结束：清空预热计时，广播通知前端
   * 正式统计在 executeRequest 中已按 warmup.active 隔离，这里无需重置
   */
  _completeWarmup() {
    if (this.timers.warmupTimer) {
      clearTimeout(this.timers.warmupTimer);
      this.timers.warmupTimer = null;
    }
    const warmup = this.testState.warmup;
    if (!warmup || !warmup.active) return;
    warmup.active = false;
    log.info('预热期结束，进入正式统计', { stats: warmup.stats });
    this.broadcast({
      type: 'warmupCompleted',
      data: { stats: warmup.stats },
    });
  }

  /**
   * 解析响应断言配置
   * type ∈ contains / not_contains / regex / min_length
   * @returns {Array<{type,value,caseSensitive}>} 合法断言列表
   */
  _resolveAssertions(input) {
    if (!Array.isArray(input)) return [];
    return input
      .map((a) => {
        if (!a || typeof a !== 'object') return null;
        const type = String(a.type || '').trim();
        const value = a.value == null ? '' : String(a.value);
        if (type === 'min_length') {
          const n = parseInt(a.value, 10);
          if (!Number.isFinite(n) || n < 0) return null;
          return { type, value: n };
        }
        if (type === 'contains' || type === 'not_contains') {
          if (!value) return null;
          return { type, value, caseSensitive: a.caseSensitive !== false };
        }
        if (type === 'regex') {
          if (!value) return null;
          try {
            return { type, value, regex: new RegExp(value, a.caseSensitive === false ? 'i' : '') };
          } catch (e) {
            log.warn('断言正则无效，已忽略', { value, error: e.message });
            return null;
          }
        }
        return null;
      })
      .filter(Boolean);
  }

  /**
   * 对成功响应内容执行断言
   * @param {string} content 响应文本
   * @returns {string|null} 断言失败描述；全部通过返回 null
   */
  _evaluateAssertions(content) {
    const assertions = this.testState.config.assertions;
    const text = typeof content === 'string' ? content : (content == null ? '' : String(content));

    for (const a of assertions) {
      if (a.type === 'contains') {
        const ok = a.caseSensitive
          ? text.includes(a.value)
          : text.toLowerCase().includes(a.value.toLowerCase());
        if (!ok) return `断言失败：响应不包含"${a.value.substring(0, 50)}"`;
      } else if (a.type === 'not_contains') {
        const ok = a.caseSensitive
          ? !text.includes(a.value)
          : !text.toLowerCase().includes(a.value.toLowerCase());
        if (!ok) return `断言失败：响应包含了"${a.value.substring(0, 50)}"`;
      } else if (a.type === 'regex') {
        if (!a.regex.test(text)) return `断言失败：响应不匹配正则 ${a.value.substring(0, 50)}`;
      } else if (a.type === 'min_length') {
        if (text.length < a.value) return `断言失败：响应长度 ${text.length} < ${a.value}`;
      }
    }
    return null;
  }

  /**
   * 渲染请求模板变量
   * 支持 {{seq}} {{timestamp}} {{date}} {{uuid}} {{random}} {{random:N}}
   * @param {string} template
   */
  _renderTemplate(template) {
    return String(template || '')
      .replace(/\{\{\s*random\s*:\s*(\d+)\s*\}\}/gi, (_, n) => {
        const len = Math.max(1, Math.min(64, parseInt(n, 10) || 8));
        let s = '';
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
        return s;
      })
      .replace(/\{\{\s*uuid\s*\}\}/gi, () => crypto.randomUUID())
      .replace(/\{\{\s*seq\s*\}\}/gi, () => String(this.promptSeq))
      .replace(/\{\{\s*timestamp\s*\}\}/gi, () => String(Date.now()))
      .replace(/\{\{\s*date\s*\}\}/gi, () => new Date().toISOString())
      .replace(/\{\{\s*random\s*\}\}/gi, () => String(Math.floor(Math.random() * 1000000)));
  }

  /**
   * 刷新延迟分位数（基于全量直方图）
   */
  refreshLatencyStats() {
    const stats = this.testState.stats;
    stats.latency = this.latencyHistogram.summary(PERCENTILES);
    stats.failureLatency = this.failureLatencyHistogram.summary(PERCENTILES);
    stats.ttfb = this.ttfbHistogram.summary(PERCENTILES);
    stats.tpot = this.tpotHistogram.summary(PERCENTILES);
    if (stats.latency.count > 0) {
      stats.avgResponseTime = stats.latency.avg;
    }
  }

  /**
   * 计算当前档位的吞吐（按档位实际时长折算）
   * 档位是并发阶梯判定"饱和点"的基本单位
   */
  updateStageThroughput() {
    const phase = this.phaseStats;
    if (!phase || !phase.startedAt) return;

    const durationMs = Math.max(1, Date.now() - phase.startedAt);
    const minutes = durationMs / 60000;

    this.testState.stats.stageThroughput = {
      requests: phase.totalRequests,
      durationMs,
      rpm: Math.round(phase.totalRequests / minutes),
      inputTPM: Math.round(phase.promptTokens / minutes),
      outputTPM: Math.round(phase.completionTokens / minutes),
      totalTPM: Math.round((phase.promptTokens + phase.completionTokens) / minutes),
    };
  }

  /**
   * 档位内的小样本分位数（档位样本量小，直接排序即可）
   */
  _percentileOf(values, p) {
    if (!values || values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)));
    return sorted[rank];
  }

  /**
   * 按 SLA 口径判定当前档位是否达标
   *   - RPM 上限看成功率 + TTFT P99（与输出长度无关）
   *   - TPM 上限看成功率 + TPOT P99（反映解码质量）
   * @param {Object} [phase] - 档位统计，缺省用当前档位
   * @param {boolean} [accumulate] - 是否写入 stats.sla
   * @returns {{met:boolean, successMet:boolean, ttftMet:boolean, tpotMet:boolean, reasons:string[], successRate:number, ttftP99:number, tpotP99:number}}
   */
  evaluateSla(phase = this.phaseStats, accumulate = true) {
    const { sla } = this.testState.thresholds;
    const stats = this.testState.stats;

    // 整场压测口径：没有档位时用全局直方图
    const totalRequests = phase ? phase.totalRequests : stats.totalRequests;
    const successCount = phase ? phase.successCount : stats.successCount;
    const ttftP99 = phase && phase.ttftTimes.length > 0
      ? Math.round(this._percentileOf(phase.ttftTimes, 99))
      : stats.ttfb.p99;
    const tpotP99 = phase && phase.tpotTimes.length > 0
      ? Math.round(this._percentileOf(phase.tpotTimes, 99) * 10) / 10
      : stats.tpot.p99;

    const successRate = totalRequests > 0 ? (successCount / totalRequests) * 100 : 100;

    const reasons = [];
    const successMet = !(sla.successThreshold > 0) || successRate >= sla.successThreshold;
    if (!successMet) {
      reasons.push(`成功率 ${Math.round(successRate * 100) / 100}% < ${sla.successThreshold}%`);
    }

    // 延迟类判定要求有足够样本，避免开局一两条请求就误判
    const ttftSamples = phase && phase.ttftTimes ? phase.ttftTimes.length : stats.ttfb.count;
    const ttftMet = !(sla.ttftP99Threshold > 0) || ttftSamples < SEEK_MIN_PHASE_SAMPLES
      ? true
      : ttftP99 <= sla.ttftP99Threshold;
    if (!ttftMet) {
      reasons.push(`TTFT P99 ${ttftP99}ms > ${sla.ttftP99Threshold}ms`);
    }

    const tpotSamples = phase && phase.tpotTimes ? phase.tpotTimes.length : stats.tpot.count;
    const tpotMet = !(sla.tpotP99Threshold > 0) || tpotSamples < SEEK_MIN_PHASE_SAMPLES
      ? true
      : tpotP99 <= sla.tpotP99Threshold;
    if (!tpotMet) {
      reasons.push(`TPOT P99 ${tpotP99}ms > ${sla.tpotP99Threshold}ms`);
    }

    const result = {
      met: successMet && ttftMet && tpotMet,
      successMet,
      ttftMet,
      tpotMet,
      reasons,
      successRate: Math.round(successRate * 100) / 100,
      ttftP99,
      tpotP99,
    };

    if (accumulate) {
      stats.sla = { ...result, thresholds: { ...sla } };
    }
    return result;
  }

  /**
   * 刷新 TPM 相关指标（滑动窗口 + 累计均值）
   */
  updateTpmStats() {
    const stats = this.testState.stats;
    const now = Date.now();

    const window = this.completionWindow.totals(['prompt', 'completion', 'total'], now);
    stats.tpmWindow = {
      total: window.total,
      input: window.prompt,
      output: window.completion,
      samples: window.samples,
      windowMs: TOKEN_WINDOW_MS,
    };
    stats.actualRPM = window.samples;

    // 闭环模式（恒定并发 / 并发阶梯）没有目标 RPM，直接展示实测达成值
    if (this.testState.mode === 'concurrency' || this.testState.mode === 'concurrency-ramp') {
      this.testState.currentRPM = window.samples;
      this.testState.targetRPM = window.samples;
    }

    const elapsedMs = this.testState.startTime ? now - this.testState.startTime : 0;
    const elapsedMinutes = elapsedMs / 60000;
    if (elapsedMinutes > 0.05 && stats.totalTokens > 0) {
      stats.avgTPM = Math.round(stats.totalTokens / elapsedMinutes);
      stats.inputTPM = Math.round(stats.totalPromptTokens / elapsedMinutes);
      stats.outputTPM = Math.round(stats.totalCompletionTokens / elapsedMinutes);
      stats.avgTokenSpeed =
        Math.round((stats.totalCompletionTokens / (elapsedMs / 1000)) * 10) / 10;
    }

    // 缓存命中率 = 累计命中 token / 累计输入 token；上游未返回缓存数据时为 null
    stats.cacheHitRate =
      stats.totalPromptTokens > 0 && stats.totalCachedTokens > 0
        ? Math.round((stats.totalCachedTokens / stats.totalPromptTokens) * 10000) / 100
        : null;
  }

  /**
   * 更新统计数据
   */
  updateStats() {
    const stats = this.testState.stats;
    const total = stats.totalRequests;

    if (total > 0) {
      stats.successRate = ((stats.successCount / total) * 100).toFixed(2);
      stats.failureRate = ((stats.failureCount / total) * 100).toFixed(2);
    }

    this.updateTpmStats();

    // 分位数 / 档位吞吐 / SLA 达标按固定频率刷新，避免高频压测下反复遍历直方图
    const now = Date.now();
    if (now - this.lastPercentileAt >= PERCENTILE_REFRESH_MS) {
      this.lastPercentileAt = now;
      this.refreshLatencyStats();
      this.updateStageThroughput();
      this.evaluateSla();
    }

    // 平均并发：Little's Law（并发 = 请求数 × 平均延迟 ÷ 运行时长）
    const elapsedMs = this.testState.startTime ? now - this.testState.startTime : 0;
    const latencyCount = this.latencyHistogram.count + this.failureLatencyHistogram.count;
    if (elapsedMs > 0 && latencyCount > 0) {
      const latencySum = this.latencyHistogram.sum + this.failureLatencyHistogram.sum;
      stats.avgConcurrency = Math.round((latencySum / elapsedMs) * 100) / 100;
    }

    // 实际请求复用率
    // 注意：请求在请求发出前就已生成，而总请求数在请求完成时才累加，
    // 因此并发场景下 uniquePromptCount 可能短暂大于 totalRequests，需裁剪到 [0,1]
    stats.promptReuseRatio = this.testState.config.promptReuseRatio;
    stats.uniquePromptCount = this.uniquePromptCount;
    stats.actualPromptReuseRatio = total > 0
      ? Math.min(1, Math.max(0, Math.round((1 - this.uniquePromptCount / total) * 10000) / 10000))
      : 0;

    // 更新当前分钟统计
    const minuteTotal = this.testState.currentMinuteStats.totalRequests;
    if (minuteTotal > 0) {
      this.testState.currentMinuteStats.successRate =
        ((this.testState.currentMinuteStats.successCount / minuteTotal) * 100).toFixed(2);
      this.testState.currentMinuteStats.failureRate =
        ((this.testState.currentMinuteStats.failureCount / minuteTotal) * 100).toFixed(2);
    }
    // 本分钟 TPM 即当前分钟窗口内的 token 数
    this.testState.currentMinuteStats.tpm = this.testState.currentMinuteStats.tokens;

    // 使用节流广播，避免频繁发送
    this.broadcastStatsThrottled();
  }

  /**
   * 检查是否过载
   */
  checkOverload() {
    const mode = this.testState.mode;
    if (mode === 'fixed') {
      return { overloaded: false };
    }

    const stats = this.testState.stats;
    const { successThreshold, maxFailures, latencyThreshold } = this.testState.thresholds;

    // seek 模式：连续失败不中止整场压测，而是立刻降低档位重新探测
    if (mode === 'seek') {
      if (maxFailures > 0 && stats.consecutiveFailures >= maxFailures) {
        return {
          overloaded: true,
          seekBackoff: true,
          reason: `连续失败${stats.consecutiveFailures}次`,
          maxRPM: this.seekState.low || null,
        };
      }
      // 其余容量判定在每个档位结束时统一评估，避免档位内被瞬时抖动误判
      return { overloaded: false };
    }

    // 条件1: 连续失败次数过多（阈值为0时跳过判定）—— 服务明显不可用，立即中止
    if (maxFailures > 0 && stats.consecutiveFailures >= maxFailures) {
      return {
        overloaded: true,
        reason: `连续失败${stats.consecutiveFailures}次`,
        maxRPM: this.testState.currentRPM,
      };
    }

    const minuteStats = this.testState.currentMinuteStats;

    // 条件2: 当前分钟成功率低于阈值（阈值为0时跳过判定）
    if (successThreshold > 0 && minuteStats.totalRequests >= 10 &&
        minuteStats.successRate < successThreshold) {
      return {
        overloaded: true,
        reason: `本分钟成功率(${minuteStats.successRate}%)低于阈值(${successThreshold}%)`,
        maxRPM: this.testState.currentRPM,
      };
    }

    // 条件3: 平均响应时间过长（基于全量直方图）
    if (latencyThreshold > 0 && stats.latency.count >= 10 &&
        stats.avgResponseTime > latencyThreshold) {
      return {
        overloaded: true,
        reason: `平均响应时间(${stats.avgResponseTime}ms)超过阈值(${latencyThreshold}ms)`,
        maxRPM: this.testState.currentRPM,
      };
    }

    return { overloaded: false };
  }

  /**
   * 记录每分钟统计
   */
  recordMinuteStats() {
    const minute = this.testState.currentMinuteStats;
    this.testState.stats.minuteStats.push({
      timestamp: minute.timestamp,
      successCount: minute.successCount,
      failureCount: minute.failureCount,
      totalRequests: minute.totalRequests,
      successRate: minute.successRate,
      // 分钟级平均延迟（仅成功请求），供详情页折线图使用
      avgResponseTime: minute.latencyCount > 0 ? Math.round(minute.latencySum / minute.latencyCount) : null,
      rpm: this.testState.currentRPM,
      tokens: minute.tokens,
      promptTokens: minute.promptTokens,
      completionTokens: minute.completionTokens,
      tpm: minute.tokens, // 一分钟窗口内的 token 数即 TPM
    });

    // 保留最近1440分钟（24小时）
    if (this.testState.stats.minuteStats.length > 1440) {
      this.testState.stats.minuteStats.shift();
    }

    // 统计错误信息（使用循环缓冲区获取错误日志）
    const errorSummary = {};
    const recentErrors = this.errorLogs.getAll();
    recentErrors.forEach(error => {
      const key = error.statusCode || 'unknown';
      errorSummary[key] = (errorSummary[key] || 0) + 1;
    });

    // 记录分钟统计日志，包含错误摘要
    const logData = {
      rpm: this.testState.currentRPM,
      requests: this.testState.currentMinuteStats.totalRequests,
      successCount: this.testState.currentMinuteStats.successCount,
      failureCount: this.testState.currentMinuteStats.failureCount,
      successRate: this.testState.currentMinuteStats.successRate,
      tpm: this.testState.currentMinuteStats.tokens,
    };

    // 只有在有失败的情况下才添加错误摘要
    if (this.testState.currentMinuteStats.failureCount > 0) {
      logData.errorSummary = errorSummary;
    }

    log.info('📊 分钟统计', logData);

    // 重置当前分钟统计
    const now = Date.now();
    this.testState.lastMinuteTime = now;
    this.testState.currentMinuteStats = {
      successCount: 0,
      failureCount: 0,
      timestamp: new Date(now).toISOString(),
      totalRequests: 0,
      successRate: 100,
      failureRate: 0,
      tokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      latencySum: 0,
      latencyCount: 0,
    };

    this.broadcast({
      type: 'minuteStatsUpdate',
      data: this.testState.stats.minuteStats,
    });
  }

  /**
   * 启动测试循环
   */
  startTestLoop() {
    const mode = this.testState.mode;

    // 分钟统计定时器
    this.timers.minuteStatsTimer = setInterval(() => {
      if (!this.testState.isRunning) {
        clearInterval(this.timers.minuteStatsTimer);
        return;
      }
      this.recordMinuteStats();
    }, 60000);

    // 测试时长上限定时器（预热期不计入正式时长，顺延到预热结束后）
    const durationMinutes = this.testState.config.testDuration;
    if (durationMinutes > 0) {
      const warmupMs = this.testState.warmup.active ? this.testState.warmup.totalMs : 0;
      this.timers.durationTimer = setTimeout(() => {
        this.finish(`达到设定测试时长(${durationMinutes}分钟)`);
      }, durationMinutes * 60000 + warmupMs);
    }

    if (mode === 'concurrency' || mode === 'concurrency-ramp') {
      this.startConcurrencyWorkers();
      // 并发阶梯：每档跑满时长后评估吞吐与 SLA，决定升档或结束
      if (mode === 'concurrency-ramp') {
        this.timers.ladderTimer = setInterval(() => this.applyLadderStep(), 1000);
      }
    } else {
      this.scheduleNextRequest();
    }

    // 自动增压定时器
    if (mode === 'auto') {
      this.timers.rpmUpdateTimer = setInterval(() => this.applyRampStep(), 1000);
    }

    // 自动寻优定时器
    if (mode === 'seek') {
      this.seekState = {
        low: 0,
        high: null,
        step: this.testState.config.seekConfig.incrementRPM,
        rounds: 0,
        lastChangeAt: Date.now(),
      };
      this.resetPhaseStats();
      this.timers.seekTimer = setInterval(() => this.applySeekStep(), 1000);
    }
  }

  /**
   * 启动恒定并发 worker（闭环加压）
   */
  startConcurrencyWorkers() {
    const workers = this.testState.config.concurrency || 1;
    for (let i = 0; i < workers; i++) {
      this.runConcurrencyWorker(i);
    }
    log.info('恒定并发模式已启动', { workers });
  }

  /**
   * 单个并发 worker：请求完成后立即发起下一个（闭环）
   * @param {number} id - worker 编号
   */
  async runConcurrencyWorker(id) {
    // 绑定当前轮次与阶段：新一轮测试或新档位开始后，旧 worker 会自行退出
    const runId = this.runId;
    const stageToken = this.stageToken;

    while (this.testState.isRunning && runId === this.runId && stageToken === this.stageToken) {
      try {
        const overloadCheck = await this.executeRequest();
        if (runId !== this.runId || stageToken !== this.stageToken) break;
        if (overloadCheck && overloadCheck.overloaded) {
          this.handleOverloadResult(overloadCheck);
          // seek 模式的降档不终止 worker，继续在当前闭环内探测
          if (!overloadCheck.seekBackoff) break;
        }
      } catch (error) {
        log.error('并发 worker 执行异常', { worker: id, error: error.message });
      }
    }
  }

  /**
   * 按时间点调度下一个请求（避免 setInterval 累积漂移）
   */
  scheduleNextRequest() {
    if (!this.testState.isRunning) return;
    if (this.testState.mode === 'concurrency') return;

    const rpm = Math.max(1, this.testState.targetRPM || 1);
    const interval = 60000 / rpm;
    const now = Date.now();

    if (this.nextFireAt === null) {
      this.nextFireAt = now;
    }
    this.nextFireAt += interval;

    let delay = this.nextFireAt - now;
    if (delay < 0) {
      if (-delay > interval) {
        // 严重落后（例如事件循环被阻塞），重置基准避免"补偿风暴"
        this.nextFireAt = now + interval;
        delay = interval;
      } else {
        delay = 0;
      }
    }

    // 绑定当前轮次：新一轮测试开始后，旧调度链自动终止
    const runId = this.runId;
    this.timers.requestTimer = setTimeout(() => {
      if (runId !== this.runId) return;
      this.fireRequest();
      this.scheduleNextRequest();
    }, delay);
  }

  /**
   * 触发一次请求（不阻塞调度）
   */
  fireRequest() {
    if (!this.testState.isRunning) return;

    const cap = this.testState.config.maxInFlight;
    if (cap > 0 && this.testState.stats.inFlight >= cap) {
      // 已达并发上限：记录被跳过的请求，反映服务端处理不过来
      this.testState.stats.skippedRequests++;
      return;
    }

    this.executeRequest()
      .then((overloadCheck) => {
        this.handleOverloadResult(overloadCheck);
      })
      .catch((error) => {
        log.error('请求执行异常', { error: error.message });
      });
  }

  /**
   * 统一的过载处理入口
   * seek 模式的过载只做"降档探测"，其他模式则直接结束测试
   * @param {{overloaded:boolean, reason?:string, maxRPM?:number|null, seekBackoff?:boolean}} check
   */
  handleOverloadResult(check) {
    if (!check || !check.overloaded) return;
    if (check.seekBackoff) {
      this.handleSeekBackoff(check.reason);
      return;
    }
    this.finish(check.reason, check.maxRPM ?? this.testState.currentRPM);
  }

  /**
   * 重新按新的 RPM 调度请求（不重启分钟统计等定时器）
   */
  rescheduleRequests() {
    if (this.timers.requestTimer) {
      clearTimeout(this.timers.requestTimer);
      this.timers.requestTimer = null;
    }
    this.nextFireAt = null;
    if (this.testState.isRunning && this.testState.mode !== 'concurrency') {
      this.scheduleNextRequest();
    }
  }

  /**
   * 设置新的目标 RPM
   */
  setTargetRPM(rpm) {
    if (rpm === this.testState.currentRPM) return;
    this.testState.currentRPM = rpm;
    this.testState.targetRPM = rpm;
    log.rpmIncrease(rpm);
    this.broadcast({ type: 'rpmIncreased', data: { newRPM: rpm, time: new Date().toISOString() } });
    this.rescheduleRequests();
  }

  /**
   * 自动增压：阶梯或线性
   */
  applyRampStep() {
    if (!this.testState.isRunning || this.testState.mode !== 'auto') return;

    const { variant, incrementRPM, incrementInterval, maxRPM, rampDurationMs, initialRPM } =
      this.testState.config.rampConfig;
    const now = Date.now();
    let newRPM;

    if (variant === 'linear') {
      const elapsed = now - this.testState.startTime;
      const ratio = rampDurationMs > 0 ? Math.min(1, elapsed / rampDurationMs) : 1;
      newRPM = Math.round(initialRPM + (maxRPM - initialRPM) * ratio);
    } else {
      if (now - this.testState.lastIncrementTime < incrementInterval) return;
      newRPM = this.testState.currentRPM + incrementRPM;
      this.testState.lastIncrementTime = now;
    }

    newRPM = Math.min(newRPM, maxRPM);
    this.setTargetRPM(newRPM);
  }

  /**
   * 空的档位统计结构
   */
  _emptyPhaseStats() {
    return {
      startedAt: Date.now(),
      totalRequests: 0,
      successCount: 0,
      failureCount: 0,
      responseTimes: [],
      ttftTimes: [],
      tpotTimes: [],
      promptTokens: 0,
      completionTokens: 0,
    };
  }

  /**
   * 重置当前档位统计
   */
  resetPhaseStats() {
    this.phaseStats = this._emptyPhaseStats();
  }

  // ==================== 并发阶梯（TPM 饱和探测） ====================

  /**
   * 切换到第 index 档并发；返回 false 表示已超出档位范围
   */
  _startLadderStage(index) {
    const ladder = this.ladderState;
    if (!ladder || index >= ladder.steps.length) return false;

    const concurrency = ladder.steps[index];
    ladder.index = index;
    ladder.lastProgressAt = Date.now();
    // 注意：不要清空 lastPoint —— 饱和判定需要与上一档的吞吐作对比

    this.testState.ladder.index = index;
    this.testState.ladder.current = concurrency;
    this.testState.config.concurrency = concurrency;

    // 阶段令牌自增：上一档的 worker 立即退出
    this.stageToken += 1;
    ladder.token = this.stageToken;
    this.resetPhaseStats();

    log.info('并发阶梯进入新档位', { index, concurrency });
    this.broadcast({
      type: 'ladderStepChanged',
      data: { index, concurrency, steps: ladder.steps },
    });

    this.startConcurrencyWorkers();
    return true;
  }

  /**
   * 并发阶梯步进：每档跑满时长后评估，达标且未饱和就继续升档
   */
  applyLadderStep() {
    if (!this.testState.isRunning || this.testState.mode !== 'concurrency-ramp') return;
    const ladder = this.ladderState;
    if (!ladder) return;

    const stepMs = this.testState.config.ladderStepMs;
    const elapsed = Date.now() - ladder.lastProgressAt;
    if (elapsed < stepMs) return;

    const phase = this.phaseStats;
    // 样本不足时延长档位，避免用一两条请求的结果判定饱和
    if (phase && phase.totalRequests < SEEK_MIN_PHASE_SAMPLES &&
        elapsed < stepMs * SEEK_MAX_PHASE_EXTENSION) {
      return;
    }

    this.updateStageThroughput();
    const slaResult = this.evaluateSla(phase, false);
    const throughput = this.testState.stats.stageThroughput;
    const saturated = this._isTpmSaturated(throughput, ladder.lastPoint);
    const concurrency = this.testState.config.concurrency;

    const point = {
      time: new Date().toISOString(),
      index: ladder.index,
      concurrency,
      requests: throughput.requests,
      durationMs: throughput.durationMs,
      rpm: throughput.rpm,
      inputTPM: throughput.inputTPM,
      outputTPM: throughput.outputTPM,
      totalTPM: throughput.totalTPM,
      successRate: slaResult.successRate,
      ttftP99: slaResult.ttftP99,
      tpotP99: slaResult.tpotP99,
      met: slaResult.met,
      reasons: slaResult.reasons,
      saturated,
      // 统一用 overloaded 表示"这一档不可承载"，便于前端复用轨迹图
      overloaded: !slaResult.met,
    };

    this.testState.rampHistory.push(point);
    if (this.testState.rampHistory.length > 200) this.testState.rampHistory.shift();
    ladder.lastPoint = point;

    // 达标即记为"已探明的能力点"
    if (slaResult.met) {
      ladder.bestMet = point;
      this.testState.maxSustainableRPM = point.rpm;
      this.testState.maxSustainableTPM = point.outputTPM;
    }

    if (!slaResult.met) {
      this.finishLadder(
        `并发 ${concurrency} 未达标（${slaResult.reasons.join('；') || '指标不满足 SLA'}）`,
        ladder.bestMet
      );
      return;
    }

    if (saturated) {
      this.finishLadder(`output TPM 在 ${concurrency} 并发处饱和（吞吐不再随并发增长）`, point);
      return;
    }

    if (!this._startLadderStage(ladder.index + 1)) {
      this.finishLadder(`已跑完全部并发档位(${ladder.steps.join('/')})，未探测到饱和点`, point);
    }
  }

  /**
   * TPM 饱和判定：吞吐增幅低于阈值即认为已饱和
   */
  _isTpmSaturated(current, prev) {
    if (!prev || !prev.outputTPM || !current.outputTPM) return false;
    const ratio = config.stressTest.concurrencyRamp.saturationGrowthRatio;
    const growth = (current.outputTPM - prev.outputTPM) / prev.outputTPM;
    return growth < ratio;
  }

  /**
   * 结束并发阶梯并输出最大可持续 TPM
   */
  finishLadder(reason, point) {
    const best = point || (this.ladderState && this.ladderState.bestMet) || null;
    if (best) {
      this.testState.maxSustainableTPM = best.outputTPM;
      this.testState.maxSustainableRPM = best.rpm;
      this.testState.currentRPM = best.rpm;
      this.testState.targetRPM = best.rpm;
    }
    log.info('并发阶梯结束', {
      reason,
      concurrency: best ? best.concurrency : null,
      maxTPM: this.testState.maxSustainableTPM,
    });
    this.finish(reason, best ? best.rpm : null);
  }

  /**
   * 自动寻优：二分逼近最大可持续 RPM
   */
  applySeekStep() {
    if (!this.testState.isRunning || this.testState.mode !== 'seek') return;

    const cfg = this.testState.config.seekConfig;
    const now = Date.now();
    const elapsed = now - this.seekState.lastChangeAt;

    if (elapsed < cfg.stepDurationMs) return;

    const phase = this.phaseStats || this._emptyPhaseStats();

    // 样本不足时延长当前档位，避免用一两条请求的结果误判容量
    if (phase.totalRequests < SEEK_MIN_PHASE_SAMPLES &&
        elapsed < cfg.stepDurationMs * SEEK_MAX_PHASE_EXTENSION) {
      return;
    }

    // 达标判定统一走 SLA 口径：成功率 + TTFT P99 + TPOT P99
    // 不再用"平均响应时间"——端到端延迟会随输出长度漂移，无法定位 RPM 上限
    const slaResult = this.evaluateSla(phase, false);
    this._recordRampPoint(phase, slaResult);

    if (slaResult.met) {
      this._raiseProbeRPM();
    } else {
      this._backoffSeek(
        `档位 ${this.testState.currentRPM} RPM 未达标：${slaResult.reasons.join('；') || '指标不满足 SLA'}`
      );
    }
  }

  /**
   * 记录一个探测档位的结果
   */
  _recordRampPoint(phase, slaResult) {
    const durationMs = Math.max(1, Date.now() - (phase.startedAt || Date.now()));
    const minutes = durationMs / 60000;

    const point = {
      time: new Date().toISOString(),
      rpm: this.testState.currentRPM,
      requests: phase.totalRequests,
      durationMs,
      rpmMeasured: Math.round(phase.totalRequests / minutes),
      inputTPM: Math.round(phase.promptTokens / minutes),
      outputTPM: Math.round(phase.completionTokens / minutes),
      successRate: slaResult.successRate,
      ttftP99: slaResult.ttftP99,
      tpotP99: slaResult.tpotP99,
      p95: this._phaseP95(phase),
      met: slaResult.met,
      reasons: slaResult.reasons || [],
      overloaded: !slaResult.met,
    };

    this.testState.rampHistory.push(point);
    if (this.testState.rampHistory.length > 200) {
      this.testState.rampHistory.shift();
    }
    this.seekState.rounds++;
    return point;
  }

  /**
   * 当前档位可承受：抬高探测档位
   */
  _raiseProbeRPM() {
    const cfg = this.testState.config.seekConfig;
    const rpm = this.testState.currentRPM;
    this.seekState.low = rpm;

    if (this.seekState.rounds >= cfg.maxRounds) {
      this.finishSeek(`已达最大探测轮次(${cfg.maxRounds})，最大可持续 RPM ≈ ${this.seekState.low}`, this.seekState.low);
      return;
    }

    if (rpm >= cfg.maxRPM) {
      this.finishSeek(`已达最大 RPM 上限(${cfg.maxRPM})，最大可持续 RPM = ${rpm}`, rpm);
      return;
    }

    const next = Math.min(rpm + this.seekState.step, cfg.maxRPM);
    if (next === rpm) {
      this.finishSeek(`已收敛，最大可持续 RPM ≈ ${this.seekState.low}`, this.seekState.low);
      return;
    }

    this.setTargetRPM(next);
    this.seekState.lastChangeAt = Date.now();
    this.resetPhaseStats();
  }

  /**
   * 当前档位不可承受：二分收缩步长后重新探测
   * @param {string} reason - 降档原因
   */
  _backoffSeek(reason) {
    const cfg = this.testState.config.seekConfig;
    const rpm = this.testState.currentRPM;
    this.seekState.high = rpm;

    log.info('自动寻优降档', { from: rpm, best: this.seekState.low, reason });

    if (this.seekState.step <= cfg.minStepRPM) {
      this.finishSeek(`已收敛，最大可持续 RPM ≈ ${this.seekState.low}`, this.seekState.low);
      return;
    }

    this.seekState.step = Math.max(cfg.minStepRPM, Math.floor(this.seekState.step / 2));
    const next = Math.min(Math.max(cfg.initialRPM, this.seekState.low + this.seekState.step), cfg.maxRPM);

    this.seekState.lastChangeAt = Date.now();
    this.resetPhaseStats();

    if (next === rpm) {
      this.finishSeek(`已收敛，最大可持续 RPM ≈ ${this.seekState.low}`, this.seekState.low);
      return;
    }

    this.setTargetRPM(next);
  }

  /**
   * 连续失败触发的强制降档
   * 与档位结束时的判定互斥，并限制同一档位内不重复降档
   * @param {string} reason
   */
  handleSeekBackoff(reason) {
    if (!this.testState.isRunning || this.testState.mode !== 'seek') {
      this.finish(reason, this.seekState.low || null);
      return;
    }

    const cfg = this.testState.config.seekConfig;
    const now = Date.now();
    if (now - this.seekState.lastChangeAt < Math.min(cfg.stepDurationMs, 5000)) {
      // 同一档位内不重复降档，等待新档位的样本
      return;
    }

    const phase = this.phaseStats || this._emptyPhaseStats();
    this._recordRampPoint(phase, {
      met: false,
      successMet: false,
      ttftMet: false,
      tpotMet: false,
      reasons: [reason],
      successRate: phase.totalRequests > 0 ? (phase.successCount / phase.totalRequests) * 100 : 0,
      ttftP99: Math.round(this._percentileOf(phase.ttftTimes || [], 99)),
      tpotP99: 0,
    });
    this._backoffSeek(reason);
  }

  /**
   * 当前档位 P95（档位样本量小，直接排序即可）
   */
  _phaseP95(phase) {
    if (!phase || phase.responseTimes.length === 0) return 0;
    const sorted = [...phase.responseTimes].sort((a, b) => a - b);
    const rank = Math.floor(0.95 * (sorted.length - 1));
    return Math.round(sorted[rank]);
  }

  /**
   * 结束自动寻优
   */
  finishSeek(reason, maxRPM) {
    this.testState.maxSustainableRPM = maxRPM;
    log.info('自动寻优结束', { maxSustainableRPM: maxRPM, reason });
    this.finish(reason, maxRPM);
  }

  // ==================== 能力探测（一键求 RPM / TPM） ====================

  /**
   * 能力探测：串行跑两轮
   *   阶段 A：短入短出 + 自动寻优  → 最大可持续 RPM
   *   阶段 B：长出 + 并发阶梯      → 最大可持续 TPM
   * 两轮的中间结果都会落库，最后再写一条汇总结论。
   */
  async startProbe(testConfig) {
    const probeCfg = config.stressTest.probe;

    this.probeState = {
      active: true,
      aborted: false,
      phase: 'rpm',
      startedAt: Date.now(),
    };

    const base = {
      providerType: testConfig.providerType,
      url: testConfig.url,
      modelName: testConfig.modelName,
      apiKey: testConfig.apiKey,
      requestType: testConfig.requestType || 'stream',
      promptReuseRatio: testConfig.promptReuseRatio ?? 0,
      successThreshold: testConfig.successThreshold,
      maxFailures: testConfig.maxFailures,
      latencyThreshold: testConfig.latencyThreshold,
      maxInFlight: testConfig.maxInFlight,
      sla: testConfig.sla,
    };

    // ===== 阶段 A：求最大可持续 RPM =====
    const rpmResult = await this._runProbePhase({
      ...base,
      mode: 'seek',
      rampAxis: 'rpm',
      promptMode: 'dataset',
      datasetId: testConfig.rpmDatasetId || probeCfg.rpmDatasetId,
      rpm: parseInt(testConfig.rpm) > 0 ? parseInt(testConfig.rpm) : 10,
      incrementRPM: parseInt(testConfig.incrementRPM) > 0
        ? parseInt(testConfig.incrementRPM)
        : probeCfg.incrementRPM,
      stepDuration: parseInt(testConfig.stepDuration) > 0
        ? parseInt(testConfig.stepDuration)
        : probeCfg.stepDuration,
      maxRPM: parseInt(testConfig.maxRPM) > 0 ? parseInt(testConfig.maxRPM) : probeCfg.maxRPM,
    });

    if (this.probeState.aborted) {
      this._endProbe('已手动终止', rpmResult, null);
      return;
    }

    this.probeState.phase = 'tpm';
    this.broadcast({
      type: 'probeProgress',
      data: {
        phase: 'tpm',
        message: `RPM 阶段完成：最大可持续 RPM ≈ ${rpmResult ? rpmResult.maxRPM : '-'}，开始探测 TPM 上限`,
        maxRPM: rpmResult ? rpmResult.maxRPM : null,
      },
    });

    // ===== 阶段 B：求最大可持续 TPM =====
    const tpmResult = await this._runProbePhase({
      ...base,
      mode: 'concurrency-ramp',
      rampAxis: 'tpm',
      promptMode: 'dataset',
      datasetId: testConfig.tpmDatasetId || probeCfg.tpmDatasetId,
      concurrencySteps: testConfig.concurrencySteps,
      concurrencyStart: testConfig.concurrencyStart,
      concurrencyMax: testConfig.concurrencyMax,
      concurrencyMultiplier: testConfig.concurrencyMultiplier,
      stepDuration: parseInt(testConfig.stepDuration) > 0
        ? parseInt(testConfig.stepDuration)
        : probeCfg.stepDuration,
    });

    this._endProbe(this.probeState.aborted ? '已手动终止' : '能力探测完成', rpmResult, tpmResult);
  }

  /**
   * 跑一轮探测；Promise 在 finish() 结束时兑现
   */
  _runProbePhase(phaseConfig) {
    return new Promise((resolve) => {
      this.probePhaseResolve = resolve;
      try {
        this.startSingleRun(phaseConfig);
      } catch (error) {
        this.probePhaseResolve = null;
        log.error('能力探测阶段启动失败', { error: error.message });
        resolve(null);
      }
    });
  }

  /**
   * 探测流程收尾：写入结论、落库、广播
   */
  _endProbe(reason, rpmResult, tpmResult) {
    const state = this.testState;
    const ratio = this._capacityRatio();

    const maxRPM = (rpmResult && rpmResult.maxRPM) ?? state.maxSustainableRPM ?? null;
    const maxTPM = (tpmResult && tpmResult.maxTPM) ?? state.maxSustainableTPM ?? null;

    state.mode = 'probe';
    state.isRunning = false;
    state.maxSustainableRPM = maxRPM;
    state.maxSustainableTPM = maxTPM;
    state.recommendedRPM = maxRPM !== null ? Math.max(1, Math.floor(maxRPM * ratio)) : null;
    state.recommendedTPM = maxTPM !== null ? Math.max(1, Math.floor(maxTPM * ratio)) : null;
    state.probeResult = {
      reason,
      maxRPM,
      maxTPM,
      recommendedRPM: state.recommendedRPM,
      recommendedTPM: state.recommendedTPM,
      capacityRatio: ratio,
      sla: state.thresholds.sla,
      rpmPhase: rpmResult
        ? { maxRPM: rpmResult.maxRPM, rampHistory: rpmResult.rampHistory, sla: rpmResult.sla }
        : null,
      tpmPhase: tpmResult
        ? { maxTPM: tpmResult.maxTPM, rampHistory: tpmResult.rampHistory, sla: tpmResult.sla }
        : null,
      finishedAt: new Date().toISOString(),
    };

    if (this.probeState) this.probeState.active = false;

    this._saveProbeSummary(state.probeResult, reason);

    log.info('能力探测结束', { maxRPM, maxTPM, reason });

    this.broadcast({ type: 'probeCompleted', data: state.probeResult });
    this.broadcast({ type: 'statsUpdate', data: this.getState() });
  }

  /**
   * 建议容量折算比例
   */
  _capacityRatio() {
    const ratio = Number(this.testState.thresholds.sla.capacityRatio);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 0.7;
  }

  /**
   * 解析每百万 token 单价：非法或非正数一律按 0（不参与成本估算）
   */
  _priceValue(value) {
    const v = parseFloat(value);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  /**
   * 按配置的单价估算已消耗成本：
   * 成本 = 输入 token / 1M × 输入单价 + 输出 token / 1M × 输出单价
   * 未配置单价时返回 null（前端不展示）
   */
  _computeEstimatedCost() {
    if (!this.testState) return null;
    const cfg = this.testState.config;
    if (!cfg || (!cfg.inputPrice && !cfg.outputPrice)) return null;
    const stats = this.testState.stats;
    const cost = (stats.totalPromptTokens / 1e6) * (cfg.inputPrice || 0)
      + (stats.totalCompletionTokens / 1e6) * (cfg.outputPrice || 0);
    return Math.round(cost * 10000) / 10000;
  }

  /**
   * 保存能力探测结论（汇总记录）
   */
  _saveProbeSummary(result, reason) {
    try {
      const cfg = this.testState.config;
      const stats = this.testState.stats;
      const startedAt = this.probeState ? this.probeState.startedAt : Date.now();

      const historyId = db.saveHistory({
        userId: this.currentOwner,
        startTime: new Date(startedAt).toISOString(),
        endTime: new Date().toISOString(),
        duration: Date.now() - startedAt,
        testUrl: cfg.url,
        modelName: cfg.modelName,
        testMode: 'probe',
        promptMode: 'dataset',
        requestType: cfg.requestType,
        targetRPM: result.maxRPM || 0,
        maxRPM: result.maxRPM,
        totalRequests: stats.totalRequests,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        successRate: parseFloat(stats.successRate) || 0,
        avgResponseTime: stats.avgResponseTime,
        stopReason: `能力探测(${reason})：最大可持续 RPM=${result.maxRPM ?? '-'}，最大可持续 TPM=${result.maxTPM ?? '-'}`,
        minuteStats: stats.minuteStats,
        errorSummary: stats.errors,
        totalPromptTokens: stats.totalPromptTokens,
        totalCompletionTokens: stats.totalCompletionTokens,
        totalTokens: stats.totalTokens,
        cachedTokens: stats.totalCachedTokens || null,
        avgTPM: stats.avgTPM,
        inputTPM: stats.inputTPM,
        outputTPM: stats.outputTPM,
        p50ResponseTime: stats.latency.p50,
        p95ResponseTime: stats.latency.p95,
        p99ResponseTime: stats.latency.p99,
        ttfbP95: stats.ttfb.p95,
        tpotP95: stats.tpot.p95,
        promptReuseRatio: cfg.promptReuseRatio,
        actualPromptReuseRatio: stats.actualPromptReuseRatio,
        concurrency: cfg.concurrency,
        peakConcurrency: stats.peakConcurrency,
        maxTPM: result.maxTPM,
        recommendedRPM: result.recommendedRPM,
        recommendedTPM: result.recommendedTPM,
        slaMet: result.maxRPM !== null && result.maxTPM !== null ? 1 : 0,
      });
      log.info('能力探测结论已保存', { historyId });
    } catch (error) {
      log.error('保存能力探测结论失败', { error: error.message });
    }
  }

  /**
   * 保存测试历史
   */
  saveHistory(stopReason, maxRPM = null) {
    try {
      const stats = this.testState.stats;
      const cfg = this.testState.config;
      const historyData = {
        userId: this.currentOwner,
        startTime: new Date(this.testState.startTime).toISOString(),
        endTime: new Date().toISOString(),
        duration: Date.now() - this.testState.startTime,
        testUrl: cfg.url,
        modelName: cfg.modelName,
        testMode: this.testState.mode,
        promptMode: cfg.promptMode,
        requestType: cfg.requestType,
        targetRPM: this.testState.targetRPM,
        maxRPM: maxRPM ?? this.testState.maxSustainableRPM,
        totalRequests: stats.totalRequests,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        successRate: parseFloat(stats.successRate),
        avgResponseTime: stats.avgResponseTime,
        stopReason: stopReason,
        minuteStats: stats.minuteStats,
        errorSummary: stats.errors,
        // Token 维度指标
        totalPromptTokens: stats.totalPromptTokens,
        totalCompletionTokens: stats.totalCompletionTokens,
        totalTokens: stats.totalTokens,
        cachedTokens: stats.totalCachedTokens || null,
        avgTPM: stats.avgTPM,
        inputTPM: stats.inputTPM,
        outputTPM: stats.outputTPM,
        // 延迟分位数
        p50ResponseTime: stats.latency.p50,
        p95ResponseTime: stats.latency.p95,
        p99ResponseTime: stats.latency.p99,
        ttfbP95: stats.ttfb.p95,
        tpotP95: stats.tpot ? stats.tpot.p95 : 0,
        // 请求复用与并发
        promptReuseRatio: cfg.promptReuseRatio,
        actualPromptReuseRatio: stats.actualPromptReuseRatio,
        concurrency: cfg.concurrency,
        peakConcurrency: stats.peakConcurrency,
        // 评估结果
        maxTPM: this.testState.maxSustainableTPM,
        recommendedRPM: this.testState.recommendedRPM,
        recommendedTPM: this.testState.recommendedTPM,
        slaMet: stats.sla && stats.sla.met ? 1 : 0,
        // 按配置单价估算的本轮压测成本（未配置单价为 null）
        estimatedCost: this._computeEstimatedCost(),
        inputPrice: cfg.inputPrice,
        outputPrice: cfg.outputPrice,
      };

      const historyId = db.saveHistory(historyData);
      log.info(`测试历史已保存`, { historyId });
    } catch (error) {
      log.error('保存测试历史失败', { error: error.message });
    }
  }

  /**
   * 清除请求日志
   */
  clearRequestLogs() {
    this.requestLogs.clear();
    this.broadcast({
      type: 'logsCleared',
    });
  }
}

// 导出单例
module.exports = new StressTestService();
