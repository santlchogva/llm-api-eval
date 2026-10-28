/**
 * SSE (Server-Sent Events) 解析工具类
 * 用于解析 AI 服务的流式响应
 */
class SSEParser {
  /**
   * 解析 SSE 流
   * @param {Stream} stream - HTTP 响应流
   * @param {Function} onData - 数据块回调函数 (data) => void
   * @param {Function} onEnd - 流结束回调函数 () => void
   * @param {Function} onError - 错误回调函数 (error) => void
   */
  static parseStream(stream, onData, onEnd, onError) {
    let buffer = '';
    let hasEnded = false;
    
    stream.on('data', (chunk) => {
      if (hasEnded) return;
      
      try {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        
        // 保留最后一行（可能不完整）
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          // 跳过空行和注释
          if (!line.trim() || line.startsWith(':')) {
            continue;
          }
          
          // 解析 SSE 数据行
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            
            // 检查流结束标记
            if (data === '[DONE]') {
              hasEnded = true;
              onEnd();
              return;
            }
            
            // 尝试解析 JSON
            try {
              const json = JSON.parse(data);
              onData(json);
            } catch (parseError) {
              // 忽略无法解析的行，继续处理其他数据
              // 某些 SSE 实现可能发送非 JSON 数据
            }
          }
        }
      } catch (error) {
        if (!hasEnded) {
          hasEnded = true;
          onError(error);
        }
      }
    });
    
    stream.on('end', () => {
      if (!hasEnded) {
        hasEnded = true;
        onEnd();
      }
    });
    
    stream.on('error', (error) => {
      if (!hasEnded) {
        hasEnded = true;
        onError(error);
      }
    });

    // 兜底：请求被中断时，底层连接可能既不触发 end 也不触发 error，
    // 只触发 close。若不处理，上层的 Promise 会一直悬挂。
    stream.on('close', () => {
      if (!hasEnded) {
        hasEnded = true;
        const error = new Error('响应流在结束前被关闭');
        error.code = 'ERR_STREAM_PREMATURE_CLOSE';
        onError(error);
      }
    });
  }
  
  /**
   * 从 SSE 数据中提取文本内容
   * @param {Object} data - SSE 数据对象
   * @param {String} provider - AI 提供商类型 ('openai', 'claude', 'gemini')
   * @returns {String|null} - 提取的文本内容，如果没有内容则返回 null
   */
  static extractContent(data, provider) {
    if (!data || typeof data !== 'object') {
      return null;
    }
    
    switch (provider.toLowerCase()) {
      case 'openai':
        // OpenAI Chat Completions 格式: choices[0].delta.content
        return data.choices?.[0]?.delta?.content || null;

      case 'responses':
      case 'openai-responses':
        // OpenAI Responses 格式: type=response.output_text.delta, delta 为增量文本
        if (data.type === 'response.output_text.delta') {
          return typeof data.delta === 'string' ? data.delta : (data.delta?.text || null);
        }
        return null;

      case 'claude':
      case 'anthropic':
        // Claude 格式: delta.text
        return data.delta?.text || null;
        
      case 'gemini':
        // Gemini 格式: candidates[0].content.parts[0].text
        return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
        
      default:
        return null;
    }
  }

  /**
   * 从流式响应数据块中提取 token 用量
   * @param {Object} data - SSE 数据对象
   * @param {String} provider - AI 提供商类型
   * @returns {{promptTokens: number|null, completionTokens: number|null}|null}
   */
  static extractUsage(data, provider) {
    if (!data || typeof data !== 'object') return null;

    switch ((provider || '').toLowerCase()) {
      case 'openai': {
        if (!data.usage) return null;
        return {
          promptTokens: data.usage.prompt_tokens ?? null,
          completionTokens: data.usage.completion_tokens ?? null,
        };
      }

      case 'responses':
      case 'openai-responses': {
        // 非流式: data.usage；流式: response.completed 事件的 data.response.usage
        const usage = data.usage || (data.type === 'response.completed' ? data.response?.usage : null);
        if (!usage) return null;
        return {
          promptTokens: usage.input_tokens ?? null,
          completionTokens: usage.output_tokens ?? null,
        };
      }

      case 'claude':
      case 'anthropic': {
        // 流式: message_start → message.usage.input_tokens；message_delta → usage.output_tokens
        const usage = data.usage || data.message?.usage;
        if (!usage) return null;
        return {
          promptTokens: usage.input_tokens ?? null,
          completionTokens: usage.output_tokens ?? null,
        };
      }

      case 'gemini': {
        if (!data.usageMetadata) return null;
        return {
          promptTokens: data.usageMetadata.promptTokenCount ?? null,
          completionTokens: data.usageMetadata.candidatesTokenCount ?? null,
        };
      }

      default:
        return null;
    }
  }
  
  /**
   * 从非流式响应中提取文本内容
   * @param {Object} data - 完整的响应数据对象
   * @param {String} provider - AI 提供商类型 ('openai', 'claude', 'gemini')
   * @returns {String} - 提取的文本内容，如果没有内容则返回空字符串
   */
  static extractNonStreamContent(data, provider) {
    if (!data || typeof data !== 'object') {
      return '';
    }
    
    switch (provider.toLowerCase()) {
      case 'openai':
        // OpenAI 非流式格式: choices[0].message.content
        return data.choices?.[0]?.message?.content || '';

      case 'responses':
      case 'openai-responses': {
        // OpenAI Responses 非流式格式: output[].content[].text (type=output_text)
        if (typeof data.output_text === 'string') return data.output_text;
        let text = '';
        (Array.isArray(data.output) ? data.output : []).forEach(item => {
          (Array.isArray(item?.content) ? item.content : []).forEach(c => {
            if (c?.type === 'output_text' && c.text) text += c.text;
          });
        });
        return text;
      }

      case 'claude':
      case 'anthropic':
        // Claude 非流式格式: content[0].text
        return data.content?.[0]?.text || '';
        
      case 'gemini':
        // Gemini 非流式格式: candidates[0].content.parts[0].text
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        
      default:
        return '';
    }
  }
}

module.exports = SSEParser;
