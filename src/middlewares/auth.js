const { AppError } = require('./errorHandler');
const sessionService = require('../services/sessionService');
const log = require('../utils/logger');

/**
 * 认证中间件（多用户）
 *
 * 校验的是**登录时签发的会话令牌**，不是登录口令本身。
 * 校验通过后把用户身份挂到 req 上：
 *   - req.sessionId：会话令牌（用于登出）
 *   - req.userId / req.user：用户身份（用于数据隔离与任务归属判定）
 */
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    log.warn('未提供认证令牌', { ip: req.ip, path: req.path });
    throw new AppError('未提供认证令牌', 401);
  }

  const session = sessionService.get(token);
  if (!session) {
    log.warn('认证失败：会话无效或已过期', { ip: req.ip, path: req.path });
    throw new AppError('认证失败：会话无效或已过期，请重新登录', 401);
  }

  req.sessionId = token;
  req.userId = session.userId;
  req.user = { id: session.userId, username: session.username, role: session.role };
  next();
};

/**
 * 管理员权限中间件（跟在 authenticate 之后）
 */
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    throw new AppError('需要管理员权限', 403);
  }
  next();
};

/**
 * 可选认证中间件（有令牌则校验，没有也放行）
 */
const optionalAuth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (token) {
    const session = sessionService.get(token);
    if (!session) {
      throw new AppError('认证失败：会话无效或已过期，请重新登录', 401);
    }
    req.sessionId = token;
    req.userId = session.userId;
    req.user = { id: session.userId, username: session.username, role: session.role };
  } else {
    req.sessionId = null;
    req.userId = null;
    req.user = null;
  }
  req.isAuthenticated = !!token;
  next();
};

module.exports = {
  authenticate,
  requireAdmin,
  optionalAuth,
};
