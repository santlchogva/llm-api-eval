/**
 * 共享 HTTP/HTTPS Agent（开启 keep-alive）
 *
 * 默认情况下 axios 每次请求都会新建 TCP/TLS 连接，短请求场景下
 * 连接建立开销会显著拉高延迟，甚至让压测端本身成为瓶颈，
 * 掩盖被测服务的真实性能。压测统一复用长连接。
 */
const http = require('http');
const https = require('https');

const baseOptions = {
  keepAlive: true,
  keepAliveMsecs: 30000,
  // 上限保护：无界 socket 池在高 RPM + 慢响应时可能耗尽文件句柄
  maxSockets: parseInt(process.env.MAX_SOCKETS) || 1024,
  maxFreeSockets: 256,
  scheduling: 'lifo',
};

const httpAgent = new http.Agent(baseOptions);
const httpsAgent = new https.Agent(baseOptions);

module.exports = { httpAgent, httpsAgent, agentOptions: baseOptions };
