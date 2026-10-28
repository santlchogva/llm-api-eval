// 并行对比测试页词条
(function () {
  Object.assign(window.I18N_EN, {
    // 占用横幅
    '其他用户正在并行压测，数据互不可见，当前无法启动新的测试。': 'Another user is running a parallel load test. Data is isolated between users and new tests cannot be started for now.',
    '强制停止': 'Force Stop',

    // 配置区
    '测试配置': 'Test Configuration',
    '同时压测最多 5 个 API 端点，横向对比不同接口协议与模型的性能表现，结束后自动生成对比结果。': 'Load test up to 5 API endpoints at once and compare protocols and models side by side; a comparison is generated automatically when finished.',
    '+ 添加配置': '+ Add Configuration',

    // 控制按钮
    '启动并行测试': 'Start Parallel Test',
    '停止测试': 'Stop Test',
    '至少填写每组配置的 Base URL、模型名称与 API Key': 'Each configuration needs Base URL, Model Name and API Key',

    // 运行状态 / 结果对比
    '准备就绪': 'Ready',
    '结果对比': 'Comparison',
    '按成功率标记最佳 / 最差配置': 'Best / worst configurations marked by success rate',

    // 表头
    '配置': 'Configuration',
    '模型': 'Model',
    '接口协议': 'API Protocol',
    '总请求': 'Total Requests',
    '成功率': 'Success Rate',
    '平均响应': 'Avg Response',
    '状态': 'Status',

    // 状态词
    '等待中': 'Pending',
    '运行中': 'Running',
    '已完成': 'Completed',
    '失败': 'Failed',
    '已停止': 'Stopped',

    // 配置组编辑器
    '添加配置': 'Add Configuration',
    '已达上限': 'Limit reached',
    '未完成': 'Incomplete',
    '就绪': 'Ready',
    'OpenAI 接口': 'OpenAI API',
    'OpenAI Responses 接口': 'OpenAI Responses API',
    'Anthropic 接口': 'Anthropic API',
    'Gemini 接口': 'Gemini API',
    '模型名称': 'Model Name',
    '请求方式': 'Request Mode',
    '流式请求': 'Streaming',
    '非流式请求': 'Non-Streaming',
    '目标 RPM': 'Target RPM',
    '测试时长（分钟）': 'Test Duration (min)',
    '0 = 不限时': '0 = no time limit',
    '测试请求': 'Test Prompt',
    '输入测试请求': 'Enter test prompt',
    '示例：': 'e.g. ',
    'https://api.openai.com 或兼容协议网关': 'https://api.openai.com or a compatible gateway',
    'https://api.openai.com（/v1/responses）': 'https://api.openai.com (/v1/responses)',
    'https://api.anthropic.com 或兼容协议网关': 'https://api.anthropic.com or a compatible gateway',
    'claude-3-5-sonnet-20241022 等': 'claude-3-5-sonnet-20241022 etc.',
    '分钟': 'min',
    '最多只能添加': 'You can add at most',
    '个配置': 'configurations',
    '至少需要保留一个配置': 'At least one configuration is required',
    '：请完整填写 Base URL、模型名称和 API Key': ': fill in Base URL, Model Name and API Key completely',
    '请用两三句话介绍一下你自己。': 'Introduce yourself in two or three sentences.',

    // 启动 / 停止 / 确认
    '当前并行测试由其他用户启动，确定强制停止吗？': 'The current parallel test was started by another user. Force stop it?',
    '当前并行测试由其他用户启动，是否强制停止？': 'The current parallel test was started by another user. Force stop?',
    '权限确认': 'Permission Required',
    '当前并行测试由其他用户启动，你的停止请求未生效': 'The current parallel test was started by another user; your stop request had no effect',
    '并行测试已启动': 'Parallel test started',
    '启动并行测试失败：': 'Failed to start parallel test: ',
    '并行测试已停止': 'Parallel test stopped',
    '停止并行测试失败：': 'Failed to stop parallel test: ',

    // 总览统计
    '测试组数': 'Test Groups',
    '组运行中': 'groups running',
    '全部结束': 'All finished',
    '总请求数': 'Total Requests',
    '全部配置合计': 'All configurations combined',
    '加权成功率': 'Weighted Success Rate',
    '按请求数加权': 'Weighted by request count',
    '各组均值': 'Mean of all groups',

    // 测试卡片
    '测试': 'Test',
    '当前 RPM': 'Current RPM',
    'RPM 进度': 'RPM Progress',

    // 对比标记 / 状态文本
    '最佳': 'Best',
    '最差': 'Worst',
    '并行测试运行中': 'Parallel test running',
    '测试已停止': 'Test stopped',
    '所有测试已完成': 'All tests completed',
    '测试已结束': 'Test finished',
    '其他用户压测中': 'Load test running by another user',
  });
})();
