/**
 * QualityTestService - 模型质量测试
 *
 * 目标：用一个尽可能低的成本，验证「中转/网关」暴露的模型接口在
 *   1) 协议契约（入参是否被透传、响应字段是否与官方一致）
 *   2) 特殊能力（工具调用、结构化输出、system 指令、多轮）
 *   3) 基础语义质量（确定性题目）
 * 三个层面与官方接口的差异，并产出可读的对比报告。
 *
 * 成本控制原则：
 *   - 大部分检查只发 1 个请求，输出上限 8~32 token
 *   - 能复用同一个响应的检查绝不重复请求（schema 复用 connectivity 的响应）
 *   - 错误路径检查使用无效模型/无效密钥，本身不产生 token 消耗
 *   - 默认套件整轮约 1~2k token
 *   - 例外：cache 检查需要长前缀（默认 2048 tokens）连发 3 轮，属可选高成本项
 */
const axios = require('axios');
const { httpAgent, httpsAgent } = require('../utils/httpAgent');
const log = require('../utils/logger');
const db = require('../../database');
const { AppError } = require('../middlewares/errorHandler');

const DEFAULT_TIMEOUT = 60000;
const MAX_REPORTS = 30;

/** 检查项目录：前端据此渲染可勾选列表 */
const CHECK_CATALOG = [
  { id: 'connectivity', name: '接口连通性', cost: '0.1k', desc: '基础 chat 是否可用，能否返回文本' },
  { id: 'schema', name: '响应结构契约', cost: '0', desc: '复用连通性响应，核对字段齐全性与类型（不额外发请求）' },
  { id: 'stream', name: '流式协议', cost: '0.2k', desc: 'SSE 格式、增量字段、结束标志、末帧 usage' },
  { id: 'streaming', name: '流式真实性', cost: '0', desc: '复用流式响应，判断是否被网关缓冲成"假流式"（不额外发请求）' },
  { id: 'max_tokens', name: 'max_tokens 透传', cost: '0.1k', desc: '验证输出上限是否真的被遵守' },
  { id: 'stop', name: 'stop 参数', cost: '0.2k', desc: '验证停止序列是否生效' },
  { id: 'tools', name: '工具调用', cost: '0.4k', desc: 'function calling / tool_use 结构与参数合法性' },
  { id: 'json', name: '结构化输出', cost: '0.4k', desc: 'json_schema / 强制工具输出，校验字段是否符合 schema' },
  { id: 'system', name: 'system 指令与多轮', cost: '0.2k', desc: 'system 角色是否生效、多轮上下文是否保持' },
  { id: 'quality', name: '语义质量', cost: '0.3k', desc: '3 道确定性题目：算术、指令遵循、JSON 抽取' },
  { id: 'tokens', name: 'Token 计数一致性', cost: '0.2k', desc: 'usage 的 input/output/total 是否自洽、与本地估算偏差多少' },
  { id: 'cache', name: '缓存命中与命中率', cost: '4k+', desc: '长前缀（≥2048 tokens，短请求通常不写缓存）连发 3 次：比对命中字段、耗时下降与计费是否打折', optional: true },
  { id: 'errors', name: '错误响应规范', cost: '0', desc: '无效模型/无效密钥的错误结构（不产生 token）' },
  { id: 'vision', name: '多模态图片输入', cost: '0.5k', desc: '图片理解能力（可选，支持默认地址或本地文件）', optional: true },
  { id: 'video', name: '多模态视频输入', cost: '1k+', desc: 'video_url 内容块是否被接受、能否描述视频内容、fps 抽帧参数是否生效（可选，需视频素材）', optional: true },
  { id: 'web_search', name: '联网搜索能力', cost: '10k+', desc: '按 tools 配置下发 web_search，验证是否真的联网（可选，成本高）', optional: true },
];

const DEFAULT_CHECKS = CHECK_CATALOG.filter((c) => !c.optional).map((c) => c.id);

// ---------------------------------------------------------------- 工具函数

/** 去掉末尾斜杠；用户可能填了完整 endpoint，也可能只填 base */
function resolveEndpoint(rawUrl, protocol) {
  let base = String(rawUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new AppError('base_url 不能为空', 400);

  const suffix = protocol === 'anthropic'
    ? '/messages'
    : protocol === 'responses'
      ? '/responses'
      : '/chat/completions';

  // 用户直接填了完整端点
  if (/\/(chat\/completions|messages|responses)$/i.test(base)) return base;
  // 已经带 /v1
  if (/\/v1$/i.test(base)) return base + suffix;
  return base + '/v1' + suffix;
}

/** 多模态素材：URL 或 base64 内联；内联体积上限（字节数，落库前拦截） */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_VIDEO_BYTES = 20 * 1024 * 1024;

function normalizeMediaInput(media, kind) {
  if (!media || typeof media !== 'object') return null;
  const url = typeof media.url === 'string' ? media.url.trim() : '';
  const dataUri = typeof media.dataUri === 'string' ? media.dataUri.trim() : '';
  const limit = kind === 'image' ? MAX_INLINE_IMAGE_BYTES : MAX_INLINE_VIDEO_BYTES;

  if (dataUri.startsWith('data:')) {
    // base64 膨胀约 1.33 倍，反推原始大小
    const base64Len = dataUri.length - dataUri.indexOf(',') - 1;
    const bytes = Math.floor((base64Len * 3) / 4);
    if (bytes > limit) {
      throw new AppError(`${kind === 'image' ? '图片' : '视频'}超过 ${Math.round(limit / 1024 / 1024)}MB 上限，请改用 URL`, 400);
    }
    return {
      source: 'inline',
      dataUri,
      name: media.name || null,
      bytes,
      fps: kind === 'video' && Number(media.fps) > 0 ? Number(media.fps) : null,
    };
  }
  if (url) {
    return {
      source: 'url',
      url,
      name: media.name || null,
      fps: kind === 'video' && Number(media.fps) > 0 ? Number(media.fps) : null,
    };
  }
  return null;
}

function buildHeaders(conf) {
  const headers = { 'Content-Type': 'application/json' };
  if (conf.protocol === 'anthropic') {
    headers['x-api-key'] = conf.apiKey;
    headers['anthropic-version'] = conf.anthropicVersion || '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${conf.apiKey}`;
  }
  return headers;
}

/** 构造与协议匹配的请求体 */
function buildBody(conf, payload) {
  const body = { model: conf.modelName, ...payload };

  // 思考强度：用户选了就原样下发，不做厂商适配（模型不认这个字段会直接报错并回显）
  if (conf.reasoningEffort && conf.protocol !== 'anthropic') {
    if (conf.protocol === 'responses') {
      if (!body.reasoning) body.reasoning = { effort: conf.reasoningEffort };
    } else if (body.reasoning_effort === undefined) {
      body.reasoning_effort = conf.reasoningEffort;
    }
  }

  if (conf.protocol === 'anthropic') {
    // Anthropic：system 是顶层字段；max_tokens 必填；不支持 stream_options / response_format
    if (body.max_tokens === undefined) body.max_tokens = 32;
    delete body.max_completion_tokens;
    delete body.stream_options;
    delete body.response_format;
    return body;
  }

  if (conf.protocol === 'responses') {
    // Responses API：messages → input，system → instructions，max_tokens → max_output_tokens
    if (Array.isArray(body.messages)) {
      const systems = body.messages.filter((m) => m.role === 'system');
      const rest = body.messages.filter((m) => m.role !== 'system');
      if (systems.length) {
        body.instructions = systems.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      }
      body.input = rest.map((m) => ({ role: m.role, content: m.content }));
      delete body.messages;
    }

    if (body.max_tokens !== undefined) {
      body.max_output_tokens = body.max_tokens;
      delete body.max_tokens;
    }
    if (body.max_completion_tokens !== undefined) {
      body.max_output_tokens = body.max_completion_tokens;
      delete body.max_completion_tokens;
    }

    // 工具定义：Responses 用扁平结构，不再包一层 function
    if (Array.isArray(body.tools)) {
      body.tools = body.tools.map((t) => {
        if (t && t.type === 'function' && t.function) {
          return {
            type: 'function',
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          };
        }
        return t;
      });
    }

    // 结构化输出：response_format → text.format
    if (body.response_format) {
      const rf = body.response_format;
      if (rf.type === 'json_schema' && rf.json_schema) {
        body.text = {
          format: {
            type: 'json_schema',
            name: rf.json_schema.name,
            schema: rf.json_schema.schema,
            strict: rf.json_schema.strict,
          },
        };
      } else {
        body.text = { format: { type: 'text' } };
      }
      delete body.response_format;
    }

    delete body.stream_options;
    delete body.top_k;
    delete body.stop_sequences;
    delete body.stop; // Responses 不支持 stop 序列
    return body;
  }

  // OpenAI Chat Completions：system 走 messages；不支持 top_k / stop_sequences
  delete body.system;
  delete body.top_k;
  delete body.stop_sequences;
  return body;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/** 从 OpenAI 非流式响应中提取文本 */
function extractOpenAIText(body) {
  const choice = body && body.choices && body.choices[0];
  if (!choice) return '';
  const msg = choice.message || {};
  if (typeof msg.content === 'string') return msg.content;
  // 部分网关把 content 返回成数组
  if (Array.isArray(msg.content)) {
    return msg.content.map((p) => (typeof p === 'string' ? p : p && p.text) || '').join('');
  }
  return '';
}

/** 从 Anthropic 非流式响应中提取文本 */
function extractAnthropicText(body) {
  const blocks = (body && body.content) || [];
  return blocks
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('');
}

/** 从 Responses API 响应中提取文本（output[].content[].type=output_text） */
function extractResponsesText(body) {
  if (!body) return '';
  if (typeof body.output_text === 'string') return body.output_text;
  let text = '';
  (Array.isArray(body.output) ? body.output : []).forEach((item) => {
    (Array.isArray(item && item.content) ? item.content : []).forEach((c) => {
      if (c && c.type === 'output_text' && c.text) text += c.text;
    });
  });
  return text;
}

function extractText(body, protocol) {
  if (protocol === 'anthropic') return extractAnthropicText(body);
  if (protocol === 'responses') return extractResponsesText(body);
  return extractOpenAIText(body);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 统一解析各家 usage：输入 / 输出 / 缓存 / 思考
 * 兼容 OpenAI(prompt_tokens)、Responses(input_tokens)、Anthropic(input_tokens + cache_read)、
 * DeepSeek(prompt_cache_hit_tokens)，以及部分网关同时返回 completion_tokens_details 与 output_tokens_details
 */
function usageDetailOf(body, protocol) {
  const u = (body && body.usage) || {};
  const promptDetails = u.prompt_tokens_details || {};
  const inputDetails = u.input_tokens_details || {};
  const completionDetails = u.completion_tokens_details || {};
  const outputDetails = u.output_tokens_details || {};

  if (protocol === 'anthropic') {
    const input = num(u.input_tokens) || 0;
    const output = num(u.output_tokens) || 0;
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: num(u.total_tokens) || input + output,
      cachedTokens: num(u.cache_read_input_tokens) || 0,
      cacheWriteTokens: num(u.cache_creation_input_tokens) || 0,
      reasoningTokens: 0,
      cacheField: 'cache_read_input_tokens',
    };
  }

  if (protocol === 'responses') {
    const input = num(u.input_tokens) || 0;
    const output = num(u.output_tokens) || 0;
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: num(u.total_tokens) || input + output,
      cachedTokens: num(inputDetails.cached_tokens) || 0,
      cacheWriteTokens: 0,
      reasoningTokens: num(outputDetails.reasoning_tokens) || 0,
      cacheField: 'input_tokens_details.cached_tokens',
    };
  }

  const input = num(u.prompt_tokens) || 0;
  const output = num(u.completion_tokens) || 0;
  const cached = num(promptDetails.cached_tokens);
  const deepseekHit = num(u.prompt_cache_hit_tokens);
  const reasoning = num(completionDetails.reasoning_tokens);

  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: num(u.total_tokens) || input + output,
    cachedTokens: cached !== null ? cached : deepseekHit || 0,
    cacheWriteTokens: 0,
    reasoningTokens: reasoning !== null ? reasoning : num(outputDetails.reasoning_tokens) || 0,
    cacheField: cached !== null
      ? 'prompt_tokens_details.cached_tokens'
      : deepseekHit !== null
        ? 'prompt_cache_hit_tokens'
        : null,
  };
}

