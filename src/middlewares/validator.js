const { AppError } = require('./errorHandler');

/**
 * 验证成功率阈值
 * @param {*} value - 输入值
 * @returns {{ valid: boolean, error?: string }} - 验证结果
 */
const validateSuccessThreshold = (value) => {
  if (value === undefined || value === null) {
    return { valid: true };
  }
  const threshold = Number(value);
  if (isNaN(threshold) || threshold < 0 || threshold > 100) {
    return { valid: false, error: '成功率阈值必须在0-100之间' };
  }
  return { valid: true };
};

/**
 * 验证最大连续失败次数
 * @param {*} value - 输入值
 * @returns {{ valid: boolean, error?: string }} - 验证结果
 */
const validateMaxFailures = (value) => {
  if (value === undefined || value === null) {
    return { valid: true };
  }
  const failures = Number(value);
  if (isNaN(failures) || failures < 0 || !Number.isInteger(failures)) {
    return { valid: false, error: '最大连续失败次数必须为非负整数' };
  }
  return { valid: true };
};

/**
 * 验证测试启动参数
 */
const validateStartTest = (req, res, next) => {
  const {
    mode, rpm, url, modelName, apiKey, testPrompt, promptMode, randomPrompts, providerType,
    datasetId, datasetItems, concurrency, promptReuseRatio,
  } = req.body;

  // 验证必填字段
  if (!url || !url.trim()) {
    throw new AppError('URL不能为空', 400);
  }

  if (!modelName || !modelName.trim()) {
    throw new AppError('模型名称不能为空', 400);
  }

  if (!apiKey || !apiKey.trim()) {
    throw new AppError('API密钥不能为空', 400);
  }

  if (!providerType || !['gemini', 'openai', 'responses', 'openai-responses', 'claude', 'anthropic'].includes(providerType)) {
    throw new AppError('必须指定有效的接口类型（openai/responses/anthropic/gemini）', 400);
  }

  // 验证 URL 格式
  try {
    new URL(url);
  } catch (e) {
    throw new AppError('URL格式无效', 400);
  }

  // 验证测压模式
  const MODES = ['fixed', 'auto', 'concurrency', 'concurrency-ramp', 'seek', 'probe'];
  if (mode && !MODES.includes(mode)) {
    throw new AppError(`测压模式必须是 ${MODES.join(' / ')}`, 400);
  }

  // 验证 RPM（固定模式必填）
  if (mode === 'fixed' && (!rpm || rpm < 1 || rpm > 100000)) {
    throw new AppError('固定模式的RPM必须在1-100000之间', 400);
  }

  if (mode !== 'fixed' && rpm !== undefined && rpm !== null && rpm !== '' &&
      (isNaN(Number(rpm)) || Number(rpm) < 1 || Number(rpm) > 100000)) {
    throw new AppError('起始RPM必须在1-100000之间', 400);
  }

  // 验证恒定并发数
  if (mode === 'concurrency') {
    const workers = Number(concurrency);
    if (!Number.isInteger(workers) || workers < 1 || workers > 512) {
      throw new AppError('并发路数必须为1-512之间的整数', 400);
    }
  }

  // 验证并发阶梯档位
  if (mode === 'concurrency-ramp') {
    const { concurrencySteps, concurrencyStart, concurrencyMax } = req.body;
    if (Array.isArray(concurrencySteps) && concurrencySteps.length > 0) {
      const invalid = concurrencySteps.some((n) => {
        const num = Number(n);
        return !Number.isInteger(num) || num < 1 || num > 512;
      });
      if (invalid) {
        throw new AppError('并发阶梯档位必须为1-512之间的整数数组', 400);
      }
    } else {
      const start = Number(concurrencyStart);
      const max = Number(concurrencyMax);
      if (Number.isFinite(start) && Number.isFinite(max) &&
          (start < 1 || max < start || max > 512)) {
        throw new AppError('并发阶梯必须满足 1 ≤ 起始并发 ≤ 上限并发 ≤ 512', 400);
      }
    }
  }

  // 验证请求复用率（0-1 的小数，也兼容传入百分数）
  if (promptReuseRatio !== undefined && promptReuseRatio !== null && promptReuseRatio !== '') {
    const ratio = Number(promptReuseRatio);
    if (!Number.isFinite(ratio) || ratio < 0) {
      throw new AppError('请求复用率必须为不小于0的数值', 400);
    }
  }

  // 验证测试请求模式
  if (promptMode && !['fixed', 'random', 'dataset', 'template'].includes(promptMode)) {
    throw new AppError('测试请求模式必须是 fixed / random / dataset / template', 400);
  }

  if (promptMode === 'fixed' && !testPrompt) {
    throw new AppError('固定模式下请填写测试请求', 400);
  }

  if (promptMode === 'random' && (!randomPrompts || randomPrompts.length === 0)) {
    throw new AppError('随机模式下请至少添加一条测试请求', 400);
  }

  if (promptMode === 'template' && !req.body.promptTemplate) {
    throw new AppError('模板模式下请填写请求模板（支持 {{seq}} {{uuid}} {{random:N}} 等变量）', 400);
  }

  // 验证预热时长（0-600 秒，仅 fixed / auto / concurrency 模式生效）
  if (req.body.warmupDuration !== undefined && req.body.warmupDuration !== null && req.body.warmupDuration !== '') {
    const warmup = Number(req.body.warmupDuration);
    if (!Number.isFinite(warmup) || warmup < 0 || warmup > 600) {
      throw new AppError('预热时长必须在 0-600 秒之间', 400);
    }
  }

  // 验证响应断言配置
  if (req.body.assertions !== undefined && req.body.assertions !== null) {
    if (!Array.isArray(req.body.assertions)) {
      throw new AppError('assertions 必须为数组', 400);
    }
    const ASSERTION_TYPES = ['contains', 'not_contains', 'regex', 'min_length'];
    for (const a of req.body.assertions) {
      if (!a || typeof a !== 'object' || !ASSERTION_TYPES.includes(a.type)) {
        throw new AppError(`断言类型必须是 ${ASSERTION_TYPES.join(' / ')}`, 400);
      }
      if (a.value === undefined || a.value === null || a.value === '') {
        throw new AppError('断言值不能为空', 400);
      }
      if (a.type === 'regex') {
        try {
          new RegExp(String(a.value));
        } catch (e) {
          throw new AppError(`断言正则无效: ${e.message}`, 400);
        }
      }
      if (a.type === 'min_length' && (!Number.isInteger(Number(a.value)) || Number(a.value) < 0)) {
        throw new AppError('最小长度断言必须为非负整数', 400);
      }
    }
  }

  // 验证 webhook 地址
  if (req.body.webhookUrl) {
    try {
      const u = new URL(String(req.body.webhookUrl));
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('protocol');
    } catch (e) {
      throw new AppError('webhook 地址必须是有效的 http(s) URL', 400);
    }
  }

  // 验证每百万 token 单价（可选，用于成本估算）
  ['inputPrice', 'outputPrice'].forEach((field) => {
    if (req.body[field] !== undefined && req.body[field] !== null && req.body[field] !== '') {
      const v = Number(req.body[field]);
      if (!Number.isFinite(v) || v < 0 || v > 100000) {
        throw new AppError(`${field} 必须是 0-100000 之间的数值（每百万 token 单价）`, 400);
      }
    }
  });

  // 能力探测会自行切换数据集，不强制要求前端指定
  if (promptMode === 'dataset' && mode !== 'probe') {
    const hasItems = Array.isArray(datasetItems) && datasetItems.length > 0;
    if (!datasetId && !hasItems) {
      throw new AppError('数据集模式下请选择内置数据集或导入自定义数据集', 400);
    }
  }

  // 验证 SLA 达标阈值
  const slaInput = req.body.sla;
  if (slaInput !== undefined && slaInput !== null) {
    if (typeof slaInput !== 'object' || Array.isArray(slaInput)) {
      throw new AppError('sla 必须为对象', 400);
    }

    const { successThreshold: slaSuccess, ttftP99Threshold, tpotP99Threshold, capacityRatio } = slaInput;

    if (slaSuccess !== undefined && slaSuccess !== null &&
        (isNaN(Number(slaSuccess)) || Number(slaSuccess) < 0 || Number(slaSuccess) > 100)) {
      throw new AppError('SLA 成功率阈值必须在 0-100 之间', 400);
    }
    if (ttftP99Threshold !== undefined && ttftP99Threshold !== null &&
        (isNaN(Number(ttftP99Threshold)) || Number(ttftP99Threshold) < 0)) {
      throw new AppError('SLA TTFT P99 阈值必须为非负数（毫秒）', 400);
    }
    if (tpotP99Threshold !== undefined && tpotP99Threshold !== null &&
        (isNaN(Number(tpotP99Threshold)) || Number(tpotP99Threshold) < 0)) {
      throw new AppError('SLA TPOT P99 阈值必须为非负数（毫秒/输出token）', 400);
    }
    if (capacityRatio !== undefined && capacityRatio !== null &&
        (isNaN(Number(capacityRatio)) || Number(capacityRatio) <= 0 || Number(capacityRatio) > 1)) {
      throw new AppError('容量折算比例必须在 (0, 1] 之间', 400);
    }
  }

  // 验证阈值参数（除固定压测外都会参与判定）
  if (mode && mode !== 'fixed') {
    const { successThreshold, maxFailures } = req.body;

    // 验证成功率阈值
    const thresholdResult = validateSuccessThreshold(successThreshold);
    if (!thresholdResult.valid) {
      throw new AppError(thresholdResult.error, 400);
    }

    // 验证最大连续失败次数
    const failuresResult = validateMaxFailures(maxFailures);
    if (!failuresResult.valid) {
      throw new AppError(failuresResult.error, 400);
    }
  }

  next();
};

