/**
 * PDF 生成器类
 * 使用 pdfkit 库生成 PDF 报告
 */

const PDFDocument = require('pdfkit');

class PDFGenerator {
  /**
   * 生成 PDF 文档
   * @param {Object} data - 报告数据
   * @returns {Promise<Buffer>} PDF 缓冲区
   */
  async generate(data) {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 50 });
        const chunks = [];

        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // 添加报告内容
        this.addTitle(doc, 'LLM-API-Eval 压测报告');
        this.addConfigSection(doc, data);
        this.addConclusionSection(doc, data);
        this.addStatsSection(doc, data);
        this.addLatencySection(doc, data);
        this.addTokenSection(doc, data);
        this.addMinuteStatsTable(doc, data.minuteStats || []);
        this.addErrorSummary(doc, data.errorSummary || {});

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 添加标题
   * @param {PDFDocument} doc - PDF 文档
   * @param {string} title - 标题文本
   */
  addTitle(doc, title) {
    doc.fontSize(20).text(title, { align: 'center' });
    doc.moveDown(2);
  }

  /**
   * 添加测试配置信息
   * @param {PDFDocument} doc - PDF 文档
   * @param {Object} config - 配置数据
   */
  addConfigSection(doc, config) {
    doc.fontSize(14).text('测试配置', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10);
    
    const configItems = [
      { label: '测试 URL', value: config.testUrl || '-' },
      { label: '模型名称', value: config.modelName || '-' },
      { label: '测试模式', value: config.testMode || '-' },
      { label: '提示模式', value: config.promptMode || '-' },
      { label: '请求类型', value: config.requestType || '-' },
      { label: '目标 RPM', value: config.targetRPM || '-' },
      { label: '最大 RPM', value: config.maxRPM || '-' },
      { label: '并发路数', value: config.concurrency || 0 },
      { label: '请求复用率(目标/实际)', value: `${this.formatPercent(config.promptReuseRatio)} / ${this.formatPercent(config.actualPromptReuseRatio)}` },
      { label: '开始时间', value: config.startTime || '-' },
      { label: '结束时间', value: config.endTime || '-' },
      { label: '持续时间', value: config.duration ? `${config.duration} 秒` : '-' }
    ];
    
    configItems.forEach(item => {
      doc.text(`${item.label}: ${item.value}`);
    });
    
    doc.moveDown(1.5);
  }

  /**
   * 添加统计数据
   * @param {PDFDocument} doc - PDF 文档
   * @param {Object} stats - 统计数据
   */
  addStatsSection(doc, stats) {
    doc.fontSize(14).text('统计数据', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10);
    
    const statsItems = [
      { label: '总请求数', value: stats.totalRequests || 0 },
      { label: '成功数', value: stats.successCount || 0 },
      { label: '失败数', value: stats.failureCount || 0 },
      { label: '成功率', value: this.formatPercent(stats.successRate) },
      { label: '平均响应时间', value: `${Math.round(stats.avgResponseTime || 0)} ms` },
      { label: '停止原因', value: stats.stopReason || '-' }
    ];

    statsItems.forEach(item => {
      doc.text(`${item.label}: ${item.value}`);
    });

    doc.moveDown(1.5);
  }

  /**
   * 添加延迟分位数（平均值会被长尾掩盖，分位数才是用户真实感知）
   * @param {PDFDocument} doc
   * @param {Object} data
   */
  addLatencySection(doc, data) {
    doc.fontSize(14).text('延迟分位数', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10);

    const rows = [
      ['端到端延迟 P50', data.p50ResponseTime, 'ms'],
      ['端到端延迟 P95', data.p95ResponseTime, 'ms'],
      ['端到端延迟 P99', data.p99ResponseTime, 'ms'],
      ['首字节延迟 TTFB P95', data.ttfbP95, 'ms'],
      ['每输出 token 耗时 TPOT P95', data.tpotP95, 'ms/token'],
    ];

    rows.forEach(([label, value, unit]) => {
      doc.text(`${label}: ${value || 0} ${unit}`);
    });

    doc.moveDown(1.5);
  }

  /**
   * 添加评估结果（最大可持续 RPM / TPM 与建议容量）
   * @param {PDFDocument} doc
   * @param {Object} data
   */
  addConclusionSection(doc, data) {
    const hasRPM = Number(data.maxRPM) > 0;
    const hasTPM = Number(data.maxTPM) > 0;
    if (!hasRPM && !hasTPM && !Number(data.recommendedRPM) && !Number(data.recommendedTPM)) {
      return;
    }

    doc.fontSize(14).text('评估结果', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10);

    if (hasRPM) {
      doc.text(`最大可持续 RPM: ${data.maxRPM}`);
    }
    if (hasTPM) {
      doc.text(`最大可持续 TPM: ${data.maxTPM}`);
    }
    if (Number(data.recommendedRPM) > 0) {
      doc.text(`建议承载 RPM: ${data.recommendedRPM}`);
    }
    if (Number(data.recommendedTPM) > 0) {
      doc.text(`建议承载 TPM: ${data.recommendedTPM}`);
    }

    doc.moveDown(1.5);
  }

  /**
   * 添加 Token 维度统计（输入/输出 TPM 分开，对应不同瓶颈）
   * @param {PDFDocument} doc
   * @param {Object} data
   */
  addTokenSection(doc, data) {
    doc.fontSize(14).text('Token 维度统计', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10);

    const rows = [
      ['累计输入 Token', data.totalPromptTokens || 0],
      ['累计输出 Token', data.totalCompletionTokens || 0],
      ['累计总 Token', data.totalTokens || 0],
      ['平均总 TPM', data.avgTPM || 0],
      ['平均输入 TPM', data.inputTPM || 0],
      ['平均输出 TPM', data.outputTPM || 0],
      ['峰值并发请求数', data.peakConcurrency || 0],
    ];

    rows.forEach(([label, value]) => {
      doc.text(`${label}: ${value}`);
    });

    doc.moveDown(1.5);
  }

  /**
   * 百分比格式化
   * @param {number} value
   */
  formatPercent(value) {
    if (value === undefined || value === null) return '-';
    const num = Number(value);
    if (!Number.isFinite(num)) return '-';
    // 复用率为 0-1 的小数，成功率等本身已是百分数
    return num <= 1 ? `${Math.round(num * 10000) / 100}%` : `${num.toFixed(2)}%`;
  }

  /**
   * 添加分钟统计表格
   * @param {PDFDocument} doc - PDF 文档
   * @param {Array} minuteStats - 分钟统计数组
   */
  addMinuteStatsTable(doc, minuteStats) {
    doc.fontSize(14).text('分钟统计', { underline: true });
    doc.moveDown(0.5);
    
    if (!minuteStats || minuteStats.length === 0) {
      doc.fontSize(10).text('无分钟统计数据');
      doc.moveDown(1.5);
      return;
    }
    
    doc.fontSize(10);
    
    // 表头
    const headers = ['时间', '成功数', '失败数', 'RPM', 'TPM'];
    const colWidths = [150, 70, 70, 70, 80];
    const startX = doc.x;
    let currentY = doc.y;
    
    // 绘制表头
    headers.forEach((header, i) => {
      doc.text(header, startX + colWidths.slice(0, i).reduce((a, b) => a + b, 0), currentY, {
        width: colWidths[i],
        align: 'left'
      });
    });
    
    currentY += 15;
    doc.moveTo(startX, currentY).lineTo(startX + colWidths.reduce((a, b) => a + b, 0), currentY).stroke();
    currentY += 5;
    
    // 绘制数据行
    minuteStats.forEach(stat => {
      // 检查是否需要换页
      if (currentY > doc.page.height - 100) {
        doc.addPage();
        currentY = 50;
      }
      
      const row = [
        stat.timestamp || '-',
        String(stat.successCount || 0),
        String(stat.failureCount || 0),
        String(stat.rpm || 0),
        String(stat.tpm ?? stat.tokens ?? 0)
      ];
      
      row.forEach((cell, i) => {
        doc.text(cell, startX + colWidths.slice(0, i).reduce((a, b) => a + b, 0), currentY, {
          width: colWidths[i],
          align: 'left'
        });
      });
      
      currentY += 15;
    });
    
    doc.y = currentY;
    doc.moveDown(1.5);
  }

  /**
   * 添加错误摘要
   * @param {PDFDocument} doc - PDF 文档
   * @param {Object} errors - 错误摘要
   */
  addErrorSummary(doc, errors) {
    doc.fontSize(14).text('错误摘要', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10);
    
    if (!errors || Object.keys(errors).length === 0) {
      doc.text('无错误记录');
      doc.moveDown(1.5);
      return;
    }
    
    Object.entries(errors).forEach(([errorType, count]) => {
      doc.text(`${errorType}: ${count} 次`);
    });
    
    doc.moveDown(1.5);
  }
}

module.exports = PDFGenerator;
