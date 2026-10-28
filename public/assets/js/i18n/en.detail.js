// 测试详情页词条
(function () {
  Object.assign(window.I18N_EN, {
    // 页面标题
    '测试详情 · LLM-API-Eval': 'Test Detail · LLM-API-Eval',
    '测试详情': 'Test Detail',
    '单次压测完整报告': 'Complete report of a single load test',

    // 模式与请求方式
    '固定压测': 'Fixed Load Test',
    '自动增压': 'Auto Ramp-Up',
    '恒定并发': 'Constant Concurrency',
    '并发阶梯': 'Concurrency Stages',
    '自动寻优': 'Auto Seek',
    '能力探测': 'Capability Probe',
    '流式请求': 'Streaming',
    '非流式请求': 'Non-Streaming',
    '固定请求': 'Fixed Prompt',
    '随机请求': 'Random Prompt',
    '数据集': 'Dataset',

    // 空状态
    '无效的记录 ID': 'Invalid record ID',
    '记录不存在，或无权访问该记录': 'Record not found, or access denied',
    '加载失败：': 'Load failed: ',
    '返回历史列表': 'Back to History',
    '返回列表': 'Back to List',

    // 基础信息
    '记录': 'Record',
    '达标': 'Met',
    '未达标': 'Not Met',
    '模型名称': 'Model',
    '压测模式': 'Load Test Mode',
    '请求方式': 'Request Type',
    '请求模式': 'Prompt Mode',
    '开始时间': 'Start Time',
    '结束时间': 'End Time',
    '测试时长': 'Duration',
    '最大可持续 RPM': 'Max Sustainable RPM',
    '目标 RPM': 'Target RPM',
    '并发路数（峰值）': 'Concurrency (Peak)',
    '请求复用率 目标 / 实际': 'Prompt Reuse (Target / Actual)',
    '停止原因': 'Stop Reason',
    '手动停止': 'Manual stop',
    '（无配置数据）': '(No config data)',

    // 核心指标
    '核心指标': 'Core Metrics',
    '总请求数': 'Total Requests',
    '成功率': 'Success Rate',
    '成功次数': 'Successes',
    '失败次数': 'Failures',
    '平均响应时间': 'Avg Response Time',
    '累计 Token': 'Total Tokens',
    '平均 TPM': 'Avg TPM',
    '预估成本（本轮）': 'Est. Cost (This Run)',
    'tokens/分': 'tokens/min',

    // 延迟分位数
    '延迟分位数': 'Latency Percentiles',
    '端到端耗时与流式输出体验': 'End-to-end timing and streaming output experience',
    '端到端 P50': 'End-to-End P50',
    '端到端 P95': 'End-to-End P95',
    '端到端 P99': 'End-to-End P99',
    '首字节 TTFB P95': 'TTFB P95',
    'ms/输出token': 'ms/output token',

    // 评估结果
    '评估结果': 'Evaluation Results',
    '压测过程测得的最大可持续吞吐与建议承载档位': 'Maximum sustainable throughput measured during the test and recommended capacity levels',
    '最大可持续 TPM（输出）': 'Max Sustainable TPM (Output)',
    '建议承载 RPM': 'Recommended RPM',
    '建议承载 TPM': 'Recommended TPM',

    // SLA 结论
    'SLA 结论': 'SLA Verdict',
    '基于压测测得的最大可持续吞吐判定': 'Judged by the maximum sustainable throughput measured in the test',
    '✓ SLA 达标': '✓ SLA Met',
    '✕ SLA 未达标': '✕ SLA Not Met',
    '已达成 SLA：压测中测得最大可持续 RPM / TPM': 'SLA met: maximum sustainable RPM / TPM measured during the test',
    '未达成 SLA：未能测得最大可持续 RPM / TPM（或成功率低于阈值）': 'SLA not met: failed to measure maximum sustainable RPM / TPM (or success rate below threshold)',

    // Token 吞吐
    'Token 吞吐（输入 / 输出拆分）': 'Token Throughput (Input / Output Breakdown)',
    '吞吐速率与累计消耗': 'Throughput rates and cumulative consumption',
    '平均输入 TPM': 'Avg Input TPM',
    '平均输出 TPM': 'Avg Output TPM',
    '累计输入 Token': 'Total Input Tokens',
    '累计输出 Token': 'Total Output Tokens',

    // 分钟级趋势
    '分钟级趋势': 'Minute-Level Trends',
    '延迟与吞吐随时间的变化，用于定位性能拐点与抖动；早期记录可能缺少分钟级延迟数据': 'How latency and throughput change over time, to locate performance inflection points and jitter; early records may lack minute-level latency data',
    '分钟平均响应延迟': 'Avg Response Latency per Minute',
    '平均响应时间（成功请求）': 'Avg Response Time (Successful Requests)',
    'Token 吞吐趋势': 'Token Throughput Trend',
    '总 TPM': 'Total TPM',
    '输入': 'Input',
    '输出': 'Output',

    // 分钟统计
    '分钟统计': 'Minute Statistics',
    '每分钟成功 / 失败与吞吐明细，共': 'Per-minute success / failure and throughput details,',
    '分钟': 'min in total',
    '时间': 'Time',
    '请求数': 'Requests',
    '成功': 'Success',
    '失败': 'Failures',
    '平均耗时': 'Avg Duration',
    '无分钟统计数据': 'No minute-level data',

    // 错误汇总
    '错误汇总': 'Error Summary',
    '按出现次数降序排列': 'Sorted by occurrence count, descending',
    '次': 'times',
    '无错误记录': 'No errors recorded',

    // 原始配置
    '原始配置': 'Raw Config',
    '该次压测提交的完整 testConfig': 'The full testConfig submitted for this load test',
    '展开 / 收起配置 JSON': 'Expand / collapse config JSON',

    // 操作按钮与提示
    '导出 JSON': 'Export JSON',
    '导出 CSV': 'Export CSV',
    '导出 PDF': 'Export PDF',
    '导出 Excel': 'Export Excel',
    '删除': 'Delete',
    '导出成功': ' export succeeded',
    '导出失败：': 'Export failed: ',
    '确定要<b>删除这条测试记录</b>吗？删除后不可恢复。': 'Are you sure you want to <b>delete this test record</b>? This cannot be undone.',
    '记录已删除': 'Record deleted',
    '删除失败：': 'Delete failed: ',
  });
})();
