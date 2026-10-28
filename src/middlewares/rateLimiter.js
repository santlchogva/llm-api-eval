const log = require('../utils/logger');

/**
 * 简单的内存存储的请求频率限制器（令牌桶，O(1) 判定）
 *
 * 注意：此限流器仅用于保护控制面板 API（登录、启动测试等），
 * 不会影响测压功能本身发送给 AI 模型的请求。
 * 测压请求在 stressTestService 中直接发送，可以达到几万 RPM。
 */
class RateLimiter {
  constructor(options = {}) {
    this.maxRequests = options.max || 300;
    this.windowMs = (options.windowMinutes || 1) * 60 * 1000;
    // 令牌桶：容量 maxRequests，按 maxRequests/windowMs 的速率匀速补充
    this.buckets = new Map();

    // 定期清理长期不活跃的桶，避免 Map 无限增长
    this.cleanupTimer = setInterval(() => this.cleanup(), this.windowMs);
    if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref();
  }

  /**
   * 检查请求是否超过限制
   */
  check(identifier) {
    const now = Date.now();
    const refillRate = this.maxRequests / this.windowMs; // tokens per ms

    let bucket = this.buckets.get(identifier);
    if (!bucket) {
      bucket = { tokens: this.maxRequests, lastRefillAt: now };
      this.buckets.set(identifier, bucket);
    }

    // 按经过的时间补充令牌
    const elapsed = now - bucket.lastRefillAt;
    if (elapsed > 0) {
      bucket.tokens = Math.min(this.maxRequests, bucket.tokens + elapsed * refillRate);
      bucket.lastRefillAt = now;
    }

    if (bucket.tokens < 1) {
      const retryAfterMs = (1 - bucket.tokens) / refillRate;
      return {
        allowed: false,
        remaining: 0,
        resetTime: now + retryAfterMs,
      };
    }

    bucket.tokens -= 1;
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      resetTime: now + this.windowMs,
    };
  }

  /**
   * 清理长期不活跃的桶
   */
  cleanup() {
    const now = Date.now();
    const refillRate = this.maxRequests / this.windowMs;
    for (const [identifier, bucket] of this.buckets.entries()) {
      // 距上次访问超过一个窗口且桶已回满，视为不活跃
      const idleFor = now - bucket.lastRefillAt;
      if (idleFor > this.windowMs && bucket.tokens + idleFor * refillRate >= this.maxRequests) {
        this.buckets.delete(identifier);
      }
    }
  }

  /**
   * 重置某个标识符的限制
   */
  reset(identifier) {
    this.buckets.delete(identifier);
  }
}

// 创建全局限流器实例
const limiter = new RateLimiter({
  max: parseInt(process.env.RATE_LIMIT_MAX) || 300,
  windowMinutes: parseInt(process.env.RATE_LIMIT_WINDOW) || 1,
});

/**
 * 请求频率限制中间件
 */
const rateLimitMiddleware = (req, res, next) => {
  // 使用 IP 地址作为标识符
  const identifier = req.ip || req.connection.remoteAddress;

  const result = limiter.check(identifier);

  // 设置响应头
  res.setHeader('X-RateLimit-Limit', limiter.maxRequests);
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset', new Date(result.resetTime).toISOString());

  if (!result.allowed) {
    log.warn('请求频率超限', {
      ip: identifier,
      path: req.path,
    });

    return res.status(429).json({
      success: false,
      error: '请求过于频繁，请稍后再试',
      retryAfter: Math.ceil((result.resetTime - Date.now()) / 1000),
    });
  }

  next();
};

module.exports = {
  RateLimiter,
  rateLimitMiddleware,
  limiter,
};
