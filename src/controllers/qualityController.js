/**
 * QualityController - 模型质量测试接口
 */
const {
  qualityTestService,
  CHECK_CATALOG,
  DEFAULT_CHECKS,
} = require('../services/qualityTestService');
const log = require('../utils/logger');

/**
 * 执行质量测试
 * POST /api/quality/run
 */
const run = async (req, res) => {
  const payload = { ...(req.body || {}), userId: req.userId };

  // 质量测试耗时较长，放宽本次请求的超时限制
  if (req.setTimeout) req.setTimeout(0);
  if (res.setTimeout) res.setTimeout(0);

  const report = await qualityTestService.run(payload);
  res.json({ success: true, data: report });
};

/**
 * 异步执行质量测试（立即返回任务句柄，后台继续跑）
 * POST /api/quality/run-async
 */
const runAsync = async (req, res) => {
  const job = qualityTestService.startJob({ ...(req.body || {}), userId: req.userId });
  res.status(202).json({ success: true, data: job });
};

/**
 * 查询最近一次异步任务状态
 * GET /api/quality/job
 */
const getJob = async (req, res) => {
  res.json({ success: true, data: qualityTestService.getJob() });
};

/**
 * 获取可选检查项目录
 * GET /api/quality/checks
 */
const getChecks = async (req, res) => {
  res.json({
    success: true,
    data: {
      catalog: CHECK_CATALOG,
      defaultChecks: DEFAULT_CHECKS,
    },
  });
};

/**
 * 历史报告列表（按用户隔离）
 * GET /api/quality/reports
 */
const listReports = async (req, res) => {
  const isAdmin = req.user && req.user.role === 'admin';
  res.json({ success: true, data: qualityTestService.listReports(req.userId, isAdmin) });
};

/**
 * 报告详情
 * GET /api/quality/reports/:id
 */
const getReport = async (req, res) => {
  const isAdmin = req.user && req.user.role === 'admin';
  const report = qualityTestService.getReport(req.params.id, req.userId, isAdmin);
  res.json({ success: true, data: report });
};

/**
 * 删除报告
 * DELETE /api/quality/reports/:id
 */
const deleteReport = async (req, res) => {
  const isAdmin = req.user && req.user.role === 'admin';
  const ok = qualityTestService.deleteReport(req.params.id, req.userId, isAdmin);
  res.json({ success: true, data: { deleted: ok } });
};

/**
 * 清空报告（管理员清全部，普通用户只清自己的）
 * POST /api/quality/reports/clear
 */
const clearReports = async (req, res) => {
  const isAdmin = req.user && req.user.role === 'admin';
  const count = qualityTestService.clearReports(req.userId, isAdmin);
  res.json({ success: true, data: { deleted: count } });
};

/**
 * 当前是否正在运行
 * GET /api/quality/status
 */
const getStatus = async (req, res) => {
  res.json({ success: true, data: { running: qualityTestService.isRunning() } });
};

module.exports = {
  run,
  runAsync,
  getJob,
  getChecks,
  listReports,
  getReport,
  deleteReport,
  clearReports,
  getStatus,
};
