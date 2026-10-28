const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate, requireAdmin } = require('../middlewares/auth');
const { validateId } = require('../middlewares/validator');
const { asyncHandler } = require('../middlewares/errorHandler');

// 用户自助操作
router.get('/me', authenticate, asyncHandler(authController.me));
router.post('/change-password', authenticate, asyncHandler(authController.changePassword));

// 管理员：用户管理
router.get('/', authenticate, requireAdmin, asyncHandler(authController.listUsers));
router.post('/', authenticate, requireAdmin, asyncHandler(authController.createUser));
router.delete('/:id', authenticate, requireAdmin, validateId, asyncHandler(authController.deleteUser));
router.post('/:id/role', authenticate, requireAdmin, validateId, asyncHandler(authController.changeRole));

module.exports = router;
