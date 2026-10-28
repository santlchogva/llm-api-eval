/**
 * LLM-API-Eval WebSocket 客户端
 * - 通过查询串携带 token（浏览器 WS 无法自定义请求头）
 * - 断线自动重连（指数退避）
 * - 按 type 分发消息：ws.on('statsUpdate', fn)
 */
(function () {
  'use strict';

  class WSClient {
    constructor() {
      this.handlers = new Map();
      this.socket = null;
      this.reconnectDelay = 1000;
      this.maxDelay = 15000;
      this.closedByUser = false;
      this.pingTimer = null;
      this.onStateChange = null; // 连接状态回调 (connected:boolean)
    }

    connect() {
      const token = window.API ? window.API.getToken() : localStorage.getItem('authToken');
      if (!token) return;

      this.closedByUser = false;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/?token=${encodeURIComponent(token)}`;

      try {
        this.socket = new WebSocket(url);
      } catch (e) {
        this._scheduleReconnect();
        return;
      }

      this.socket.onopen = () => {
        this.reconnectDelay = 1000;
        this._startPing();
        if (this.onStateChange) this.onStateChange(true);
      };

      this.socket.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (e) {
          return;
        }
        const type = msg.type;
        if (!type) return;
        // 对外同时暴露细粒度事件
        this._emit(type, msg.data);
        // 统一入口，方便调试
        this._emit('*', msg);
      };

      this.socket.onclose = () => {
        this._stopPing();
        if (this.onStateChange) this.onStateChange(false);
        if (!this.closedByUser) this._scheduleReconnect();
      };

      this.socket.onerror = () => {
        try {
          this.socket.close();
        } catch (e) { /* ignore */ }
      };
    }

    /** 关闭并停止重连 */
    close() {
      this.closedByUser = true;
      this._stopPing();
      if (this.socket) {
        try {
          this.socket.close();
        } catch (e) { /* ignore */ }
      }
    }

    on(type, fn) {
      if (!this.handlers.has(type)) this.handlers.set(type, new Set());
      this.handlers.get(type).add(fn);
      return () => this.off(type, fn);
    }

    off(type, fn) {
      const set = this.handlers.get(type);
      if (set) set.delete(fn);
    }

    _emit(type, data) {
      const set = this.handlers.get(type);
      if (!set) return;
      set.forEach((fn) => {
        try {
          fn(data);
        } catch (e) {
          console.error(`[ws] handler error for ${type}:`, e);
        }
      });
    }

    _scheduleReconnect() {
      setTimeout(() => {
        if (!this.closedByUser) this.connect();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.maxDelay, this.reconnectDelay * 1.6);
    }

    _startPing() {
      this._stopPing();
      this.pingTimer = setInterval(() => {
        this.send({ type: 'ping' });
      }, 25000);
    }

    _stopPing() {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
    }

    send(obj) {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(JSON.stringify(obj));
        } catch (e) { /* ignore */ }
      }
    }
  }

  /** 创建页面级单例，页面卸载时自动断开 */
  window.createWS = function () {
    const client = new WSClient();
    client.connect();
    window.addEventListener('beforeunload', () => client.close());
    return client;
  };
})();