/**
 * 验证分页参数
 */
const validatePagination = (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 20;

  if (page < 1) {
    throw new AppError('页码必须大于0', 400);
  }

  if (pageSize < 1 || pageSize > 100) {
    throw new AppError('每页数量必须在1-100之间', 400);
  }

  req.query.page = page;
  req.query.pageSize = pageSize;

  next();
};

/**
 * 验证 ID 参数
 */
const validateId = (req, res, next) => {
  const id = parseInt(req.params.id);

  if (isNaN(id) || id < 1) {
    throw new AppError('无效的ID参数', 400);
  }

  req.params.id = id;
  next();
};

/**
 * 验证登录参数（多用户：username 可省略，默认 admin）
 */
const validateLogin = (req, res, next) => {
  const { password } = req.body;

  if (!password || !String(password).trim()) {
    throw new AppError('密码不能为空', 400);
  }

  next();
};

/**
 * 开放注册参数校验：用户名 2-32 位字母/数字/下划线/中划线，密码至少 6 位
 */
const validateRegister = (req, res, next) => {
  const { username, password } = req.body;
  const name = String(username || '').trim();

  if (!name) throw new AppError('用户名不能为空', 400);
  if (!/^[a-z0-9_-]{2,32}$/.test(name.toLowerCase())) {
    throw new AppError('用户名仅支持 2-32 位字母、数字、下划线和中划线', 400);
  }
  if (!password || String(password).length < 6) {
    throw new AppError('密码长度至少为 6 位', 400);
  }

  next();
};

module.exports = {
  validateStartTest,
  validatePagination,
  validateId,
  validateLogin,
  validateRegister,
  // 导出纯验证函数用于测试
  validateSuccessThreshold,
  validateMaxFailures,
};


