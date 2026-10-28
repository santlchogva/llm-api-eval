const sessionService = require('../services/sessionService');
const userService = require('../services/userService');
const db = require('../../database');
const { AppError } = require('../middlewares/errorHandler');
const log = require('../utils/logger');

/**
 * 登录控制器（多用户）
 *
 * 用户名密码校验通过后签发**独立会话令牌**，会话中记录用户身份。
 * 前端后续请求携带该令牌，服务端据此判断"谁在操作"，
 * 支持数据隔离（历史/任务/报告按用户隔离）与归属判定。
 */
const login = (req, res) => {
  const { username, password } = req.body;

  const user = userService.authenticate(username, password);
  const token = sessionService.create({ user, ip: req.ip });
  const activeSessions = sessionService.count();

  log.info('用户登录成功', { ip: req.ip, username: user.username, activeSessions });

  res.json({
    success: true,
    token,
    user: { id: user.id, username: user.username, role: user.role },
    message: '登录成功',
  });
};

/**
 * 开放注册：创建普通用户并直接签发会话（注册即登录）
 */
const register = (req, res) => {
  const user = userService.register(req.body);
  const token = sessionService.create({ user, ip: req.ip });

  log.info('新用户注册', { ip: req.ip, username: user.username });

  res.status(201).json({
    success: true,
    token,
    user: { id: user.id, username: user.username, role: user.role },
    message: '注册成功',
  });
};

/**
 * 登出：销毁当前会话
 */
const logout = (req, res) => {
  const removed = sessionService.remove(req.sessionId);
  log.info('用户登出', { ip: req.ip, removed });
  res.json({ success: true, message: '已登出' });
};

/**
 * 当前登录用户信息
 */
const me = (req, res) => {
  res.json({ success: true, data: req.user });
};

/**
 * 修改自己的密码（需验证旧密码）
 */
const changePassword = (req, res) => {
  const { oldPassword, newPassword } = req.body;

  const user = db.getUserById(req.userId);
  if (!user) throw new AppError('用户不存在', 404);
  if (!userService.verifyPassword(oldPassword || '', user.password_hash)) {
    throw new AppError('当前密码不正确', 400);
  }

  userService.changePassword(req.userId, newPassword);
  log.info('用户修改密码', { userId: req.userId, username: req.user.username });
  res.json({ success: true, message: '密码已更新' });
};

/**
 * 用户列表（仅管理员）
 */
const listUsers = (req, res) => {
  res.json({ success: true, data: userService.listUsers() });
};

/**
 * 创建用户（仅管理员）
 */
const createUser = (req, res) => {
  const created = userService.createUser(req.body);
  res.json({ success: true, user: created, message: '用户已创建' });
};

/**
 * 删除用户（仅管理员）
 */
const deleteUser = (req, res) => {
  userService.deleteUser(req.params.id, req.user);
  res.json({ success: true, message: '用户已删除' });
};

/**
 * 修改用户角色（仅管理员）
 */
const changeRole = (req, res) => {
  userService.changeRole(req.params.id, req.body.role, req.user);
  res.json({ success: true, message: '角色已更新' });
};

module.exports = {
  login,
  register,
  logout,
  me,
  changePassword,
  listUsers,
  createUser,
  deleteUser,
  changeRole,
};
