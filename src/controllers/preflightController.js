const { AIRequestService } = require('../services/aiService');
const { AppError } = require('../middlewares/errorHandler');
const log = require('../utils/logger');

/**
 * 连通性预检（Preflight）
 *
 * 压测前先发一次真实请求，验证目标地址、API Key、模型名是否可用，
 * 并返回单请求的延迟 / TTFB / token 用量 / 内容预览。
 * 避免把整轮压测时间浪费在 401、404、模型名拼错这类配置问题上。
 */
const preflight = async (req, res) => {
  const { url, modelName, apiKey, providerType, requestType, testPrompt } = req.body;

  if (!url || !modelName || !apiKey || !providerType) {
    throw new AppError('预检需要 url / modelName / apiKey / providerType', 400);
  }

  const service = new AIRequestService(providerType, {
    url,
    modelName,
    apiKey,
    requestType: requestType === 'stream' ? 'stream' : 'non-stream',
    // 预检是单请求探测，超时给短一些，快速暴露不可用目标
    timeout: 30000,
  });

  const prompt = testPrompt || '你好，请只回复：OK';
  const result = await service.execute(prompt);

  if (!result.success) {
    log.warn('连通性预检失败', { providerType, status: result.status, error: result.error });
  }

  res.json({
    success: true,
    data: {
      ok: !!result.success,
      status: result.status ?? null,
      // 单请求总耗时与首字节延迟（仅流式可测）
      latency: result.responseTime ?? null,
      ttfb: result.ttfb ?? null,
      tokens: result.tokens || null,
      contentPreview: result.content ? String(result.content).slice(0, 120) : '',
      error: result.error || null,
      errorCode: result.errorCode || null,
    },
  });
};

module.exports = { preflight };
