const express = require('express');
const router = express.Router();

const authRoutes = require('./auth');
const userRoutes = require('./users');
const testRoutes = require('./test');
const historyRoutes = require('./history');
const scheduleRoutes = require('./schedule');
const parallelRoutes = require('./parallel');
const benchmarkRoutes = require('./benchmark');
const datasetRoutes = require('./datasets');
const qualityRoutes = require('./quality');
const presetRoutes = require('./presets');

// 挂载路由
router.use('/', authRoutes);
router.use('/users', userRoutes);
router.use('/', testRoutes);
router.use('/history', historyRoutes);
router.use('/schedules', scheduleRoutes);
router.use('/parallel', parallelRoutes);
router.use('/benchmark', benchmarkRoutes);
router.use('/datasets', datasetRoutes);
router.use('/quality', qualityRoutes);
router.use('/presets', presetRoutes);

module.exports = router;
