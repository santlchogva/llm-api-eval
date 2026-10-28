const { percentile, summarize, SlidingWindow, Histogram } = require('./stats');

describe('percentile', () => {
  test('空数组返回 0', () => {
    expect(percentile([], 50)).toBe(0);
  });

  test('单元素直接返回', () => {
    expect(percentile([42], 99)).toBe(42);
  });

  test('中位数（线性插值）', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3], 50)).toBe(2);
  });

  test('P0 与 P100 边界', () => {
    expect(percentile([10, 20, 30], 0)).toBe(10);
    expect(percentile([10, 20, 30], 100)).toBe(30);
  });

  test('P99 取高尾值', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(arr, 99)).toBeCloseTo(99.01, 1);
  });
});

describe('summarize', () => {
  test('空输入返回零值结构', () => {
    const r = summarize([]);
    expect(r.count).toBe(0);
    expect(r.avg).toBe(0);
    expect(r.p99).toBe(0);
  });

  test('过滤非有限值', () => {
    const r = summarize([10, NaN, 20, Infinity, 30]);
    expect(r.count).toBe(3);
    expect(r.avg).toBe(20);
    expect(r.min).toBe(10);
    expect(r.max).toBe(30);
  });

  test('分位数计算', () => {
    const r = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [50, 95]);
    expect(r.count).toBe(10);
    // 线性插值 p50=5.5，summarize 输出取整为 6
    expect(r.p50).toBe(6);
    expect(r.p95).toBeGreaterThan(9);
  });
});

describe('SlidingWindow', () => {
  test('窗口内样本求和', () => {
    const w = new SlidingWindow(1000);
    const now = Date.now();
    w.add({ total: 10 }, now);
    w.add({ total: 5 }, now + 100);
    expect(w.totals(['total'], now + 200)).toMatchObject({ samples: 2, total: 15 });
  });

  test('过期样本被淘汰', () => {
    const w = new SlidingWindow(1000);
    const now = Date.now();
    w.add({ total: 10 }, now);
    // 超过窗口后读取
    expect(w.totals(['total'], now + 1500)).toMatchObject({ samples: 0, total: 0 });
    expect(w.size).toBe(0);
  });

  test('clear 清空', () => {
    const w = new SlidingWindow(1000);
    w.add({ total: 1 });
    w.clear();
    expect(w.size).toBe(0);
  });

  test('maxSamples 硬上限', () => {
    const w = new SlidingWindow(60000, 10);
    for (let i = 0; i < 30; i++) w.add({ v: i });
    expect(w.size).toBeLessThanOrEqual(10);
  });
});

describe('Histogram', () => {
  test('记录与 summary 基本统计', () => {
    const h = new Histogram({ maxValue: 1000, bucketMs: 10 });
    [10, 20, 30, 40, 50].forEach((v) => h.record(v));
    const s = h.summary([50, 99]);
    expect(s.count).toBe(5);
    expect(s.min).toBe(10);
    expect(s.max).toBe(50);
    expect(s.avg).toBe(30);
    // 直方图用桶中点代表样本：10/20/30/40/50 分别落在桶 1-5（中点 15/25/35/45/55）
    // p50 的 rank=2，累计到桶 3 时首次超过 → 中点 35
    expect(s.p50).toBe(35);
  });

  test('p99 接近最大值', () => {
    const h = new Histogram({ maxValue: 60000, bucketMs: 10 });
    for (let i = 0; i < 1000; i++) h.record(i);
    // 真实 p99=989；桶中点近似为 985（桶 98 覆盖 980-989），误差不超过一个桶宽
    expect(h.percentile(99)).toBeGreaterThanOrEqual(985);
    expect(h.percentile(99)).toBeLessThan(1000);
  });

  test('非法样本被忽略', () => {
    const h = new Histogram({ maxValue: 1000, bucketMs: 10 });
    h.record(-5);
    h.record(NaN);
    h.record('abc');
    expect(h.count).toBe(0);
  });

  test('超出量程计入末桶', () => {
    const h = new Histogram({ maxValue: 100, bucketMs: 10 });
    h.record(5000);
    expect(h.count).toBe(1);
    expect(h.max).toBe(5000);
  });

  test('clear 重置', () => {
    const h = new Histogram({ maxValue: 1000, bucketMs: 10 });
    h.record(100);
    h.clear();
    expect(h.count).toBe(0);
    expect(h.summary().count).toBe(0);
  });
});
