const cors = require('cors');
const log = require('../utils/logger');

/**
 * CORS 配置
 */
const getCorsOptions = () => {
  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim())
    : ['*'];

  // 鉴权走 Authorization Bearer 头而非 Cookie，
  // 通配源下浏览器本就禁止 credentials，显式关掉避免无效组合
  const wildcard = allowedOrigins.includes('*');

  return {
    origin: (origin, callback) => {
      // 允许所有源
      if (wildcard) {
        callback(null, true);
        return;
      }

      // 允许没有 origin 的请求（如移动应用或 Postman）
      if (!origin) {
        callback(null, true);
        return;
      }

      // 检查是否在白名单中
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        log.warn('CORS阻止的请求', { origin });
        callback(new Error('不允许的跨域请求'));
      }
    },
    credentials: !wildcard,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge: 86400, // 24小时
  };
};

// 创建 CORS 中间件
const corsMiddleware = cors(getCorsOptions());

module.exports = corsMiddleware;


