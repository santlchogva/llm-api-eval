const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./src/config');

// 使用配置文件中的数据库路径
const dbPath = path.resolve(config.database.path);
const dbDir = path.dirname(dbPath);

// 确保数据库目录存在
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log(`数据库目录已创建: ${dbDir}`);
}

// 创建或打开数据库
console.log(`数据库路径: ${dbPath}`);
const db = new Database(dbPath);
console.log('数据库连接成功');

// ==================== 连接参数 ====================
// WAL 模式：读写不再互斥，压测落库不会阻塞列表查询；
// busy_timeout：并发写偶发锁冲突时自动等待，而不是直接抛 SQLITE_BUSY。
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

// ==================== 表结构 ====================

// 用户表（多用户支持）
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// 创建历史记录表
db.exec(`
  CREATE TABLE IF NOT EXISTS test_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    duration INTEGER NOT NULL,
    test_url TEXT NOT NULL,
    model_name TEXT NOT NULL,
    test_mode TEXT NOT NULL,
    prompt_mode TEXT NOT NULL,
    request_type TEXT NOT NULL,
    target_rpm INTEGER NOT NULL,
    max_rpm INTEGER,
    total_requests INTEGER NOT NULL,
    success_count INTEGER NOT NULL,
    failure_count INTEGER NOT NULL,
    success_rate REAL NOT NULL,
    avg_response_time INTEGER NOT NULL,
    stop_reason TEXT,
    minute_stats TEXT,
    error_summary TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 创建定时任务表
db.exec(`
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    test_config TEXT NOT NULL,
    schedule_type TEXT NOT NULL,
    run_at TEXT,
    cron_expression TEXT,
    enabled INTEGER DEFAULT 1,
    last_run_at TEXT,
    next_run_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// 创建测速报告表
db.exec(`
  CREATE TABLE IF NOT EXISTS benchmark_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    base_url TEXT NOT NULL,
    model_name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    duration INTEGER,
    config TEXT,
    result TEXT
  )
`);

// 创建模型质量报告表（质量测试结果持久化，重启不丢）
db.exec(`
  CREATE TABLE IF NOT EXISTS quality_reports (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    target_url TEXT NOT NULL,
    target_model TEXT NOT NULL,
    target_protocol TEXT,
    baseline_url TEXT,
    baseline_model TEXT,
    baseline_protocol TEXT,
    score INTEGER DEFAULT 0,
    pass_count INTEGER DEFAULT 0,
    warn_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    skip_count INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    conclusion TEXT,
    report TEXT NOT NULL
  )
`);

// 目标预设表：保存常用的被测接口配置（含密钥），启动压测时可一键选用
db.exec(`
  CREATE TABLE IF NOT EXISTS target_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    model_name TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',
    provider_type TEXT NOT NULL DEFAULT 'openai',
    request_type TEXT NOT NULL DEFAULT 'stream',
    test_prompt TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_quality_created ON quality_reports(created_at DESC)`);

// ==================== 兼容旧库的字段补充 ====================

// 给已有表补充 user_id 列（多用户数据隔离）
//   - 历史数据 user_id 为 NULL，视为公共数据：管理员可见，普通用户不可见
(() => {
  const addUserColumn = (table) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!columns.includes('user_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER`);
      console.log(`表 ${table} 已补充字段: user_id`);
    }
  };
  ['test_history', 'schedules', 'benchmark_reports', 'quality_reports'].forEach(addUserColumn);
})();

