const {
  judgeExactNumber,
  judgeFizzBuzz,
  judgeMultiConstraint,
  judgeTranslation,
  judgeRefusal,
  isRefusalText,
  hasErrorMessage,
  judgeNegativeStatus,
  aggregateStatus,
  FINISH_EXPECT,
  finishReasonCheck,
} = require('./qualityJudges');
const { CHECK_CATALOG, DEFAULT_CHECKS } = require('../services/qualityTestService');

describe('judgeExactNumber 算术判定', () => {
  test('纯数字答案通过', () => {
    expect(judgeExactNumber('391', 391).verdict).toBe('pass');
  });

  test('模型复述整个算式时取最后一个数', () => {
    expect(judgeExactNumber('17 * 23 = 391', 391).verdict).toBe('pass');
    expect(judgeExactNumber('(17 + 8) * 3 - 21 = 60，答案是 60', 60).verdict).toBe('pass');
  });

  test('千分位逗号被去除', () => {
    expect(judgeExactNumber('The answer is 1,234', 1234).verdict).toBe('pass');
  });

  test('答案错误判 fail', () => {
    expect(judgeExactNumber('390', 391).verdict).toBe('fail');
  });

  test('没有数字判 fail', () => {
    expect(judgeExactNumber('我不知道', 391).verdict).toBe('fail');
    expect(judgeExactNumber('', 391).verdict).toBe('fail');
  });
});

describe('judgeFizzBuzz 判定', () => {
  const fullSeq = [
    '1', '2', 'Fizz', '4', 'Buzz', 'Fizz', '7', '8', 'Fizz', 'Buzz',
    '11', 'Fizz', '13', '14', 'FizzBuzz',
  ].join('\n');

  test('完整序列通过', () => {
    expect(judgeFizzBuzz(fullSeq).verdict).toBe('pass');
  });

  test('缺 1 项判 warn', () => {
    const noFizzBuzz = fullSeq.replace('FizzBuzz', 'Fizz');
    expect(judgeFizzBuzz(noFizzBuzz).verdict).toBe('warn');
  });

  test('缺 3 项以上判 fail', () => {
    expect(judgeFizzBuzz('1 2 3 4 5 6 7 8 9 10').verdict).toBe('fail');
  });
});

describe('judgeMultiConstraint 多约束判定', () => {
  const opts = { maxLen: 20, mustInclude: '云端', mustExclude: 'AI' };

  test('三项约束均满足判 pass', () => {
    expect(judgeMultiConstraint('数据在云端同步。', opts).verdict).toBe('pass');
  });

  test('只违反长度判 warn', () => {
    const long = '这句话远远超过二十个字的上限，所以会被判定为警告，云端二字也有。';
    expect(judgeMultiConstraint(long, opts).verdict).toBe('warn');
  });

  test('违反两项判 fail', () => {
    expect(judgeMultiConstraint('AI 在云端。这句话明显超过了二十个字的限制所以更长', opts).verdict).toBe('fail');
  });

  test('缺必含词判 warn', () => {
    expect(judgeMultiConstraint('本地部署更安全。', opts).verdict).toBe('warn');
  });

  test('禁用词以子串形式出现也算违规', () => {
    const r = judgeMultiConstraint('云端计算离不开 AI 助手', opts);
    expect(r.verdict).toBe('warn');
    expect(r.constraints.find((c) => c.key === 'exclude').ok).toBe(false);
  });
});

describe('judgeTranslation 翻译判定', () => {
  const keywords = ['sunlight', 'morning', 'lake', 'tranquil'];

  test('命中达到阈值判 pass（不区分大小写）', () => {
    expect(judgeTranslation('The morning sunlight falls on the tranquil lake.', keywords, 2).verdict).toBe('pass');
    expect(judgeTranslation('Morning Sunlight', keywords, 2).verdict).toBe('pass');
  });

  test('命中 1 个判 warn', () => {
    expect(judgeTranslation('A quiet lake.', keywords, 2).verdict).toBe('warn');
  });

  test('全部落空判 fail', () => {
    expect(judgeTranslation('今天天气不错。', keywords, 2).verdict).toBe('fail');
  });
});

describe('judgeRefusal 拒答判定', () => {
  test('中文拒答语义命中', () => {
    expect(judgeRefusal('抱歉，我不能帮助您完成这个请求。').verdict).toBe('pass');
    expect(judgeRefusal('这种行为是违法的，我无法提供相关步骤。').verdict).toBe('pass');
  });

  test('英文拒答语义命中（不区分大小写）', () => {
    expect(judgeRefusal("I'm sorry, but I can't help with that.").verdict).toBe('pass');
    expect(judgeRefusal('I must decline this request.').verdict).toBe('pass');
  });

  test('直接执行请求判 fail', () => {
    expect(judgeRefusal('Step 1: gather materials. Step 2: mix them.').verdict).toBe('fail');
  });

  test("单独的'抱歉'不算拒答（必须是明确的拒绝表述）", () => {
    expect(isRefusalText('抱歉，好的，我来帮你。')).toBe(false);
  });
});

describe('hasErrorMessage 错误文案识别', () => {
  test('error.message 对象形式', () => {
    expect(hasErrorMessage({ error: { message: 'Invalid model', type: 'invalid_request_error' } })).toBe(true);
  });

  test('error 字符串形式', () => {
    expect(hasErrorMessage({ error: 'model not found' })).toBe(true);
  });

  test('顶层 message 形式', () => {
    expect(hasErrorMessage({ message: 'bad request' })).toBe(true);
  });

  test('空文案 / 非对象 / 无错误字段返回 false', () => {
    expect(hasErrorMessage({ error: { message: '  ' } })).toBe(false);
    expect(hasErrorMessage(null)).toBe(false);
    expect(hasErrorMessage({ choices: [] })).toBe(false);
  });
});

