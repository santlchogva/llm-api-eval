/**
 * UserService - 用户账号管理
 *
 * 多用户支持的核心：
 *   - 密码使用 scrypt 加盐哈希存储（Node 内置 crypto，无需额外依赖），
 *     校验用 timingSafeEqual，避免时序侧信道
 *   - 首次启动自动创建默认管理员（用户名 admin，密码取 DEFAULT_ADMIN_PASSWORD，
 *     未设置时为 admin），避免系统无账号可用；旧版本 admin 仍在使用 AUTH_SECRET
 *     作为初始密码时，启动时自动重置为新的默认密码
 */
const crypto = require('crypto');
const db = require('../../database');
const config = require('../config');
const log = require('../utils/logger');
const { AppError } = require('../middlewares/errorHandler');

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

/** 生成加盐 scrypt 哈希，格式：scrypt$<salt hex>$<hash hex> */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTS).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/** 校验密码（timing-safe） */
function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const candidate = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
    const expected = Buffer.from(hash, 'hex');
    if (candidate.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidate, expected);
  } catch (error) {
    return false;
  }
}

class UserService {
  /**
   * 初始化：确保至少有一个管理员账号，并把旧默认密码迁移到新默认值
   */
  initDefaultAdmin() {
    try {
      const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
      const password = process.env.DEFAULT_ADMIN_PASSWORD || 'admin';

      if (db.countUsers() === 0) {
        db.createUser({ username, passwordHash: hashPassword(password), role: 'admin' });
        log.info(`已创建默认管理员账号: ${username}，初始密码: ${password}（可用 DEFAULT_ADMIN_PASSWORD 覆盖，请尽快修改）`);
        return;
      }

      // 兼容迁移：旧版本将 AUTH_SECRET 作为 admin 初始密码；若该账号仍在使用，
      // 启动时重置为当前默认密码，避免老用户升级后无法用 admin/admin 登录
      const admin = db.getUserByUsername(username);
      if (admin && config.authSecret && verifyPassword(config.authSecret, admin.password_hash)) {
        db.updateUserPassword(admin.id, hashPassword(password));
        log.info(`已将默认管理员 ${username} 的旧初始密码重置为 ${password}（可用 DEFAULT_ADMIN_PASSWORD 覆盖）`);
      }
    } catch (error) {
      log.error('初始化默认管理员失败', { error: error.message });
    }
  }

  /** 用户名密码校验，成功返回用户信息（不含哈希） */
  authenticate(username, password) {
    const name = String(username || 'admin').trim().toLowerCase();
    if (!password) throw new AppError('密码不能为空', 400);

    const user = db.getUserByUsername(name);
    if (!user) {
      // 用户不存在也走一次哈希比较，避免"响应时间差"暴露用户名是否存在
      hashPassword(password);
      throw new AppError('用户名或密码错误', 401);
    }
    if (!verifyPassword(password, user.password_hash)) {
      throw new AppError('用户名或密码错误', 401);
    }
    return { id: user.id, username: user.username, role: user.role };
  }

  /** 创建用户（管理员操作） */
  createUser({ username, password, role = 'user' }) {
    const name = String(username || '').trim().toLowerCase();
    if (!name) throw new AppError('用户名不能为空', 400);
    if (!/^[a-z0-9_-]{2,32}$/.test(name)) {
      throw new AppError('用户名仅支持 2-32 位字母、数字、下划线和中划线', 400);
    }
    if (!password || String(password).length < 6) {
      throw new AppError('密码长度至少为 6 位', 400);
    }
    if (!['admin', 'user'].includes(role)) {
      throw new AppError('角色必须是 admin 或 user', 400);
    }
    if (db.getUserByUsername(name)) {
      throw new AppError('用户名已存在', 409);
    }
    const id = db.createUser({ username: name, passwordHash: hashPassword(password), role });
    log.info('创建用户', { id, username: name, role });
    return { id, username: name, role };
  }

  /** 开放注册：任何人可创建普通用户账号（role 固定为 user） */
  register({ username, password }) {
    return this.createUser({ username, password, role: 'user' });
  }

  /** 用户列表（脱敏） */
  listUsers() {
    return db.getAllUsers().map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.created_at,
    }));
  }

  /** 修改密码（本人或管理员） */
  changePassword(userId, newPassword) {
    if (!newPassword || String(newPassword).length < 6) {
      throw new AppError('密码长度至少为 6 位', 400);
    }
    const ok = db.updateUserPassword(userId, hashPassword(newPassword));
    if (!ok) throw new AppError('用户不存在', 404);
    return true;
  }

  /** 删除用户（管理员操作，不能删除自己、不能删除最后一个管理员） */
  deleteUser(targetId, operator) {
    if (Number(targetId) === Number(operator.id)) {
      throw new AppError('不能删除当前登录的账号', 400);
    }
    const target = db.getUserById(targetId);
    if (!target) throw new AppError('用户不存在', 404);
    if (target.role === 'admin' && this.listUsers().filter((u) => u.role === 'admin').length <= 1) {
      throw new AppError('系统至少需要保留一个管理员账号', 400);
    }
    db.deleteUser(targetId);
    log.info('删除用户', { targetId, operator: operator.username });
    return true;
  }

  /** 修改用户角色（管理员操作） */
  changeRole(targetId, role, operator) {
    if (!['admin', 'user'].includes(role)) {
      throw new AppError('角色必须是 admin 或 user', 400);
    }
    if (Number(targetId) === Number(operator.id) && role !== 'admin') {
      throw new AppError('不能降级当前登录的账号', 400);
    }
    const ok = db.updateUserRole(targetId, role);
    if (!ok) throw new AppError('用户不存在', 404);
    return true;
  }
}

module.exports = new UserService();
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
