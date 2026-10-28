/**
 * LLM-API-Eval 公共 API 客户端
 * 统一携带 Bearer Token、处理 401 跳转、解析 {success,data,error} 包装
 */
(function () {
  'use strict';

  const TOKEN_KEY = 'authToken';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  }

  function redirectToLogin() {
    clearToken();
    if (!location.pathname.startsWith('/')) return;
    location.href = '/';
  }

  /**
   * 通用请求
   * @param {string} path 以 / 开头的 API 路径
   * @param {Object} [opts] { method, body, timeout, raw }
   * @returns {Promise<any>} 成功时返回 data 字段（raw=true 时返回完整 Response）
   */
  async function request(path, opts = {}) {
    const {
      method = 'GET',
      body = null,
      timeout = 120000,
      raw = false,
    } = opts;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    if (typeof timer.unref === 'function') timer.unref();

    let res;
    try {
      res = await fetch(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getToken()}`,
        },
        body: body !== null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('请求超时，请稍后重试');
      throw new Error('网络错误，请检查服务器连接');
    }
    clearTimeout(timer);

    if (res.status === 401) {
      redirectToLogin();
      throw new Error('登录已失效，请重新登录');
    }

    if (raw) return res;

    let json;
    try {
      json = await res.json();
    } catch (e) {
      if (!res.ok) throw new Error(`请求失败 (HTTP ${res.status})`);
      return null;
    }

    if (!res.ok || json.success === false) {
      const msg = json.error || json.message || `请求失败 (HTTP ${res.status})`;
      const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      err.status = res.status;
      err.data = json.data;
      throw err;
    }
    return json.data !== undefined ? json.data : json;
  }

  /** 下载文件（带鉴权） */
  async function download(path, fallbackName = 'export.bin') {
    const res = await request(path, { raw: true, timeout: 300000 });
    const blob = await res.blob();
    let name = fallbackName;
    const cd = res.headers.get('content-disposition');
    if (cd) {
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd);
      if (m) name = decodeURIComponent(m[1]);
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  window.API = {
    getToken,
    setToken,
    clearToken,
    request,
    download,
    get: (p, opts) => request(p, { ...opts, method: 'GET' }),
    post: (p, body, opts) => request(p, { ...opts, method: 'POST', body }),
    put: (p, body, opts) => request(p, { ...opts, method: 'PUT', body }),
    del: (p, opts) => request(p, { ...opts, method: 'DELETE' }),
  };
})();
