const express = require('express');
const router = express.Router();
const datasetController = require('../controllers/datasetController');
const { authenticate } = require('../middlewares/auth');
const { asyncHandler } = require('../middlewares/errorHandler');

/**
 * @swagger
 * /api/datasets:
 *   get:
 *     summary: 获取内置压测数据集列表
 *     tags: [数据集]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: 成功获取数据集列表
 */
router.get('/', authenticate, asyncHandler(datasetController.listDatasets));

/**
 * @swagger
 * /api/datasets/synthesize:
 *   post:
 *     summary: 按目标 token 数合成测试请求
 *     tags: [数据集]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [targetTokens]
 *             properties:
 *               targetTokens:
 *                 type: integer
 *                 description: 目标输入长度（token）
 *               question:
 *                 type: string
 *                 description: 附加在长材料末尾的问题
 *     responses:
 *       200:
 *         description: 成功合成请求
 */
router.post('/synthesize', authenticate, asyncHandler(datasetController.synthesizePrompt));

/**
 * @swagger
 * /api/datasets/parse:
 *   post:
 *     summary: 解析导入的数据集文本（CSV / JSONL / JSON 数组 / 纯文本）
 *     tags: [数据集]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content:
 *                 type: string
 *               column:
 *                 type: string
 *                 description: CSV 取值列名
 *               limit:
 *                 type: integer
 *                 description: 最多解析条数
 *     responses:
 *       200:
 *         description: 成功解析
 */
router.post('/parse', authenticate, asyncHandler(datasetController.parseDataset));

/**
 * @swagger
 * /api/datasets/{id}:
 *   get:
 *     summary: 获取单个数据集详情
 *     tags: [数据集]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: 成功获取数据集
 *       404:
 *         description: 数据集不存在
 */
router.get('/:id', authenticate, asyncHandler(datasetController.getDataset));

module.exports = router;
