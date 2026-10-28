/**
 * 统计工具
 * 提供分位数计算与滑动时间窗口计数器。
 *
 * 平均响应时间会被长尾请求掩盖，无法反映用户真实感知，
 * 因此压测结果需要同时输出 P50/P90/P95/P99 分位数。
 */

/**
 * 计算已升序排列数组的百分位数（线性插值）
 * @param {number[]} sortedAsc - 升序数组
 * @param {number} p - 百分位（0-100）
 * @returns {number}
 */
function percentile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0];

  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

/**
 * 对原始数值数组做描述性统计
 * @param {number[]} values - 原始数值数组
 * @param {number[]} percentiles - 需要计算的百分位
 * @returns {{count:number, avg:number, min:number, max:number, [key:string]:number}}
 */
function summarize(values, percentiles = [50, 90, 95, 99]) {
  const result = { count: 0, avg: 0, min: 0, max: 0 };
  percentiles.forEach((p) => {
    result[`p${p}`] = 0;
  });

  if (!Array.isArray(values) || values.length === 0) {
    return result;
  }

  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return result;

  const sum = sorted.reduce((acc, v) => acc + v, 0);
  result.count = sorted.length;
  result.avg = Math.round(sum / sorted.length);
  result.min = Math.round(sorted[0]);
  result.max = Math.round(sorted[sorted.length - 1]);
  percentiles.forEach((p) => {
    result[`p${p}`] = Math.round(percentile(sorted, p));
  });

  return result;
}

/**
 * 滑动时间窗口计数器
 * 用于计算「最近 N 秒」的速率型指标（如 TPM / 实际 RPM）。
 * 样本按时间顺序追加，读取时淘汰过期样本，避免内存无限增长。
 */
class SlidingWindow {
  /**
   * @param {number} windowMs - 窗口长度（毫秒）
   * @param {number} maxSamples - 样本数硬上限（防止高频压测下内存膨胀）
   */
  constructor(windowMs = 60000, maxSamples = 200000) {
    this.windowMs = windowMs;
    this.maxSamples = maxSamples;
    this._samples = [];
  }

  /**
   * 追加一个样本
   * @param {Object} sample - 除时间戳外的字段
   * @param {number} [now] - 当前时间戳
   */
  add(sample, now = Date.now()) {
    this._samples.push({ t: now, ...sample });
    this._prune(now);
  }

  /**
   * 淘汰窗口外的样本
   * @param {number} now
   */
  _prune(now) {
    const cutoff = now - this.windowMs;
    let expired = 0;
    while (expired < this._samples.length && this._samples[expired].t < cutoff) {
      expired++;
    }
    if (expired > 0) {
      this._samples.splice(0, expired);
    }
    if (this._samples.length > this.maxSamples) {
      this._samples.splice(0, this._samples.length - this.maxSamples);
    }
  }

  /**
   * 汇总窗口内各数值字段的总和
   * @param {string[]} fields - 需要求和的字段
   * @param {number} [now]
   * @returns {{samples:number, [key:string]:number}}
   */
  totals(fields, now = Date.now()) {
    this._prune(now);
    const out = { samples: this._samples.length };
    fields.forEach((f) => {
      out[f] = 0;
    });
    for (let i = 0; i < this._samples.length; i++) {
      const s = this._samples[i];
      for (let j = 0; j < fields.length; j++) {
        out[fields[j]] += s[fields[j]] || 0;
      }
    }
    return out;
  }

  /** 当前窗口内样本数 */
  get size() {
    return this._samples.length;
  }

  /** 清空窗口 */
  clear() {
    this._samples = [];
  }
}

/**
 * 定宽桶直方图
 *
 * 循环缓冲区只能反映「最近 N 次」请求的分位数，长时间压测会丢失
 * 前段样本。直方图用固定内存记录**全量**样本分布，从而给出整场压测
 * 的 P50/P95/P99，精度由桶宽决定（默认 10ms）。
 */
class Histogram {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxValue] - 最大统计值（毫秒），超出部分计入末桶
   * @param {number} [options.bucketMs] - 桶宽（毫秒）
   */
  constructor({ maxValue = 600000, bucketMs = 10 } = {}) {
    this.bucketMs = bucketMs;
    this.bucketCount = Math.ceil(maxValue / bucketMs) + 1;
    this.buckets = new Float64Array(this.bucketCount);
    this.count = 0;
    this.sum = 0;
    this.min = null;
    this.max = 0;
  }

  /**
   * 记录一个样本
   * @param {number} value
   */
  record(value) {
    if (!Number.isFinite(value) || value < 0) return;
    let index = Math.floor(value / this.bucketMs);
    if (index >= this.bucketCount) index = this.bucketCount - 1;
    this.buckets[index]++;
    this.count++;
    this.sum += value;
    if (this.min === null || value < this.min) this.min = value;
    if (value > this.max) this.max = value;
  }

  /**
   * 取第 rank（0 基）个样本的近似值（用桶中点代表）
   * @param {number} rank
   * @returns {number}
   */
  valueAtRank(rank) {
    if (this.count === 0) return 0;
    let acc = 0;
    for (let i = 0; i < this.bucketCount; i++) {
      acc += this.buckets[i];
      if (acc > rank) return Math.round((i + 0.5) * this.bucketMs);
    }
    return Math.round(this.max);
  }

  /**
   * 计算百分位数
   * @param {number} p - 百分位（0-100）
   * @returns {number}
   */
  percentile(p) {
    if (this.count === 0) return 0;
    const rank = (p / 100) * (this.count - 1);
    return this.valueAtRank(rank);
  }

  /**
   * 输出描述性统计（与 summarize 返回结构保持一致）
   * @param {number[]} percentiles
   */
  summary(percentiles = [50, 90, 95, 99]) {
    const result = {
      count: this.count,
      avg: this.count > 0 ? Math.round(this.sum / this.count) : 0,
      min: this.min === null ? 0 : Math.round(this.min),
      max: Math.round(this.max),
    };
    percentiles.forEach((p) => {
      result[`p${p}`] = this.percentile(p);
    });
    return result;
  }

  /** 清空统计 */
  clear() {
    this.buckets.fill(0);
    this.count = 0;
    this.sum = 0;
    this.min = null;
    this.max = 0;
  }
}

module.exports = {
  percentile,
  summarize,
  SlidingWindow,
  Histogram,
};
