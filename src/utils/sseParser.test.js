const SSEParser = require('./sseParser');
const { EventEmitter } = require('events');

/** 构造一个可手动喂 chunk 的假流 */
function makeStream() {
  return new EventEmitter();
}

/** 收集 parseStream 的三个回调 */
function collect(stream) {
  const out = { data: [], ended: false, error: null };
  SSEParser.parseStream(
    stream,
    (d) => out.data.push(d),
    () => { out.ended = true; },
    (e) => { out.error = e; }
  );
  return out;
}

describe('SSEParser.parseStream', () => {
  test('解析单条 data 行', () => {
    const stream = makeStream();
    const out = collect(stream);
    stream.emit('data', Buffer.from('data: {"a":1}\n\n'));
    expect(out.data).toEqual([{ a: 1 }]);
  });

  test('跨 chunk 拆行的消息也能解析', () => {
    const stream = makeStream();
    const out = collect(stream);
    stream.emit('data', Buffer.from('data: {"a"'));
    stream.emit('data', Buffer.from(':1}\n\n'));
    expect(out.data).toEqual([{ a: 1 }]);
  });

  test('[DONE] 触发结束', () => {
    const stream = makeStream();
    const out = collect(stream);
    stream.emit('data', Buffer.from('data: {"a":1}\n\ndata: [DONE]\n\n'));
    expect(out.ended).toBe(true);
    expect(out.data).toHaveLength(1);
  });

  test('end 事件兜底结束', () => {
    const stream = makeStream();
    const out = collect(stream);
    stream.emit('end');
    expect(out.ended).toBe(true);
  });

  test('close 兜底：避免 Promise 悬挂', () => {
    const stream = makeStream();
    const out = collect(stream);
    stream.emit('close');
    // close 兜底通过 onError 通知上层拒绝 Promise，不走 onEnd
    expect(out.ended).toBe(false);
    expect(out.error).not.toBeNull();
    expect(out.error.code).toBe('ERR_STREAM_PREMATURE_CLOSE');
  });

  test('error 事件回调', () => {
    const stream = makeStream();
    const out = collect(stream);
    stream.emit('error', new Error('boom'));
    expect(out.error).not.toBeNull();
    expect(out.error.message).toBe('boom');
  });

  test('注释行与空行被跳过', () => {
    const stream = makeStream();
    const out = collect(stream);
    stream.emit('data', Buffer.from(': keepalive\n\n\n: another\n'));
    expect(out.data).toHaveLength(0);
    expect(out.ended).toBe(false);
  });

  test('非 JSON data 行被忽略', () => {
    const stream = makeStream();
    const out = collect(stream);
    stream.emit('data', Buffer.from('data: not-json\n\n'));
    expect(out.data).toHaveLength(0);
  });

  test('结束后再来的数据被忽略', () => {
    const stream = makeStream();
    const out = collect(stream);
    stream.emit('data', Buffer.from('data: [DONE]\n\n'));
    stream.emit('data', Buffer.from('data: {"late":1}\n\n'));
    expect(out.data).toHaveLength(0);
  });
});

describe('SSEParser.extractContent', () => {
  test('openai 增量', () => {
    expect(SSEParser.extractContent({ choices: [{ delta: { content: 'hi' } }] }, 'openai')).toBe('hi');
  });

  test('claude 增量', () => {
    expect(SSEParser.extractContent({ delta: { text: '你好' } }, 'claude')).toBe('你好');
  });

  test('gemini 增量', () => {
    expect(SSEParser.extractContent({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }, 'gemini')).toBe('x');
  });

  test('responses 增量', () => {
    expect(SSEParser.extractContent({ type: 'response.output_text.delta', delta: 'abc' }, 'responses')).toBe('abc');
    expect(SSEParser.extractContent({ type: 'response.output_text.delta', delta: { text: 'abc' } }, 'responses')).toBe('abc');
  });

  test('未知类型/空数据返回 null', () => {
    expect(SSEParser.extractContent(null, 'openai')).toBeNull();
    expect(SSEParser.extractContent({ foo: 1 }, 'unknown')).toBeNull();
  });
});

describe('SSEParser.extractUsage', () => {
  test('openai usage', () => {
    const u = SSEParser.extractUsage({ usage: { prompt_tokens: 5, completion_tokens: 7 } }, 'openai');
    expect(u).toEqual({ promptTokens: 5, completionTokens: 7 });
  });

  test('responses 流式末帧 usage', () => {
    const u = SSEParser.extractUsage(
      { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 4 } } },
      'responses'
    );
    expect(u).toEqual({ promptTokens: 3, completionTokens: 4 });
  });

  test('claude message_start / message_delta', () => {
    expect(SSEParser.extractUsage({ message: { usage: { input_tokens: 2, output_tokens: null } } }, 'claude'))
      .toEqual({ promptTokens: 2, completionTokens: null });
    expect(SSEParser.extractUsage({ usage: { input_tokens: null, output_tokens: 9 } }, 'claude'))
      .toEqual({ promptTokens: null, completionTokens: 9 });
  });

  test('gemini usageMetadata', () => {
    const u = SSEParser.extractUsage({ usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 8 } }, 'gemini');
    expect(u).toEqual({ promptTokens: 6, completionTokens: 8 });
  });

  test('无 usage 返回 null', () => {
    expect(SSEParser.extractUsage({ foo: 1 }, 'openai')).toBeNull();
    expect(SSEParser.extractUsage(null, 'openai')).toBeNull();
  });
});

describe('SSEParser.extractNonStreamContent', () => {
  test('openai 非流式', () => {
    const text = SSEParser.extractNonStreamContent({ choices: [{ message: { content: 'hello' } }] }, 'openai');
    expect(text).toBe('hello');
  });

  test('claude 非流式', () => {
    const text = SSEParser.extractNonStreamContent({ content: [{ type: 'text', text: 'world' }] }, 'claude');
    expect(text).toBe('world');
  });

  test('gemini 非流式', () => {
    const text = SSEParser.extractNonStreamContent({ candidates: [{ content: { parts: [{ text: 'g' }] } }] }, 'gemini');
    expect(text).toBe('g');
  });

  test('responses 非流式：output_text 直出', () => {
    expect(SSEParser.extractNonStreamContent({ output_text: 'resp' }, 'responses')).toBe('resp');
  });

  test('responses 非流式：output 数组聚合', () => {
    const text = SSEParser.extractNonStreamContent({
      output: [{ content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] }],
    }, 'responses');
    expect(text).toBe('ab');
  });

  test('空数据返回空串', () => {
    expect(SSEParser.extractNonStreamContent(null, 'openai')).toBe('');
  });
});
