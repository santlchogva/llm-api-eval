/**
 * 压测数据集
 *
 * 压测结果只有在「输入长度 / 输出长度」受控时才有可比性，
 * 因此内置按场景划分的数据集，每个场景固定输入长度目标与输出长度指令：
 *
 *   - 短入短出：压的是调度 / 排队 / 框架开销，适合测 RPM 上限
 *   - 长入：压的是 prefill 算力，TTFT 随输入长度近似线性增长
 *   - 长出：压的是 decode 吞吐与 KV Cache，适合测 TPM 上限
 *
 * 每条 prompt 会按 dataset.inputTokens 自动补齐到目标输入长度，
 * 并追加 outputInstruction 约束输出长度，从而控制变量。
 */
const { estimateTokens } = require('../utils/tokenEstimator');

/** 用于补齐输入长度的填充段落 */
const FILLER_PARAGRAPH =
  '以下是一段用于构造长输入的材料：人工智能正在深刻改变软件开发的方式，从代码补全到架构设计，' +
  '从自动化测试到智能运维，大模型已经成为工程师日常工作中不可或缺的助手。评估一个模型服务的真实性能，' +
  '需要同时关注首 token 延迟、解码速度和并发吞吐等多个维度，并结合业务真实的输入输出长度分布进行加权。';

/**
 * 数据集定义
 * inputTokens  - 目标输入长度（token），短场景无需补齐
 * outputTokens - 期望输出长度（token），仅作参考
 * outputInstruction - 追加到 prompt 末尾的输出长度约束
 */
