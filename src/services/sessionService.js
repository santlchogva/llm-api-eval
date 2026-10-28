/**
 * SessionService - 登录会话管理
 *
 * 多用户模式：登录校验通过后签发一枚**独立会话令牌**（随机 UUID），
 * 会话中记录用户身份（userId / username / role），用于：
 *   1. 接口鉴权（替代"令牌即口令"）
 *   2. WebSocket 握手鉴权
 *   3. 压测/测速/并行任务的归属判定与广播隔离（按 userId，而非 sessionId）
 *
 * 会话保存在内存中：进程重启后所有会话失效，需要重新登录。
 * 这是刻意选择——令牌不落盘，避免口令或令牌被持久化到磁盘。
 */
const crypto = require('crypto');
const config = require('../config');
const log = require('../utils/logger');

const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 过期会话清理间隔

class SessionService {
  constructor() {
    /** @type {Map<string, {id:string, userId:number, username:string, role:string, ip:string, createdAt:number, lastSeenAt:number}>} */
    this.sessions = new Map();
    this.ttlMs = (parseInt(config.security.tokenExpiry) || 86400) * 1000;
    this.sweepTimer = null;
  }

  /**
   * 为指定用户签发一个新会话
   * @param {{user:{id:number,username:string,role:string}, ip?:string}} params
   * @returns {string} 会话令牌
   */
  create({ user, ip = '' }) {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.sessions.set(id, {
      id,
      userId: user.id,
      username: user.username,
      role: user.role,
      ip,
      createdAt: now,
      lastSeenAt: now,
    });
    this.startSweeper();
    return id;
  }

  /**
   * 取会话（不存在或过期返回 null）
   * @param {string|null|undefined} id
   */
  get(id) {
    if (!id || typeof id !== 'string') return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (Date.now() - session.lastSeenAt > this.ttlMs) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  /**
   * 校验会话是否有效；有效则刷新活跃时间
   * @param {string|null|undefined} id
   * @returns {boolean}
   */
  isValid(id) {
    return !!this.get(id);
  }

  /** 触达会话（刷新活跃时间） */
  touch(id) {
    const session = this.get(id);
    if (session) session.lastSeenAt = Date.now();
    return session;
  }

  /**
   * 主动登出
   * @param {string} id
   * @returns {boolean} 是否确实删除了会话
   */
  remove(id) {
    return this.sessions.delete(id);
  }

  /** 当前有效会话数 */
  count() {
    return this.sessions.size;
  }

  /** 启动过期清理定时器（懒启动，且不阻塞进程退出） */
  startSweeper() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  /** 清理过期会话 */
  sweep() {
    const now = Date.now();
    let removed = 0;
    this.sessions.forEach((session, id) => {
      if (now - session.lastSeenAt > this.ttlMs) {
        this.sessions.delete(id);
        removed++;
      }
    });
    if (removed > 0) {
      log.debug('清理过期会话', { removed, remaining: this.sessions.size });
    }
  }
}

module.exports = new SessionService();
