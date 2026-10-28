// 历史报告页词条
(function () {
  Object.assign(window.I18N_EN, {
    // 页面标题
    '历史报告 · LLM-API-Eval': 'History · LLM-API-Eval',
    '历史报告': 'History',
    '压测记录与导出': 'Load test records & export',

    // 统计概览
    '当前记录数': 'Current Records',
    '本页汇总': 'This page',
    '总请求数': 'Total Requests',
    '平均成功率': 'Avg Success Rate',
    '平均 P95 延迟': 'Avg P95 Latency',

    // 列表卡片
    '测试记录': 'Test Records',
    '所有已完成的压测记录，按时间倒序，点击行可查看详情': 'All completed load test records, newest first. Click a row to view details',
    'A/B 对比': 'A/B Compare',
    '清空记录': 'Clear Records',

    // 筛选
    '压测模式': 'Load Test Mode',
    '全部模式': 'All Modes',
    '固定压测': 'Fixed Load Test',
    '自动增压': 'Auto Ramp-Up',
    '恒定并发': 'Constant Concurrency',
    '并发阶梯': 'Concurrency Stages',
    '自动寻优': 'Auto Seek',
    '能力探测': 'Capability Probe',
    '开始日期': 'Start Date',
    '结束日期': 'End Date',
    '筛选': 'Filter',
    '重置': 'Reset',

    // 表头
    '时间': 'Time',
    '目标 / 模型': 'Target / Model',
    '模式': 'Mode',
    '请求数': 'Requests',
    '成功率': 'Success Rate',
    '平均耗时': 'Avg Duration',
    '操作': 'Actions',

    // 行内容与行操作
    '查看': 'View',
    '对比': 'Compare',
    '与另一条记录做 A/B 对比': 'Compare with another record (A/B)',
    '导出 JSON': 'Export JSON',
    '导出 CSV': 'Export CSV',
    '流式': 'Stream',
    '非流式': 'Non-Stream',
    '时长': 'Duration',

    // 空状态 / 分页
    '暂无历史记录': 'No history records yet',
    '开始压测后，记录会自动保存在这里': 'Records are saved here automatically after each load test',
    '共': 'Total',
    '条': 'records',
    '第 {page} / {totalPages} 页': 'Page {page} / {totalPages}',
    '上一页': 'Prev',
    '下一页': 'Next',

    // 导出 / 删除 / 清空
    '导出成功': ' export succeeded',
    '导出失败：': 'Export failed: ',
    '加载失败：': 'Load failed: ',
    '确定要<b>删除这条测试记录</b>吗？删除后不可恢复。': 'Are you sure you want to <b>delete this test record</b>? This cannot be undone.',
    '删除': 'Delete',
    '记录已删除': 'Record deleted',
    '删除失败：': 'Delete failed: ',
    '确定要<b>清空所有历史记录</b>吗？此操作不可恢复！': 'Are you sure you want to <b>clear all history records</b>? This action cannot be undone!',
    '全部清空': 'Clear All',
    '历史记录已清空': 'History records cleared',
    '清空失败：': 'Clear failed: ',

    // A/B 对比弹窗
    'A/B 历史对比': 'A/B History Compare',
    '基准记录 A': 'Baseline Record A',
    '对比记录 B': 'Compare Record B',
    'A 基准': 'A (Baseline)',
    'B 对比': 'B (Compare)',
    '开始对比': 'Start Compare',
    '关闭': 'Close',
    '指标': 'Metric',
    '变化': 'Change',
    '变化（B − A）': 'Change (B − A)',
    '✓ 与绿色表示 B 侧更优；延迟类指标越低越好，吞吐类指标越高越好。': '✓ Green and a check mark mean B is better; lower is better for latency metrics, higher is better for throughput metrics.',
    '对比失败：': 'Compare failed: ',
    '点击“开始对比”查看逐项指标差异': 'Click “Start Compare” to view metric-by-metric differences',
    '请选择两条不同的记录': 'Please select two different records',
    '至少需要两条测试记录才能对比，请先完成两次压测': 'At least two test records are required to compare. Please complete two load tests first',
  });
})();
