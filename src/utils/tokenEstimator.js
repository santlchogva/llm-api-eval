/**
 * Token 估算工具
 * 当接口未返回 usage 字段时，按字符构成估算 token 数：
 * CJK 字符约 1 字 1 token，其余字符约 4 字符 1 token。
 */
function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const rest = text.length - cjk;
  return Math.max(1, Math.round(cjk + rest / 4));
}

module.exports = { estimateTokens };