/** 类型名，用于字段类型对比 */
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * 累计整轮测试的 token 用量（挂在 conf 上，按被测/对照分别统计）
 * 只统计真正返回 usage 的响应；流式用量由 checkStream 在解析末帧后补记
 */
function accumulateUsage(conf, body) {
  if (!body || !body.usage) return;
  const u = usageDetailOf(body, conf.protocol);
  if (!u.inputTokens && !u.outputTokens) return;

  if (!conf.__usage) {
    conf.__usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      cacheWriteTokens: 0,
      requests: 0,
      cacheField: null,
    };
  }

  const acc = conf.__usage;
  acc.inputTokens += u.inputTokens || 0;
  acc.outputTokens += u.outputTokens || 0;
  acc.totalTokens += u.totalTokens || 0;
  acc.cachedTokens += u.cachedTokens || 0;
  acc.reasoningTokens += u.reasoningTokens || 0;
  acc.cacheWriteTokens += u.cacheWriteTokens || 0;
  acc.requests += 1;
  if (!acc.cacheField && u.cacheField) acc.cacheField = u.cacheField;
}

/** 把 conf.__usage 转成报告里的 usage 结构 */
function usageSummaryOf(conf) {
  const acc = conf && conf.__usage;
  if (!acc || !acc.requests) return null;
  return {
    promptTokens: acc.inputTokens,
    completionTokens: acc.outputTokens,
    totalTokens: acc.totalTokens,
    cachedTokens: acc.cachedTokens,
    cacheWriteTokens: acc.cacheWriteTokens,
    reasoningTokens: acc.reasoningTokens,
    cacheHitRate: acc.inputTokens > 0
      ? Math.round((acc.cachedTokens / acc.inputTokens) * 1000) / 10
      : 0,
    cacheField: acc.cacheField || null,
    requests: acc.requests,
  };
}

// ---------------------------------------------------------------- 输出预算

/**
 * 每个检查项的「正文输出需求」，不是全局常量
 * 依据判据：只判定有无合规输出 → 128；需要多行才能看截断 → 320；摘要型 → 512
 */
const OUTPUT_NEED = {
  connectivity: 128,
  stop: 320,
  tools: 160,
  json: 160,
  system: 192,
  quality: 192,
  tokens: 160,
  vision: 160,
  video: 160,
  web_search: 512,
};

const OUTPUT_CAP_DEFAULT = 4096; // 单次请求 max_tokens 硬上限
const OUTPUT_ROUND_CAP = 8192; // 单检查项累计输出 tokens 上限（成本护栏）
const OUTPUT_MAX_RETRY = 2; // 截断后最多加档 2 次

function finishReasonOf(r, protocol) {
  if (!r || !r.body) return null;
  if (protocol === 'anthropic') return r.body.stop_reason || null;
  if (protocol === 'responses') {
    if (r.body.status === 'incomplete') {
      return (r.body.incomplete_details && r.body.incomplete_details.reason) || 'incomplete';
    }
    return r.body.status || null;
  }
  return ((r.body.choices || [])[0] || {}).finish_reason || null;
}

/** 是否因输出上限被截断（推理模型常见：预算全被思考吃掉，正文为空） */
function looksTruncated(r, usage, protocol) {
  const reason = finishReasonOf(r, protocol);
  const textLen = (r.text || '').length;
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens') {
    return textLen < 8;
  }
  if (reason === 'incomplete') return textLen === 0;
  return false;
}

/**
 * 带输出预算的请求
 *   - 按已观测的思考占比预置 max_tokens（首轮 128，后续按比例放大）
 *   - 被截断且正文没拿到时自动加档（×4，最多 2 次，硬上限 4096）
 *   - 记录每个检查项的累计输出 tokens，超过护栏直接熔断
 * @returns 与 sendRequest 相同的结构，额外带 budget { attempts, tokens, exhausted }
 */
async function sendWithBudget(conf, payload, opts = {}) {
  const need = Number(opts.need) || 128;
  const cap = Number(conf.maxOutputTokens) > 0 ? Number(conf.maxOutputTokens) : OUTPUT_CAP_DEFAULT;
  if (!conf.__budget) conf.__budget = { reasoningRatio: 0, spent: 0 };
  const budget = conf.__budget;

  if (budget.spent >= OUTPUT_ROUND_CAP) {
    return {
      status: 0,
      headers: {},
      contentType: '',
      url: '',
      body: null,
      rawText: '',
      text: '',
      chunks: [],
      ttfb: null,
      total: 0,
      error: `本轮累计输出已达 ${OUTPUT_ROUND_CAP} tokens 护栏，跳过`,
      budget: { attempts: [], tokens: 0, exhausted: true },
    };
  }

  // 思考最多占 85%，避免除零/爆炸
  const ratio = Math.min(0.85, Math.max(0, budget.reasoningRatio || 0));
  let tokens = Math.min(cap, Math.max(need, Math.ceil(need / (1 - ratio))));

  const attempts = [];
  let r = null;

  for (let i = 0; i <= OUTPUT_MAX_RETRY; i += 1) {
    r = await sendRequest(conf, { ...payload, max_tokens: tokens }, { timeout: opts.timeout });
    const usage = usageDetailOf(r.body, conf.protocol);
    budget.spent += usage.outputTokens || 0;

    attempts.push({
      maxTokens: tokens,
      httpStatus: r.status,
      finishReason: finishReasonOf(r, conf.protocol),
      completionTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      textLength: (r.text || '').length,
    });

    // 只用「正常结束」的样本学习思考占比：被截断的样本 reasoning 恒等于上限，会污染后续预算
    const truncated = looksTruncated(r, usage, conf.protocol);
    if (!truncated && usage.outputTokens > 0 && usage.reasoningTokens > 0) {
      budget.reasoningRatio = Math.max(budget.reasoningRatio, usage.reasoningTokens / usage.outputTokens);
    }

    if (r.error || r.status >= 400) break;
    if (!truncated) break;
    if (tokens >= cap) break;
    if (budget.spent >= OUTPUT_ROUND_CAP) break;
    tokens = Math.min(cap, tokens * 4);
  }

  r.budget = { attempts, tokens, exhausted: budget.spent >= OUTPUT_ROUND_CAP };
  return r;
}

// ---------------------------------------------------------------- 请求层

/**
 * 发送一次请求
 * @returns {Promise<{status, headers, contentType, body, text, rawText, chunks, ttfb, total, error}>}
 */
async function sendRequest(conf, payload, options = {}) {
  const url = resolveEndpoint(conf.url, conf.protocol);
  const body = buildBody(conf, payload);
  const startedAt = Date.now();

  try {
    const response = await axios.post(url, body, {
      headers: buildHeaders(conf),
      timeout: options.timeout || DEFAULT_TIMEOUT,
      responseType: options.stream ? 'stream' : 'json',
      validateStatus: () => true,
      httpAgent,
      httpsAgent,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      decompress: true,
    });

    const contentType = String(response.headers['content-type'] || '');
    const base = {
      status: response.status,
      headers: response.headers,
      contentType,
      url,
    };

    if (options.stream) {
      const streamResult = await readStream(response, startedAt);
      return {
        ...base,
        ...streamResult,
        body: null,
        text: '',
        rawText: '',
      };
    }

    const bodyJson = response.data && typeof response.data === 'object' ? response.data : safeJson(String(response.data || ''));
    const rawText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || '');
    accumulateUsage(conf, bodyJson);
    return {
      ...base,
      body: bodyJson,
      rawText: String(rawText).slice(0, 4000),
      text: extractText(bodyJson, conf.protocol),
      chunks: [],
      ttfb: Date.now() - startedAt,
      total: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      status: 0,
      headers: {},
      contentType: '',
      url,
      body: null,
      rawText: '',
      text: '',
      chunks: [],
      ttfb: null,
      total: Date.now() - startedAt,
      error: error.code === 'ECONNABORTED' ? '请求超时' : error.message,
    };
  }
}

/** 读取 SSE 流，记录每块到达时间 */
function readStream(response, startedAt) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let buffer = '';
    let firstAt = null;

    const stream = response.data;

    const timer = setTimeout(() => {
      try {
        stream.destroy();
      } catch (e) {
        // ignore
      }
      resolve({ chunks, ttfb: firstAt, total: Date.now() - startedAt, truncated: true });
    }, DEFAULT_TIMEOUT);

    stream.on('data', (buf) => {
      const at = Date.now() - startedAt;
      if (firstAt === null) firstAt = at;
      buffer += buf.toString('utf8');

      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line.trim()) chunks.push({ at, line });
      }
    });

    stream.on('end', () => {
      clearTimeout(timer);
      if (buffer.trim()) chunks.push({ at: Date.now() - startedAt, line: buffer });
      resolve({ chunks, ttfb: firstAt, total: Date.now() - startedAt, truncated: false });
    });

    stream.on('error', (error) => {
      clearTimeout(timer);
      resolve({ chunks, ttfb: firstAt, total: Date.now() - startedAt, error: error.message });
    });
  });
}