const PRESETS = [
  {
    id: 'short-short',
    name: '短输入短输出（分类 / 意图识别）',
    category: 'latency',
    description: '瓶颈在调度与排队，适合探测 RPM / QPS 上限',
    inputTokens: 60,
    outputTokens: 20,
    outputInstruction: '只输出结论，不要解释，不超过 20 个字。',
    items: [
      '请判断这句话的情绪倾向：这个功能用起来真是一言难尽，优点有但槽点也不少。',
      '把下面这句话归类到最合适的意图类别（咨询/投诉/下单/退款）：我昨天买的东西到现在还没发货。',
      '请判断以下文本是否包含个人隐私信息：我的联系电话是 13800000000。',
      '将下面这句话标记为「正面」「负面」或「中性」：会议纪要已发送至各位邮箱。',
      '请识别下面的语言种类：Ceci est un exemple de phrase en français.',
      '判断下面这条评论是否属于垃圾广告：加V信领取免费资料，名额有限。',
    ],
  },
  {
    id: 'balanced',
    name: '短输入中输出（翻译 / 改写）',
    category: 'balanced',
    description: '输入输出长度接近，用于观察吞吐与延迟的均衡表现',
    inputTokens: 120,
    outputTokens: 200,
    outputInstruction: '请输出完整译文或改写结果，约 200 字。',
    items: [
      '把下面这段产品介绍翻译成英文：本产品采用一体化设计，支持多设备协同，能够在弱网环境下保持稳定连接，适合家庭与办公场景。',
      '把下面这段话改写成更正式、更专业的书面表达：这个方案我觉得还行，就是有点贵，而且上线时间太赶了。',
      '把下面这段技术说明改写为面向非技术读者的通俗版本：该服务通过异步队列削峰填谷，并在下游失败时执行指数退避重试。',
      '把下面这段会议记录整理成要点式摘要：会上讨论了三个议题，分别是排期、资源与风险，其中风险项需要在周五前给出缓解方案。',
      '把下面的口语化描述翻译成英文：这个页面加载太慢了，用户点进去要等好几秒才能看到内容。',
      '将下面这段话压缩到一半长度，保留关键信息：为了提升系统的整体可用性，我们引入了多级缓存、熔断降级与灰度发布三项机制。',
    ],
  },
  {
    id: 'long-in-short-out',
    name: '长输入短输出（摘要 / RAG 问答）',
    category: 'prefill',
    description: '瓶颈在 prefill 算力，TTFT 随输入长度近似线性增长',
    inputTokens: 4000,
    outputTokens: 80,
    outputInstruction: '请用一句话总结上述材料，不超过 60 个字。',
    items: [
      '请阅读以下材料并概括其核心观点：',
      '请阅读以下材料，指出作者的主要结论与依据：',
      '以下是一份技术文档节选，请用一句话说明它解决了什么问题：',
      '请基于以下材料回答：该方案的主要收益是什么？',
    ],
  },
  {
    id: 'short-in-long-out',
    name: '短输入长输出（长文写作）',
    category: 'decode',
    description: '瓶颈在 decode 吞吐与 KV Cache，适合测 TPM 上限',
    inputTokens: 80,
    outputTokens: 1500,
    outputInstruction: '请输出约 1500 字，结构清晰，分点展开。',
    items: [
      '请写一篇关于「边缘计算在工业互联网中的落地路径」的技术综述。',
      '请写一篇面向工程师的「大模型推理加速技术」科普文章，涵盖 KV Cache、批处理与量化。',
      '请阐述微服务架构中分布式事务的常见方案及其取舍。',
      '请写一份「API 网关限流与熔断设计」的实施方案。',
    ],
  },
  {
    id: 'long-in-long-out',
    name: '长输入长输出（文档生成 / 深度分析）',
    category: 'mixed',
    description: '同时压 prefill 与 decode，考验显存与吞吐的叠加表现',
    inputTokens: 8000,
    outputTokens: 2000,
    outputInstruction: '请基于上述材料输出约 2000 字的深度分析，包含结论与风险提示。',
    items: [
      '请阅读以下材料，并撰写一份包含背景、现状、风险与建议四部分的深度分析报告：',
      '请阅读以下材料，输出一份面向管理层的技术评估报告：',
    ],
  },
  {
    id: 'multi-turn',
    name: '多轮对话（KV Cache 复用）',
    category: 'cache',
    description: '累积上下文，观察多轮场景下前缀缓存与延迟变化',
    inputTokens: 2000,
    outputTokens: 300,
    outputInstruction: '请延续上面的对话继续回答。',
    items: [
      '我们之前已经讨论过系统架构与选型，现在请继续分析容量规划。',
      '基于前面的讨论，请给出灰度发布的详细步骤。',
      '接着上面的方案，请补充监控与告警的设计。',
    ],
  },
  {
    id: 'json-output',
    name: '结构化输出（JSON / 约束解码）',
    category: 'structured',
    description: '考验约束解码与格式遵循能力，输出长度稳定',
    inputTokens: 150,
    outputTokens: 300,
    outputInstruction: '只输出 JSON，不要输出任何解释性文字，且必须是合法 JSON。',
    items: [
      '请从下面这段招聘信息中抽取结构化信息（职位、公司、城市、薪资、经验要求）：我们正在招聘后端工程师，坐标杭州，薪资 25-40K，要求三年以上经验。',
      '请从下面这段订单描述中抽取结构化信息（商品、数量、金额、收货城市）：用户下单了 2 件无线键盘，共计 398 元，收货地址为深圳。',
      '请从下面这段日志中抽取结构化信息（时间、级别、服务名、错误码）：2026-09-20 10:12:33 ERROR order-service code=5001',
      '请把下面这段话转为结构化条目（事件、时间、地点、参与人）：周三下午三点在产品会议室召开需求评审会，参会人有张三和李四。',
    ],
  },
  {
    id: 'tool-call',
    name: '工具调用（Function Calling）',
    category: 'structured',
    description: '考验工具选择与参数解析，链路包含二次调用开销',
    inputTokens: 200,
    outputTokens: 150,
    outputInstruction: '请以 JSON 形式给出应该调用的函数名与参数。',
    items: [
      '可用的函数有 get_weather(city)、book_flight(from, to, date)。请问「帮我查一下北京的天气」应该调用哪个函数？',
      '可用的函数有 search_docs(query)、summarize(text)。请问「把这份文档总结一下」应该调用哪个函数？',
      '可用的函数有 create_order(sku, count)、cancel_order(orderId)。请问「取消订单 10086」应该调用哪个函数？',
      '可用的函数有 send_email(to, subject)、send_sms(phone, text)。请问「给张三发一封会议通知邮件」应该调用哪个函数？',
    ],
  },
];

/**
 * 将文本补齐到目标 token 数（不足时追加填充段落）
 * @param {string} text
 * @param {number} targetTokens
 * @returns {string}
 */
function padToTokens(text, targetTokens) {
  let prompt = text;
  const perParagraph = estimateTokens(FILLER_PARAGRAPH);
  let guard = 0;
  while (estimateTokens(prompt) < targetTokens && guard < 2000) {
    prompt += '\n\n' + FILLER_PARAGRAPH;
    guard++;
  }
  return prompt;
}

/**
 * 按目标输入长度与输出指令加工一条 prompt
 * @param {string} text - 原始请求
 * @param {Object} dataset - 数据集定义
 * @returns {string}
 */
