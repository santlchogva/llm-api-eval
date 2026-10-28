const express = require('express');
const router = express.Router();
const qualityController = require('../controllers/qualityController');
const { authenticate } = require('../middlewares/auth');
const { asyncHandler } = require('../middlewares/errorHandler');

/**
 * @swagger
 * /api/quality/run:
 *   post:
 *     summary: 执行模型质量测试
 *     description: |
 *       用最小成本验证中转接口与官方协议的一致性，以及工具调用、结构化输出等特殊能力。
 *       可选填写官方 baseline，填写后会双跑并输出字段级差异。
 *     tags: [质量测试]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url, apiKey, modelName]
 *             properties:
 *               protocol:
 *                 type: string
 *                 enum: [openai, anthropic]
 *               url:
 *                 type: string
 *                 description: 被测接口的 base_url
 *               apiKey:
 *                 type: string
 *               modelName:
 *                 type: string
 *               checks:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: 要执行的检查项，默认执行全部低成本项
 *               baseline:
 *                 type: object
 *                 description: 官方对照配置，结构同 url/apiKey/modelName/protocol
 *     responses:
 *       200:
 *         description: 测试完成，返回完整报告
 */
router.post('/run', authenticate, asyncHandler(qualityController.run));

/**
 * @swagger
 * /api/quality/run-async:
 *   post:
 *     summary: 异步执行模型质量测试（立即返回任务句柄）
 *     description: |
 *       测试在后台跑，前端用 GET /api/quality/job 轮询进度。
 *       页面刷新/切走后任务仍在继续，完成后报告写入数据库。
 *     tags: [质量测试]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       202:
 *         description: 已提交
 */
router.post('/run-async', authenticate, asyncHandler(qualityController.runAsync));

/**
 * @swagger
 * /api/quality/job:
 *   get:
 *     summary: 查询最近一次异步质量测试任务
 *     tags: [质量测试]
 *     security:
 *       - BearerAuth: []
 */
router.get('/job', authenticate, asyncHandler(qualityController.getJob));

/**
 * @swagger
 * /api/quality/checks:
 *   get:
 *     summary: 获取质量检查项目录
 *     tags: [质量测试]
 *     security:
 *       - BearerAuth: []
 */
router.get('/checks', authenticate, asyncHandler(qualityController.getChecks));

/**
 * @swagger
 * /api/quality/reports:
 *   get:
 *     summary: 历史质量报告列表
 *     tags: [质量测试]
 *     security:
 *       - BearerAuth: []
 */
router.get('/reports', authenticate, asyncHandler(qualityController.listReports));

/**
 * @swagger
 * /api/quality/reports/{id}:
 *   get:
 *     summary: 质量报告详情
 *     tags: [质量测试]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/reports/:id', authenticate, asyncHandler(qualityController.getReport));

/**
 * @swagger
 * /api/quality/reports/clear:
 *   post:
 *     summary: 清空历史质量报告
 *     tags: [质量测试]
 *     security:
 *       - BearerAuth: []
 */
router.post('/reports/clear', authenticate, asyncHandler(qualityController.clearReports));

/**
 * @swagger
 * /api/quality/reports/{id}:
 *   delete:
 *     summary: 删除质量报告
 *     tags: [质量测试]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.delete('/reports/:id', authenticate, asyncHandler(qualityController.deleteReport));

/**
 * @swagger
 * /api/quality/status:
 *   get:
 *     summary: 质量测试运行状态
 *     tags: [质量测试]
 *     security:
 *       - BearerAuth: []
 */
router.get('/status', authenticate, asyncHandler(qualityController.getStatus));

module.exports = router;
