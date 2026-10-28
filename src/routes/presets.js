const express = require('express');
const router = express.Router();
const presetController = require('../controllers/presetController');
const { authenticate } = require('../middlewares/auth');
const { validateId } = require('../middlewares/validator');
const { asyncHandler } = require('../middlewares/errorHandler');

/**
 * 目标预设：保存常用的被测接口配置，一键选用
 */
router.get('/', authenticate, asyncHandler(presetController.list));
router.post('/', authenticate, asyncHandler(presetController.create));
router.put('/:id', authenticate, validateId, asyncHandler(presetController.update));
router.delete('/:id', authenticate, validateId, asyncHandler(presetController.remove));

module.exports = router;
