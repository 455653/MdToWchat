/*
 * preview-mode.js —— 只读页（URL 带 ?mode=preview 或 ?mode=copy）
 *
 * 这两个页面是同一件事的两个宽度：
 *   ?mode=preview —— 手机浏览器打开 serve.cmd 起的服务，看到「发出去之后读者会看到的那一份」。
 *                    它是用户唯一可能「全选复制」的页面，所以除了正文什么都不能有。
 *   ?mode=copy    —— 桌面端「打开纯净页」按钮开的，宽度自适应、同样只有正文。
 *                    它不是给手机看的，是给「我自己 Ctrl+A」的人用的：
 *                    选中范围从第一个字符到最后一行，不会有工具栏混进去。
 * 两者共用同一套取数、主题、轮询逻辑——差别只在容器（宽度）与顶层类名，
 * 所以是同一个文件里的两条分支，而不是两个模块。
 *   为什么这里不给 <html> 加任何新元素：只切类、只往正文容器里放产物，
 *   连「加载中」这类提示都不做（提示只在真的没内容可显示时才画，且画在正文框里）。
 *
 * 为什么轮询的是 /sync 的 rev，而不是 localStorage 的 mw.rev：
 *   localStorage 是「每台设备 + 每个浏览器」各自独立的存储。手机浏览器里
 *   根本没有电脑写进去的那份 mw.doc，按原方案在手机上轮询同一个键名，
 *   轮到的永远是空值——两台设备之间必须有一个双方都能访问的落点。
 *   所以这里优先走 MW.sync（serve.py 里的 /sync），只有在「从头到尾一次都没连上」
 *   时才退回本机的 localStorage，那一条是为「在电脑自己浏览器里打开这个地址」准备的。
 *
 * 滚动位置按百分比恢复而不是按像素：
 *   重渲染后内容高度几乎一定变了（少了一行、图片撑高了、主题字号变了）。
 *   记像素值只会在短文档上滚过头、在长文档上停在别处；
 *   记百分比才能保证「看到哪一段」这件事大致不变。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  /* 本文件的行为等级：P3 引入只读预览页，P4 又让它兼管 ?mode=copy 的纯净复制页；
     P5 起 build() 变成异步（图片/公式/图表要在本机栅格化），这一页也必须跟着 await，
     否则渲染失败。所以跟着 P5 一起抬到 5。它不是「本文件在哪一阶段被创建」的记录。 */
  const PHASE = 5;

  /** 轮询间隔。需求定的是 800ms：肉眼像实时，又不至于把请求堆起来。 */
  const POLL_MS = 800;

  const KEY_DOC = 'mw.doc';
  const KEY_REV = 'mw.rev';
  const KEY_THEME = 'mw.theme';

  /** 没内容可显示时的文案。它只在页面真要空着的时候出现，正常预览页看不到它。 */
  const EMPTY_TEXT = '这里还没有内容。这一页的正文由电脑端推过来：'
    + '请确认电脑上已经运行 serve.cmd，并在编辑页里写了内容，然后稍等片刻。';

  /**
   * 两个只读页共用这套逻辑，靠 MODE 分叉。
   * 判定放在加载期而不是 init 里：app.js 在 init 之前就要用 active 决定走哪条引导路径。
   */
  const MODE = new URLSearchParams(global.location.search).get('mode');
  const isCopy = MODE === 'copy';
  const active = MODE === 'preview' || isCopy;

  const el = {};
  let lastRev = null;      // null = 一次都没从服务端拿到过版本号
  let lastDoc = null;
  let lastLocalRev = null;
  let localSeen = false;
  let themeApplied = false;
  let busy = false;

  function $(id) { return document.getElementById(id); }

  /* ==================== 滚动位置 ==================== */

  function scrollHost() {
    // 这一页滚动的是文档本身（CSS 里 html/body 被改成 height:auto; overflow:auto），
    // 所以滚动容器要从 scrollingElement 取，而不是某个 div。
    return document.scrollingElement || document.documentElement;
  }

  function readRatio() {
    const box = scrollHost();
    const max = box.scrollHeight - box.clientHeight;
    return max > 0 ? box.scrollTop / max : 0;
  }

  function applyRatio(ratio) {
    const box = scrollHost();
    // 读 scrollHeight 会强制一次同步排版，正好保证量到的是刚换上去的新内容的高度，
    // 而不是上一版的。少了这一步，短文档上会滚过头。
    const max = box.scrollHeight - box.clientHeight;
    box.scrollTop = max > 0 ? ratio * max : 0;
  }

  /* ==================== 内容与主题 ==================== */

  /**
   * 主题只写 CSS 变量，不碰面板控件——这一页根本没有控件。
   * 固化器读的是「元素在舞台上的计算样式」，而计算样式来自 :root 上的变量，
   * 所以变量必须在 build 之前就位，否则算出来的是一份默认主题的产物。
   */
  function useTheme(theme) {
    if (theme && typeof theme === 'object') {
      MW.panels.settings.apply(theme);
      themeApplied = true;
      return;
    }
    if (themeApplied) return;
    MW.panels.settings.apply(readLocalTheme() || MW.panels.settings.DEFAULTS);
    themeApplied = true;
  }

  function readLocalTheme() {
    try {
      const raw = global.localStorage.getItem(KEY_THEME);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      // 读不到（没存过，或 file:// 下存储被禁用）就用默认值，
      // 两者的结果完全一样，不值得为它在只读页上插一条提示。
      return null;
    }
  }

  function readLocal(key) {
    try {
      return global.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  /** 把一段说明画进正文框。它替代正文，所以不会污染「复制出去的东西」。 */
  function notice(text) {
    el.article.textContent = '';
    const box = document.createElement('div');
    box.setAttribute('style', 'margin:20px 0;padding:14px 16px;border:1px solid #e2e4e8;'
      + 'border-radius:6px;color:#6b7280;font-size:13px;line-height:1.7;');
    box.textContent = text;
    el.article.appendChild(box);
  }

  /**
   * 把 doc 渲染进正文容器。
   *
   * P5 起是异步的：build() 返回 Promise（图片/公式/图表的内嵌要等懒加载库与栅格化）。
   * 不 await 就会把一个 Promise 对象 appendChild 进去——它不是节点，直接抛错，
   * 而报错文案（appendChild 收到非 Node）离真实原因很远，很难查。
   *
   * renderToken 是「单飞」锁：渲染变成异步之后，两次 consume 可能在第一次还没
   * 写完 DOM 时就开始第二次。没有这把锁，谁先写完是碰运气，
   * 正文可能停在上一版——手机上表现成「电脑改了，手机反而退回去了」。
   */
  let renderToken = 0;

  async function render(doc) {
    const myToken = ++renderToken;
    const ratio = readRatio();

    let out;
    try {
      // 编码参数只影响统计栏的显示，不影响渲染；这一页没有统计栏，所以给默认值即可。
      out = await MW.pipeline.build(doc, { encoding: 'UTF-8' });
    } catch (err) {
      // 这一页没有 toast，失败只能画进正文框：否则手机上看到的是「文章突然没了」，
      // 而这条真实原因（哪个库缺了、哪一步抛了）就彻底拿不到了。
      if (myToken === renderToken) notice('渲染失败：' + (err && err.message ? err.message : err));
      return;
    }

    if (myToken !== renderToken) return; // 已经有更新的内容在渲染，这一版作废
    el.article.textContent = '';
    el.article.appendChild(out.root);
    applyRatio(ratio);
  }

  function consume(data) {
    lastRev = data.rev;
    // 主题必须先落，再 build：见 useTheme 的注释
    useTheme(data.theme);
    // unchanged 为真时服务端只回版本号、不回正文（那是它省流量的设计），
    // 此时 doc 是 undefined。拿它去渲染会把整篇文章渲染成空白，
    // 而「手机上文章突然全没了」这个现象离「服务端没回 doc」隔得很远，很难查。
    if (data.unchanged || data.doc == null) return;
    // rev 变了但正文一样（只改了文件名之类）时不必重建 DOM：
    // 重建会顺带把滚动位置重算一次，是白做功。
    if (data.doc === lastDoc) return;
    lastDoc = data.doc;
    render(data.doc);
  }

  /**
   * 本机存储这条退路。
   * 它在手机上永远取到空值——这正是它只能当退路、不能当主路的原因。
   */
  function localTick() {
    const rev = readLocal(KEY_REV);
    const doc = readLocal(KEY_DOC);

    if (localSeen && rev === lastLocalRev) return;
    lastLocalRev = rev;
    localSeen = true;

    if (doc == null || doc === '') {
      if (lastDoc !== null) return;
      notice(EMPTY_TEXT);
      return;
    }
    if (doc === lastDoc) return;
    lastDoc = doc;
    render(doc);
  }

  function tick() {
    // 上一轮还没回来就跳过这一轮。没有这个开关，服务一旦半死不活，
    // 800ms 一次的请求会越堆越多，最后变成「手机不动了」——现象离原因很远。
    if (busy) return;
    busy = true;

    MW.sync.pull(lastRev).then(function (data) {
      busy = false;
      if (data) { consume(data); return; }

      // 一次都没连上过服务：退回本机存储（服务没开时，电脑自己开这个地址也能看）。
      // 连上过又断了则什么都不做——手机上那份 localStorage 是空的，
      // 拿它去覆盖已经显示出来的正文，表现成「文章突然没了」，比不更新更难查。
      if (lastRev == null) localTick();
    });
  }

  function init() {
    el.article = $(isCopy ? 'copyArticle' : 'previewArticle');
    el.page = $(isCopy ? 'copyPage' : 'previewPage');

    // 隐藏外壳靠的是这个类（见 theme.css 的 html.is-preview-mode / is-copy-mode 段），
    // 用类而不是「运行时删 DOM」：这一页的 HTML 是静态的，
    // 隐藏掉不会产生新元素，也就没有元素会被「全选复制」带走。
    document.documentElement.classList.add(isCopy ? 'is-copy-mode' : 'is-preview-mode');
    el.page.hidden = false;

    // script 加载失败在 file:// 下是静默失败（不报错、不进控制台），
    // 不显式检查的话，用户看到的是一片纯白，没有任何线索。
    if (!MW.sync || !MW.pipeline || !MW.panels || !MW.panels.settings) {
      notice('页面脚本没有按顺序加载，预览无法进行。请确认 src/ 与 vendor/ 目录完整后刷新。');
      return;
    }

    tick();                                  // 先来一次，别让首屏空等 800ms
    global.setInterval(tick, POLL_MS);
  }

  MW.previewMode = {
    PHASE: PHASE,
    /** app.js 靠它决定走哪条引导路径 */
    active: active,
    /** 'preview' 或 'copy'，供控制台排查「到底开的哪一页」 */
    mode: MODE,
    init: init
  };
})(window);
