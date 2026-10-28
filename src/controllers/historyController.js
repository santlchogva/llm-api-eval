const db = require('../../database');
const { AppError } = require('../middlewares/errorHandler');

/** 是否管理员（管理员可见/可管理所有用户的数据） */
const isAdminOf = (req) => req.user && req.user.role === 'admin';

/**
 * 获取历史记录列表（按用户隔离，管理员可见全部）
 */
const getHistoryList = (req, res) => {
  const { page, pageSize } = req.query;
  const result = db.getHistoryList(page, pageSize, req.userId, isAdminOf(req));
  res.json(result);
};

/**
 * 获取单条历史记录详情
 */
const getHistoryDetail = (req, res) => {
  const { id } = req.params;
  const detail = db.getHistoryDetail(id, req.userId, isAdminOf(req));

  if (!detail) {
    throw new AppError('历史记录不存在', 404);
  }

  res.json(detail);
};

/**
 * 删除历史记录
 */
const deleteHistory = (req, res) => {
  const { id } = req.params;
  const success = db.deleteHistory(id, req.userId, isAdminOf(req));

  if (!success) {
    throw new AppError('历史记录不存在', 404);
  }

  res.json({ success: true, message: '删除成功' });
};

/**
 * 清空历史记录（管理员清全部，普通用户只清自己的）
 */
const clearHistory = (req, res) => {
  db.clearAllHistory(req.userId, isAdminOf(req));
  res.json({ success: true, message: '历史记录已清空' });
};

/**
 * 导出单条记录为 JSON
 */
const exportJSON = (req, res) => {
  const detail = db.getHistoryDetail(req.params.id, req.userId, isAdminOf(req));
  if (!detail) throw new AppError('历史记录不存在', 404);

  const filename = `llm-api-eval_report_${detail.model_name || 'test'}_${detail.id}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(JSON.stringify(detail, null, 2));
};

/**
 * 导出单条记录的分钟统计为 CSV
 */
const exportCSV = (req, res) => {
  const detail = db.getHistoryDetail(req.params.id, req.userId, isAdminOf(req));
  if (!detail) throw new AppError('历史记录不存在', 404);

  const rows = Array.isArray(detail.minuteStats) ? detail.minuteStats : [];
  const header = ['timestamp', 'totalRequests', 'successCount', 'failureCount', 'successRate', 'rpm', 'tokens', 'tpm'];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  rows.forEach((m) => {
    lines.push([
      m.timestamp, m.totalRequests, m.successCount, m.failureCount,
      m.successRate, m.rpm, m.tokens, m.tpm,
    ].map(esc).join(','));
  });

  const filename = `llm-api-eval_minutes_${detail.model_name || 'test'}_${detail.id}.csv`;
  // BOM 保证 Excel 打开中文不乱码
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send('\ufeff' + lines.join('\n'));
};

/**
 * 对比两条历史记录（A/B 回归对比）
 *
 * 用于"换模型 / 换网关 / 调参前后"的效果验证：
 * 返回两侧元信息与逐项指标差值，winner 标出每项更优的一侧。
 */
const COMPARE_METRICS = [
  { key: 'total_requests', label: '总请求数', unit: '', higherBetter: null },
  { key: 'success_rate', label: '成功率', unit: '%', higherBetter: true },
  { key: 'avg_response_time', label: '平均响应时间', unit: 'ms', higherBetter: false },
  { key: 'p50_response_time', label: 'P50 延迟', unit: 'ms', higherBetter: false },
  { key: 'p95_response_time', label: 'P95 延迟', unit: 'ms', higherBetter: false },
  { key: 'p99_response_time', label: 'P99 延迟', unit: 'ms', higherBetter: false },
  { key: 'ttfb_p95', label: 'TTFB P95', unit: 'ms', higherBetter: false },
  { key: 'tpot_p95', label: 'TPOT P95', unit: 'ms/tok', higherBetter: false },
  { key: 'avg_tpm', label: '平均 TPM', unit: '', higherBetter: true },
  { key: 'input_tpm', label: '输入 TPM', unit: '', higherBetter: true },
  { key: 'output_tpm', label: '输出 TPM', unit: '', higherBetter: true },
  { key: 'total_tokens', label: '总 Token 数', unit: '', higherBetter: null },
  { key: 'estimated_cost', label: '预估成本', unit: '', higherBetter: false },
  { key: 'duration', label: '持续时间', unit: 'ms', higherBetter: null },
];

const compareHistory = (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (ids.length !== 2) {
    throw new AppError('请提供恰好两条记录 ID，如 ?ids=1,2', 400);
  }
  if (ids[0] === ids[1]) {
    throw new AppError('不能与自身对比', 400);
  }

  const a = db.getHistoryDetail(ids[0], req.userId, isAdminOf(req));
  const b = db.getHistoryDetail(ids[1], req.userId, isAdminOf(req));
  if (!a) throw new AppError(`记录 ${ids[0]} 不存在`, 404);
  if (!b) throw new AppError(`记录 ${ids[1]} 不存在`, 404);

  const round2 = (v) => Math.round(v * 100) / 100;
  const metrics = COMPARE_METRICS.map((m) => {
    const va = a[m.key] == null ? null : Number(a[m.key]);
    const vb = b[m.key] == null ? null : Number(b[m.key]);

    let delta = null;
    let deltaPct = null;
    let winner = null;
    if (va != null && vb != null && (va !== 0 || vb !== 0)) {
      delta = round2(vb - va);
      if (va !== 0) deltaPct = round2((vb - va) / Math.abs(va) * 100);
      if (m.higherBetter !== null && va !== vb) {
        winner = (m.higherBetter ? vb > va : vb < va) ? 'b' : 'a';
      }
    }
    return { key: m.key, label: m.label, unit: m.unit, a: va, b: vb, delta, deltaPct, winner };
  });

  const brief = (r) => ({
    id: r.id,
    model_name: r.model_name,
    test_url: r.test_url,
    test_mode: r.test_mode,
    request_type: r.request_type,
    start_time: r.start_time,
  });

  res.json({
    success: true,
    data: { a: brief(a), b: brief(b), metrics },
  });
};

module.exports = {
  getHistoryList,
  getHistoryDetail,
  deleteHistory,
  clearHistory,
  exportJSON,
  exportCSV,
  compareHistory,
};
