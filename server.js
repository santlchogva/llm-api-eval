const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const config = require('./src/config');
const log = require('./src/utils/logger');
const db = require('./database');
const setupSwagger = require('./src/swagger');
const stressTestService = require('./src/services/stressTestService');
const sessionService = require('./src/services/sessionService');
const userService = require('./src/services/userService');
const parallelTestService = require('./src/services/parallelTestService');
const scheduleService = require('./src/services/scheduleService');
const benchmarkService = require('./src/services/benchmarkService');
const MemoryMonitor = require('./src/utils/memoryMonitor');

// 创建内存监控实例（用于 /metrics 端点）
const memoryMonitor = new MemoryMonitor();

// 导入中间件
const corsMiddleware = require('./src/middlewares/cors');
const { rateLimitMiddleware } = require('./src/middlewares/rateLimiter');
const { notFound, errorHandler } = require('./src/middlewares/errorHandler');

// 导入路由
const apiRoutes = require('./src/routes');

// 创建应用
const app = express();
const server = http.createServer(app);

// WebSocket 握手鉴权
// 浏览器 WebSocket API 无法自定义请求头，因此令牌通过查询串传入：
//   ws://host/?token=<会话令牌>
// 校验不通过直接拒绝握手，避免未登录者围观全部压测数据。
const wss = new WebSocket.Server({
  server,
  verifyClient: (info, done) => {
    let token = null;
    try {
      token = new URL(info.req.url, 'http://localhost').searchParams.get('token');
    } catch (error) {
      token = null;
    }

    const session = token ? sessionService.get(token) : null;
    if (!session) {
      log.warn('WebSocket 握手被拒绝：会话无效', {
        ip: info.req.socket && info.req.socket.remoteAddress,
      });
      done(false, 401, 'Unauthorized');
      return;
    }

    // 用户身份挂到连接上，供各服务做"按用户归属下发"的过滤
    info.req.userId = session.userId;
    info.req.username = session.username;
    done(true);
  },
});

// ===================================
// 中间件配置
// ===================================

// CORS
app.use(corsMiddleware);

// 请求体解析（多模态素材可能以 base64 内联提交，放宽到 40mb）
app.use(express.json({ limit: '40mb' }));
app.use(express.urlencoded({ extended: true, limit: '40mb' }));

// 请求频率限制（仅限制控制面板API，不影响压测功能）
app.use('/api/', rateLimitMiddleware);

// 静态文件服务
app.use(express.static('public'));

// 请求日志
app.use((req, res, next) => {
  log.debug(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  next();
});

// ===================================
// API 路由
// ===================================

app.use('/api', apiRoutes);

// ===================================
// Swagger API 文档
// ===================================

// 默认启用API文档，除非明确禁用
if (process.env.DISABLE_API_DOCS !== 'true') {
  try {
    setupSwagger(app);
    log.info('Swagger API 文档已启用: /api-docs');
  } catch (error) {
    log.error('Swagger初始化失败', { error: error.message });
  }
}

// ===================================
// 页面路由
// ===================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/history', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

app.get('/schedule', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'schedule.html'));
});

app.get('/parallel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'parallel.html'));
});

app.get('/benchmark', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'benchmark.html'));
});

app.get('/quality', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quality.html'));
});

app.get('/detail', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'detail.html'));
});

// 版本号端点（用于前端动态获取）
const packageJson = require('./package.json');
app.get('/api/version', (req, res) => {
  res.json({
    version: packageJson.version,
    name: packageJson.name,
  });
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: config.nodeEnv,
    version: packageJson.version,
  });
});

// 系统信息端点
app.get('/metrics', (req, res) => {
  const state = stressTestService.getState();
  const memoryUsage = memoryMonitor.getMemoryUsage();

  res.json({
    isRunning: state.isRunning,
    totalRequests: state.stats.totalRequests,
    successRate: state.stats.successRate,
    currentRPM: state.currentRPM,
    uptime: process.uptime(),
    memory: {
      // 原始字节值
      heapUsed: memoryUsage?.heapUsed || 0,
      heapTotal: memoryUsage?.heapTotal || 0,
      rss: memoryUsage?.rss || 0,
      external: memoryUsage?.external || 0,
      // MB 格式（便于阅读）
      heapUsedMB: memoryUsage?.heapUsedMB || 0,
      heapTotalMB: memoryUsage?.heapTotalMB || 0,
      rssMB: memoryUsage?.rssMB || 0,
      externalMB: memoryUsage?.externalMB || 0,
      // 时间戳
      timestamp: memoryUsage?.timestamp || new Date().toISOString()
    }
  });
});