/** 把 SSE 行解析成事件 */
function parseSSE(chunks) {
  const events = [];
  for (const c of chunks) {
    if (!c.line.startsWith('data:')) continue;
    const payload = c.line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') {
      events.push({ at: c.at, done: true });
      continue;
    }
    const data = safeJson(payload);
    if (data) events.push({ at: c.at, data });
  }
  return events;
}

// ---------------------------------------------------------------- 检查项

/** 1. 连通性 */
async function checkConnectivity(conf) {
  const payload = {
    messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
    temperature: 0,
  };

  // 首轮同时用于观测「思考占比」，后续检查项据此预置预算
  const r = await sendWithBudget(conf, payload, { need: OUTPUT_NEED.connectivity });
  const issues = [];

  if (r.error) issues.push({ level: 'fail', message: `请求失败：${r.error}` });
  else if (r.status >= 400) {
    const errMsg = r.body && r.body.error ? JSON.stringify(r.body.error).slice(0, 200) : r.rawText.slice(0, 200);
    issues.push({ level: 'fail', message: `HTTP ${r.status}：${errMsg}` });
  } else if (!r.text) {
    const reasoning = usageDetailOf(r.body, conf.protocol).reasoningTokens;
    issues.push({
      level: 'warn',
      message: reasoning > 0
        ? `HTTP 200 但没有正文，思考已用 ${reasoning} tokens（本轮预算 ${r.budget ? r.budget.tokens : '?'}），可调高输出预算`
        : 'HTTP 200 但未提取到文本内容（可能是非标准返回结构）',
    });
  }

  return {
    status: issues.some((i) => i.level === 'fail') ? 'fail' : issues.length ? 'warn' : 'pass',
    issues,
    evidence: {
      httpStatus: r.status,
      contentType: r.contentType.split(';')[0],
      hasText: !!r.text,
      textLength: r.text.length,
      latencyMs: r.total,
      model: (r.body && r.body.model) || null,
      budget: r.budget || null,
    },
    _raw: r,
  };
}

/** 2. 响应结构契约（复用连通性响应） */
function checkSchema(conf, raw) {
  const issues = [];
  const body = raw && raw.body;
  const evidence = {};

  if (!body) {
    return {
      status: 'fail',
      issues: [{ level: 'fail', message: '无有效 JSON 响应，无法核对结构' }],
      evidence,
    };
  }

  if (conf.protocol === 'anthropic') {
    evidence.topLevelFields = Object.keys(body).sort();
    evidence.hasId = !!body.id;
    evidence.hasType = body.type === 'message';
    evidence.typeValue = body.type || null;
    evidence.hasRole = body.role === 'assistant';
    evidence.contentIsArray = Array.isArray(body.content);
    evidence.hasStopReason = !!body.stop_reason;
    evidence.stopReason = body.stop_reason || null;
    evidence.usageFields = body.usage ? Object.keys(body.usage).sort() : [];
    evidence.inputTokens = body.usage ? body.usage.input_tokens : null;
    evidence.outputTokens = body.usage ? body.usage.output_tokens : null;

    if (!body.id) issues.push({ level: 'warn', message: '缺少 id 字段' });
    if (body.type !== 'message') issues.push({ level: 'warn', message: `type 应为 message，实际为 ${body.type}` });
    if (!Array.isArray(body.content)) issues.push({ level: 'fail', message: 'content 应为数组' });
    if (!body.usage) issues.push({ level: 'warn', message: '缺少 usage 字段' });
    else {
      if (typeof body.usage.input_tokens !== 'number') issues.push({ level: 'warn', message: 'usage.input_tokens 缺失或类型错误' });
      if (typeof body.usage.output_tokens !== 'number') issues.push({ level: 'warn', message: 'usage.output_tokens 缺失或类型错误' });
      if (body.usage.input_tokens === 0) issues.push({ level: 'warn', message: 'usage.input_tokens 为 0，可能与实际不符' });
    }
  } else if (conf.protocol === 'responses') {
    const usage = body.usage || null;
    const output = Array.isArray(body.output) ? body.output : [];

    evidence.topLevelFields = Object.keys(body).sort();
    evidence.hasId = !!body.id;
    evidence.objectValue = body.object || null;
    evidence.status = body.status || null;
    evidence.hasModel = !!body.model;
    evidence.outputIsArray = Array.isArray(body.output);
    evidence.outputItemTypes = output.map((i) => i && i.type).filter(Boolean);
    evidence.hasUsage = !!usage;
    evidence.usageFields = usage ? Object.keys(usage).sort() : [];
    evidence.inputTokens = usage ? usage.input_tokens : null;
    evidence.outputTokens = usage ? usage.output_tokens : null;
    evidence.totalTokens = usage ? usage.total_tokens : null;
    evidence.inputTokensDetailsType = usage ? typeOf(usage.input_tokens_details) : 'missing';
    evidence.outputTokensDetailsType = usage ? typeOf(usage.output_tokens_details) : 'missing';

    if (!body.id) issues.push({ level: 'warn', message: '缺少 id 字段' });
    if (body.object !== 'response') {
      issues.push({ level: 'warn', message: `object 应为 response，实际为 ${body.object || '缺失'}` });
    }
    if (body.status !== 'completed') {
      issues.push({ level: 'warn', message: `status 应为 completed，实际为 ${body.status || '缺失'}` });
    }
    if (!Array.isArray(body.output) || output.length === 0) {
      issues.push({ level: 'fail', message: 'output 缺失或为空' });
    }
    if (!usage) {
      issues.push({ level: 'warn', message: '缺少 usage 字段' });
    } else {
      if (typeof usage.input_tokens !== 'number') issues.push({ level: 'warn', message: 'usage.input_tokens 缺失或类型错误' });
      if (typeof usage.output_tokens !== 'number') issues.push({ level: 'warn', message: 'usage.output_tokens 缺失或类型错误' });
      if (usage.input_tokens === 0) issues.push({ level: 'warn', message: 'usage.input_tokens 为 0，可能与实际不符' });
      if (typeOf(usage.input_tokens_details) === 'null') {
        issues.push({ level: 'warn', message: 'usage.input_tokens_details 为 null（官方通常为对象）' });
      }
    }
  } else {
    const choice = (body.choices || [])[0] || {};
    const usage = body.usage || null;

    evidence.topLevelFields = Object.keys(body).sort();
    evidence.hasId = !!body.id;
    evidence.objectValue = body.object || null;
    evidence.hasCreated = typeof body.created === 'number';
    evidence.hasModel = !!body.model;
    evidence.choicesLength = Array.isArray(body.choices) ? body.choices.length : 0;
    evidence.messageRole = (choice.message && choice.message.role) || null;
    evidence.finishReason = choice.finish_reason || null;
    evidence.hasUsage = !!usage;
    evidence.usageFields = usage ? Object.keys(usage).sort() : [];
    evidence.promptTokens = usage ? usage.prompt_tokens : null;
    evidence.completionTokens = usage ? usage.completion_tokens : null;
    evidence.totalTokens = usage ? usage.total_tokens : null;
    evidence.promptTokensDetailsType = usage ? typeOf(usage.prompt_tokens_details) : 'missing';
    evidence.completionTokensDetailsType = usage ? typeOf(usage.completion_tokens_details) : 'missing';

    if (!body.id) issues.push({ level: 'warn', message: '缺少 id 字段' });
    if (body.object !== 'chat.completion') {
      issues.push({ level: 'warn', message: `object 应为 chat.completion，实际为 ${body.object || '缺失'}` });
    }
    if (!Array.isArray(body.choices) || body.choices.length === 0) {
      issues.push({ level: 'fail', message: 'choices 缺失或为空' });
    }
    if (!choice.finish_reason) issues.push({ level: 'warn', message: '缺少 finish_reason' });
    if (!usage) {
      issues.push({ level: 'warn', message: '缺少 usage 字段' });
    } else {
      if (typeof usage.prompt_tokens !== 'number') issues.push({ level: 'warn', message: 'usage.prompt_tokens 缺失或类型错误' });
      if (typeof usage.completion_tokens !== 'number') issues.push({ level: 'warn', message: 'usage.completion_tokens 缺失或类型错误' });
      if (usage.prompt_tokens === 0) issues.push({ level: 'warn', message: 'usage.prompt_tokens 为 0，可能与实际不符（真模型必有输入 token）' });
      if (usage.total_tokens !== (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)) {
        issues.push({ level: 'warn', message: 'total_tokens 不等于 prompt + completion' });
      }
      // 官方 OpenAI 该字段是对象；部分中转返回 null
      if (typeOf(usage.prompt_tokens_details) === 'null') {
        issues.push({ level: 'warn', message: 'usage.prompt_tokens_details 为 null（官方通常为对象，可能是网关未透传）' });
      }
    }
  }

  return {
    status: issues.some((i) => i.level === 'fail') ? 'fail' : issues.length ? 'warn' : 'pass',
    issues,
    evidence,
  };
}