// 兼容旧库：为历史记录表补充指标字段
//   - token 维度（TPM）
//   - 延迟分位数（P50/P95/P99、TTFB P95）
//   - 压测场景维度（请求复用率、并发数）
(() => {
  const columns = db.prepare(`PRAGMA table_info(test_history)`).all().map(c => c.name);
  const extraColumns = [
    ['total_prompt_tokens', 'INTEGER DEFAULT 0'],
    ['total_completion_tokens', 'INTEGER DEFAULT 0'],
    ['total_tokens', 'INTEGER DEFAULT 0'],
    ['avg_tpm', 'INTEGER DEFAULT 0'],
    ['input_tpm', 'INTEGER DEFAULT 0'],
    ['output_tpm', 'INTEGER DEFAULT 0'],
    ['p50_response_time', 'INTEGER DEFAULT 0'],
    ['p95_response_time', 'INTEGER DEFAULT 0'],
    ['p99_response_time', 'INTEGER DEFAULT 0'],
    ['ttfb_p95', 'INTEGER DEFAULT 0'],
    ['prompt_reuse_ratio', 'REAL DEFAULT 0'],
    ['actual_prompt_reuse_ratio', 'REAL DEFAULT 0'],
    ['concurrency', 'INTEGER DEFAULT 0'],
    ['peak_concurrency', 'INTEGER DEFAULT 0'],
    // 评估结果：TPOT、最大可持续 TPM 与建议容量
    ['tpot_p95', 'INTEGER DEFAULT 0'],
    ['max_tpm', 'INTEGER DEFAULT 0'],
    ['recommended_rpm', 'INTEGER DEFAULT 0'],
    ['recommended_tpm', 'INTEGER DEFAULT 0'],
    ['sla_met', 'INTEGER DEFAULT 0'],
    // 成本估算（按每百万 token 单价计算）
    ['estimated_cost', 'REAL'],
    ['input_price', 'REAL DEFAULT 0'],
    ['output_price', 'REAL DEFAULT 0'],
  ];
  extraColumns.forEach(([name, type]) => {
    if (!columns.includes(name)) {
      db.exec(`ALTER TABLE test_history ADD COLUMN ${name} ${type}`);
      console.log(`历史记录表已补充字段: ${name}`);
    }
  });
})();

// ==================== 索引 ====================
// 历史列表按时间倒序分页，无索引时全表扫描 + 排序
db.exec(`CREATE INDEX IF NOT EXISTS idx_history_created ON test_history(created_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_history_user ON test_history(user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_schedules_user ON schedules(user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_benchmark_created ON benchmark_reports(created_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_presets_user ON target_presets(user_id)`);

// ==================== 用户相关语句 ====================

const insertUser = db.prepare(`
  INSERT INTO users (username, password_hash, role) VALUES (@username, @password_hash, @role)
`);
const selectUserByUsername = db.prepare(`SELECT * FROM users WHERE username = ?`);
const selectUserById = db.prepare(`SELECT * FROM users WHERE id = ?`);
const selectAllUsers = db.prepare(`SELECT id, username, role, created_at FROM users ORDER BY id ASC`);
const updateUserPasswordStmt = db.prepare(`UPDATE users SET password_hash = @password_hash WHERE id = @id`);
const updateUserRoleStmt = db.prepare(`UPDATE users SET role = @role WHERE id = @id`);
const deleteUserStmt = db.prepare(`DELETE FROM users WHERE id = ?`);
const countUsersStmt = db.prepare(`SELECT COUNT(*) as count FROM users`);

// ==================== 目标预设相关语句 ====================

const insertPreset = db.prepare(`
  INSERT INTO target_presets (user_id, name, url, model_name, api_key, provider_type, request_type, test_prompt)
  VALUES (@user_id, @name, @url, @model_name, @api_key, @provider_type, @request_type, @test_prompt)
`);
const selectPresetsByUser = db.prepare(`
  SELECT * FROM target_presets WHERE user_id = ? ORDER BY id DESC
`);
const selectPresetById = db.prepare(`SELECT * FROM target_presets WHERE id = ?`);
const deletePresetStmt = db.prepare(`DELETE FROM target_presets WHERE id = ? AND user_id = ?`);

// ==================== 历史记录相关语句 ====================

// 插入测试记录
const insertHistory = db.prepare(`
  INSERT INTO test_history (
    start_time, end_time, duration, test_url, model_name,
    test_mode, prompt_mode, request_type, target_rpm, max_rpm,
    total_requests, success_count, failure_count, success_rate,
    avg_response_time, stop_reason, minute_stats, error_summary,
    total_prompt_tokens, total_completion_tokens, total_tokens, avg_tpm,
    input_tpm, output_tpm, p50_response_time, p95_response_time, p99_response_time,
    ttfb_p95, prompt_reuse_ratio, actual_prompt_reuse_ratio, concurrency, peak_concurrency,
    tpot_p95, max_tpm, recommended_rpm, recommended_tpm, sla_met, user_id,
    estimated_cost, input_price, output_price
  ) VALUES (
    @start_time, @end_time, @duration, @test_url, @model_name,
    @test_mode, @prompt_mode, @request_type, @target_rpm, @max_rpm,
    @total_requests, @success_count, @failure_count, @success_rate,
    @avg_response_time, @stop_reason, @minute_stats, @error_summary,
    @total_prompt_tokens, @total_completion_tokens, @total_tokens, @avg_tpm,
    @input_tpm, @output_tpm, @p50_response_time, @p95_response_time, @p99_response_time,
    @ttfb_p95, @prompt_reuse_ratio, @actual_prompt_reuse_ratio, @concurrency, @peak_concurrency,
    @tpot_p95, @max_tpm, @recommended_rpm, @recommended_tpm, @sla_met, @user_id,
    @estimated_cost, @input_price, @output_price
  )
`);