// ===================================
// WebSocket 连接处理
// ===================================

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  // 用户身份挂到连接上，供各服务做"按用户归属下发"的过滤
  ws.userId = req.userId || null;
  ws.username = req.username || null;
  ws.isAlive = true;
  log.info('新WebSocket连接', { ip: clientIp, userId: ws.userId, username: ws.username });

  // 添加客户端到服务
  stressTestService.addClient(ws);
  parallelTestService.addClient(ws);
  benchmarkService.addClient(ws);

  // 发送当前状态（按用户归属脱敏：他人的压测数据不下发）
  try {
    ws.send(JSON.stringify({
      type: 'stateUpdate',
      data: stressTestService.getStateFor(ws.userId),
    }));
  } catch (error) {
    log.error('发送状态失败', { error: error.message });
  }

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      log.debug('收到WebSocket消息', { type: data.type });

      // 处理客户端消息（如果需要）
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (error) {
      log.error('解析WebSocket消息失败', { error: error.message });
    }
  });

  ws.on('close', () => {
    stressTestService.removeClient(ws);
    parallelTestService.removeClient(ws);
    benchmarkService.removeClient(ws);
    log.info('WebSocket连接关闭', { ip: clientIp });
  });

  ws.on('error', (error) => {
    log.error('WebSocket错误', { error: error.message, ip: clientIp });
  });
});

// 心跳检测（服务级单一循环）：
// 只 ping 不查 pong 的话，浏览器崩溃/断网产生的死连接会永远留在 clients
// 集合里，广播时反复向已失效的 socket 写数据。连续一个周期无 pong 直接 terminate。
const HEARTBEAT_MS = config.websocket.heartbeatInterval || 30000;
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch (error) { /* 忽略 */ }
      return;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (error) {
      log.error('心跳发送失败', { error: error.message });
    }
  });
}, HEARTBEAT_MS);
heartbeatTimer.unref();

wss.on('close', () => clearInterval(heartbeatTimer));

// ===================================
// 错误处理
// ===================================

// 404 处理
app.use(notFound);

// 全局错误处理
app.use(errorHandler);

// ===================================
// 启动服务器
// ===================================

server.listen(config.port, () => {
  // 首次启动创建默认管理员（admin / admin，可用 DEFAULT_ADMIN_PASSWORD 覆盖），保证系统有账号可用
  userService.initDefaultAdmin();

  // 恢复定时任务调度（加载数据库中已启用的任务）
  try {
    scheduleService.init();
  } catch (error) {
    log.error('定时任务服务初始化失败', { error: error.message });
  }

  log.info(`
╔════════════════════════════════════════════╗
║        LLM-API-Eval v${packageJson.version}                ║
║        大模型 API 接口压测平台              ║
╚════════════════════════════════════════════╝

✓ 服务器运行在: http://localhost:${config.port}
✓ WebSocket: ws://localhost:${config.port}
✓ API文档: http://localhost:${config.port}/api-docs
✓ 健康检查: http://localhost:${config.port}/health
✓ 系统指标: http://localhost:${config.port}/metrics

环境: ${config.nodeEnv}
日志级别: ${config.logging.level}

⚠️  默认管理员账号: admin（初始密码 admin，可用 DEFAULT_ADMIN_PASSWORD 覆盖，请尽快修改）
  `);
});

// 优雅关闭
function gracefulShutdown(signal) {
  log.info(`收到${signal}信号，准备关闭服务器...`);

  // 停止接受新连接
  server.close(() => {
    log.info('HTTP服务器已关闭');
  });

  // 关闭所有WebSocket连接
  wss.clients.forEach(client => {
    try {
      client.close();
    } catch (error) {
      log.error('关闭WebSocket连接失败', { error: error.message });
    }
  });

  // 关闭WebSocket服务器
  wss.close(() => {
    log.info('WebSocket服务器已关闭');
  });

  // 设置超时强制退出（5秒后）
  const forceExitTimer = setTimeout(() => {
    log.warn('强制退出（超时）');
    process.exit(1);
  }, 5000);
  forceExitTimer.unref();

  // 收尾：持久化缓冲落库、关闭数据库连接后退出
  setTimeout(() => {
    try {
      stressTestService.flushRequestLogs();
    } catch (error) {
      log.error('关闭时下发请求日志失败', { error: error.message });
    }
    try {
      db.close();
      log.info('数据库连接已关闭');
    } catch (error) {
      log.error('关闭数据库失败', { error: error.message });
    }
    log.info('服务器已安全关闭');
    process.exit(0);
  }, 1000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 未捕获的异常处理
process.on('uncaughtException', (error) => {
  log.error('未捕获的异常', { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('未处理的Promise拒绝', { reason, promise });
});

module.exports = { app, server };