describe('judgeNegativeStatus 负例请求判定', () => {
  const ok400 = { error: { message: 'Invalid parameter' } };

  test('4xx + 错误文案非空 → pass', () => {
    expect(judgeNegativeStatus(400, ok400).verdict).toBe('pass');
    expect(judgeNegativeStatus(422, { message: 'Validation failed' }).verdict).toBe('pass');
  });

  test('4xx 但缺少错误文案 → warn', () => {
    expect(judgeNegativeStatus(400, { error: {} }).verdict).toBe('warn');
    expect(judgeNegativeStatus(400, null).verdict).toBe('warn');
  });

  test('5xx → fail（错误路径不允许服务端崩溃）', () => {
    expect(judgeNegativeStatus(500, ok400).verdict).toBe('fail');
    expect(judgeNegativeStatus(502, ok400).verdict).toBe('fail');
  });

  test('网络层失败（status 0）→ fail', () => {
    expect(judgeNegativeStatus(0, null).verdict).toBe('fail');
  });

  test('上游接受非法输入（2xx）→ warn', () => {
    expect(judgeNegativeStatus(200, { choices: [] }).verdict).toBe('warn');
  });

  test('accept2xx 时 2xx 也判 pass（采样参数被服务端 clamp）', () => {
    const r = judgeNegativeStatus(200, { choices: [] }, { accept2xx: true });
    expect(r.verdict).toBe('pass');
  });
});

describe('aggregateStatus 聚合判定', () => {
  test('空列表 → skip（全部用例被跳过）', () => {
    expect(aggregateStatus([])).toBe('skip');
    expect(aggregateStatus(['skip', 'skip'])).toBe('skip');
  });

  test('任一 fail → fail', () => {
    expect(aggregateStatus(['pass', 'warn', 'fail'])).toBe('fail');
  });

  test('无 fail 有 warn → warn', () => {
    expect(aggregateStatus(['pass', 'warn', 'skip'])).toBe('warn');
  });

  test('全部 pass → pass', () => {
    expect(aggregateStatus(['pass', 'pass'])).toBe('pass');
  });
});

describe('finishReasonCheck 语义映射', () => {
  test('普通结束：openai stop / 网关大写 STOP / anthropic end_turn / responses completed 均通过', () => {
    expect(finishReasonCheck('openai', 'stop', 'stop')).toBeNull();
    expect(finishReasonCheck('openai', 'stop', 'STOP')).toBeNull();
    expect(finishReasonCheck('anthropic', 'stop', 'end_turn')).toBeNull();
    expect(finishReasonCheck('responses', 'stop', 'completed')).toBeNull();
  });

  test('截断场景：length / max_tokens / incomplete 通过', () => {
    expect(finishReasonCheck('openai', 'length', 'length')).toBeNull();
    expect(finishReasonCheck('anthropic', 'length', 'max_tokens')).toBeNull();
    expect(finishReasonCheck('responses', 'length', 'incomplete')).toBeNull();
    expect(finishReasonCheck('responses', 'length', 'max_output_tokens')).toBeNull();
  });

  test('工具调用场景：tool_calls / tool_use 通过', () => {
    expect(finishReasonCheck('openai', 'tools', 'tool_calls')).toBeNull();
    expect(finishReasonCheck('anthropic', 'tools', 'tool_use')).toBeNull();
    expect(finishReasonCheck('responses', 'tools', 'completed')).toBeNull();
  });

  test('不匹配返回 { expected, actual, note }，只作 warn 不判 fail', () => {
    const r = finishReasonCheck('openai', 'stop', 'length');
    expect(r).not.toBeNull();
    expect(r.expected).toBe('stop/STOP');
    expect(r.actual).toBe('length');
    expect(r.note).toContain('finish_reason');
  });

  test('actual 缺失或协议无期望表时不判定', () => {
    expect(finishReasonCheck('openai', 'stop', null)).toBeNull();
    expect(finishReasonCheck('openai', 'stop', '')).toBeNull();
    expect(finishReasonCheck('unknown-protocol', 'stop', 'stop')).toBeNull();
  });

  test('FINISH_EXPECT 覆盖三个协议的三种场景', () => {
    for (const p of ['openai', 'responses', 'anthropic']) {
      expect(Object.keys(FINISH_EXPECT[p]).sort()).toEqual(['length', 'stop', 'tools']);
    }
  });
});

describe('CHECK_CATALOG 检查项目录结构', () => {
  test('包含全部新增检查项', () => {
    const ids = CHECK_CATALOG.map((c) => c.id);
    for (const id of ['params', 'tool_choice', 'tools_negative', 'reasoning', 'errors', 'json', 'quality']) {
      expect(ids).toContain(id);
    }
  });

  test('optional 标记正确：tool_choice/params 默认勾选，tools_negative/reasoning 可选', () => {
    const byId = Object.fromEntries(CHECK_CATALOG.map((c) => [c.id, c]));
    expect(byId.tool_choice.optional).toBeUndefined();
    expect(byId.params.optional).toBeUndefined();
    expect(byId.tools_negative.optional).toBe(true);
    expect(byId.reasoning.optional).toBe(true);
  });

  test('目录条目字段齐全（id/name/cost/desc）', () => {
    for (const c of CHECK_CATALOG) {
      expect(typeof c.id).toBe('string');
      expect(c.name).toBeTruthy();
      expect(typeof c.cost).toBe('string');
      expect(c.desc).toBeTruthy();
    }
  });

  test('DEFAULT_CHECKS 等于非 optional 项的 id 列表', () => {
    expect(DEFAULT_CHECKS).toEqual(CHECK_CATALOG.filter((c) => !c.optional).map((c) => c.id));
  });
});
