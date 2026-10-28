const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { validateLogin, validateRegister } = require('../middlewares/validator');
const { asyncHandler } = require('../middlewares/errorHandler');
const { authenticate } = require('../middlewares/auth');

/**
 * @swagger
 * /api/login:
 *   post:
 *     summary: 用户登录
 *     tags: [认证]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - password
 *             properties:
 *               password:
 *                 type: string
 *                 description: 登录密码
 *     responses:
 *       200:
 *         description: 登录成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 token:
 *                   type: string
 *                 message:
 *                   type: string
 *       401:
 *         description: 密码错误
 */
router.post('/login', validateLogin, asyncHandler(authController.login));

/**
 * @swagger
 * /api/register:
 *   post:
 *     summary: 开放注册（注册即登录）
 *     tags: [认证]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *                 description: 用户名，2-32 位字母/数字/下划线/中划线
 *               password:
 *                 type: string
 *                 description: 密码，至少 6 位
 *     responses:
 *       201:
 *         description: 注册成功，返回会话令牌
 *       400:
 *         description: 参数错误
 *       409:
 *         description: 用户名已存在
 */
router.post('/register', validateRegister, asyncHandler(authController.register));

/**
 * @swagger
 * /api/logout:
 *   post:
 *     summary: 登出（销毁当前会话）
 *     tags: [认证]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: 已登出
 *       401:
 *         description: 未授权
 */
router.post('/logout', authenticate, asyncHandler(authController.logout));

module.exports = router;