/** 3. 流式协议 + 4. 流式真实性（同一个请求） */
async function checkStream(conf) {
  const payload = {
    messages: [{ role: 'user', content: 'Count from 1 to 10, separated by spaces.' }],
    max_tokens: 24,
    temperature: 0,
    stream: true,
  };

  if (conf.protocol === 'openai') {
    payload.stream_options = { include_usage: true };
  }

  const r = await sendRequest(conf, payload, { stream: true });
  const issues = [];
  const events = parseSSE(r.chunks);

  const isSSE = /text\/event-stream/i.test(r.contentType) || events.length > 0;

  let text = '';
  let finishReason = null;
  let hasDone = false;
  let usageInStream = null;
  let contentDeltas = 0;

  for (const ev of events) {
    if (ev.done) {
      hasDone = true;
      continue;
    }
    const d = ev.data;
    if (!d) continue;

    if (conf.protocol === 'anthropic') {
      if (d.type === 'content_block_delta' && d.delta && typeof d.delta.text === 'string') {
        text += d.delta.text;
        contentDeltas++;
      }
      if (d.type === 'message_delta' && d.usage) usageInStream = d.usage;
      if (d.type === 'message_stop') hasDone = true;
      if (d.delta && d.delta.stop_reason) finishReason = d.delta.stop_reason;
    } else if (conf.protocol === 'responses') {
      if (d.type === 'response.output_text.delta' && typeof d.delta === 'string') {
        text += d.delta;
        contentDeltas++;
      }
      if (d.type === 'response.completed') {
        hasDone = true;
        if (d.response && d.response.usage) usageInStream = d.response.usage;
        if (d.response && d.response.status) finishReason = d.response.status;
      }
    } else {
      if (d.usage) usageInStream = d.usage;
      const choice = (d.choices || [])[0];
      if (choice) {
        if (choice.delta && typeof choice.delta.content === 'string') {
          text += choice.delta.content;
          contentDeltas++;
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  }

  if (usageInStream) accumulateUsage(conf, { usage: usageInStream });

  const times = [...new Set(r.chunks.map((c) => c.at))].sort((a, b) => a - b);
  const span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  // 判定"假流式"：内容和结束标志都到了，但所有数据块在同一瞬间到达
  const fake = r.chunks.length > 2 && span < 30;

  const streamEvidence = {
    httpStatus: r.status,
    contentType: r.contentType.split(';')[0],
    isSSE,
    chunkLines: r.chunks.length,
    parsedEvents: events.length,
    contentDeltas,
    textLength: text.length,
    hasDoneMarker: hasDone,
    finishReason,
    usageInFinalChunk: usageInStream
      ? conf.protocol === 'openai'
        ? { prompt_tokens: usageInStream.prompt_tokens, completion_tokens: usageInStream.completion_tokens }
        : { input_tokens: usageInStream.input_tokens, output_tokens: usageInStream.output_tokens }
      : null,
  };

  if (r.error) issues.push({ level: 'fail', message: `流式请求失败：${r.error}` });
  else if (!isSSE) issues.push({ level: 'fail', message: `返回不是 SSE（Content-Type: ${streamEvidence.contentType}），流式未生效` });
  else {
    if (contentDeltas === 0) issues.push({ level: 'fail', message: 'SSE 中没有任何增量内容（delta），无法增量输出' });
    if (!hasDone) issues.push({ level: 'warn', message: '未收到结束标志（[DONE] / message_stop）' });
    if (!usageInStream) issues.push({ level: 'warn', message: '末帧未携带 usage（流式用量统计缺失）' });
  }

  const streamStatus = issues.some((i) => i.level === 'fail') ? 'fail' : issues.length ? 'warn' : 'pass';

  // 流式真实性
  const timingIssues = [];
  if (fake) {
    timingIssues.push({
      level: 'warn',
      message: `所有 ${r.chunks.length} 个数据块在 ${span}ms 内一次性到达，疑似网关缓冲后转发（假流式）`,
    });
  }
  if (r.ttfb !== null && r.ttfb > 5000) {
    timingIssues.push({ level: 'warn', message: `首字节耗时 ${r.ttfb}ms，超过 5s` });
  }

  const timingEvidence = {
    ttfbMs: r.ttfb,
    totalMs: r.total,
    chunkSpanMs: span,
    distinctArrivalGroups: times.length,
    bufferedByGateway: fake,
  };

  return {
    stream: {
      status: streamStatus,
      issues,
      evidence: streamEvidence,
    },
    timing: {
      status: timingIssues.some((i) => i.level === 'fail') ? 'fail' : timingIssues.length ? 'warn' : 'pass',
      issues: timingIssues,
      evidence: timingEvidence,
    },
  };
}

/** 5. max_tokens 透传 */
async function checkMaxTokens(conf) {
  // 固定小预算，不参与自动加档：这一项的被测目标就是「上限是否被遵守」
  const LIMIT = 16;
  const r = await sendRequest(conf, {
    messages: [{ role: 'user', content: 'Write a long paragraph about the ocean.' }],
    max_tokens: LIMIT,
    temperature: 0,
  });

  const issues = [];
  const usage = usageDetailOf(r.body, conf.protocol);
  const completionTokens = usage.outputTokens || null;
  const reasoningTokens = usage.reasoningTokens || 0;
  const textLen = r.text.length;

  if (r.error || r.status >= 400) {
    issues.push({ level: 'fail', message: `请求失败：${r.error || 'HTTP ' + r.status}` });
  } else {
    if (typeof completionTokens === 'number' && completionTokens > LIMIT + 2) {
      issues.push({ level: 'warn', message: `max_tokens=${LIMIT} 但 completion_tokens=${completionTokens}，上限未被严格遵守` });
    } else if (textLen === 0 && reasoningTokens > 0) {
      // 推理模型会把预算全用在思考上，此时无法从正文侧判断上限，不能直接判缺陷
      issues.push({
        level: 'warn',
        message: `预算被思考占满（reasoning_tokens=${reasoningTokens}/${LIMIT}），正文为空，无法从正文侧验证长度限制`,
      });
    }
    if (textLen > LIMIT * 8) {
      issues.push({ level: 'warn', message: `max_tokens=${LIMIT} 却返回了 ${textLen} 个字符，输出长度未受限` });
    }
  }

  return {
    status: issues.some((i) => i.level === 'fail') ? 'fail' : issues.length ? 'warn' : 'pass',
    issues,
    evidence: {
      httpStatus: r.status,
      limit: LIMIT,
      completionTokens,
      reasoningTokens,
      textLength: textLen,
      finishReason: r.body
        ? (conf.protocol === 'openai'
            ? ((r.body.choices || [])[0] || {}).finish_reason
            : (r.body.stop_reason || r.body.status || null))
        : null,
    },
  };
}

/** 6. stop 参数 */
async function checkStop(conf) {
  // Responses API 没有 stop 序列参数
  if (conf.protocol === 'responses') {
    return {
      status: 'skip',
      issues: [{ level: 'warn', message: 'Responses API 不支持 stop 序列参数，本项跳过' }],
      evidence: { skipped: true, reason: 'unsupported_parameter' },
    };
  }

  const payload =
    conf.protocol === 'anthropic'
      ? {
          messages: [{ role: 'user', content: 'Repeat exactly this string: ABCDEFGHIJ' }],
          temperature: 0,
          stop_sequences: ['DEF'],
        }
      : {
          messages: [{ role: 'user', content: 'Repeat exactly this string: ABCDEFGHIJ' }],
          temperature: 0,
          stop: ['DEF'],
        };

  const r = await sendWithBudget(conf, payload, { need: OUTPUT_NEED.stop });
  const issues = [];
  const text = r.text || '';
  const containsStop = text.includes('DEF');

  if (r.error || r.status >= 400) {
    issues.push({ level: 'fail', message: `请求失败：${r.error || 'HTTP ' + r.status}` });
  } else if (containsStop) {
    issues.push({ level: 'warn', message: `stop 序列 "DEF" 仍然出现在输出中："${text.slice(0, 60)}"，停止参数可能未生效` });
  }

  return {
    status: issues.some((i) => i.level === 'fail') ? 'fail' : issues.length ? 'warn' : 'pass',
    issues,
    evidence: {
      httpStatus: r.status,
      output: text.slice(0, 80),
      stopTokenLeaked: containsStop,
      finishReason: r.body ? (conf.protocol === 'anthropic' ? r.body.stop_reason : ((r.body.choices || [])[0] || {}).finish_reason) : null,
    },
  };
}

/** 7. 工具调用 */
async function checkTools(conf) {
  const toolName = 'get_weather';
  const prompt = 'What is the weather in Beijing right now? Use the provided tool to answer.';

  const payload =
    conf.protocol === 'anthropic'
      ? {
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          tools: [
            {
              name: toolName,
              description: 'Get current weather for a city',
              input_schema: {
                type: 'object',
                properties: { city: { type: 'string', description: 'City name' } },
                required: ['city'],
              },
            },
          ],
        }
      : {
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          tools: [
            {
              type: 'function',
              function: {
                name: toolName,
                description: 'Get current weather for a city',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string', description: 'City name' } },
                  required: ['city'],
                },
              },
            },
          ],
        };

  const r = await sendWithBudget(conf, payload, { need: OUTPUT_NEED.tools });
  const issues = [];

  let hasToolCall = false;
  let resolvedName = null;
  let argsRaw = null;
  let finishReason = null;

  if (r.body) {
    if (conf.protocol === 'anthropic') {
      const blocks = r.body.content || [];
      const toolUse = blocks.find((b) => b && b.type === 'tool_use');
      if (toolUse) {
        hasToolCall = true;
        resolvedName = toolUse.name;
        argsRaw = toolUse.input;
        finishReason = r.body.stop_reason || null;
      }
    } else if (conf.protocol === 'responses') {
      const items = Array.isArray(r.body.output) ? r.body.output : [];
      const fnCall = items.find((i) => i && i.type === 'function_call');
      if (fnCall) {
        hasToolCall = true;
        resolvedName = fnCall.name;
        argsRaw = fnCall.arguments;
        finishReason = r.body.status || null;
      }
    } else {
      const choice = (r.body.choices || [])[0] || {};
      const msg = choice.message || {};
      const calls = msg.tool_calls || [];
      if (calls.length > 0) {
        hasToolCall = true;
        const fn = calls[0].function || {};
        resolvedName = fn.name;
        argsRaw = fn.arguments;
        finishReason = choice.finish_reason || null;
      }
    }
  }

  let argsIsObject = false;
  let argsValue = null;
  if (argsRaw !== null && argsRaw !== undefined) {
    if (typeof argsRaw === 'string') {
      const parsed = safeJson(argsRaw);
      if (parsed) {
        argsIsObject = true;
        argsValue = parsed;
      }
    } else if (typeof argsRaw === 'object') {
      argsIsObject = true;
      argsValue = argsRaw;
    }
  }

  if (r.error || r.status >= 400) {
    issues.push({ level: 'fail', message: `请求失败：${r.error || 'HTTP ' + r.status}` });
  } else if (!hasToolCall) {
    issues.push({
      level: 'fail',
      message: '模型未返回任何工具调用，可能不支持 function calling / tool_use，或网关未透传 tools 参数',
    });
  } else {
    if (resolvedName !== toolName) {
      issues.push({ level: 'warn', message: `工具名不符：期望 ${toolName}，实际 ${resolvedName}` });
    }
    if (!argsIsObject) {
      issues.push({ level: 'warn', message: '工具参数不是合法 JSON 对象' });
    }
    const expectedFinish = conf.protocol === 'anthropic'
      ? 'tool_use'
      : conf.protocol === 'responses'
        ? null // Responses 以 status=completed 表达完成，不用 finish_reason
        : 'tool_calls';
    if (expectedFinish && finishReason !== expectedFinish) {
      issues.push({ level: 'warn', message: `finish_reason 期望 ${expectedFinish}，实际 ${finishReason}` });
    }
  }

  return {
    status: issues.some((i) => i.level === 'fail') ? 'fail' : issues.length ? 'warn' : 'pass',
    issues,
    evidence: {
      httpStatus: r.status,
      toolCallPresent: hasToolCall,
      toolName: resolvedName,
      argsIsObject,
      argsValue,
      finishReason,
    },
  };
}

/** 8. 结构化输出 */
async function checkJson(conf) {
  const schema = {
    type: 'object',
    properties: {
      city: { type: 'string' },
      temperature: { type: 'number' },
    },
    required: ['city', 'temperature'],
    additionalProperties: false,
  };

  const instruction = 'Extract the city and temperature from this sentence and return JSON: "Beijing is 21 degrees today."';

  const payload =
    conf.protocol === 'anthropic'
      ? {
          messages: [{ role: 'user', content: instruction }],
          temperature: 0,
          tools: [
            {
              name: 'output_json',
              description: 'Return the extraction result as JSON',
              input_schema: schema,
            },
          ],
          tool_choice: { type: 'tool', name: 'output_json' },
        }
      : {
          messages: [{ role: 'user', content: instruction }],
          temperature: 0,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'weather_extraction', strict: true, schema },
          },
        };

  const r = await sendWithBudget(conf, payload, { need: OUTPUT_NEED.json });
  const issues = [];

  let parsed = null;
  if (conf.protocol === 'anthropic') {
    const blocks = (r.body && r.body.content) || [];
    const toolUse = blocks.find((b) => b && b.type === 'tool_use');
    if (toolUse && toolUse.input && typeof toolUse.input === 'object') parsed = toolUse.input;
  } else {
    const text = (r.text || '').trim();
    if (text) parsed = safeJson(text.replace(/^```json\s*/i, '').replace(/```$/, '').trim());
  }

  let fieldsOk = false;
  if (parsed && typeof parsed === 'object') {
    fieldsOk = typeof parsed.city === 'string' && typeof parsed.temperature === 'number';
  }

  if (r.error || r.status >= 400) {
    issues.push({ level: 'fail', message: `请求失败：${r.error || 'HTTP ' + r.status}` });
  } else if (!parsed) {
    issues.push({ level: 'fail', message: '未返回可解析的 JSON（结构化输出未生效）' });
  } else if (!fieldsOk) {
    issues.push({ level: 'warn', message: `返回了 JSON 但字段不符合 schema：${JSON.stringify(parsed).slice(0, 120)}` });
  }

  return {
    status: issues.some((i) => i.level === 'fail') ? 'fail' : issues.length ? 'warn' : 'pass',
    issues,
    evidence: {
      httpStatus: r.status,
      isJson: !!parsed,
      fieldsMatchSchema: fieldsOk,
      parsed,
    },
  };
}

