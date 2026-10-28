const { estimateTokens } = require('./tokenEstimator');

describe('estimateTokens', () => {
  test('空输入返回 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  test('纯中文按 1 字 1 token 估算', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('压测平台')).toBe(4);
  });

  test('纯 ASCII 按 4 字符 1 token 估算', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('abcdefghijklmnop')).toBe(4);
  });

  test('混合文本：CJK 计 1，其余按 1/4 折算', () => {
    // 2 CJK + 4 ASCII = 2 + 1 = 3
    expect(estimateTokens('你好abcd')).toBe(3);
  });

  test('单个 ASCII 字符至少计 1 token（下限保护）', () => {
    // round(0.25) = 0，但 Math.max(1, ...) 兜底
    expect(estimateTokens('a')).toBe(1);
  });

  test('CJK 标点与全角字符计入 CJK', () => {
    // "你好，世界！" 全部位于 \u3000-\u303f / \uff00-\uffef
    expect(estimateTokens('你好，世界！')).toBe(6);
  });

  test('估算结果始终为整数', () => {
    expect(Number.isInteger(estimateTokens('abc'))).toBe(true);
    expect(Number.isInteger(estimateTokens('你好abc世界123'))).toBe(true);
  });
});