function fitPrompt(text, dataset) {
  let prompt = text;
  const target = Number(dataset.inputTokens) || 0;
  if (target > 0 && estimateTokens(prompt) * 1.5 < target) {
    prompt = padToTokens(prompt, target);
  }
  if (dataset.outputInstruction) {
    prompt = `${prompt}\n\n${dataset.outputInstruction}`;
  }
  return prompt;
}

/**
 * 数据集元信息列表（不含具体请求，用于前端下拉）
 */
function listDatasets() {
  return PRESETS.map((d) => ({
    id: d.id,
    name: d.name,
    category: d.category,
    description: d.description,
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    itemCount: d.items.length,
  }));
}

/**
 * 获取加工后的数据集
 * @param {string} id
 * @returns {{id:string,name:string,items:string[],inputTokens:number,outputTokens:number}|null}
 */
function getDataset(id) {
  const dataset = PRESETS.find((d) => d.id === id);
  if (!dataset) return null;
  return {
    id: dataset.id,
    name: dataset.name,
    category: dataset.category,
    description: dataset.description,
    inputTokens: dataset.inputTokens,
    outputTokens: dataset.outputTokens,
    items: dataset.items.map((text) => fitPrompt(text, dataset)),
  };
}

/**
 * 按目标 token 数合成一条 prompt（用于扫描不同 prefill 长度下的 TTFT）
 * @param {number} targetTokens
 * @param {string} [question] - 附加问题
 * @returns {string}
 */
function buildPromptByTokens(targetTokens, question) {
  const target = Math.max(1, parseInt(targetTokens) || 1);
  const ask = question || '请阅读以上材料并用一句话总结其核心观点。';
  return padToTokens(`请阅读以下材料：\n\n`, target) + `\n\n${ask}`;
}

/**
 * 解析单行 CSV（支持双引号包裹与转义引号）
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

/**
 * 解析导入文本为请求列表（支持 JSONL / JSON 数组 / CSV / 纯文本）
 * @param {string} text - 原始文本
 * @param {Object} [options]
 * @param {string} [options.column] - CSV 取值列名
 * @param {number} [options.limit] - 最多返回条数
 * @returns {{items:string[], format:string, total:number}}
 */
function parseItems(text, { column = null, limit = 500 } = {}) {
  const raw = String(text || '').trim();
  if (!raw) {
    return { items: [], format: 'empty', total: 0 };
  }

  const max = Math.max(1, Math.min(5000, parseInt(limit) || 500));

  // JSON 数组
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const items = arr
          .map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') {
              return item.prompt || item.text || item.content || item.question || null;
            }
            return null;
          })
          .filter(Boolean)
          .slice(0, max);
        return { items, format: 'json-array', total: arr.length };
      }
    } catch (e) {
      // 落到后续解析
    }
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) {
    return { items: [], format: 'empty', total: 0 };
  }

  // JSONL
  if (lines[0].trim().startsWith('{')) {
    const items = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const value = typeof obj === 'string'
          ? obj
          : obj.prompt || obj.text || obj.content || obj.question;
        if (value) items.push(String(value));
      } catch (e) {
        // 忽略无法解析的行
      }
      if (items.length >= max) break;
    }
    if (items.length > 0) {
      return { items, format: 'jsonl', total: lines.length };
    }
  }

  // CSV
  if (lines[0].includes(',')) {
    const header = parseCsvLine(lines[0]).map((h) => h.trim());
    const hasHeader = header.some((h) => !/^[\d.\s]*$/.test(h) && /[a-zA-Z\u4e00-\u9fa5]/.test(h));
    let index = 0;
    let start = 0;

    if (hasHeader) {
      const target = column || header.find((h) => /prompt|text|content|question|input/i.test(h));
      index = target ? header.indexOf(target) : 0;
      if (index < 0) index = 0;
      start = 1;
    }

    const items = lines
      .slice(start)
      .map((line) => {
        const cells = parseCsvLine(line);
        return (cells[index] || cells[0] || '').trim();
      })
      .filter(Boolean)
      .slice(0, max);

    return { items, format: 'csv', total: lines.length - start };
  }

  // 纯文本：一行一条；单列 CSV 无法通过逗号识别表头，这里按列名兜底跳过
  const looksLikeHeader = /^(prompt|text|content|question|input|query|请求|文本|内容|问题)$/i
    .test(lines[0].trim());
  const dataLines = looksLikeHeader ? lines.slice(1) : lines;
  const items = dataLines.map((l) => l.trim()).filter(Boolean).slice(0, max);
  return { items, format: 'text', total: dataLines.length };
}

module.exports = {
  listDatasets,
  getDataset,
  buildPromptByTokens,
  parseItems,
  PRESETS,
};