/** 9. system 指令与多轮 */
async function checkSystem(conf) {
  const systemText = 'You are a strict calculator. Reply with digits only, no words, no punctuation.';
  const messages = [
    { role: 'user', content: '2+2' },
    { role: 'assistant', content: '4' },
    { role: 'user', content: '5+5' },
  ];

  const payload =
    conf.protocol === 'anthropic'
      ? { messages, temperature: 0, system: systemText }
      : { messages: [{ role: 'system', content: systemText }, ...messages], temperature: 0 };

  const r = await sendWithBudget(conf, payload, { need: OUTPUT_NEED.system });
  const issues = [];
  const text = (r.text || '').trim();

  if (r.error || r.status >= 400) {
    issues.push({ level: 'fail', message: `请求失败：${r.error || 'HTTP ' + r.status}` });
  } else if (!/^10$/.test(text)) {
    issues.push({
      level: 'warn',
      message: `多轮结果期望 "10"，实际 "${text.slice(0, 40)}"（system 指令或上下文可能未生效）`,
    });
  }

  return {
    status: issues.some((i) => i.level === 'fail') ? 'fail' : issues.length ? 'warn' : 'pass',
    issues,
    evidence: {
      httpStatus: r.status,
      output: text.slice(0, 60),
      multiTurnOk: /^10$/.test(text),
      systemOnlyDigits: !/[a-zA-Z\u4e00-\u9fa5]/.test(text),
    },
  };
}

/** 10. 语义质量：3 道确定性题目 */
async function checkQuality(conf) {
  const cases = [
    {
      name: '算术',
      prompt: 'What is 17 * 23? Reply with the number only.',
      expected: '391',
      verify: (t) => t.replace(/[^\d-]/g, '') === '391',
      maxTokens: 12,
    },
    {
      name: '指令遵循',
      prompt: 'Reply with exactly this token and nothing else: PONG',
      expected: 'PONG',
      verify: (t) => t.trim().toUpperCase() === 'PONG',
      maxTokens: 8,
    },
    {
      name: 'JSON 抽取',
      prompt: 'Output only a JSON object with keys "name" and "age" for: "Tom is 30 years old."',
      expected: '{"name":"Tom","age":30}',
      verify: (t) => {
        const j = safeJson(t.replace(/^```json\s*/i, '').replace(/```$/, '').trim());
        return !!j && j.name === 'Tom' && Number(j.age) === 30;
      },
      maxTokens: 40,
    },
  ];

  const results = [];
  let passed = 0;

  for (const c of cases) {
    const r = await sendWithBudget(
      conf,
      { messages: [{ role: 'user', content: c.prompt }], temperature: 0 },
      { need: Math.max(c.maxTokens, OUTPUT_NEED.quality) }
    );
    const text = (r.text || '').trim();
    const ok = r.status === 200 && !r.error && c.verify(text);
    if (ok) passed++;
    results.push({
      name: c.name,
      expected: c.expected,
      got: text.slice(0, 80),
      pass: ok,
      httpStatus: r.status,
    });
  }

  const issues = [];
  if (passed === 0) issues.push({ level: 'fail', message: '3 道基础题全部未通过，模型质量或链路存在严重问题' });
  else if (passed < cases.length) issues.push({ level: 'warn', message: `${cases.length} 道题通过 ${passed} 道` });

  return {
    status: passed === cases.length ? 'pass' : passed === 0 ? 'fail' : 'warn',
    issues,
    evidence: {
      passed,
      total: cases.length,
      cases: results,
    },
  };
}

/** 粗略 token 估算：CJK 按 1 字 1 token，英文按单词 1.3，符号按 0.5 */
function estimateTokens(text) {
  if (!text) return 0;
  const cjkMatches = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || [];
  const cjk = cjkMatches.length;
  const rest = text.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ');
  const words = (rest.match(/[A-Za-z0-9]+/g) || []).length;
  const symbols = (rest.match(/[^\sA-Za-z0-9]/g) || []).length;
  return cjk + Math.ceil(words * 1.3) + Math.ceil(symbols / 2);
}

/** 11. Token 计数一致性：usage 自洽性 + 与本地估算的偏差 */
async function checkTokens(conf) {
  const prompt = 'Translate into English: 质量测试需要可复现。';
  const r = await sendWithBudget(
    conf,
    { messages: [{ role: 'user', content: prompt }], temperature: 0 },
    { need: OUTPUT_NEED.tokens }
  );

  const issues = [];
  const u = usageDetailOf(r.body, conf.protocol);
  const rawUsage = (r.body && r.body.usage) || null;
  const text = (r.text || '').trim();
  const localEstimate = estimateTokens(prompt);
  const deviationPct = u.inputTokens > 0
    ? Math.round(((u.inputTokens - localEstimate) / u.inputTokens) * 1000) / 10
    : null;
  const totalConsistent = rawUsage
    ? Math.abs((u.totalTokens || 0) - (u.inputTokens + u.outputTokens)) <= 1
    : null;

  if (r.error || r.status >= 400) {
    issues.push({ level: 'fail', message: `请求失败：${r.error || 'HTTP ' + r.status}` });
  } else if (!rawUsage) {
    issues.push({ level: 'fail', message: '响应未返回 usage，无法核对 token 计数（流式统计与计费都会受影响）' });
  } else {
    if (!totalConsistent) {
      issues.push({
        level: 'warn',
        message: `usage 不自洽：input ${u.inputTokens} + output ${u.outputTokens} ≠ total ${u.totalTokens}`,
      });
    }
    if (deviationPct !== null && Math.abs(deviationPct) > 40) {
      issues.push({
        level: 'warn',
        message: `输入 ${u.inputTokens} tokens 与本地估算 ${localEstimate} 偏差 ${deviationPct}%（非 OpenAI 系 tokenizer 存在系统性偏差，属正常范围）`,
      });
    }
    if (u.reasoningTokens > 0 && u.reasoningTokens >= u.outputTokens * 0.9) {
      issues.push({
        level: 'warn',
        message: `completion_tokens ${u.outputTokens} 中 reasoning_tokens ${u.reasoningTokens}，正文仅 ${text.length} 字符；统计输出成本需把思考计入`,
      });
    }
  }

  return {
    status: issues.some((i) => i.level === 'fail') ? 'fail' : issues.length ? 'warn' : 'pass',
    issues,
    evidence: {
      httpStatus: r.status,
      usage: rawUsage,
      details: u.reasoningTokens || u.cachedTokens
        ? { reasoning_tokens: u.reasoningTokens, cached_tokens: u.cachedTokens }
        : null,
      promptChars: prompt.length,
      localEstimate,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      totalTokens: u.totalTokens,
      deviationPct,
      totalConsistent,
      outputChars: text.length,
    },
  };
}

/**
 * 生成稳定长前缀（逐字节可复现）
 * 中文约 0.5~1 token/字，按 0.5 保守估算，确保实际输入能越过各家缓存写入阈值
 */
function buildCachePrefix(targetTokens) {
  const needChars = Math.ceil(targetTokens / 0.5);
  const parts = [];
  let chars = 0;
  let i = 1;
  while (chars < needChars) {
    const seg = `第${i}段：本段内容用于构造稳定长前缀，编号 ${i}，与业务无关，仅用于缓存命中测试，请忽略。`;
    parts.push(seg);
    chars += seg.length + 1;
    i += 1;
  }
  return parts.join('\n');
}

/**
 * 13. 前缀缓存：最小前缀 2048 tokens + 3 轮 + 三指标 + 三态结论
 *
 * 为什么这样设计：
 *   - 前缀太短会假阴性：Kimi-K3 的 KDA 在极短输入（≤256 token）不写缓存，各家阈值/块对齐也不同
 *   - 轮次：第 1 轮基本是「写缓存」，DeepSeek 官方口径前两次不命中，所以至少 3 轮（1 写 2 读）
 *   - 三个指标互相独立：字段命中率（能力是否透明）、耗时加速比（能力是否存在）、
 *     计费是否打折（是否真的省钱），只看一个都会误判
 *   - 三态结论：字段回传 / 仅加速（有缓存但不让利）/ 无缓存
 */
