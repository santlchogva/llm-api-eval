/**
 * ScheduleController - 定时任务控制器
 * 处理定时任务相关的 API 请求（数据按用户隔离，管理员可见全部）
 */
const scheduleService = require('../services/scheduleService');

const scopeOf = (req) => [req.userId, req.user && req.user.role === 'admin'];

/**
 * 创建定时任务
 * POST /api/schedules
 */
const createSchedule = (req, res) => {
  const schedule = scheduleService.create({ ...req.body, userId: req.userId });
  res.status(201).json({
    success: true,
    message: '定时任务创建成功',
    data: schedule,
  });
};

/**
 * 获取所有定时任务
 * GET /api/schedules
 */
const getAllSchedules = (req, res) => {
  const [userId, isAdmin] = scopeOf(req);
  const schedules = scheduleService.getAll(userId, isAdmin);
  res.json({
    success: true,
    data: schedules,
  });
};

/**
 * 获取单个任务详情
 * GET /api/schedules/:id
 */
const getScheduleById = (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({
      success: false,
      message: '无效的任务 ID',
    });
  }
  
  const schedule = scheduleService.getById(id, ...scopeOf(req));
  if (!schedule) {
    return res.status(404).json({ success: false, message: '任务不存在' });
  }
  res.json({
    success: true,
    data: schedule,
  });
};


/**
 * 更新任务配置
 * PUT /api/schedules/:id
 */
const updateSchedule = (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({
      success: false,
      message: '无效的任务 ID',
    });
  }
  
  const schedule = scheduleService.update(id, req.body, ...scopeOf(req));
  res.json({
    success: true,
    message: '定时任务更新成功',
    data: schedule,
  });
};

/**
 * 删除任务
 * DELETE /api/schedules/:id
 */
const deleteSchedule = (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({
      success: false,
      message: '无效的任务 ID',
    });
  }
  
  scheduleService.delete(id, ...scopeOf(req));
  res.json({
    success: true,
    message: '定时任务删除成功',
  });
};

/**
 * 切换任务启用状态
 * POST /api/schedules/:id/toggle
 */
const toggleSchedule = (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({
      success: false,
      message: '无效的任务 ID',
    });
  }
  
  const schedule = scheduleService.toggle(id, ...scopeOf(req));
  if (!schedule) {
    return res.status(404).json({ success: false, message: '任务不存在' });
  }
  res.json({
    success: true,
    message: schedule.enabled ? '定时任务已启用' : '定时任务已禁用',
    data: schedule,
  });
};

module.exports = {
  createSchedule,
  getAllSchedules,
  getScheduleById,
  updateSchedule,
  deleteSchedule,
  toggleSchedule,
};
