const express = require('express');
const router = express.Router();
const benchmarkController = require('../controllers/benchmarkController');
const { authenticate } = require('../middlewares/auth');
const { asyncHandler } = require('../middlewares/errorHandler');

/**
 * @swagger
 * /api/benchmark/start:
 *   post:
 *     summary: 启动 Token 级速度测试（解码/并发/预填充）
 *     tags: [速度测试]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [providerType, url, modelName, apiKey]
 *             properties:
 *               providerType:
 *                 type: string
 *                 enum: [openai, responses, anthropic, gemini]
 *               url:
 *                 type: string
 *                 description: Base URL
 *               modelName:
 *                 type: string
 *               apiKey:
 *                 type: string
 *               runs:
 *                 type: number
 *                 description: 单流解码测速轮数（默认3，最多10）
 *               concurrency:
 *                 type: number
 *                 description: 并发路数（默认4，最多16）
 *               outputTokens:
 *                 type: number
 *                 description: 每轮最大输出 token 数（默认512）
 *               prefillTokens:
 *                 type: number
 *                 description: 预填充测速的提示词规模（默认8000，0为跳过）
 *     responses:
 *       200:
 *         description: 速度测试已启动
 *       400:
 *         description: 参数错误或已有测试在运行
 */
router.post('/start', authenticate, asyncHandler(benchmarkController.startBenchmark));

/**
 * @swagger
 * /api/benchmark/stop:
 *   post:
 *     summary: 停止速度测试
 *     tags: [速度测试]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: 停止请求已提交
 */
router.post('/stop', authenticate, asyncHandler(benchmarkController.stopBenchmark));

/**
 * @swagger
 * /api/benchmark/status:
 *   get:
 *     summary: 获取速度测试当前状态
 *     tags: [速度测试]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: 当前状态
 */
router.get('/status', authenticate, asyncHandler(benchmarkController.getBenchmarkStatus));

/**
 * @swagger
 * /api/benchmark/reports:
 *   get:
 *     summary: 获取测速报告列表
 *     tags: [速度测试]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: 报告列表
 */
router.get('/reports', authenticate, asyncHandler(benchmarkController.getReports));

/**
 * @swagger
 * /api/benchmark/reports/{id}:
 *   get:
 *     summary: 获取单条测速报告详情
 *     tags: [速度测试]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: 报告详情
 *       404:
 *         description: 报告不存在
 */
router.get('/reports/:id', authenticate, asyncHandler(benchmarkController.getReportById));

/**
 * @swagger
 * /api/benchmark/reports/{id}:
 *   delete:
 *     summary: 删除测速报告
 *     tags: [速度测试]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: 删除成功
 */
router.delete('/reports/:id', authenticate, asyncHandler(benchmarkController.deleteReport));

module.exports = router;
