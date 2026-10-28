const benchmarkService = require('../services/benchmarkService');
const db = require('../../database');
const { AppError } = require('../middlewares/errorHandler');

/**
 * 启动速度测试
 */
const startBenchmark = (req, res) => {
  const { providerType, url, modelName, apiKey } = req.body;

  if (!url || !url.trim()) throw new AppError('Base URL不能为空', 400);
  if (!modelName || !modelName.trim()) throw new AppError('模型名称不能为空', 400);
  if (!apiKey || !apiKey.trim()) throw new AppError('API Key不能为空', 400);
  if (!providerType || !['openai', 'responses', 'openai-responses', 'anthropic', 'claude', 'gemini'].includes(providerType)) {
    throw new AppError('必须指定有效的接口类型（openai/responses/anthropic/gemini）', 400);
  }
  try {
    new URL(url);
  } catch (e) {
    throw new AppError('Base URL格式无效', 400);
  }

  const result = benchmarkService.start(req.body, req.userId);
  if (!result.success) throw new AppError(result.error, 400);
  res.json(result);
};

/**
 * 停止速度测试
 * 默认只能停自己启动的测试；他人测试需显式传 force=true（仅管理员）
 */
const stopBenchmark = (req, res) => {
  const force = !!(req.body && req.body.force === true);
  if (force && !(req.user && req.user.role === 'admin')) {
    return res.status(403).json({ success: false, message: '仅管理员可以强制停止他人测试' });
  }
  const result = benchmarkService.stop(req.userId, force);

  if (result.ownerMismatch) return res.status(403).json(result);
  if (!result.success) throw new AppError(result.error, 400);
  res.json(result);
};

/**
 * 获取速度测试当前状态（按用户归属脱敏）
 */
const getBenchmarkStatus = (req, res) => {
  res.json({ success: true, data: benchmarkService.getStateFor(req.userId) });
};

/**
 * 获取测速报告列表（按用户隔离）
 */
const getReports = (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = Math.min(100, parseInt(req.query.pageSize) || 20);
  const isAdmin = req.user && req.user.role === 'admin';
  res.json(db.getBenchmarkReports(page, pageSize, req.userId, isAdmin));
};

/**
 * 获取单条测速报告
 */
const getReportById = (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) throw new AppError('无效的ID参数', 400);
  const isAdmin = req.user && req.user.role === 'admin';
  const report = db.getBenchmarkReportById(id, req.userId, isAdmin);
  if (!report) throw new AppError('报告不存在', 404);
  res.json({ success: true, data: report });
};

/**
 * 删除测速报告
 */
const deleteReport = (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) throw new AppError('无效的ID参数', 400);
  const isAdmin = req.user && req.user.role === 'admin';
  const ok = db.deleteBenchmarkReport(id, req.userId, isAdmin);
  if (!ok) throw new AppError('报告不存在', 404);
  res.json({ success: true, message: '报告已删除' });
};

module.exports = {
  startBenchmark,
  stopBenchmark,
  getBenchmarkStatus,
  getReports,
  getReportById,
  deleteReport,
};
