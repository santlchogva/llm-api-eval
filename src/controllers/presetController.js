const db = require('../../database');
const { AppError } = require('../middlewares/errorHandler');

/**
 * 目标预设控制器：保存常用的被测接口配置（url/model/key/provider），
 * 启动压测、定时任务时一键选用，避免反复手填。
 * 预设按用户隔离：每个用户只能看到和使用自己的预设。
 */

const SECRET_FIELDS = ['apiKey'];

/** 输出到前端的预设：密钥脱敏（保留首尾各 4 位便于辨认） */
const maskPreset = (preset) => ({
  ...preset,
  apiKey: maskSecret(preset.apiKey),
});

function maskSecret(secret) {
  const s = String(secret || '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

const list = (req, res) => {
  res.json({ success: true, data: db.getPresets(req.userId).map(maskPreset) });
};

const create = (req, res) => {
  const { name, url, modelName, apiKey, providerType, requestType, testPrompt } = req.body;
  if (!name || !name.trim()) throw new AppError('预设名称不能为空', 400);
  if (!url || !url.trim()) throw new AppError('URL不能为空', 400);
  if (!modelName || !modelName.trim()) throw new AppError('模型名称不能为空', 400);
  try {
    new URL(url);
  } catch (e) {
    throw new AppError('URL格式无效', 400);
  }

  const id = db.savePreset({
    userId: req.userId,
    name: name.trim(),
    url: url.trim(),
    modelName: modelName.trim(),
    apiKey: apiKey || '',
    providerType: providerType || 'openai',
    requestType: requestType || 'stream',
    testPrompt: testPrompt || '',
  });
  const preset = db.getPresetById(id, req.userId);
  res.json({ success: true, preset: preset ? maskPreset(preset) : null, id });
};

const update = (req, res) => {
  const { id } = req.params;
  const existing = db.getPresetById(id, req.userId);
  if (!existing) throw new AppError('预设不存在', 404);

  const { name, url, modelName, apiKey, providerType, requestType, testPrompt } = req.body;
  // apiKey 未传或为脱敏串时保留原值
  const nextKey = !apiKey || apiKey.includes('****') ? existing.apiKey : apiKey;

  db.deletePreset(id, req.userId);
  const newId = db.savePreset({
    userId: req.userId,
    name: (name || existing.name).trim(),
    url: (url || existing.url).trim(),
    modelName: (modelName || existing.modelName).trim(),
    apiKey: nextKey,
    providerType: providerType || existing.providerType,
    requestType: requestType || existing.requestType,
    testPrompt: testPrompt !== undefined ? testPrompt : existing.testPrompt,
  });
  const preset = db.getPresetById(newId, req.userId);
  res.json({ success: true, preset: preset ? maskPreset(preset) : null });
};

const remove = (req, res) => {
  const ok = db.deletePreset(req.params.id, req.userId);
  if (!ok) throw new AppError('预设不存在', 404);
  res.json({ success: true, message: '预设已删除' });
};

module.exports = { list, create, update, remove, SECRET_FIELDS };