const CACHE_ROUNDS = 3;
const CACHE_TIMEOUT = 120000;

async function checkCache(conf) {
  const targetTokens = Number(conf.cachePrefixTokens) > 0 ? Number(conf.cachePrefixTokens) : 2048;
  const prefix = buildCachePrefix(targetTokens);
  const rounds = [];
  const issues = [];

  // Anthropic 的 system 是顶层字段；其余协议走 messages
  const payload = conf.protocol === 'anthropic'
    ? { system: prefix, messages: [{ role: 'user', content: '请只回复 OK。' }], max_tokens: 64, temperature: 0 }
    : { messages: [{ role: 'system', content: prefix }, { role: 'user', content: '请只回复 OK。' }], max_tokens: 64, temperature: 0 };

  for (let i = 1; i <= CACHE_ROUNDS; i += 1) {
    const r = await sendRequest(conf, payload, { timeout: CACHE_TIMEOUT });

    const u = usageDetailOf(r.body, conf.protocol);
    rounds.push({
      round: i,
      httpStatus: r.status,
      totalMs: r.total,
      inputTokens: u.inputTokens,
      cachedTokens: u.cachedTokens,
      reasoningTokens: u.reasoningTokens,
      totalTokens: u.totalTokens,
    });

    if (r.error || r.status >= 400) {
      issues.push({
        level: 'fail',
        message: `第 ${i} 轮请求失败：${r.error || 'HTTP ' + r.status} ${String(r.rawText || '').slice(0, 180)}`,
      });
      break;
    }
  }

  const okRounds = rounds.filter((x) => x.httpStatus && x.httpStatus < 400);
  const evidence = {
    targetTokens,
    prefixChars: prefix.length,
    cacheField: usageDetailOf(null, conf.protocol).cacheField,
    rounds,
    state: 'unknown',
    fieldHitRate: null,
    speedup: null,
    inputTokensStable: null,
  };

  if (okRounds.length < 2) {
    issues.push({ level: 'fail', message: '缓存检查至少需要 2 轮成功响应才能评估' });
    return { status: 'fail', issues, evidence };
  }

  const first = okRounds[0];
  const later = okRounds.slice(1);
  const inputTokens = first.inputTokens;
  const cachedMax = Math.max(...later.map((x) => x.cachedTokens || 0));
  const laterMs = Math.min(...later.map((x) => (x.totalMs ? x.totalMs : Infinity)));

  const fieldHitRate = inputTokens > 0 ? Math.round((cachedMax / inputTokens) * 1000) / 10 : 0;
  const speedup = first.totalMs && Number.isFinite(laterMs)
    ? Math.round((laterMs / first.totalMs) * 1000) / 1000
    : null;
  const inputTokensStable = later.every((x) => x.inputTokens === inputTokens);

  Object.assign(evidence, { fieldHitRate, speedup, inputTokensStable });

  // 口径不足：输入没到缓存写入阈值，不下「没有缓存」的结论
  if (inputTokens < targetTokens) {
    evidence.state = 'below-threshold';
    issues.push({
      level: 'warn',
      message: `输入仅 ${inputTokens} tokens，未达 ${targetTokens} 的缓存写入阈值（如 Kimi-K3 的 KDA 极短输入不写缓存），本次口径不足，不下结论`,
    });
    return { status: 'skip', issues, evidence };
  }

  // 状态一：命中字段已回传
  if (fieldHitRate > 0) {
    evidence.state = 'field';
    if (fieldHitRate < 30) {
      issues.push({
        level: 'warn',
        message: `缓存命中率偏低：cached_tokens=${cachedMax}/${inputTokens}（${fieldHitRate}%）`,
      });
    }
    if (speedup !== null && speedup > 0.9) {
      issues.push({
        level: 'warn',
        message: `回传了 ${fieldHitRate}% 缓存命中，但复测耗时几乎没降（${Math.round(speedup * 100)}%），命中数可能不真实`,
      });
    }
    return { status: issues.length ? 'warn' : 'pass', issues, evidence };
  }

  // 状态二：缓存生效但不回传、不打折
  if (speedup !== null && speedup <= 0.8) {
    evidence.state = 'speed-only';
    issues.push({
      level: 'warn',
      message: `缓存生效但未回传：cached_tokens 各轮均为 0，但复测耗时从 ${first.totalMs}ms 降到 ${laterMs}ms（-${Math.round((1 - speedup) * 100)}%）`,
    });
    if (inputTokensStable) {
      issues.push({
        level: 'warn',
        message: `prompt_tokens 恒定 ${inputTokens}，缓存部分仍按全量计入输入，费用上没有缓存优惠`,
      });
    }
    return { status: 'warn', issues, evidence };
  }

  // 状态三：无缓存
  evidence.state = 'none';
  issues.push({
    level: 'warn',
    message: `未观察到缓存效果：cached_tokens 恒 0，复测耗时 ${Math.round(laterMs)}ms 与首轮 ${first.totalMs}ms 无显著差异`,
  });
  return { status: 'warn', issues, evidence };
}

/** 11. 错误响应规范（不产生 token） */
async function checkErrors(conf) {
  const issues = [];

  const badModel = await sendRequest(
    { ...conf, modelName: '__llm_eval_nonexistent_model__' },
    { messages: [{ role: 'user', content: 'hi' }], max_tokens: 4 }
  );

  const badKey = await sendRequest(
    { ...conf, apiKey: 'sk-llm-eval-invalid-key' },
    { messages: [{ role: 'user', content: 'hi' }], max_tokens: 4 }
  );

  const badModelOk = badModel.status >= 400 && badModel.status < 500;
  const badKeyOk = badKey.status === 401 || badKey.status === 403;

  const errShape = (r) => {
    const b = r.body;
    if (!b || typeof b !== 'object') return null;
    if (b.error && typeof b.error === 'object') {
      return {
        hasErrorObject: true,
        fields: Object.keys(b.error).sort(),
        type: b.error.type || b.error.code || null,
      };
    }
    return { hasErrorObject: false, fields: Object.keys(b).sort() };
  };

  if (!badModelOk) {
    issues.push({
      level: 'warn',
      message: `无效模型名期望返回 4xx，实际 ${badModel.status}${badModel.status === 200 ? '（异常）' : ''}`,
    });
  }
  if (!badKeyOk) {
    issues.push({
      level: 'warn',
      message: `无效密钥期望返回 401/403，实际 ${badKey.status}${badKey.status === 200 ? '（鉴权可能未生效）' : ''}`,
    });
  }

  return {
    status: issues.length ? 'warn' : 'pass',
    issues,
    evidence: {
      invalidModel: { httpStatus: badModel.status, error: errShape(badModel) },
      invalidKey: { httpStatus: badKey.status, error: errShape(badKey) },
    },
  };
}

/** 12. 多模态图片（可选） */
async function checkVision(conf) {
  // 默认素材：1x1 红色 PNG；用户可传公网 URL 或本地文件（base64）
  const RED_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const media = conf.image || { source: 'inline', dataUri: `data:image/png;base64,${RED_PNG}`, name: 'builtin-1x1-red.png' };
  const isInline = media.source === 'inline';
  const inlineMime = isInline ? (media.dataUri.match(/^data:([^;]+);/) || [])[1] || 'image/png' : null;
  const inlineData = isInline ? media.dataUri.slice(media.dataUri.indexOf(',') + 1) : null;
  const imageUrl = isInline ? media.dataUri : media.url;
  const askText = '用一句话描述这张图片的内容。';

  const payload =
    conf.protocol === 'anthropic'
      ? {
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: isInline
                    ? { type: 'base64', media_type: inlineMime, data: inlineData }
                    : { type: 'url', url: imageUrl },
                },
                { type: 'text', text: askText },
              ],
            },
          ],
          temperature: 0,
        }
      : conf.protocol === 'responses'
      ? {
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: askText },
                { type: 'input_image', image_url: imageUrl },
              ],
            },
          ],
          temperature: 0,
        }
      : {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: askText },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
          temperature: 0,
        };

  const r = await sendWithBudget(conf, payload, { need: OUTPUT_NEED.vision, timeout: 120000 });
  const issues = [];

  if (r.error || r.status >= 400) {
    issues.push({
      level: 'fail',
      message: `图片输入失败：${r.error || 'HTTP ' + r.status} ${String(r.rawText || '').slice(0, 200)}`,
    });
  } else if (!r.text) {
    issues.push({ level: 'fail', message: '接口返回 200 但没有图片描述，图片输入未被识别' });
  }

  return {
    status: issues.length ? 'fail' : 'pass',
    issues,
    evidence: {
      httpStatus: r.status,
      source: isInline ? `inline（${media.name || 'base64'}）` : media.url,
      output: (r.text || '').slice(0, 80),
    },
  };
}

/** 12.1 多模态视频（可选）：不做适配，原样下发 video_url */
async function checkVideo(conf) {
  if (conf.protocol === 'anthropic') {
    return {
      status: 'skip',
      issues: [{ level: 'warn', message: 'Anthropic Messages 协议未定义视频内容块，本项跳过' }],
      evidence: { skipped: true, reason: 'unsupported_by_protocol' },
    };
  }
  if (!conf.video) {
    return {
      status: 'skip',
      issues: [{ level: 'warn', message: '未提供视频素材（URL 或本地文件），本项跳过' }],
      evidence: { skipped: true, reason: 'no_media' },
    };
  }

  const media = conf.video;
  const isInline = media.source === 'inline';
  const videoUrl = isInline ? media.dataUri : media.url;
  const fps = Number(media.fps) > 0 ? Number(media.fps) : null;
  const askText = '用一句话描述这个视频的内容。';

  const payload = conf.protocol === 'responses'
    ? {
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: askText },
              Object.assign({ type: 'input_video', video_url: videoUrl }, fps ? { fps } : {}),
            ],
          },
        ],
        temperature: 0,
      }
    : {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: askText },
              Object.assign({ type: 'video_url', video_url: { url: videoUrl } }, fps ? { fps } : {}),
            ],
          },
        ],
        temperature: 0,
      };

  const r = await sendWithBudget(conf, payload, { need: OUTPUT_NEED.video, timeout: 180000 });
  const issues = [];

  if (r.error || r.status >= 400) {
    issues.push({
      level: 'fail',
      message: `视频输入失败：${r.error || 'HTTP ' + r.status} ${String(r.rawText || '').slice(0, 200)}`,
    });
  } else if (!r.text) {
    issues.push({ level: 'fail', message: '接口返回 200 但没有视频描述，视频输入未被识别' });
  }

  return {
    status: issues.length ? 'fail' : 'pass',
    issues,
    evidence: {
      httpStatus: r.status,
      source: isInline ? `inline（${media.name || 'base64'}）` : media.url,
      fps: fps || null,
      output: (r.text || '').slice(0, 80),
    },
  };
}

