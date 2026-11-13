/*
 * panels/settings.js —— 主题参数面板
 *
 * 为什么这个面板自己管持久化，而不是交给 app.js：
 * 「参数值」是面板自己的状态，面板最清楚它有哪些字段、每个字段的单位是什么。
 * app.js 只负责「把面板挂上去」，不需要知道 mw.theme 里存了什么。
 *
 * 关键设计：六个值全部通过 document.documentElement.style.setProperty
 * 写成 CSS 自定义属性（--mw-*），而不是往元素上打类名或行内样式。
 * 理由有两条：
 *   1. 一处写入、所有引用了变量的地方同时变，不需要重新渲染管线；
 *   2. P2 的固化器要把这些值写进产物的内联 style，
 *      从 CSS 变量取值比从一堆 DOM 控件里反查可靠得多。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});
  const STORAGE_KEY = 'mw.theme';

  /** 唯一一份默认值。index.html 里不给 range 写 value，避免两处默认值漂移。 */
  const DEFAULTS = {
    fontSize: 16,      // px
    lineHeight: 1.75,  // 无单位
    color: '#3f3f3f',
    accent: '#0f7ae5',
    padding: 0,        // px
    paraSpacing: 1.6   // em
  };

  const VAR_MAP = {
    fontSize: '--mw-font-size',
    lineHeight: '--mw-line-height',
    color: '--mw-color',
    accent: '--mw-accent',
    padding: '--mw-padding',
    paraSpacing: '--mw-para-spacing'
  };

  const UNIT = {
    fontSize: 'px',
    lineHeight: '',
    color: '',
    accent: '',
    padding: 'px',
    paraSpacing: 'em'
  };

  let warned = false;

  function warnOnce(message) {
    if (warned) return;
    warned = true;
    MW.util.toast(message, 'warn');
  }

  function loadTheme() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return Object.assign({}, DEFAULTS);
      const parsed = JSON.parse(raw);
      // 只接纳已知字段：手改过 localStorage 或旧版本残留的字段不能污染面板
      const theme = Object.assign({}, DEFAULTS);
      Object.keys(DEFAULTS).forEach(function (key) {
        if (parsed && parsed[key] != null) theme[key] = parsed[key];
      });
      return theme;
    } catch (err) {
      warnOnce('主题参数读取失败，已用默认值：' + err.message);
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
    } catch (err) {
      // 这里必须只提示一次：滑块拖动会连续触发，每动一格弹一个 toast 等于没法用
      warnOnce('主题参数无法保存（本地存储不可用）：' + err.message);
    }
  }

  /** 控件里显示的值。字号带 px、行高两位小数、段距带 em，是硬性要求。 */
  function toDisplay(key, value) {
    if (key === 'lineHeight') return Number(value).toFixed(2);
    if (key === 'paraSpacing') return Number(value).toFixed(1) + 'em';
    if (key === 'fontSize' || key === 'padding') return String(value) + 'px';
    return String(value);
  }

  function cssValueText(key, value) {
    if (key === 'lineHeight') return Number(value).toFixed(2);
    return String(value) + (UNIT[key] || '');
  }

  const inputs = {};
  let host = null;
  let current = Object.assign({}, DEFAULTS);

  function collectInputs() {
    host = document.getElementById('paramBar');
    if (!host) return;
    const list = host.querySelectorAll('[data-theme-key]');
    for (let i = 0; i < list.length; i++) {
      inputs[list[i].getAttribute('data-theme-key')] = list[i];
    }
  }

  function syncOutputs() {
    if (!host) return;
    const outs = host.querySelectorAll('[data-out-for]');
    for (let i = 0; i < outs.length; i++) {
      const key = outs[i].getAttribute('data-out-for');
      outs[i].textContent = toDisplay(key, current[key]);
    }
  }

  function syncControls() {
    Object.keys(inputs).forEach(function (key) {
      if (current[key] != null) inputs[key].value = current[key];
    });
  }

  /**
   * 写 CSS 变量。这里刻意逐条 setProperty 而不是替换整段 style 文本，
   * 因为替换整段会连带清掉别人（比如 P2 的舞台宽度）写在 :root 上的变量。
   */
  function apply(theme) {
    const rootStyle = document.documentElement.style;
    Object.keys(VAR_MAP).forEach(function (key) {
      if (theme[key] == null) return;
      rootStyle.setProperty(VAR_MAP[key], cssValueText(key, theme[key]));
    });
  }

  function readFromDom() {
    const theme = {};
    Object.keys(inputs).forEach(function (key) {
      const raw = inputs[key].value;
      theme[key] = (key === 'color' || key === 'accent') ? raw : Number(raw);
    });
    return theme;
  }

  function setTheme(theme, persist) {
    current = theme;
    apply(current);
    syncControls();
    syncOutputs();
    if (persist) saveTheme(current);
    // P2 起产物是「固化」的：样式已经写死进每个元素的 style，
    // 改 CSS 变量不会回头改它们。所以主题一变就必须通知外层重跑管线，
    // 否则预览会停在旧主题上，和参数条上显示的值对不上。
    document.dispatchEvent(new CustomEvent('mw:theme', { detail: Object.assign({}, current) }));
  }

  function reset() {
    setTheme(Object.assign({}, DEFAULTS), true);
  }

  function bind() {
    Object.keys(inputs).forEach(function (key) {
      const node = inputs[key];
      // 用 input 而不是 change：color 控件在 change 时才触发，
      // 拖动取色盘的过程中看不到反馈，input 事件能给到实时预览。
      node.addEventListener('input', function () {
        setTheme(readFromDom(), true);
      });
    });

    const btn = document.getElementById('btnResetTheme');
    if (btn) btn.addEventListener('click', reset);
  }

  function init() {
    collectInputs();
    current = loadTheme();
    apply(current);
    syncControls();
    syncOutputs();
    bind();
    return Object.assign({}, current);
  }

  MW.panels = MW.panels || {};
  MW.panels.settings = {
    DEFAULTS: DEFAULTS,
    VAR_MAP: VAR_MAP,
    init: init,
    apply: apply,
    reset: reset,
    get: function () { return Object.assign({}, current); },
    /** P2 的固化器从这里取值，避免它自己去读 DOM 控件 */
    cssVarOf: function (key) {
      return getComputedStyle(document.documentElement).getPropertyValue(VAR_MAP[key]).trim();
    }
  };
})(window);
