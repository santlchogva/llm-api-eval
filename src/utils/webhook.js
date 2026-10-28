/**
 * Webhook 通知工具：压测结束时把最终结果 POST 到用户配置的 URL。
 * 失败只记日志，不影响压测流程本身。
 */
const axios = require('axios');
const log = require('./logger');

/**
 * 推送 webhook 通知
 * @param {string} url - webhook 地址
 * @param {Object} payload - 通知内容
 */
async function sendWebhook(url, payload) {
  if (!url || !/^https?:\/\//i.test(url)) return false;

  try {
    await axios.post(url, payload, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' },
    });
    log.info('Webhook 通知已发送', { url });
    return true;
  } catch (error) {
    log.warn('Webhook 通知发送失败', { url, error: error.message });
    return false;
  }
}

module.exports = { sendWebhook };