// 历史记录修剪：只保留最近 N 条，防止库无限膨胀
const pruneHistory = db.prepare(`
  DELETE FROM test_history WHERE id NOT IN (
    SELECT id FROM test_history ORDER BY created_at DESC, id DESC LIMIT @keep
  )
`);

// 获取所有历史记录（分页）
const getHistoryList = db.prepare(`
  SELECT
    id, start_time, end_time, duration, test_url, model_name,
    test_mode, prompt_mode, request_type, target_rpm, max_rpm,
    total_requests, success_count, failure_count, success_rate,
    avg_response_time, stop_reason, created_at,
    total_tokens, avg_tpm, input_tpm, output_tpm,
    p50_response_time, p95_response_time, p99_response_time,
    ttfb_p95, prompt_reuse_ratio, actual_prompt_reuse_ratio,
    concurrency, peak_concurrency,
    tpot_p95, max_tpm, recommended_rpm, recommended_tpm, sla_met,
    estimated_cost, input_price, output_price
  FROM test_history
  ORDER BY created_at DESC, id DESC
  LIMIT @limit OFFSET @offset
`);

const getHistoryListByUser = db.prepare(`
  ${getHistoryList.source.replace('FROM test_history', 'FROM test_history WHERE user_id = @user_id')}
`);

// 获取历史记录总数
const getHistoryCount = db.prepare(`SELECT COUNT(*) as count FROM test_history`);
const getHistoryCountByUser = db.prepare(`SELECT COUNT(*) as count FROM test_history WHERE user_id = @user_id`);

// 根据ID获取单条历史记录（包含详细数据）
const getHistoryById = db.prepare(`SELECT * FROM test_history WHERE id = ?`);

// 删除历史记录
const deleteHistoryStmt = db.prepare(`DELETE FROM test_history WHERE id = ?`);
const deleteHistoryByOwner = db.prepare(`DELETE FROM test_history WHERE id = ? AND user_id = ?`);

// 清空历史记录
const clearAllHistoryStmt = db.prepare(`DELETE FROM test_history`);
const clearHistoryByOwner = db.prepare(`DELETE FROM test_history WHERE user_id = ?`);

// ==================== 定时任务相关语句 ====================

const insertSchedule = db.prepare(`
  INSERT INTO schedules (
    name, description, test_config, schedule_type,
    run_at, cron_expression, enabled, next_run_at, user_id
  ) VALUES (
    @name, @description, @test_config, @schedule_type,
    @run_at, @cron_expression, @enabled, @next_run_at, @user_id
  )
`);

const getAllSchedulesStmt = db.prepare(`SELECT * FROM schedules ORDER BY created_at DESC`);
const getAllSchedulesByUser = db.prepare(`SELECT * FROM schedules WHERE user_id = ? ORDER BY created_at DESC`);
const getScheduleByIdStmt = db.prepare(`SELECT * FROM schedules WHERE id = ?`);

const updateScheduleStmt = db.prepare(`
  UPDATE schedules SET
    name = @name,
    description = @description,
    test_config = @test_config,
    schedule_type = @schedule_type,
    run_at = @run_at,
    cron_expression = @cron_expression,
    enabled = @enabled,
    next_run_at = @next_run_at,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = @id
`);

const deleteScheduleStmt = db.prepare(`DELETE FROM schedules WHERE id = ?`);
const deleteScheduleByOwner = db.prepare(`DELETE FROM schedules WHERE id = ? AND user_id = ?`);

