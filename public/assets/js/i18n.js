/**
 * i18n.js - 前端中英文切换引擎
 *
 * 机制：
 *  - 字典按页面拆分在 assets/js/i18n/en.*.js 中，往 window.I18N_EN 上合并（key = 中文原文，value = 英文）
 *  - 英文模式下用 TreeWalker 扫描文本节点、placeholder/title/aria-label 属性与 document.title，
 *    先按整段精确匹配，再按汉字段切分替换
 *  - MutationObserver 监听 DOM 变化（layout 动态渲染、innerHTML 模板、toast 等）自动重新翻译
 *  - JS 代码里拼接含变量的中文串时调用 window.t('加载失败') 包裹固定部分
 *  - 语言存 localStorage('llm_eval_lang')，默认跟随浏览器；切换后整页刷新
 */
(function () {
  'use strict';

  var STORE_KEY = 'llm_eval_lang';

  // 所有 en.*.js 字典文件都会往这里合并：{ '中文原文': 'English' }
  var DICT = (window.I18N_EN = window.I18N_EN || {});

  function getLang() {
    var saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) { /* ignore */ }
    if (saved === 'zh' || saved === 'en') return saved;
    var nav = (navigator.language || '').toLowerCase();
    return nav.indexOf('zh') === 0 ? 'zh' : 'en';
  }

  var lang = getLang();

  var HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
  // 连续纯汉字段 + 尾部紧邻的中文标点（不吞字母数字，这样"成功 123 / 失败 4"这类含变量文本
  // 能拆成"成功"/"失败"等短语段命中字典）
  var SEG_RE = /[\u3400-\u4dbf\u4e00-\u9fff]+[，。：；！？、（）"“”‘’…—·]*/g;
  var SEG_TAIL_RE = /[，。：；！？、（）"“”‘’…—·]+$/;

  /** 按汉字段替换 */
  function seg(str) {
    return str.replace(SEG_RE, function (m) {
      if (m in DICT) return DICT[m];
      var trimmed = m.replace(SEG_TAIL_RE, '');
      if (trimmed && trimmed in DICT) {
        return m.slice(0, m.length - trimmed.length) + DICT[trimmed];
      }
      return m;
    });
  }

  /**
   * 翻译一个字符串。中文模式原样返回；英文模式先整段匹配，再按汉字段替换。
   * 未收录的内容保持原样（渐进覆盖，不会丢字）。
   */
  function t(s) {
    if (s == null) return s;
    var str = String(s);
    if (lang === 'zh' || !HAN_RE.test(str)) return str;
    var trimmed = str.trim();
    if (trimmed && trimmed in DICT) return str.replace(trimmed, DICT[trimmed]);
    return seg(str);
  }

  /** 扫描并翻译 root（默认整个 document）内的文本与属性 */
  function apply(root) {
    if (lang !== 'en') return;
    root = root || document;

    if (root === document || root.documentElement === document.documentElement) {
      if (HAN_RE.test(document.title)) document.title = t(document.title);
      if (document.documentElement.lang !== 'en') document.documentElement.lang = 'en';
    }

    var doc = root.ownerDocument || document;

    // 文本节点
    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var nodes = [];
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && HAN_RE.test(node.nodeValue)) nodes.push(node);
    }
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].nodeValue = t(nodes[i].nodeValue);
    }

    // 常用属性（值未变化时跳过 setAttribute，否则会再次触发 MutationObserver 造成循环）
    if (root.querySelectorAll) {
      var els = root.querySelectorAll('[placeholder],[title],[aria-label]');
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        var attrs = ['placeholder', 'title', 'aria-label'];
        for (var k = 0; k < attrs.length; k++) {
          var a = attrs[k];
          var v = el.getAttribute(a);
          if (v && HAN_RE.test(v)) {
            var nv = t(v);
            if (nv !== v) el.setAttribute(a, nv);
          }
        }
      }
    }
  }

  // DOM 变化（layout 渲染 / 页面模板 / 弹窗 / toast）后自动重翻，防抖合并。
  // 保险丝：10 秒内回调超过 200 次视为异常循环，自动断开 observer 防止拖死页面。
  var pending = null;
  var fuseStart = 0;
  var fuseCount = 0;
  var observer = new MutationObserver(function (muts) {
    if (lang !== 'en') return;
    var now = Date.now();
    if (now - fuseStart > 10000) { fuseStart = now; fuseCount = 0; }
    if (++fuseCount > 200) {
      observer.disconnect();
      console.warn('[i18n] 高频 DOM 循环，已暂停自动翻译');
      return;
    }
    var hasRelevant = muts.some(function (m) {
      return m.type === 'childList' || m.type === 'attributes';
    });
    if (!hasRelevant) return;
    clearTimeout(pending);
    pending = setTimeout(function () { apply(document); }, 80);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['placeholder', 'title', 'aria-label'],
  });

  window.I18N = {
    t: t,
    apply: apply,
    getLang: getLang,
    /** 切换语言并整页刷新 */
    setLang: function (l) {
      if (l !== 'zh' && l !== 'en') return;
      try { localStorage.setItem(STORE_KEY, l); } catch (e) { /* ignore */ }
      location.reload();
    },
    toggle: function () {
      window.I18N.setLang(lang === 'zh' ? 'en' : 'zh');
    },
  };
  // 供各处 JS 直接调用：t('中文')
  window.t = t;

  // 首次应用（脚本位于 body 尾部，静态内容直接翻译）
  apply(document);
})();