/** 13. 联网搜索（可选，只探测是否暴露工具） */
async function checkWebSearch(conf) {
  const issues = [];
  let evidence = {};
  // 用户自定义工具（如智谱 web_search 结构、Kimi builtin_function），原样下发
  const customTools = Array.isArray(conf.searchTools) && conf.searchTools.length ? conf.searchTools : null;

  if (conf.protocol === 'anthropic') {
    const tools = customTools || [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }];
    const r = await sendWithBudget(
      conf,
      {
        messages: [{ role: 'user', content: 'Search the web for the latest population of Tokyo and cite the source.' }],
        temperature: 0,
        tools,
      },
      { need: OUTPUT_NEED.web_search, timeout: 180000 }
    );

    const hasServerTool = r.body && Array.isArray(r.body.content) && r.body.content.some((b) => b && b.type === 'server_tool_use');
    const hasCitation = r.body && Array.isArray(r.body.content) && r.body.content.some((b) => b && b.type === 'text' && Array.isArray(b.citations) && b.citations.length);
    evidence = { httpStatus: r.status, toolsSent: tools, hasServerToolUse: !!hasServerTool, hasCitations: !!hasCitation };

    if (r.status >= 400) issues.push({ level: 'warn', message: `联网搜索工具调用失败：${(r.rawText || '').slice(0, 120)}` });
    else if (!hasServerTool && !hasCitation) issues.push({ level: 'warn', message: '未观察到 server_tool_use 或 citations，联网搜索可能未启用' });
  } else {
    const tools = customTools || [{ type: 'web_search_preview' }];
    const r = await sendWithBudget(
      conf,
      {
        messages: [{ role: 'user', content: 'Search the web for the latest population of Tokyo and cite the source.' }],
        temperature: 0,
        tools,
      },
      { need: OUTPUT_NEED.web_search, timeout: 180000 }
    );

    const bodyStr = JSON.stringify(r.body || {});
    const hasSearchResults = Array.isArray(r.body && r.body.web_search) && r.body.web_search.length > 0;
    const hasAnnotations = bodyStr.includes('"annotations"') || bodyStr.includes('"citations"');
    const mentionsUrl = /https?:\/\//.test(bodyStr);
    evidence = { httpStatus: r.status, toolsSent: tools, hasSearchResults, hasAnnotations, mentionsUrl };

    if (r.status >= 400) {
      issues.push({
        level: 'warn',
        message: `web_search 工具不被支持：HTTP ${r.status} ${String(r.rawText || '').slice(0, 200)}`,
      });
    } else if (!hasSearchResults && !hasAnnotations) {
      issues.push({ level: 'warn', message: '未观察到搜索结果字段或引用标注，联网搜索可能未真正执行' });
    }
  }

  return {
    status: issues.length ? 'warn' : 'pass',
    issues,
    evidence,
  };
}

// ---------------------------------------------------------------- 对比与报告

const ENUM_FIELDS = new Set([
  'objectValue', 'typeValue', 'finishReason', 'messageRole', 'stopReason', 'contentType',
]);

// 这些字段天然有波动，不参与"官方 vs 本地"的契约差异判定
const IGNORED_DIFF_FIELDS = new Set([
  'latencyMs', 'totalMs', 'ttfbMs', 'chunkSpanMs', 'durationMs', 'textLength', 'output',
]);

/** 递归对比两个观测值，只关注"结构/类型/量级"，不比较自然语言内容 */
function diffEvidence(official, local, path = '', out = []) {
  if (out.length >= 60) return out;

  // 时序类字段天然有波动，不属于契约差异，直接跳过
  const leafName = path.split('.').pop() || '';
  if (IGNORED_DIFF_FIELDS.has(leafName)) return out;

  if (official === undefined || local === undefined) {
    out.push({
      path: path || '(root)',
      official: official === undefined ? '(缺失)' : official,
      local: local === undefined ? '(缺失)' : local,
      type: 'missing',
    });
    return out;
  }

  const to = typeOf(official);
  const tl = typeOf(local);

  if (to !== tl) {
    out.push({ path: path || '(root)', official: `${to}`, local: `${tl}`, type: 'type' });
    return out;
  }

  if (to === 'object') {
    const keys = new Set([...Object.keys(official || {}), ...Object.keys(local || {})]);
    for (const k of keys) {
      diffEvidence(official ? official[k] : undefined, local ? local[k] : undefined, path ? `${path}.${k}` : k, out);
    }
    return out;
  }

  if (to === 'array') {
    // 字符串数组（如字段名列表）按集合比较，直接指出"哪边多了/少了哪些字段"
    const allStrings = official.every((v) => typeof v === 'string') && local.every((v) => typeof v === 'string');
    if (allStrings) {
      const onlyOfficial = official.filter((v) => !local.includes(v));
      const onlyLocal = local.filter((v) => !official.includes(v));
      if (onlyOfficial.length) {
        out.push({ path: `${path}.仅官方有`, official: onlyOfficial.join(', '), local: '(无)', type: 'missing' });
      }
      if (onlyLocal.length) {
        out.push({ path: `${path}.仅本地有`, official: '(无)', local: onlyLocal.join(', '), type: 'extra' });
      }
      return out;
    }

    if (official.length !== local.length) {
      out.push({ path: `${path}.length`, official: official.length, local: local.length, type: 'length' });
    }
    const n = Math.min(official.length, local.length);
    for (let i = 0; i < n; i++) {
      diffEvidence(official[i], local[i], `${path}[${i}]`, out);
    }
    return out;
  }

  if (to === 'number') {
    const a = Number(official);
    const b = Number(local);
    if (Number.isNaN(a) || Number.isNaN(b)) return out;
    if (a === b) return out;
    const bothZero = a === 0 && b === 0;
    if (bothZero) return out;
    const maxAbs = Math.max(Math.abs(a), Math.abs(b));
    const relative = maxAbs === 0 ? 0 : Math.abs(a - b) / maxAbs;
    if (relative > 0.5 || (a === 0) !== (b === 0)) {
      out.push({ path, official: a, local: b, type: 'value' });
    }
    return out;
  }

  if (to === 'boolean') {
    if (official !== local) out.push({ path, official, local, type: 'value' });
    return out;
  }

  if (to === 'string') {
    // 只对枚举型字段做严格比较，自由文本不参与 diff
    const leaf = path.split('.').pop() || '';
    if ((ENUM_FIELDS.has(leaf) || /Type$/.test(leaf)) && official !== local) {
      out.push({ path, official, local, type: 'value' });
    }
  }

  return out;
}

function scoreOf(checks) {
  let weighted = 0;
  let total = 0;
  for (const c of checks) {
    if (c.status === 'skip') continue;
    total += 1;
    if (c.status === 'pass') weighted += 1;
    else if (c.status === 'warn') weighted += 0.5;
  }
  if (total === 0) return 0;
  return Math.round((weighted / total) * 100);
}

// ---------------------------------------------------------------- 主流程

class QualityTestService {
  constructor() {
    this.reports = new Map();
    this.running = false;
    // 最近一次异步任务：页面离开/刷新后仍能查到进度与结果
    this.job = null;
  }