const toggleScheduleEnabled = db.prepare(`
  UPDATE schedules SET
    enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const toggleScheduleByOwner = db.prepare(`
  UPDATE schedules SET
    enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ? AND user_id = ?
`);

const updateScheduleRunTimeStmt = db.prepare(`
  UPDATE schedules SET
    last_run_at = @last_run_at,
    next_run_at = @next_run_at,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = @id
`);

const getEnabledSchedulesStmt = db.prepare(`SELECT * FROM schedules WHERE enabled = 1`);

// ==================== 测速报告相关语句 ====================

const insertBenchmarkReport = db.prepare(`
  INSERT INTO benchmark_reports (
    base_url, model_name, provider_type, status, duration, config, result, user_id
  ) VALUES (
    @base_url, @model_name, @provider_type, @status, @duration, @config, @result, @user_id
  )
`);

const getBenchmarkReportList = db.prepare(`
  SELECT id, created_at, base_url, model_name, provider_type, status, duration
  FROM benchmark_reports
  ORDER BY id DESC
  LIMIT @limit OFFSET @offset
`);

const getBenchmarkReportListByUser = db.prepare(`
  ${getBenchmarkReportList.source.replace('FROM benchmark_reports', 'FROM benchmark_reports WHERE user_id = @user_id')}
`);

const getBenchmarkReportCount = db.prepare(`SELECT COUNT(*) as count FROM benchmark_reports`);
const getBenchmarkReportCountByUser = db.prepare(`SELECT COUNT(*) as count FROM benchmark_reports WHERE user_id = @user_id`);
const getBenchmarkReportByIdStmt = db.prepare(`SELECT * FROM benchmark_reports WHERE id = ?`);
const deleteBenchmarkReportStmt = db.prepare(`DELETE FROM benchmark_reports WHERE id = ?`);
const deleteBenchmarkReportByOwner = db.prepare(`DELETE FROM benchmark_reports WHERE id = ? AND user_id = ?`);

// ==================== 模型质量报告相关语句 ====================

const insertQualityReport = db.prepare(`
  INSERT OR REPLACE INTO quality_reports (
    id, created_at, target_url, target_model, target_protocol,
    baseline_url, baseline_model, baseline_protocol,
    score, pass_count, warn_count, fail_count, skip_count,
    duration_ms, conclusion, report, user_id
  ) VALUES (
    @id, @created_at, @target_url, @target_model, @target_protocol,
    @baseline_url, @baseline_model, @baseline_protocol,
    @score, @pass_count, @warn_count, @fail_count, @skip_count,
    @duration_ms, @conclusion, @report, @user_id
  )
`);

const selectQualityReportList = db.prepare(`
  SELECT id, created_at, target_url, target_model, target_protocol,
         baseline_url, baseline_model, baseline_protocol,
         score, pass_count, warn_count, fail_count, skip_count, duration_ms
  FROM quality_reports
  ORDER BY created_at DESC
  LIMIT @limit OFFSET @offset
`);

const selectQualityReportListByUser = db.prepare(`
  ${selectQualityReportList.source.replace('FROM quality_reports', 'FROM quality_reports WHERE user_id = @user_id')}
`);

const countQualityReport = db.prepare(`SELECT COUNT(*) as count FROM quality_reports`);
const countQualityReportByUser = db.prepare(`SELECT COUNT(*) as count FROM quality_reports WHERE user_id = @user_id`);
const selectQualityReportById = db.prepare(`SELECT * FROM quality_reports WHERE id = ?`);
const deleteQualityReportStmt = db.prepare(`DELETE FROM quality_reports WHERE id = ?`);
const deleteQualityReportByOwner = db.prepare(`DELETE FROM quality_reports WHERE id = ? AND user_id = ?`);
const clearQualityReportsStmt = db.prepare(`DELETE FROM quality_reports`);
const clearQualityReportsByOwner = db.prepare(`DELETE FROM quality_reports WHERE user_id = ?`);
const pruneQualityReports = db.prepare(`
  DELETE FROM quality_reports WHERE id NOT IN (
    SELECT id FROM quality_reports ORDER BY created_at DESC LIMIT @keep
  )
`);

// ==================== 可见性辅助 ====================

/**
 * 组装"按用户可见性过滤"的查询参数
 * 管理员可见全部（含 user_id 为 NULL 的历史数据）；普通用户只看自己的
 */
function scopeParams(userId, isAdmin, extra = {}) {
  if (isAdmin || userId == null) return extra;
  return { ...extra, user_id: userId };
}

function canAccess(rowUserId, userId, isAdmin) {
  if (isAdmin) return true;
  if (rowUserId == null) return false; // 历史遗留的公共数据只对管理员开放
  return Number(rowUserId) === Number(userId);
}

function mapSchedule(item) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    testConfig: JSON.parse(item.test_config),
    scheduleType: item.schedule_type,
    runAt: item.run_at,
    cronExpression: item.cron_expression,
    enabled: item.enabled === 1,
    lastRunAt: item.last_run_at,
    nextRunAt: item.next_run_at,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    userId: item.user_id == null ? null : Number(item.user_id),
  };
}

// ==================== 导出函数 ====================
module.exports = {
  // ==================== 用户相关方法 ====================

  createUser: ({ username, passwordHash, role = 'user' }) => {
    const info = insertUser.run({ username, password_hash: passwordHash, role });
    return info.lastInsertRowid;
  },

  getUserByUsername: (username) => selectUserByUsername.get(username) || null,
  getUserById: (id) => selectUserById.get(id) || null,
  getAllUsers: () => selectAllUsers.all(),
  updateUserPassword: (id, passwordHash) => updateUserPasswordStmt.run({ id, password_hash: passwordHash }).changes > 0,
  updateUserRole: (id, role) => updateUserRoleStmt.run({ id, role }).changes > 0,
  deleteUser: (id) => deleteUserStmt.run(id).changes > 0,
  countUsers: () => countUsersStmt.get().count,

  // ==================== 目标预设相关方法 ====================

  savePreset: (data) => {
    const info = insertPreset.run({
      user_id: data.userId,
      name: data.name,
      url: data.url,
      model_name: data.modelName,
      api_key: data.apiKey || '',
      provider_type: data.providerType || 'openai',
      request_type: data.requestType || 'stream',
      test_prompt: data.testPrompt || null,
    });
    return info.lastInsertRowid;
  },

  getPresets: (userId) => selectPresetsByUser.all(userId).map((row) => ({
    id: row.id,
    name: row.name,
    url: row.url,
    modelName: row.model_name,
    apiKey: row.api_key,
    providerType: row.provider_type,
    requestType: row.request_type,
    testPrompt: row.test_prompt,
    createdAt: row.created_at,
  })),

  getPresetById: (id, userId) => {
    const row = selectPresetById.get(id);
    if (!row || Number(row.user_id) !== Number(userId)) return null;
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      modelName: row.model_name,
      apiKey: row.api_key,
      providerType: row.provider_type,
      requestType: row.request_type,
      testPrompt: row.test_prompt,
      createdAt: row.created_at,
    };
  },

  deletePreset: (id, userId) => deletePresetStmt.run(id, userId).changes > 0,

  // ==================== 历史记录相关方法 ====================

  // 保存测试历史
  saveHistory: (data) => {
    try {
      const info = insertHistory.run({
        start_time: data.startTime,
        end_time: data.endTime,
        duration: data.duration,
        test_url: data.testUrl,
        model_name: data.modelName,
        test_mode: data.testMode,
        prompt_mode: data.promptMode,
        request_type: data.requestType,
        target_rpm: data.targetRPM,
        max_rpm: data.maxRPM || null,
        total_requests: data.totalRequests,
        success_count: data.successCount,
        failure_count: data.failureCount,
        success_rate: data.successRate,
        avg_response_time: data.avgResponseTime,
        stop_reason: data.stopReason,
        minute_stats: JSON.stringify(data.minuteStats || []),
        error_summary: JSON.stringify(data.errorSummary || {}),
        total_prompt_tokens: data.totalPromptTokens || 0,
        total_completion_tokens: data.totalCompletionTokens || 0,
        total_tokens: data.totalTokens || 0,
        avg_tpm: data.avgTPM || 0,
        input_tpm: data.inputTPM || 0,
        output_tpm: data.outputTPM || 0,
        p50_response_time: data.p50ResponseTime || 0,
        p95_response_time: data.p95ResponseTime || 0,
        p99_response_time: data.p99ResponseTime || 0,
        ttfb_p95: data.ttfbP95 || 0,
        prompt_reuse_ratio: data.promptReuseRatio || 0,
        actual_prompt_reuse_ratio: data.actualPromptReuseRatio || 0,
        concurrency: data.concurrency || 0,
        peak_concurrency: data.peakConcurrency || 0,
        tpot_p95: data.tpotP95 || 0,
        max_tpm: data.maxTPM || 0,
        recommended_rpm: data.recommendedRPM || 0,
        recommended_tpm: data.recommendedTPM || 0,
        sla_met: data.slaMet || 0,
        user_id: data.userId == null ? null : Number(data.userId),
        estimated_cost: data.estimatedCost == null ? null : data.estimatedCost,
        input_price: data.inputPrice || 0,
        output_price: data.outputPrice || 0,
      });

      // 只保留最近 N 条历史记录（MAX_HISTORY_RECORDS，默认 1000）
      try {
        pruneHistory.run({ keep: config.history.maxRecords });
      } catch (e) {
        console.error('修剪历史记录失败:', e.message);
      }

      return info.lastInsertRowid;
    } catch (error) {
      console.error('保存历史记录失败:', error);
      throw error;
    }
  },

  // 获取历史记录列表（按用户隔离）
  getHistoryList: (page = 1, pageSize = 20, userId = null, isAdmin = false) => {
    try {
      const offset = (page - 1) * pageSize;
      const scoped = isAdmin || userId == null;
      const params = scopeParams(userId, isAdmin, { limit: pageSize, offset });
      const list = scoped ? getHistoryList.all(params) : getHistoryListByUser.all(params);
      const { count } = scoped ? getHistoryCount.get() : getHistoryCountByUser.get(params);

      return {
        list,
        total: count,
        page,
        pageSize,
        totalPages: Math.ceil(count / pageSize)
      };
    } catch (error) {
      console.error('获取历史记录列表失败:', error);
      throw error;
    }
  },

  // 获取单条历史记录详情
  getHistoryDetail: (id, userId = null, isAdmin = false) => {
    try {
      const record = getHistoryById.get(id);
      if (!record) return null;
      if (!canAccess(record.user_id, userId, isAdmin)) return null;

      return {
        ...record,
        user_id: record.user_id == null ? null : Number(record.user_id),
        minuteStats: JSON.parse(record.minute_stats || '[]'),
        errorSummary: JSON.parse(record.error_summary || '{}')
      };
    } catch (error) {
      console.error('获取历史记录详情失败:', error);
      throw error;
    }
  },

  // 删除历史记录
  deleteHistory: (id, userId = null, isAdmin = false) => {
    try {
      if (isAdmin) {
        return deleteHistoryStmt.run(id).changes > 0;
      }
      return deleteHistoryByOwner.run(id, userId).changes > 0;
    } catch (error) {
      console.error('删除历史记录失败:', error);
      throw error;
    }
  },

  // 清空所有历史记录（管理员清全部，普通用户只清自己的）
  clearAllHistory: (userId = null, isAdmin = false) => {
    try {
      if (isAdmin) {
        clearAllHistoryStmt.run();
      } else {
        clearHistoryByOwner.run(userId);
      }
      return true;
    } catch (error) {
      console.error('清空历史记录失败:', error);
      throw error;
    }
  },

  // 关闭数据库连接
  close: () => {
    db.close();
  },

  // ==================== 定时任务相关方法 ====================

  // 创建定时任务
  createSchedule: (data) => {
    try {
      const info = insertSchedule.run({
        name: data.name,
        description: data.description || null,
        test_config: JSON.stringify(data.testConfig),
        schedule_type: data.scheduleType,
        run_at: data.runAt || null,
        cron_expression: data.cronExpression || null,
        enabled: data.enabled !== false ? 1 : 0,
        next_run_at: data.nextRunAt || null,
        user_id: data.userId == null ? null : Number(data.userId),
      });
      return info.lastInsertRowid;
    } catch (error) {
      console.error('创建定时任务失败:', error);
      throw error;
    }
  },

  // 获取定时任务列表（按用户隔离）
  getAllSchedules: (userId = null, isAdmin = false) => {
    try {
      const rows = (isAdmin || userId == null)
        ? getAllSchedulesStmt.all()
        : getAllSchedulesByUser.all(userId);
      return rows.map(mapSchedule);
    } catch (error) {
      console.error('获取定时任务列表失败:', error);
      throw error;
    }
  },

  // 根据 ID 获取定时任务（校验归属）
  getScheduleById: (id, userId = null, isAdmin = false) => {
    try {
      const item = getScheduleByIdStmt.get(id);
      if (!item) return null;
      if (!canAccess(item.user_id, userId, isAdmin)) return null;
      return mapSchedule(item);
    } catch (error) {
      console.error('获取定时任务详情失败:', error);
      throw error;
    }
  },

  // 更新定时任务
  updateSchedule: (id, data) => {
    try {
      const info = updateScheduleStmt.run({
        id,
        name: data.name,
        description: data.description || null,
        test_config: JSON.stringify(data.testConfig),
        schedule_type: data.scheduleType,
        run_at: data.runAt || null,
        cron_expression: data.cronExpression || null,
        enabled: data.enabled !== false ? 1 : 0,
        next_run_at: data.nextRunAt || null
      });
      return info.changes > 0;
    } catch (error) {
      console.error('更新定时任务失败:', error);
      throw error;
    }
  },

  // 删除定时任务（按归属校验）
  deleteSchedule: (id, userId = null, isAdmin = false) => {
    try {
      if (isAdmin) {
        return deleteScheduleStmt.run(id).changes > 0;
      }
      return deleteScheduleByOwner.run(id, userId).changes > 0;
    } catch (error) {
      console.error('删除定时任务失败:', error);
      throw error;
    }
  },

  // 切换定时任务启用状态（按归属校验）
  toggleSchedule: (id, userId = null, isAdmin = false) => {
    try {
      const info = (isAdmin || userId == null)
        ? toggleScheduleEnabled.run(id)
        : toggleScheduleByOwner.run(id, userId);
      if (info.changes > 0) {
        return module.exports.getScheduleById(id, userId, isAdmin);
      }
      return null;
    } catch (error) {
      console.error('切换定时任务状态失败:', error);
      throw error;
    }
  },

  // 更新定时任务执行时间（内部使用，不做归属校验）
  updateScheduleRunTime: (id, lastRunAt, nextRunAt) => {
    try {
      const info = updateScheduleRunTimeStmt.run({
        id,
        last_run_at: lastRunAt,
        next_run_at: nextRunAt
      });
      return info.changes > 0;
    } catch (error) {
      console.error('更新定时任务执行时间失败:', error);
      throw error;
    }
  },

  // 获取所有启用的定时任务（内部使用，调度器需要全量）
  getEnabledSchedules: () => {
    try {
      return getEnabledSchedulesStmt.all().map(mapSchedule);
    } catch (error) {
      console.error('获取启用的定时任务失败:', error);
      throw error;
    }
  },

  // ==================== 测速报告相关方法 ====================

  // 保存测速报告
  saveBenchmarkReport: (data) => {
    try {
      const info = insertBenchmarkReport.run({
        base_url: data.baseUrl,
        model_name: data.modelName,
        provider_type: data.providerType,
        status: data.status || 'completed',
        duration: data.duration || 0,
        config: JSON.stringify(data.config || {}),
        result: JSON.stringify(data.result || {}),
        user_id: data.userId == null ? null : Number(data.userId),
      });
      return info.lastInsertRowid;
    } catch (error) {
      console.error('保存测速报告失败:', error);
      throw error;
    }
  },

  // 获取测速报告列表（分页，按用户隔离）
  getBenchmarkReports: (page = 1, pageSize = 20, userId = null, isAdmin = false) => {
    try {
      const offset = (page - 1) * pageSize;
      const scoped = isAdmin || userId == null;
      const params = scopeParams(userId, isAdmin, { limit: pageSize, offset });
      const list = scoped ? getBenchmarkReportList.all(params) : getBenchmarkReportListByUser.all(params);
      const { count } = scoped ? getBenchmarkReportCount.get() : getBenchmarkReportCountByUser.get(params);
      return {
        list,
        total: count,
        page,
        pageSize,
        totalPages: Math.ceil(count / pageSize)
      };
    } catch (error) {
      console.error('获取测速报告列表失败:', error);
      throw error;
    }
  },

  // 获取单条测速报告（按归属校验）
  getBenchmarkReportById: (id, userId = null, isAdmin = false) => {
    try {
      const record = getBenchmarkReportByIdStmt.get(id);
      if (!record) return null;
      if (!canAccess(record.user_id, userId, isAdmin)) return null;
      return {
        id: record.id,
        createdAt: record.created_at,
        baseUrl: record.base_url,
        modelName: record.model_name,
        providerType: record.provider_type,
        status: record.status,
        duration: record.duration,
        config: JSON.parse(record.config || '{}'),
        result: JSON.parse(record.result || '{}'),
        userId: record.user_id == null ? null : Number(record.user_id),
      };
    } catch (error) {
      console.error('获取测速报告详情失败:', error);
      throw error;
    }
  },

  // 删除测速报告（按归属校验）
  deleteBenchmarkReport: (id, userId = null, isAdmin = false) => {
    try {
      if (isAdmin) {
        return deleteBenchmarkReportStmt.run(id).changes > 0;
      }
      return deleteBenchmarkReportByOwner.run(id, userId).changes > 0;
    } catch (error) {
      console.error('删除测速报告失败:', error);
      throw error;
    }
  },

  // ==================== 模型质量报告相关方法 ====================

  // 保存质量报告（同 id 覆盖）
  saveQualityReport: (report) => {
    try {
      const target = report.target || {};
      const baseline = report.baseline || null;
      const summary = report.summary || {};

      insertQualityReport.run({
        id: report.id,
        created_at: report.createdAt || new Date().toISOString(),
        target_url: target.url || '',
        target_model: target.modelName || '',
        target_protocol: target.protocol || null,
        baseline_url: baseline ? baseline.url : null,
        baseline_model: baseline ? baseline.modelName : null,
        baseline_protocol: baseline ? baseline.protocol : null,
        score: summary.score || 0,
        pass_count: summary.pass || 0,
        warn_count: summary.warn || 0,
        fail_count: summary.fail || 0,
        skip_count: summary.skip || 0,
        duration_ms: summary.durationMs || 0,
        conclusion: report.conclusion || null,
        report: JSON.stringify(report),
        user_id: report.userId == null ? null : Number(report.userId),
      });

      // 只保留最近 500 份，避免库无限增长
      pruneQualityReports.run({ keep: 500 });
      return report.id;
    } catch (error) {
      console.error('保存质量报告失败:', error);
      throw error;
    }
  },

  // 质量报告列表（默认按时间倒序，按用户隔离）
  getQualityReports: (limit = 100, offset = 0, userId = null, isAdmin = false) => {
    try {
      const scoped = isAdmin || userId == null;
      const params = scopeParams(userId, isAdmin, { limit, offset });
      const list = scoped ? selectQualityReportList.all(params) : selectQualityReportListByUser.all(params);
      const { count } = scoped ? countQualityReport.get() : countQualityReportByUser.get(params);
      return {
        list: list.map((row) => ({
          id: row.id,
          createdAt: row.created_at,
          target: {
            url: row.target_url,
            modelName: row.target_model,
            protocol: row.target_protocol,
          },
          baseline: row.baseline_url
            ? { url: row.baseline_url, modelName: row.baseline_model, protocol: row.baseline_protocol }
            : null,
          summary: {
            score: row.score,
            pass: row.pass_count,
            warn: row.warn_count,
            fail: row.fail_count,
            skip: row.skip_count,
            durationMs: row.duration_ms,
          },
        })),
        total: count,
      };
    } catch (error) {
      console.error('获取质量报告列表失败:', error);
      throw error;
    }
  },

  // 质量报告详情（完整报告，按归属校验）
  getQualityReportById: (id, userId = null, isAdmin = false) => {
    try {
      const row = selectQualityReportById.get(id);
      if (!row) return null;
      if (!canAccess(row.user_id, userId, isAdmin)) return null;
      try {
        return JSON.parse(row.report);
      } catch (e) {
        return {
          id: row.id,
          createdAt: row.created_at,
          target: { url: row.target_url, modelName: row.target_model, protocol: row.target_protocol },
          baseline: row.baseline_url
            ? { url: row.baseline_url, modelName: row.baseline_model, protocol: row.baseline_protocol }
            : null,
          summary: {
            score: row.score,
            pass: row.pass_count,
            warn: row.warn_count,
            fail: row.fail_count,
            skip: row.skip_count,
            durationMs: row.duration_ms,
          },
          checks: [],
          differences: [],
          conclusion: row.conclusion || '',
        };
      }
    } catch (error) {
      console.error('获取质量报告详情失败:', error);
      throw error;
    }
  },

  // 删除质量报告（按归属校验）
  deleteQualityReport: (id, userId = null, isAdmin = false) => {
    try {
      if (isAdmin) {
        return deleteQualityReportStmt.run(id).changes > 0;
      }
      return deleteQualityReportByOwner.run(id, userId).changes > 0;
    } catch (error) {
      console.error('删除质量报告失败:', error);
      throw error;
    }
  },

  // 清空质量报告（管理员清全部，普通用户只清自己的）
  clearQualityReports: (userId = null, isAdmin = false) => {
    try {
      if (isAdmin) {
        clearQualityReportsStmt.run();
        return true;
      }
      clearQualityReportsByOwner.run(userId);
      return true;
    } catch (error) {
      console.error('清空质量报告失败:', error);
      throw error;
    }
  }
};
