/**
 * 数据集控制器
 * 提供内置压测数据集的查询、按 token 长度合成与自定义数据导入解析能力。
 */

const datasets = require('../datasets');
const { AppError } = require('../middlewares/errorHandler');
const { estimateTokens } = require('../utils/tokenEstimator');

/**
 * 获取数据集列表（仅元信息）
 */
const listDatasets = (req, res) => {
  res.json({ datasets: datasets.listDatasets() });
};

/**
 * 获取单个数据集的完整内容
 */
const getDataset = (req, res) => {
  const dataset = datasets.getDataset(req.params.id);
  if (!dataset) {
    throw new AppError('数据集不存在', 404);
  }

  // 预览时把加工后的请求也按 token 长度标注，便于确认输入长度是否受控
  const preview = dataset.items.slice(0, 10).map((prompt) => ({
    prompt,
    estimatedTokens: estimateTokens(prompt),
  }));

  res.json({ ...dataset, preview });
};

/**
 * 按目标 token 数合成一条 prompt
 * POST /api/datasets/synthesize
 */
const synthesizePrompt = (req, res) => {
  const targetTokens = parseInt(req.body.targetTokens);
  if (!Number.isFinite(targetTokens) || targetTokens < 1 || targetTokens > 200000) {
    throw new AppError('targetTokens 必须在 1-200000 之间', 400);
  }

  const prompt = datasets.buildPromptByTokens(targetTokens, req.body.question);
  res.json({ prompt, targetTokens, estimatedTokens: estimateTokens(prompt) });
};

/**
 * 解析导入的数据集文本（CSV / JSONL / JSON 数组 / 纯文本）
 * POST /api/datasets/parse
 */
const parseDataset = (req, res) => {
  const { content, column, limit } = req.body;
  if (!content || typeof content !== 'string' || !content.trim()) {
    throw new AppError('导入内容不能为空', 400);
  }

  const result = datasets.parseItems(content, { column, limit });
  if (result.items.length === 0) {
    throw new AppError('未能从导入内容中解析出任何请求', 400);
  }

  res.json({
    ...result,
    sample: result.items.slice(0, 5),
    estimatedTokens: result.items.map((p) => estimateTokens(p)).slice(0, 5),
  });
};

module.exports = {
  listDatasets,
  getDataset,
  synthesizePrompt,
  parseDataset,
};
