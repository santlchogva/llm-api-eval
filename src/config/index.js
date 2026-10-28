require('dotenv').config();

module.exports = {
  // 服务器配置
  port: process.env.PORT || 8998,
  // 默认管理员初始密码（首次启动创建 admin 时使用，可用环境变量覆盖）
  adminPassword: process.env.DEFAULT_ADMIN_PASSWORD || 'admin',
  // 旧版本的初始密码来源（AUTH_SECRET），现仅用于启动时检测并迁移旧账号密码
  authSecret: process.env.AUTH_SECRET || 'change_this_password',
  nodeEnv: process.env.NODE_ENV || 'production',

  // 测压配置
  stressTest: {
    // 成功率阈值（低于此值判定为承受不住）
    successThreshold: parseInt(process.env.DEFAULT_SUCCESS_THRESHOLD) || 80,

    // 最大连续失败次数
    maxConsecutiveFailures: parseInt(process.env.DEFAULT_MAX_FAILURES) || 10,

    // 响应时间阈值（毫秒）
    responseTimeThreshold: parseInt(process.env.DEFAULT_RESPONSE_TIME_THRESHOLD) || 150000,

    // 首字节延迟（TTFB）阈值（毫秒），用于统计 SLA 达标率
    ttftThreshold: parseInt(process.env.DEFAULT_TTFT_THRESHOLD) || 1000,

    // 流式响应空闲超时（毫秒）：超过该时长未收到任何数据判定为流挂死，
    // 主动掐断。axios 的 timeout 只覆盖到响应头，管不住"开始响应后卡住"的流
    streamIdleTimeout: parseInt(process.env.STREAM_IDLE_TIMEOUT) || 30000,

    // 并发上限（in-flight 请求数）：防止配置失误时把本机/目标打挂。
    // 可通过环境变量或请求参数覆盖，设为 0 表示不限制
    maxInFlight: parseInt(process.env.DEFAULT_MAX_IN_FLIGHT) || 512,

    // 请求内容池大小：复用率 > 0 时用于构造可复用的请求池
    promptPoolSize: parseInt(process.env.DEFAULT_PROMPT_POOL_SIZE) || 20,

    // 自动增压（auto）默认参数
    autoMode: {
      initialRPM: 10,           // 起始RPM
      incrementRPM: 10,         // 每次增加的RPM
      incrementInterval: 60000, // 增长间隔（毫秒）1分钟
      maxRPM: 1000              // 最大RPM限制
    },

    // 恒定并发（concurrency）默认参数
    concurrencyMode: {
      defaultWorkers: 8,        // 默认并发路数
      maxWorkers: 512           // 并发路数上限
    },

    // 自动寻优（seek）默认参数：二分逼近最大可持续 RPM
    seekMode: {
      initialRPM: 10,
      incrementRPM: 20,
      minStepRPM: 5,
      maxRPM: 1000,
      stepDuration: 60000,      // 每档持续时间（毫秒）
      maxStepRounds: 40         // 最大档位切换次数，防止无限运行
    },

    // SLA 达标阈值：判断某一档位"是否可承载"的统一口径
    //   RPM 上限看成功率 + 首 token 延迟（与输出长度无关）
    //   TPM 上限看成功率达到标 + 每输出 token 耗时（TPOT，反映解码质量）
    sla: {
      successThreshold: parseFloat(process.env.DEFAULT_SLA_SUCCESS_THRESHOLD) || 99,   // %
      ttftP99Threshold: parseInt(process.env.DEFAULT_TTFT_P99_THRESHOLD) || 1000,      // ms
      tpotP99Threshold: parseInt(process.env.DEFAULT_TPOT_P99_THRESHOLD) || 50,        // ms/输出token
      capacityRatio: parseFloat(process.env.DEFAULT_CAPACITY_RATIO) || 0.7             // 建议容量按此比例折算
    },

    // 并发阶梯：用于寻找 TPM 饱和点（吞吐不再随并发增长）
    concurrencyRamp: {
      steps: (process.env.DEFAULT_CONCURRENCY_STEPS || '1,2,4,8,16')
        .split(',')
        .map((n) => parseInt(n))
        .filter((n) => Number.isFinite(n) && n > 0),
      stepDuration: parseInt(process.env.DEFAULT_CONCURRENCY_STEP_DURATION) || 60, // 秒
      saturationGrowthRatio: parseFloat(process.env.DEFAULT_TPM_SATURATION_RATIO) || 0.05
    },

    // 能力探测（probe）：自动跑两轮，分别求最大可持续 RPM 与 TPM
    probe: {
      maxRPM: parseInt(process.env.DEFAULT_PROBE_MAX_RPM) || 1000,
      incrementRPM: parseInt(process.env.DEFAULT_PROBE_INCREMENT_RPM) || 50,
      stepDuration: parseInt(process.env.DEFAULT_PROBE_STEP_DURATION) || 30,       // 秒
      rpmDatasetId: process.env.DEFAULT_PROBE_RPM_DATASET || 'short-short',
      tpmDatasetId: process.env.DEFAULT_PROBE_TPM_DATASET || 'short-in-long-out'
    }
  },
  
  // 日志配置
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    colorize: process.env.LOG_COLORIZE === 'true',
    dir: process.env.LOG_DIR || 'logs',
    retentionDays: parseInt(process.env.LOG_RETENTION_DAYS) || 30,
  },
  
  // 安全配置
  security: {
    corsOrigin: process.env.CORS_ORIGIN || '*',
    tokenExpiry: parseInt(process.env.TOKEN_EXPIRY) || 86400,
    rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX) || 100,
    rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW) || 1,
  },
  
  // WebSocket 配置
  websocket: {
    heartbeatInterval: parseInt(process.env.WS_HEARTBEAT_INTERVAL) || 30000,
    heartbeatTimeout: parseInt(process.env.WS_HEARTBEAT_TIMEOUT) || 5000,
  },
  
  // 数据库配置
  database: {
    path: process.env.DB_PATH || './data/llm-api-eval.db',
    logging: process.env.DB_LOGGING === 'true',
  },
  
  // 历史记录配置
  history: {
    defaultPageSize: parseInt(process.env.DEFAULT_PAGE_SIZE) || 20,
    maxRecords: parseInt(process.env.MAX_HISTORY_RECORDS) || 1000,
  },
};