  /**
   * 异步执行：立即返回任务句柄，测试在后台跑完
   * 解决同步请求过长被浏览器/网关断开（Failed to fetch）以及切换页面后结果丢失的问题
   */
  startJob(input) {
    if (this.running) throw new AppError('已有质量测试正在运行，请稍后再试', 409);
    // 参数非法时直接 400，避免把错误塞进后台任务
    this._normalizeTarget(input || {}, '被测接口');

    const job = {
      id: `qj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      reportId: null,
      error: null,
      target: { url: input.url, modelName: input.modelName, protocol: input.protocol },
      checks: Array.isArray(input.checks) ? input.checks.length : DEFAULT_CHECKS.length,
      withBaseline: !!(input.baseline && input.baseline.url),
    };
    this.job = job;

    this.run(input)
      .then((report) => {
        job.status = 'done';
        job.reportId = report.id;
        job.finishedAt = new Date().toISOString();
      })
      .catch((err) => {
        job.status = 'error';
        job.error = (err && err.message) || '测试失败';
        job.finishedAt = new Date().toISOString();
        log.warn('异步质量测试失败', { jobId: job.id, error: job.error });
      });

    return job;
  }

  getJob() {
    return this.job;
  }

  /** 参数校验与归一化 */
  _normalizeTarget(input, label) {
    if (!input || !input.url) throw new AppError(`${label} base_url 不能为空`, 400);
    if (!input.apiKey) throw new AppError(`${label} api_key 不能为空`, 400);
    if (!input.modelName) throw new AppError(`${label} 模型名称不能为空`, 400);

    const protocol = input.protocol === 'anthropic'
      ? 'anthropic'
      : input.protocol === 'responses'
        ? 'responses'
        : 'openai';
    return {
      protocol,
      url: String(input.url).trim(),
      apiKey: String(input.apiKey).trim(),
      modelName: String(input.modelName).trim(),
      anthropicVersion: input.anthropicVersion,
      // 长上下文档位可调大前缀，默认 2048 tokens
      cachePrefixTokens: Number(input.cachePrefixTokens) > 0 ? Number(input.cachePrefixTokens) : undefined,
      // 可选参数：思考强度、多模态素材、自定义联网搜索工具
      reasoningEffort: input.reasoningEffort ? String(input.reasoningEffort) : undefined,
      image: normalizeMediaInput(input.image, 'image'),
      video: normalizeMediaInput(input.video, 'video'),
      searchTools: Array.isArray(input.searchTools) && input.searchTools.length ? input.searchTools : undefined,
    };
  }

  /** 执行单个目标的全套检查 */
  async _runTarget(conf, checkIds) {
    const tasks = [];
    const want = (id) => checkIds.includes(id);

    // 连通性必须先跑，schema 复用它
    const connectivity = want('connectivity') || want('schema')
      ? await checkConnectivity(conf)
      : null;

    if (want('connectivity')) {
      tasks.push({ id: 'connectivity', result: connectivity });
    }
    if (want('schema')) {
      const r = connectivity ? checkSchema(conf, connectivity._raw) : { status: 'skip', issues: [{ level: 'warn', message: '连通性检查未执行' }], evidence: {} };
      tasks.push({ id: 'schema', result: r });
    }
    if (connectivity) delete connectivity._raw;

    // 流式两项共用一次请求
    if (want('stream') || want('streaming')) {
      const s = await checkStream(conf);
      if (want('stream')) tasks.push({ id: 'stream', result: s.stream });
      if (want('streaming')) tasks.push({ id: 'streaming', result: s.timing });
    }

    // 其余检查并发执行，限制并发度避免触发限流
    const parallelDefs = [
      ['max_tokens', checkMaxTokens],
      ['stop', checkStop],
      ['tools', checkTools],
      ['json', checkJson],
      ['system', checkSystem],
      ['quality', checkQuality],
      ['tokens', checkTokens],
      ['cache', checkCache],
      ['errors', checkErrors],
      ['vision', checkVision],
      ['video', checkVideo],
      ['web_search', checkWebSearch],
    ].filter(([id]) => want(id));

    const concurrency = 3;
    for (let i = 0; i < parallelDefs.length; i += concurrency) {
      const batch = parallelDefs.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async ([id, fn]) => {
          try {
            return { id, result: await fn(conf) };
          } catch (error) {
            return { id, result: { status: 'fail', issues: [{ level: 'fail', message: error.message }], evidence: {} } };
          }
        })
      );
      tasks.push(...results);
    }

    // 按目录顺序整理
    const order = CHECK_CATALOG.map((c) => c.id);
    tasks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    return tasks;
  }

  /** 运行质量测试 */
  async run(input) {
    if (this.running) {
      throw new AppError('已有质量测试正在运行，请稍后再试', 409);
    }

    const target = this._normalizeTarget(input, '被测接口');
    const baseline = input.baseline && input.baseline.url ? this._normalizeTarget(input.baseline, '官方对照') : null;

    const checkIds = Array.isArray(input.checks) && input.checks.length
      ? input.checks.filter((id) => CHECK_CATALOG.some((c) => c.id === id))
      : DEFAULT_CHECKS;

    if (checkIds.length === 0) throw new AppError('至少选择一个检查项', 400);

    this.running = true;
    const startedAt = Date.now();

    try {
      log.info('开始模型质量测试', {
        target: target.url,
        protocol: target.protocol,
        model: target.modelName,
        checks: checkIds.length,
        withBaseline: !!baseline,
      });

      const localTasks = await this._runTarget(target, checkIds);
      const baselineTasks = baseline ? await this._runTarget(baseline, checkIds) : null;

      const checks = localTasks.map((t) => {
        const meta = CHECK_CATALOG.find((c) => c.id === t.id) || { id: t.id, name: t.id };
        const base = baselineTasks ? baselineTasks.find((b) => b.id === t.id) : null;
        const item = {
          id: t.id,
          name: meta.name,
          desc: meta.desc,
          status: t.result.status,
          issues: t.result.issues || [],
          evidence: t.result.evidence || {},
          baselineEvidence: base ? base.result.evidence || {} : null,
          baselineStatus: base ? base.result.status : null,
          differences: base ? diffEvidence(base.result.evidence || {}, t.result.evidence || {}) : [],
        };
        return item;
      });

      const differences = [];
      for (const c of checks) {
        for (const d of c.differences) {
          differences.push({
            check: c.id,
            checkName: c.name,
            path: d.path,
            official: d.official,
            local: d.local,
            type: d.type,
          });
        }
      }

      const summary = {
        total: checks.length,
        pass: checks.filter((c) => c.status === 'pass').length,
        warn: checks.filter((c) => c.status === 'warn').length,
        fail: checks.filter((c) => c.status === 'fail').length,
        skip: checks.filter((c) => c.status === 'skip').length,
        score: scoreOf(checks),
        durationMs: Date.now() - startedAt,
      };

      const report = {
        id: `qr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        userId: input.userId == null ? null : Number(input.userId),
        target: { protocol: target.protocol, url: target.url, modelName: target.modelName },
        baseline: baseline ? { protocol: baseline.protocol, url: baseline.url, modelName: baseline.modelName } : null,
        summary,
        usage: usageSummaryOf(target),
        capabilities: this._buildCapabilities(target, checks),
        checks,
        differences,
        conclusion: this._buildConclusion(summary, differences, !!baseline),
      };

      this.reports.set(report.id, report);
      if (this.reports.size > MAX_REPORTS) {
        const oldest = this.reports.keys().next().value;
        this.reports.delete(oldest);
      }

      // 落库持久化，容器重启后仍可在历史记录中查看
      try {
        db.saveQualityReport(report);
      } catch (err) {
        log.warn('质量报告写入数据库失败，仅保留在内存', { id: report.id, error: err.message });
      }

      log.info('模型质量测试完成', {
        id: report.id,
        score: summary.score,
        pass: summary.pass,
        warn: summary.warn,
        fail: summary.fail,
        differences: differences.length,
      });

      return report;
    } finally {
      this.running = false;
    }
  }

  /** 能力支持情况：把各检查项结论映射成「这个能力到底支不支持」 */
  _buildCapabilities(target, checks) {
    const byId = {};
    for (const c of checks) byId[c.id] = c;

    const supportedOf = (c) => (!c ? null : c.status === 'pass' ? true : c.status === 'fail' ? false : null);

    const detailOf = (c, fallback) => {
      if (!c) return fallback;
      const ev = c.evidence || {};
      const http = ev.httpStatus || ev.status || null;
      const msg = (c.issues && c.issues[0] && c.issues[0].message) || (c.status === 'pass' ? '正常返回' : '');
      const text = [http ? `HTTP ${http}` : null, msg].filter(Boolean).join(' · ');
      return text || fallback;
    };

    const caps = [];

    if (target && target.reasoningEffort) {
      const conn = byId.connectivity;
      caps.push({
        name: `思考强度 reasoning_effort=${target.reasoningEffort}`,
        supported: supportedOf(conn),
        detail: detailOf(conn, '未选择连通性检查，无法判定'),
      });
    }

    caps.push({
      name: '图片输入 image_url',
      supported: supportedOf(byId.vision),
      detail: detailOf(byId.vision, '未选择该检查项'),
    });
    caps.push({
      name: '视频输入 video_url',
      supported: supportedOf(byId.video),
      detail: detailOf(byId.video, '未选择该检查项'),
    });
    caps.push({
      name: '联网搜索 web_search',
      supported: supportedOf(byId.web_search),
      detail: detailOf(byId.web_search, '未选择该检查项'),
    });
    caps.push({
      name: '结构化输出 json_schema',
      supported: supportedOf(byId.json),
      detail: detailOf(byId.json, '未选择该检查项'),
    });

    const cache = byId.cache;
    if (cache) {
      const ev = cache.evidence || {};
      caps.push({
        name: '缓存计费字段',
        supported: Number(ev.fieldHitRate) > 0,
        detail: (cache.issues && cache.issues.length ? cache.issues[0].message : '')
          || `字段命中率 ${Math.round(Number(ev.fieldHitRate || 0) * 100)}%`,
      });
    } else {
      caps.push({ name: '缓存计费字段', supported: null, detail: '未选择缓存检查项' });
    }

    return caps;
  }

  /** 一句话结论 */
  _buildConclusion(summary, differences, hasBaseline) {
    const parts = [];
    parts.push(`共 ${summary.total} 项检查：通过 ${summary.pass}、警告 ${summary.warn}、失败 ${summary.fail}，综合得分 ${summary.score}。`);

    if (!hasBaseline) {
      parts.push('本次未提供官方对照，差异结论基于协议规范判断；如需精确定位字段级差异，建议同时填写官方 base_url 与 key。');
    } else if (differences.length === 0) {
      parts.push('与官方对照相比，未发现结构性差异。');
    } else {
      const byType = differences.reduce((acc, d) => {
        acc[d.type] = (acc[d.type] || 0) + 1;
        return acc;
      }, {});
      const detail = Object.entries(byType).map(([k, v]) => `${k} ${v} 处`).join('、');
      parts.push(`与官方对照相比发现 ${differences.length} 处差异（${detail}），详见差异明细。`);
    }

    if (summary.fail > 0) {
      parts.push('存在失败项，说明该接口在协议契约或核心能力上与官方不一致，不建议直接用于生产。');
    } else if (summary.warn > 0) {
      parts.push('存在警告项，功能基本可用，但部分参数透传或字段规范与官方有差距。');
    } else if (differences.length > 0) {
      parts.push(`各项检查均通过，但与官方对照仍有 ${differences.length} 处字段级差异，建议逐项确认是否影响业务。`);
    } else {
      parts.push('全部检查通过，接口行为与官方规范一致。');
    }

    return parts.join('');
  }

  listReports(userId = null, isAdmin = false) {
    const merged = new Map();

    // 先取数据库中的历史报告（重启后仍在；按用户隔离）
    try {
      const { list } = db.getQualityReports(200, 0, userId, isAdmin);
      for (const r of list) merged.set(r.id, r);
    } catch (err) {
      log.warn('读取质量报告列表失败，降级为内存列表', { error: err.message });
    }

    // 再补本次进程内的报告（防止刚完成但落库失败；仅限归属者）
    for (const r of this.reports.values()) {
      if (merged.has(r.id)) continue;
      if (!isAdmin && r.userId != null && userId != null && Number(r.userId) !== Number(userId)) continue;
      merged.set(r.id, {
        id: r.id,
        createdAt: r.createdAt,
        target: r.target,
        baseline: r.baseline,
        summary: r.summary,
      });
    }

    return [...merged.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  getReport(id, userId = null, isAdmin = false) {
    const cached = this.reports.get(id);
    if (cached) {
      const owned = isAdmin || cached.userId == null || Number(cached.userId) === Number(userId);
      if (owned) return cached;
    }

    let stored = null;
    try {
      stored = db.getQualityReportById(id, userId, isAdmin);
    } catch (err) {
      log.warn('读取质量报告详情失败', { id, error: err.message });
    }
    if (!stored) throw new AppError('报告不存在', 404);
    return stored;
  }

  deleteReport(id, userId = null, isAdmin = false) {
    const cached = this.reports.get(id);
    if (cached && cached.userId != null) {
      const owned = isAdmin || Number(cached.userId) === Number(userId);
      if (!owned) throw new AppError('报告不存在', 404);
    }
    this.reports.delete(id);
    return db.deleteQualityReport(id, userId, isAdmin);
  }

  clearReports(userId = null, isAdmin = false) {
    // 内存报告一并清理（进程内只有最近几轮，直接清空）
    this.reports.clear();
    return db.clearQualityReports(userId, isAdmin);
  }

  isRunning() {
    return this.running;
  }
}

const qualityTestService = new QualityTestService();

module.exports = {
  qualityTestService,
  CHECK_CATALOG,
  DEFAULT_CHECKS,
  resolveEndpoint,
  diffEvidence,
};
