/**
 * LLM-API-Eval 页面框架
 * 负责：登录校验、侧边栏/顶栏渲染、用户菜单、Toast、Modal、
 *       管理员的用户管理、公共格式化工具
 *
 * 页面用法：
 *   <body data-page="dashboard">
 *     <div id="page-content"> …页面独有内容… </div>
 *     <script src="/assets/js/api.js"></script> …
 *     <script>Layout.init({ active:'dashboard', title:'压测控制台' }).then(user => { ...页面逻辑... })</script>
 */
(function () {
  'use strict';

  const ICONS = {
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 17 5.5 7 9 17M3.4 13.5h4.2M12.5 17V7h3a3.2 3.2 0 0 1 0 6.4h-3M21.5 7v10"></path></svg>',
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 12 19 5"/><path d="M12 6v2"/><path d="M18 12h2"/></svg>',
    speed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    parallel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
    quality: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
    schedule: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>',
  };

  const NAV_ITEMS = [
    { id: 'dashboard', href: '/dashboard', label: '压测控制台', icon: 'dashboard', group: '压测' },
    { id: 'parallel', href: '/parallel', label: '并行压测', icon: 'parallel', group: '压测' },
    { id: 'benchmark', href: '/benchmark', label: '速度测试', icon: 'speed', group: '压测' },
    { id: 'quality', href: '/quality', label: '质量测试', icon: 'quality', group: '测试' },
    { id: 'schedule', href: '/schedule', label: '定时任务', icon: 'schedule', group: '测试' },
    { id: 'history', href: '/history', label: '历史报告', icon: 'history', group: '数据' },
  ];

  // ---------- 格式化工具 ----------
  function fmtInt(n) {
    if (n === null || n === undefined || isNaN(Number(n))) return '0';
    return Number(n).toLocaleString('en-US');
  }

  function fmtMs(ms) {
    const v = Number(ms);
    if (!Number.isFinite(v)) return '-';
    if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
    return `${Math.round(v)}ms`;
  }

  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(Number(ms) / 1000));
    if (s < 60) return `${s}秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}分${s % 60}秒`;
    const h = Math.floor(m / 60);
    return `${h}时${String(m % 60).padStart(2, '0')}分`;
  }

  function fmtTokens(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '0';
    if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
    return String(Math.round(v));
  }

  function fmtPct(n, digits = 2) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '-';
    return `${v.toFixed(digits)}%`;
  }

  function fmtTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- Toast ----------
  let toastContainer = null;
  function ensureToastContainer() {
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.className = 'toast-container';
      document.body.appendChild(toastContainer);
    }
    return toastContainer;
  }

  function toast(message, type = 'info', duration = 3500) {
    const c = ensureToastContainer();
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const icon = type === 'success' ? ICONS.check : type === 'error' ? ICONS.alert : ICONS.info;
    el.innerHTML = `<span class="t-icon">${icon}</span><div class="flex-1">${escapeHtml(message)}</div>`;
    c.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 260);
    }, duration);
  }
  toast.success = (m, d) => toast(m, 'success', d);
  toast.error = (m, d) => toast(m, 'error', d || 5000);
  toast.warning = (m, d) => toast(m, 'warning', d || 4500);
  toast.info = (m, d) => toast(m, 'info', d);

  // ---------- Modal ----------
  /**
   * 打开一个模态框
   * @param {Object} opts { title, body(HTML|Node), footer(HTML|Node|null), large, onClose }
   * @returns {{el: HTMLElement, close: Function}}
   */
  function modal(opts = {}) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = `modal${opts.large ? ' modal-lg' : ''}`;

    const head = document.createElement('div');
    head.className = 'modal-head';
    head.innerHTML = `<div class="m-title">${escapeHtml(opts.title || '')}</div>
      <button class="modal-close" type="button">${ICONS.x}</button>`;

    const bodyEl = document.createElement('div');
    bodyEl.className = 'modal-body';
    if (typeof opts.body === 'string') bodyEl.innerHTML = opts.body;
    else if (opts.body) bodyEl.appendChild(opts.body);

    box.appendChild(head);
    box.appendChild(bodyEl);

    if (opts.footer) {
      const foot = document.createElement('div');
      foot.className = 'modal-foot';
      if (typeof opts.footer === 'string') foot.innerHTML = opts.footer;
      else foot.appendChild(opts.footer);
      box.appendChild(foot);
    }

    mask.appendChild(box);
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('open'));

    function close() {
      mask.classList.remove('open');
      setTimeout(() => mask.remove(), 200);
      if (opts.onClose) opts.onClose();
    }

    head.querySelector('.modal-close').addEventListener('click', close);
    mask.addEventListener('mousedown', (e) => {
      if (e.target === mask) close();
    });

    return { el: box, body: bodyEl, close };
  }

  /** 确认对话框，返回 Promise<boolean> */
  function confirmDialog(message, { title = '确认操作', danger = false, okText = '确认' } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const foot = document.createElement('div');
      foot.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-ghost';
      cancelBtn.textContent = '取消';
      const okBtn = document.createElement('button');
      okBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
      okBtn.textContent = okText;
      foot.append(cancelBtn, okBtn);

      const m = modal({
        title,
        body: `<div style="color:var(--text-2);font-size:var(--fs-md);line-height:1.7">${message}</div>`,
        footer: foot,
        onClose: () => { if (!settled) { settled = true; resolve(false); } },
      });

      cancelBtn.addEventListener('click', () => { settled = true; m.close(); resolve(false); });
      okBtn.addEventListener('click', () => { settled = true; m.close(); resolve(true); });
    });
  }

  // ---------- 修改密码 ----------
  function openChangePasswordModal() {
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="field mb-3">
        <label class="req">当前密码</label>
        <input type="password" class="input" id="cp-old" autocomplete="current-password">
      </div>
      <div class="field mb-3">
        <label class="req">新密码（至少 6 位）</label>
        <input type="password" class="input" id="cp-new" autocomplete="new-password">
      </div>
      <div class="field">
        <label class="req">确认新密码</label>
        <input type="password" class="input" id="cp-new2" autocomplete="new-password">
      </div>`;
    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-ghost';
    cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.className = 'btn btn-primary';
    ok.textContent = '确认修改';
    foot.append(cancel, ok);

    const m = modal({ title: '修改密码', body, footer: foot });
    cancel.addEventListener('click', () => m.close());
    ok.addEventListener('click', async () => {
      const oldPwd = body.querySelector('#cp-old').value;
      const newPwd = body.querySelector('#cp-new').value;
      const newPwd2 = body.querySelector('#cp-new2').value;
      if (!oldPwd || !newPwd) return toast.warning('请填写完整');
      if (newPwd.length < 6) return toast.warning('新密码至少 6 位');
      if (newPwd !== newPwd2) return toast.warning('两次输入的新密码不一致');
      try {
        await API.post('/api/users/change-password', { oldPassword: oldPwd, newPassword: newPwd });
        toast.success('密码修改成功');
        m.close();
      } catch (e) {
        toast.error(e.message);
      }
    });
  }

  // ---------- 用户管理（管理员） ----------
  async function openUserManageModal() {
    const body = document.createElement('div');
    body.innerHTML = '<div class="loading-overlay" style="position:static"><span class="spinner"></span></div>';

    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;gap:10px;justify-content:space-between;align-items:center;flex-wrap:wrap;';
    foot.innerHTML = `
      <div class="flex gap-2 flex-1" style="min-width:280px">
        <input class="input" id="nu-name" placeholder="用户名（2-32位小写字母/数字/_/-）" style="flex:1">
        <input class="input" id="nu-pwd" type="password" placeholder="密码（≥6位）" style="width:150px">
        <select class="select" id="nu-role" style="width:100px">
          <option value="user">普通用户</option>
          <option value="admin">管理员</option>
        </select>
        <button class="btn btn-primary" id="nu-add">${ICONS.plus}添加</button>
      </div>`;

    const m = modal({ title: '用户管理', body, footer: foot, large: true });

    async function renderList() {
      try {
        const users = await API.get('/api/users');
        const rows = users.map((u) => `
          <tr data-id="${u.id}">
            <td>${escapeHtml(u.username)}</td>
            <td><span class="badge ${u.role === 'admin' ? 'warning' : 'info'}">${u.role === 'admin' ? '管理员' : '普通用户'}</span></td>
            <td class="muted">${fmtTime(u.createdAt)}</td>
            <td>
              <div class="flex gap-2" style="justify-content:flex-end">
                <button class="btn btn-ghost btn-sm act-role" data-role="${u.role}">${u.role === 'admin' ? '降为普通' : '设为管理员'}</button>
                <button class="btn btn-danger btn-sm act-del" ${u.id === window.currentUser.id ? 'disabled title="不能删除自己"' : ''}>${ICONS.trash}</button>
              </div>
            </td>
          </tr>`).join('');
        body.innerHTML = `
          <div class="table-wrap"><table class="table">
            <thead><tr><th>用户名</th><th>角色</th><th>创建时间</th><th style="text-align:right">操作</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`;

        body.querySelectorAll('.act-role').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const tr = btn.closest('tr');
            const id = tr.dataset.id;
            const target = btn.dataset.role === 'admin' ? 'user' : 'admin';
            try {
              await API.post(`/api/users/${id}/role`, { role: target });
              toast.success('角色已更新');
              renderList();
            } catch (e) { toast.error(e.message); }
          });
        });
        body.querySelectorAll('.act-del').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const tr = btn.closest('tr');
            const id = tr.dataset.id;
            const name = tr.cells[0].textContent;
            if (!(await confirmDialog(`确定删除用户 <b>${escapeHtml(name)}</b>？该用户的历史数据将保留但无法再登录。`, { danger: true, okText: '删除' }))) return;
            try {
              await API.del(`/api/users/${id}`);
              toast.success('用户已删除');
              renderList();
            } catch (e) { toast.error(e.message); }
          });
        });
      } catch (e) {
        body.innerHTML = `<div class="empty-state">${ICONS.alert}<div class="e-title">${escapeHtml(e.message)}</div></div>`;
      }
    }

    foot.querySelector('#nu-add').addEventListener('click', async () => {
      const username = foot.querySelector('#nu-name').value.trim();
      const password = foot.querySelector('#nu-pwd').value;
      const role = foot.querySelector('#nu-role').value;
      if (!username || !password) return toast.warning('请填写用户名和密码');
      try {
        await API.post('/api/users', { username, password, role });
        toast.success(`用户 ${username} 创建成功`);
        foot.querySelector('#nu-name').value = '';
        foot.querySelector('#nu-pwd').value = '';
        renderList();
      } catch (e) { toast.error(e.message); }
    });

    renderList();
  }

  // ---------- 框架渲染 ----------
  function buildShell(pageId, title, sub) {
    const content = document.getElementById('page-content');
    const shell = document.createElement('div');
    shell.className = 'app-shell';

    const groups = [];
    NAV_ITEMS.forEach((item) => {
      let g = groups.find((x) => x.name === item.group);
      if (!g) { g = { name: item.group, items: [] }; groups.push(g); }
      g.items.push(item);
    });

    const navHtml = groups.map((g) => `
      <div class="nav-group-title">${g.name}</div>
      ${g.items.map((i) => `
        <a class="nav-link ${i.id === pageId ? 'active' : ''}" href="${i.href}">
          ${ICONS[i.icon]}<span>${i.label}</span>
        </a>`).join('')}`).join('');

    shell.innerHTML = `
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-logo">
          <div class="logo-mark">${ICONS.logo}</div>
          <div>
            <div class="logo-name">LLM-API-Eval</div>
            <div class="logo-sub">LLM API 压测平台</div>
          </div>
        </div>
        <nav class="sidebar-nav">${navHtml}</nav>
        <div class="sidebar-user" id="sidebar-user"></div>
      </aside>
      <div class="sidebar-mask" id="sidebar-mask"></div>
      <div class="main-wrap">
        <header class="topbar">
          <button class="menu-toggle" id="menu-toggle" type="button">${ICONS.menu}</button>
          <span class="topbar-title">${escapeHtml(title || '')}</span>
          ${sub ? `<span class="topbar-sub">${escapeHtml(sub)}</span>` : ''}
          <div class="topbar-actions" id="topbar-actions"></div>
        </header>
        <main class="main" id="page-main"></main>
      </div>`;

    if (content) shell.querySelector('#page-main').appendChild(content);
    document.body.appendChild(shell);

    // 移动端菜单
    const sidebar = shell.querySelector('#sidebar');
    const mask = shell.querySelector('#sidebar-mask');
    shell.querySelector('#menu-toggle').addEventListener('click', () => {
      sidebar.classList.toggle('open');
      mask.classList.toggle('show');
    });
    mask.addEventListener('click', () => {
      sidebar.classList.remove('open');
      mask.classList.remove('show');
    });
  }

  function buildUserArea(user) {
    const actions = document.getElementById('topbar-actions');

    // 语言切换（中 / EN）
    const langBtn = document.createElement('button');
    langBtn.className = 'btn btn-ghost btn-sm';
    langBtn.id = 'lang-toggle';
    langBtn.type = 'button';
    langBtn.textContent = window.I18N && window.I18N.getLang() === 'en' ? '中文' : 'EN';
    langBtn.title = '切换语言 / Switch language';
    langBtn.addEventListener('click', () => window.I18N.toggle());
    actions.appendChild(langBtn);

    const chip = document.createElement('div');
    chip.className = 'user-chip';
    chip.innerHTML = `
      <div class="avatar">${escapeHtml((user.username || 'U').charAt(0).toUpperCase())}</div>
      <span class="user-name">${escapeHtml(user.username)}</span>
      <span class="role-tag ${user.role === 'admin' ? 'admin' : ''}">${user.role === 'admin' ? '管理员' : '用户'}</span>
      <div class="dropdown" id="user-dropdown">
        <button class="dd-item" id="dd-users" style="display:${user.role === 'admin' ? 'flex' : 'none'}">${ICONS.users}<span>用户管理</span></button>
        <button class="dd-item" id="dd-pwd">${ICONS.key}<span>修改密码</span></button>
        <div class="dd-divider"></div>
        <button class="dd-item danger" id="dd-logout">${ICONS.logout}<span>退出登录</span></button>
      </div>`;
    actions.appendChild(chip);

    const dropdown = chip.querySelector('#user-dropdown');
    chip.addEventListener('click', (e) => {
      if (e.target.closest('.dropdown')) return;
      dropdown.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!chip.contains(e.target)) dropdown.classList.remove('open');
    });

    chip.querySelector('#dd-pwd').addEventListener('click', () => {
      dropdown.classList.remove('open');
      openChangePasswordModal();
    });
    chip.querySelector('#dd-users').addEventListener('click', () => {
      dropdown.classList.remove('open');
      openUserManageModal();
    });
    chip.querySelector('#dd-logout').addEventListener('click', async () => {
      dropdown.classList.remove('open');
      try {
        await API.post('/api/logout');
      } catch (e) { /* 忽略 */ }
      API.clearToken();
      location.href = '/';
    });

    // 侧边栏底部也放一个迷你用户条
    const su = document.getElementById('sidebar-user');
    if (su) {
      su.innerHTML = `
        <div class="flex items-center gap-2">
          <div class="avatar" style="width:28px;height:28px;font-size:var(--fs-xs)">${escapeHtml((user.username || 'U').charAt(0).toUpperCase())}</div>
          <div class="flex-1 ellipsis" style="font-size:var(--fs-sm)">${escapeHtml(user.username)}</div>
          <span class="badge ${user.role === 'admin' ? 'warning' : 'info'}">${user.role === 'admin' ? '管理员' : '用户'}</span>
        </div>`;
    }
  }

  /**
   * 页面初始化入口
   * @param {Object} opts { active, title, sub }
   * @returns {Promise<{id,username,role}>} 当前用户
   */
  async function init(opts = {}) {
    // 未登录直接跳走
    if (!API.getToken()) {
      location.href = '/';
      return new Promise(() => {});
    }

    let user;
    try {
      user = await API.get('/api/users/me');
    } catch (e) {
      // 401 已在 api.js 里跳转；其他错误也退回登录页
      if (location.pathname !== '/') location.href = '/';
      return new Promise(() => {});
    }
    window.currentUser = user;

    buildShell(opts.active, opts.title, opts.sub);
    buildUserArea(user);

    // 页面标题
    document.title = `${opts.title || 'LLM-API-Eval'} · LLM-API-Eval`;
    return user;
  }

  window.Layout = {
    init,
    toast,
    modal,
    confirmDialog,
    icons: ICONS,
    fmtInt,
    fmtMs,
    fmtDuration,
    fmtTokens,
    fmtPct,
    fmtTime,
    escapeHtml,
  };
  // 常用别名，页面少打字
  window.toast = toast;
  window.fmtInt = fmtInt;
  window.fmtMs = fmtMs;
  window.fmtDuration = fmtDuration;
  window.fmtTokens = fmtTokens;
  window.fmtPct = fmtPct;
  window.fmtTime = fmtTime;
  window.esc = escapeHtml;
})();
