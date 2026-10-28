/**
 * 成本估算与历史对比（A/B）指标计算单元测试
 */
jest.mock('../../database', () => ({
  getHistoryDetail: jest.fn(),
  getHistoryList: jest.fn(),
  saveHistory: jest.fn(),
  deleteHistory: jest.fn(),
  clearAllHistory: jest.fn(),
}));

const db = require('../../database');
const stressTestService = require('../services/stressTestService');
const historyController = require('./historyController');
const { AppError } = require('../middlewares/errorHandler');

const makeRes = () => ({ json: jest.fn() });

describe('成本估算（stressTestService）', () => {
  afterEach(() => {
    stressTestService.testState = null;
  });

  test('_priceValue：合法正数保留，非法输入归 0', () => {
    expect(stressTestService._priceValue('2.5')).toBe(2.5);
    expect(stressTestService._priceValue(10)).toBe(10);
    expect(stressTestService._priceValue('abc')).toBe(0);
    expect(stressTestService._priceValue(-1)).toBe(0);
    expect(stressTestService._priceValue(0)).toBe(0);
    expect(stressTestService._priceValue(null)).toBe(0);
    expect(stressTestService._priceValue(undefined)).toBe(0);
  });

  test('_computeEstimatedCost：未配置单价返回 null', () => {
    stressTestService.testState = {
      config: { inputPrice: 0, outputPrice: 0 },
      stats: { totalPromptTokens: 1000, totalCompletionTokens: 2000 },
    };
    expect(stressTestService._computeEstimatedCost()).toBeNull();

    stressTestService.testState = null;
    expect(stressTestService._computeEstimatedCost()).toBeNull();
  });

  test('_computeEstimatedCost：按百万单价正确计算', () => {
    // 输入 1M token × 2 元/M + 输出 0.5M token × 8 元/M = 2 + 4 = 6
    stressTestService.testState = {
      config: { inputPrice: 2, outputPrice: 8 },
      stats: { totalPromptTokens: 1_000_000, totalCompletionTokens: 500_000 },
    };
    expect(stressTestService._computeEstimatedCost()).toBe(6);
  });

  test('_computeEstimatedCost：只配置输出单价时输入不计价', () => {
    stressTestService.testState = {
      config: { inputPrice: 0, outputPrice: 10 },
      stats: { totalPromptTokens: 999999, totalCompletionTokens: 1_000_000 },
    };
    expect(stressTestService._computeEstimatedCost()).toBe(10);
  });

  test('_computeEstimatedCost：结果四舍五入到 4 位小数', () => {
    stressTestService.testState = {
      config: { inputPrice: 3, outputPrice: 0 },
      stats: { totalPromptTokens: 123, totalCompletionTokens: 0 },
    };
    // 123 / 1e6 * 3 = 0.000369
    expect(stressTestService._computeEstimatedCost()).toBe(0.0004);
  });
});

describe('历史对比（historyController.compareHistory）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const recordA = {
    id: 1, model_name: 'model-a', test_url: 'https://a.example.com', test_mode: 'fixed',
    request_type: 'stream', start_time: '2026-01-01T00:00:00.000Z',
    total_requests: 1000, success_rate: 99.5, avg_response_time: 800,
    p50_response_time: 700, p95_response_time: 1200, p99_response_time: 1500,
    ttfb_p95: 300, tpot_p95: 20, avg_tpm: 50000, input_tpm: 40000, output_tpm: 10000,
    total_tokens: 1_000_000, estimated_cost: 6, duration: 600000,
  };
  const recordB = {
    ...recordA,
    id: 2, model_name: 'model-b', test_url: 'https://b.example.com',
    success_rate: 99.9, avg_response_time: 600, avg_tpm: 60000,
  };

  test('逐项计算 delta / deltaPct / winner', () => {
    db.getHistoryDetail
      .mockImplementation((id) => (Number(id) === 1 ? recordA : recordB));

    const req = { query: { ids: '1,2' }, userId: 1, user: { role: 'admin' } };
    const res = makeRes();
    historyController.compareHistory(req, res);

    expect(res.json).toHaveBeenCalledTimes(1);
    const { data } = res.json.mock.calls[0][0];
    expect(data.a.id).toBe(1);
    expect(data.b.id).toBe(2);
    expect(data.metrics).toHaveLength(14);

    const byKey = Object.fromEntries(data.metrics.map((m) => [m.key, m]));

    // 成功率：B 更高 → winner b，delta = +0.4
    expect(byKey.success_rate.winner).toBe('b');
    expect(byKey.success_rate.delta).toBe(0.4);

    // 平均响应：B 更低 → winner b（延迟越低越好），delta = -200，deltaPct = -25
    expect(byKey.avg_response_time.winner).toBe('b');
    expect(byKey.avg_response_time.delta).toBe(-200);
    expect(byKey.avg_response_time.deltaPct).toBe(-25);

    // 吞吐：B 更高 → winner b
    expect(byKey.avg_tpm.winner).toBe('b');
    expect(byKey.avg_tpm.deltaPct).toBe(20);

    // 成本：A=6、B=6 相同 → 无 winner
    expect(byKey.estimated_cost.winner).toBeNull();
    expect(byKey.estimated_cost.delta).toBe(0);

    // higherBetter=null 的指标不判 winner
    expect(byKey.total_requests.winner).toBeNull();
    expect(byKey.duration.winner).toBeNull();
  });

  test('ids 参数非法时抛 400', () => {
    const req = { query: { ids: '1' }, userId: 1, user: { role: 'admin' } };
    expect(() => historyController.compareHistory(req, makeRes())).toThrow(AppError);
    expect(() => historyController.compareHistory(
      { query: { ids: '3,3' }, userId: 1, user: { role: 'admin' } }, makeRes()
    )).toThrow(/不能与自身对比/);
  });

  test('记录不存在时抛 404', () => {
    db.getHistoryDetail.mockReturnValue(null);
    const req = { query: { ids: '1,2' }, userId: 1, user: { role: 'admin' } };
    expect(() => historyController.compareHistory(req, makeRes())).toThrow(AppError);
  });
});
