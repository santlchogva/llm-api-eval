const stressTestService = require('../services/stressTestService');
const { AppError } = require('../middlewares/errorHandler');

/**
 * 启动测压
 * 启动方用户会记为该轮测试的归属者，用于停止权限判定、数据隔离与广播隔离
 */
const startTest = (req, res) => {
  const result = stressTestService.start(req.body, req.userId);
  res.json(result);
};

/**
 * 停止测压
 * 默认只能停自己启动的测试；他人测试需显式传 force=true 强制停止（仅管理员）
 */
const stopTest = (req, res) => {
  const force = !!(req.body && req.body.force === true);
  if (force && !(req.user && req.user.role === 'admin')) {
    return res.status(403).json({ success: false, message: '仅管理员可以强制停止他人测试' });
  }
  const result = stressTestService.stop(req.userId, force);

  if (result && result.ownerMismatch) {
    return res.status(403).json(result);
  }

  res.json(result);
};

/**
 * 获取当前状态（按用户归属脱敏）
 */
const getStatus = (req, res) => {
  res.json(stressTestService.getStateFor(req.userId));
};

/**
 * 清除请求日志
 */
const clearLogs = (req, res) => {
  stressTestService.clearRequestLogs();
  res.json({ success: true, message: '日志已清除' });
};

module.exports = {
  startTest,
  stopTest,
  getStatus,
  clearLogs,
};
