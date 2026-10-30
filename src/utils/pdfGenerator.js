/**
 * PDF 生成器类
 * 使用 pdfkit 生成卡片式性能测试报告
 * 布局参照：标题区 → 核心性能指标卡 → 吞吐与请求卡 → 延迟分位数卡 → 分钟级统计表 → 错误汇总 → 页脚
 */

const PDFDocument = require('pdfkit');
const fs = require('fs');

/**
 * 中文字体候选列表（按顺序探测，取第一个存在的）
 * pdfkit 默认 Helvetica 不含中文字形，必须注册 TTF/TTC 中文字体，否则中文全部乱码。
 * TTC 集合字体需指定 face 的 postscriptname；单文件 TTF face 置 null 即可。
 * 可通过环境变量 PDF_FONT_PATH 强制指定字体文件路径（TTC 时用「路径|face名」格式，如 xxx.ttc|MicrosoftYaHei）。
 */
const CJK_FONT_CANDIDATES = [
  process.env.PDF_FONT_PATH,
  { path: 'C:/Windows/Fonts/msyh.ttc', face: 'MicrosoftYaHei' },   // Windows 微软雅黑
  { path: 'C:/Windows/Fonts/simhei.ttf', face: null },             // Windows 黑体
  { path: 'C:/Windows/Fonts/simsun.ttc', face: 'SimSun' },         // Windows 宋体
  { path: '/usr/share/fonts/noto/NotoSansCJK-Regular.ttc', face: 'NotoSansCJKsc-Regular' },          // Alpine (font-noto-cjk)
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', face: 'NotoSansCJKsc-Regular' }, // Debian/Ubuntu (fonts-noto-cjk)
  { path: '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', face: 'WenQuanYiMicroHei' },             // 文泉驿微米黑
  { path: '/System/Library/Fonts/PingFang.ttc', face: 'PingFangSC-Regular' },                        // macOS 苹方
];

function findChineseFont() {
  for (const c of CJK_FONT_CANDIDATES) {
    try {
      if (!c) continue;
      let fontPath;
      let face;
      if (typeof c === 'string') {
        // 字符串格式：路径 或 「路径|face名」
        const parts = c.split('|');
        fontPath = parts[0];
        face = parts[1] || null;
      } else {
        fontPath = c.path;
        face = c.face;
      }
      if (fontPath && fs.existsSync(fontPath)) return { path: fontPath, face };
    } catch (e) { /* 忽略探测异常，继续下一个候选 */ }
  }
  return null;
}

// 配色
const C = {
  text: '#111827',       // 主文字
  text2: '#374151',      // 次级文字
  muted: '#6b7280',      // 弱化文字
  faint: '#9ca3af',      // 更弱注释
  border: '#e5e7eb',     // 卡片边框
  headBg: '#f3f4f6',     // 表头底色
  rowLine: '#f3f4f6',    // 表格行分隔线
  primary: '#2563eb',    // 主题蓝
  green: '#059669',      // 达标
  greenBg: '#d1fae5',
  red: '#dc2626',        // 未达标
  redBg: '#fee2e2',
};

// 达标判定阈值（与前端评估口径一致）
const THRESHOLD = {
  successRate: 90,      // 有效成功率 ≥ 90%
  cacheHitRate: 80,     // 缓存命中率 ≥ 80%
  ttfbP95: 15000,       // TTFT P95 ≤ 15 s
  tpotP95: 50,          // TPOT P95 ≤ 50 ms/token
};

const PAGE = { width: 595.28, height: 841.89, margin: 40 };
const AVAIL_W = PAGE.width - PAGE.margin * 2; // 515.28

function judge(value, threshold, higherBetter) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  return higherBetter ? v >= threshold : v <= threshold;
}

class PDFGenerator {
  constructor() {
    this.fontInfo = findChineseFont();
  }

  /**
   * 生成 PDF 文档
   * @param {Object} data - 报告数据
   * @returns {Promise<Buffer>} PDF 缓冲区
   */
  async generate(data) {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: PAGE.margin, size: 'A4' });

        // 注册中文字体（Helvetica 不含中文字形，不注册会乱码）
        if (this.fontInfo) {
          if (this.fontInfo.face) {
            doc.font(this.fontInfo.path, this.fontInfo.face);
          } else {
            doc.font(this.fontInfo.path);
          }
        } else {
          console.warn('[pdfGenerator] 未找到可用的中文字体，中文可能显示异常。可通过环境变量 PDF_FONT_PATH 指定 TTF/TTC 字体文件');
        }

        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('error', reject);

        this.drawHeader(doc, data);
        this.drawCoreMetrics(doc, data);
        this.drawThroughputMetrics(doc, data);
        this.drawLatencyMetrics(doc, data);
        this.drawMinuteStatsTable(doc, data.minuteStats || []);
        this.drawErrorSummary(doc, data.errorSummary || {});
        this.drawFooters(doc, data);

        doc.end();
        doc.on('end', () => resolve(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    });
  }

  /** 顶部标题区 */
  drawHeader(doc, data) {
    const m = PAGE.margin;
    const top = m + 8;

    // 左侧标题
    doc.fillColor(C.text).fontSize(20)
      .text(`${data.modelName || '未知模型'} 性能测试报告`, m, top, { lineBreak: false });

    // 左侧 URL 与模式标签
    doc.fillColor(C.muted).fontSize(9)
      .text(String(data.testUrl || '-'), m, top + 30, { lineBreak: false });
    const tags = [
      data.testMode || '-',
      data.promptMode || '-',
      data.requestType || '-',
      data.concurrency != null ? `并发 ${data.concurrency}` : null,
    ].filter(Boolean).join('  ·  ');
    doc.fillColor(C.faint).fontSize(9)
      .text(tags, m, top + 46, { lineBreak: false });

    // 右侧元信息（右对齐，自下而上排）
    const rightX = PAGE.width - m;
    const avgInput = data.totalRequests > 0
      ? Math.round((data.totalPromptTokens || 0) / data.totalRequests)
      : null;
    const metaLines = [
      `测试时间 ${data.startTime || '-'}`,
      `模型 ${data.modelName || '-'}`,
      avgInput != null ? `平均输入 ${this.fmtNum(avgInput)} tokens / 请求` : null,
      `持续时间 ${this.fmtDuration(data.duration)}`,
    ].filter(Boolean);
    let my = top + 2;
    metaLines.forEach((line) => {
      doc.fillColor(C.muted).fontSize(8.5)
        .text(line, rightX - 220, my, { width: 220, align: 'right', lineBreak: false });
      my += 14;
    });

    // 分隔线
    const lineY = Math.max(top + 64, my + 4);
    doc.moveTo(m, lineY).lineTo(rightX, lineY).lineWidth(0.75).strokeColor(C.border).stroke();
    doc.x = m;
    doc.y = lineY + 16;
  }

  /** 分区标题：蓝色竖条 + 标题 + 右侧注释 */
  sectionTitle(doc, title, note) {
    const m = PAGE.margin;
    const y = doc.y;
    doc.fillColor(C.primary).rect(m, y + 1, 3, 12).fill();
    doc.fillColor(C.text).fontSize(13).text(title, m + 10, y - 2, { lineBreak: false });
    if (note) {
      doc.fillColor(C.faint).fontSize(8)
        .text(note, PAGE.width - m - 200, y + 1, { width: 200, align: 'right', lineBreak: false });
    }
    doc.y = y + 24;
  }

  /** 核心性能指标：5 张大卡 */
  drawCoreMetrics(doc, data) {
    this.sectionTitle(doc, '核心性能指标');

    const cacheHit = data.cachedTokens != null && data.totalPromptTokens > 0
      ? Math.round((data.cachedTokens / data.totalPromptTokens) * 10000) / 100
      : null;

    const cards = [
      {
        title: '有效成功率',
        value: data.successRate != null ? `${this.fmtNum(data.successRate)}%` : '-',
        status: judge(data.successRate, THRESHOLD.successRate, true),
        foot: `${data.successCount || 0} 成功 / ${data.failureCount || 0} 失败`,
        foot2: '目标 ≥ 90%',
      },
      {
        title: '缓存命中率',
        value: cacheHit != null ? `${this.fmtNum(cacheHit)}%` : '-',
        status: cacheHit != null ? judge(cacheHit, THRESHOLD.cacheHitRate, true) : null,
        foot: cacheHit != null
          ? `${this.fmtNum(data.cachedTokens)} / ${this.fmtNum(data.totalPromptTokens)}`
          : '上游未返回缓存数据',
        foot2: cacheHit != null ? '目标 ≥ 80%' : null,
      },
      {
        title: 'TTFT P95',
        value: data.ttfbP95 != null ? `${this.fmtNum(data.ttfbP95)} ms` : '-',
        status: judge(data.ttfbP95, THRESHOLD.ttfbP95, false),
        foot: '首字节延迟',
        foot2: '目标 ≤ 15 s',
      },
      {
        title: 'TPOT P95',
        value: data.tpotP95 != null ? `${this.fmtNum(data.tpotP95)} ms/tok` : '-',
        status: judge(data.tpotP95, THRESHOLD.tpotP95, false),
        foot: '单 token 解码间隔',
        foot2: '目标 ≤ 50 ms/token',
      },
      {
        title: 'Total TPM',
        value: data.avgTPM != null ? this.fmtNum(data.avgTPM) : '-',
        status: null,
        foot: '输入 + 输出 / 分钟',
      },
    ];

    this.drawCardRow(doc, cards, 5, 78, 15);
  }

  /** 吞吐与请求：12 张小卡，两行 */
  drawThroughputMetrics(doc, data) {
    doc.y += 6;
    this.sectionTitle(doc, '吞吐与请求');

    const total = data.totalRequests || 0;
    const avgOutput = total > 0 ? Math.round((data.totalCompletionTokens || 0) / total) : null;
    const inShare = data.totalTokens > 0
      ? `${Math.round(((data.totalPromptTokens || 0) / data.totalTokens) * 100)}%`
      : '-';
    const outShare = data.totalTokens > 0
      ? `${Math.round(((data.totalCompletionTokens || 0) / data.totalTokens) * 100)}%`
      : '-';
    const failShare = total > 0 ? `${this.fmtNum(((data.failureCount || 0) / total) * 100, 1)}%` : '-';

    const row1 = [
      { title: '平均输出', value: avgOutput != null ? this.fmtNum(avgOutput) : '-', foot: 'tokens · 每请求' },
      { title: '请求数', value: this.fmtNum(total), foot: data.successCount != null ? `${this.fmtNum(data.successCount)} 成功 / 总数` : '总数' },
      { title: 'RPM', value: this.fmtNum(data.actualRPM || total), foot: data.targetRPM ? `目标 ${data.targetRPM}` : '实际达成' },
      { title: 'Input TPM', value: this.fmtNum(data.inputTPM || 0), foot: `占总 token ${inShare}` },
      { title: 'Output TPM', value: this.fmtNum(data.outputTPM || 0), foot: `占总 token ${outShare}` },
      { title: 'Total TPM', value: this.fmtNum(data.avgTPM || 0), foot: '输入 + 输出' },
    ];
    const row2 = [
      { title: '峰值并发', value: this.fmtNum(data.peakConcurrency || 0), foot: data.concurrency ? `设定 ${data.concurrency}` : '实测' },
      { title: '累计输入 Token', value: this.fmtNum(data.totalPromptTokens || 0) },
      { title: '累计输出 Token', value: this.fmtNum(data.totalCompletionTokens || 0) },
      { title: '累计总 Token', value: this.fmtNum(data.totalTokens || 0) },
      { title: '平均响应时间', value: this.fmtNum(data.avgResponseTime || 0), unit: 'ms', foot: '端到端' },
      { title: '失败请求', value: this.fmtNum(data.failureCount || 0), foot: `占比 ${failShare}` },
    ];

    this.drawCardRow(doc, row1, 6, 54, 12);
    this.drawCardRow(doc, row2, 6, 54, 12);
  }

  /** 延迟分位数：6 张中卡 */
  drawLatencyMetrics(doc, data) {
    doc.y += 6;
    this.sectionTitle(doc, '延迟分位数', '分位数比均值更能反映长尾');

    const cards = [
      { title: 'Latency P50', value: `${this.fmtNum(data.p50ResponseTime || 0)} ms`, foot: '端到端' },
      { title: 'Latency P95', value: `${this.fmtNum(data.p95ResponseTime || 0)} ms`, foot: '端到端' },
      { title: 'Latency P99', value: `${this.fmtNum(data.p99ResponseTime || 0)} ms`, foot: '端到端' },
      { title: 'TTFT P95', value: `${this.fmtNum(data.ttfbP95 || 0)} ms`, foot: '首字节延迟' },
      { title: 'TPOT P95', value: `${this.fmtNum(data.tpotP95 || 0)} ms/tok`, foot: '解码间隔' },
      { title: 'Latency Avg', value: `${this.fmtNum(data.avgResponseTime || 0)} ms`, foot: '端到端均值' },
    ];

    this.drawCardRow(doc, cards, 6, 62, 12.5);
  }

  /**
   * 画一行指标卡
   * @param {Array} cards - 卡片定义 {title, value, unit?, status?, foot?, foot2?}
   * @param {Number} cols - 列数
   * @param {Number} cardH - 卡片高度
   * @param {Number} valueSize - 数值字号
   */
  drawCardRow(doc, cards, cols, cardH, valueSize) {
    const m = PAGE.margin;
    const gap = 8;
    const cardW = (AVAIL_W - gap * (cols - 1)) / cols;

    // 底部安全区：剩余空间不够一行时换页
    if (doc.y + cardH > PAGE.height - 64) {
      doc.addPage();
    }

    // 冻结行坐标：卡片内部的 text 调用会推进 doc 游标，统一从 rowY 取值，
    // 行画完后显式恢复，避免卡片沿对角线漂移
    const rowY = doc.y;
    let x = m;
    cards.forEach((card) => {
      this.drawCard(doc, card, x, rowY, cardW, cardH, valueSize);
      x += cardW + gap;
    });

    doc.y = rowY + cardH + 10;
  }

  /** 单张指标卡（内部元素全部使用固定锚点定位，禁止文本游标参与布局） */
  drawCard(doc, card, x, y, w, h, valueSize) {
    const pad = 9;
    doc.roundedRect(x, y, w, h, 6).fillColor('#ffffff').fillAndStroke('#ffffff', C.border);

    // 标题：固定在卡片顶部
    doc.fillColor(C.muted).fontSize(8.5)
      .text(card.title, x + pad, y + pad, {
        width: w - pad * 2, height: 12, lineBreak: false, ellipsis: true,
      });

    // 数值：单行，超宽截断；颜色随达标状态
    const color = card.status === true ? C.green : card.status === false ? C.red : C.text;
    const valueY = y + pad + 13;
    doc.fillColor(color).fontSize(valueSize)
      .text(`${card.value}${card.unit ? ' ' + card.unit : ''}`, x + pad, valueY, {
        width: w - pad * 2, height: valueSize + 4, lineBreak: false, ellipsis: true,
      });

    // 底部脚注区（固定锚点：从卡片底部向上排）
    const foot1Y = y + h - (card.foot2 ? 22 : 13);
    const foot2Y = y + h - 11;
    if (card.foot) {
      doc.fillColor(C.faint).fontSize(7.5)
        .text(card.foot, x + pad, foot1Y, {
          width: w - pad * 2, height: 10, lineBreak: false, ellipsis: true,
        });
    }
    if (card.foot2) {
      doc.fillColor(C.faint).fontSize(7.5)
        .text(card.foot2, x + pad, foot2Y, {
          width: w - pad * 2, height: 10, lineBreak: false, ellipsis: true,
        });
    }

    // 达标徽章：固定在卡片右上角，与数值同基线
    if (card.status === true || card.status === false) {
      const label = card.status ? '达标' : '未达标';
      const bw = 30;
      const bx = x + w - pad - bw;
      doc.roundedRect(bx, y + pad - 1, bw, 13, 3)
        .fillColor(card.status ? C.greenBg : C.redBg).fill();
      doc.fillColor(card.status ? C.green : C.red).fontSize(7.5)
        .text(label, bx, y + pad + 1.5, { width: bw, align: 'center', lineBreak: false });
    }
  }

  /** 分钟级统计表 */
  drawMinuteStatsTable(doc, minuteStats) {
    doc.y += 6;
    this.sectionTitle(doc, '分钟级统计', `${minuteStats.length} 个采样点`);

    const m = PAGE.margin;
    const cols = [
      { key: 'time', label: '时间', width: 150, align: 'left' },
      { key: 'success', label: '成功', width: 80, align: 'right' },
      { key: 'failure', label: '失败', width: 80, align: 'right' },
      { key: 'rpm', label: 'RPM', width: 90, align: 'right' },
      { key: 'tpm', label: 'TPM', width: 115, align: 'right' },
    ];

    const drawCells = (row, y, header) => {
      if (header) {
        doc.rect(m, y, AVAIL_W, 20).fillColor(C.headBg).fill();
      }
      let x = m;
      cols.forEach((col) => {
        doc.fillColor(header ? C.muted : C.text2).fontSize(9)
          .text(String(row[col.key] ?? '-'), x + 6, y + 5.5, {
            width: col.width - 12,
            align: col.align,
            lineBreak: false,
            ellipsis: true,
          });
        x += col.width;
      });
      if (!header) {
        doc.moveTo(m, y + 20).lineTo(m + AVAIL_W, y + 20).lineWidth(0.5).strokeColor(C.rowLine).stroke();
      }
    };

    const headerRow = {};
    cols.forEach((c) => { headerRow[c.key] = c.label; });

    let y = doc.y;
    const bottomSafe = PAGE.height - 70;

    if (!minuteStats.length) {
      doc.fillColor(C.faint).fontSize(9.5).text('无分钟统计数据', m, y);
      doc.y = y + 20;
      return;
    }

    drawCells(headerRow, y, true);
    y += 20;

    minuteStats.forEach((stat) => {
      if (y + 20 > bottomSafe) {
        doc.addPage();
        y = PAGE.margin;
        drawCells(headerRow, y, true);
        y += 20;
      }
      drawCells({
        time: this.fmtMinuteTime(stat.timestamp),
        success: String(stat.successCount || 0),
        failure: String(stat.failureCount || 0),
        rpm: String(stat.rpm || 0),
        tpm: this.fmtNum(stat.tpm ?? stat.tokens ?? 0),
      }, y, false);
      y += 20;
    });

    doc.y = y + 8;
  }

  /** 错误摘要 */
  drawErrorSummary(doc, errors) {
    doc.y += 6;
    this.sectionTitle(doc, '错误汇总', '按错误类型聚合');

    const m = PAGE.margin;
    const entries = Object.entries(errors || {});

    if (!entries.length) {
      const y0 = doc.y;
      doc.fillColor(C.green).fontSize(9.5).text('无错误，全部成功', m, y0, { lineBreak: false });
      doc.y = y0 + 24;
      return;
    }

    entries.forEach(([type, count]) => {
      const y0 = doc.y;
      doc.fillColor(C.red).fontSize(9.5)
        .text(`${type}: ${count} 次`, m, y0, { width: AVAIL_W, lineBreak: false });
      doc.y = y0 + 16;
    });
    doc.y += 8;
  }

  /** 页脚：每页底部画项目名、报告编号与页码 */
  drawFooters(doc, data) {
    // 注意：不能先 flushPages() —— flush 会清空 page buffer，
    // 导致 bufferedPageRange() 返回 count=0，页脚一次都画不上
    const range = doc.bufferedPageRange();
    const total = range.count;
    const m = PAGE.margin;
    const fy = PAGE.height - 46;

    for (let i = 0; i < total; i++) {
      doc.switchToPage(range.start + i);
      doc.moveTo(m, fy - 8).lineTo(PAGE.width - m, fy - 8).lineWidth(0.5).strokeColor(C.border).stroke();
      // 右侧页脚不用 width/align 选项：带 width 的 text 会走 LineWrapper，
      // 在接近页底时（doc.y + 行高 > 下边距）被自动换页到下一页
      doc.fillColor(C.faint).fontSize(8)
        .text('LLM-API-Eval · 大模型 API 接口压测平台', m, fy, { lineBreak: false });
      const right = `报告编号 ${data.id || '-'}   第 ${i + 1} / ${total} 页`;
      const rightW = doc.widthOfString(right);
      doc.fillColor(C.faint).fontSize(8)
        .text(right, PAGE.width - m - rightW, fy, { lineBreak: false });
    }
  }

  /** 数字格式化：千分位，≥10 万缩写为 K */
  fmtNum(value, digits) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '-';
    if (digits != null) return n.toFixed(digits);
    if (Math.abs(n) >= 100000) {
      return `${(n / 1000).toFixed(1)} K`;
    }
    return Math.round(n * 100) / 100 === Math.round(n)
      ? n.toLocaleString('en-US')
      : (Math.round(n * 100) / 100).toLocaleString('en-US');
  }

  /** 毫秒时长格式化：1 分 0 秒 */
  fmtDuration(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '-';
    const totalSec = Math.round(n / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min <= 0) return `${sec} 秒`;
    return `${min} 分 ${sec} 秒`;
  }

  /** 分钟统计时间格式化：ISO → MM-dd HH:mm；非法时间原样返回 */
  fmtMinuteTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /**
   * 百分比格式化
   * @param {number} value
   */
  formatPercent(value) {
    if (value === undefined || value === null) return '-';
    const num = Number(value);
    if (!Number.isFinite(num)) return '-';
    return num <= 1 ? `${Math.round(num * 10000) / 100}%` : `${num.toFixed(2)}%`;
  }
}

module.exports = PDFGenerator;
