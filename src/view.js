/*
 * view.js —— 预览视图
 *
 * P3 只加「看」的能力，所以这一层不碰解析、不碰固化，只做四件事：
 *   1. 双栏对照：左栏桌面宽 1080px、右栏手机宽，两栏挂的是同一份产物；
 *   2. 设备档位：375 / 393 / 360 三档，只改右栏容器宽度，不重跑管线；
 *   3. 大纲侧栏：从 window.MW.outline 生成，点击按 data-mw-id 跳转，可视区高亮；
 *   4. 深色背景开关与二维码遮罩。
 *
 * 「同一份产物」是这一层唯一不能妥协的地方：
 *   两栏各渲染一次看起来也能跑，但那意味着管线跑两遍，两边一旦有任何
 *   非确定性（异步富内容、随机 id、时间相关），就会出现「左栏有、右栏没有」，
 *   而那时候问题已经离原因很远了。所以做法是：挂一次、克隆一次。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  const PHASE = 3;

  /**
   * 左栏基准宽度。
   * 取 1080px 是因为它就是公众号横版封面的标准宽度，也是「宽屏正文」的常见上界；
   * 换个数字当然也能跑，但那样这个栏位就只是一个没有含义的「大窗口」。
   */
  const DESKTOP_WIDTH = 1080;

  /**
   * 三档设备宽度。数字是各机型的 CSS 逻辑宽度（不是物理像素）：
   * 375 是 iPhone SE / 8 系列，393 是 iPhone 15 Pro，360 是安卓最常见的一档。
   * 全部落在 360–393 这个区间不是巧合——固化基准是 375px，
   * 三档贴着它取，才能看出「宽一点点、窄一点点会不会把某一行挤坏」。
   */
  const DEVICES = [
    { width: 375, name: 'iPhone SE' },
    { width: 393, name: 'iPhone 15 Pro' },
    { width: 360, name: 'Android 常见机' }
  ];

  /** 大纲折叠状态。需求要求「折叠状态记住」，所以它是这里唯一持久化的东西。 */
  const KEY_OUTLINE_OPEN = 'mw.outline.open';

  /** 分隔条的左右下界：拖到 20% 以下会把某一栏压成一条线，等于把它弄丢了。 */
  const SPLIT_MIN = 20;
  const SPLIT_MAX = 80;

  const el = {};

  let splitPercent = 50;
  let deviceIndex = 0;
  let desktopScale = 1;
  let observer = null;
  let visibleIds = [];
  let orderIds = [];
  let fitRaf = 0;

  function $(id) { return document.getElementById(id); }

  /* ==================== 双栏挂载 ==================== */

  /**
   * 把一份产物挂到两栏上，并刷新大纲与缩放。
   * 两栏共用同一份 root：先挂左栏，再克隆给右栏。
   * 克隆会带上全部的 data-* 属性，但不会带任何 class（产物里本来就没有 class），
   * 所以「产物不含 class」这条断言不会被这里破坏。
   */
  function paint(out) {
    const root = out && out.root;
    if (!root) return;

    el.desktopArticle.textContent = '';
    el.phoneArticle.textContent = '';
    el.desktopArticle.appendChild(root);
    el.phoneArticle.appendChild(root.cloneNode(true));

    fitDesktop();
    renderOutline(out.outline || []);
    observeHeadings();
  }

  /**
   * 左栏缩放。
   *
   * 为什么不用 CSS zoom：实测（无头 Chrome 探针）zoom 会缩放 getBoundingClientRect，
   * 但外层滚动容器的 scrollHeight 仍然按未缩放的布局盒算——两者对不上，
   * 滚动位置直接算不出来（赋 scrollTop 无效）。所以改用 transform: scale()，
   * 并把「缩放后的高度」手算出来写回包装层。
   *
   * 为什么只缩不放：栏目比 1080px 还宽时保持 1:1。
   * 放大出来的字重、间距和真实排版不是一回事，看它没有意义。
   */
  function fitDesktop() {
    if (!el.desktopScroll || !el.desktopScaler) return;

    const cs = getComputedStyle(el.desktopScroll);
    const avail = el.desktopScroll.clientWidth
      - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    // 预览 tab 被切走时容器是 display:none，量到的宽度是 0。
    // 这时候直接返回、保留上一次的尺寸，比按 0 算出一个 k=0 把内容缩没要好。
    if (!(avail > 0)) return;

    desktopScale = Math.min(1, avail / DESKTOP_WIDTH);
    el.desktopScaler.style.transform = 'scale(' + desktopScale + ')';

    // transform 不参与布局：滚动容器算 scrollHeight 用的还是未缩放的那一版高度。
    // 不补这一层，滚动条长度和眼睛看到的内容长度就是对不上的。
    const height = el.desktopScaler.offsetHeight;
    el.desktopFit.style.width = Math.ceil(DESKTOP_WIDTH * desktopScale) + 'px';
    el.desktopFit.style.height = Math.ceil(height * desktopScale) + 'px';
  }

  /** 拖动分隔条时每次 pointermove 都重算会连续强制排版，用 rAF 合并成每帧一次。 */
  function scheduleFit() {
    if (fitRaf) return;
    fitRaf = global.requestAnimationFrame(function () {
      fitRaf = 0;
      fitDesktop();
    });
  }

  /* ==================== 设备档位 ==================== */

  function setDevice(index) {
    const next = Math.max(0, Math.min(DEVICES.length - 1, Number(index) || 0));
    deviceIndex = next;
    const device = DEVICES[next];

    // 只改容器宽度，不重跑管线：
    // 产物是恒按 375px 固化的（P2 定下的基准），换档位要看的正是
    // 「同一份产物在别的机身宽度上会不会被挤坏」。重固化一次，
    // 产物会跟着变，这个问题就被掩盖掉了——那就白测了。
    el.phone.style.setProperty('--device-w', device.width + 'px');
    el.phoneName.textContent = device.name;
    el.phoneWidth.textContent = device.width + 'px';

    const buttons = el.deviceSeg.querySelectorAll('.seg-btn');
    for (let i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('is-active', i === next);
    }
  }

  /* ==================== 大纲 ==================== */

  function renderOutline(outline) {
    el.outlineList.textContent = '';
    orderIds = [];

    if (!outline.length) {
      const empty = document.createElement('div');
      empty.className = 'outline-empty';
      empty.textContent = '文档里还没有标题。写一个「# 一级标题」，这里就会出现可点击的目录。';
      el.outlineList.appendChild(empty);
      return;
    }

    // 扁平列表而不是嵌套 <ul>：大纲要跳的是「标题」而不是「树节点」，
    // 扁平按钮的点击区域更大，缩进用一个 padding-left 就够了。
    outline.forEach(function (item) {
      orderIds.push(item.nodeId);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'outline-item';
      btn.setAttribute('data-node', item.nodeId);
      btn.setAttribute('data-level', String(Math.min(item.level, 3)));
      btn.title = item.text || '(空标题)';
      btn.textContent = item.text || '(空标题)';
      btn.style.paddingLeft = (8 + (item.level - 1) * 12) + 'px';
      el.outlineList.appendChild(btn);
    });
  }

  /**
   * 标题相对舞台纸面的偏移。
   *
   * 为什么用 offsetTop 链而不是 getBoundingClientRect：
   * 左栏整块被 transform 缩放过，rect 是缩放后的值，而 scrollTop 是未缩放的布局值，
   * 两者直接相减得到的是一个不存在的中间量。offsetTop 走的是布局坐标系，
   * 再乘上缩放系数就回到了滚动容器自己的坐标系里。
   *
   * 这条链能停在 .device-paper 上，是因为 CSS 里给它写了 position: relative——
   * offsetParent 只停在有定位的祖先上，少那一行，这里会一路走到 body，算出来的距离全错。
   */
  function offsetWithin(node, stop) {
    let y = 0;
    let cur = node;
    while (cur && cur !== stop) {
      y += cur.offsetTop;
      cur = cur.offsetParent;
    }
    return cur === stop ? y : 0;
  }

  function scrollColumn(box, paper, scale, nodeId) {
    const node = box.querySelector('[data-mw-id="' + nodeId + '"]');
    if (!node) return;
    // 留 8px 余量：正好贴顶会让「跳转生效了」和「本来就停在顶部」看起来一样
    box.scrollTop = Math.max(0, offsetWithin(node, paper) * scale - 8);
  }

  function jumpTo(nodeId) {
    // 两栏是同一份内容的两种视图，跳到同一处才符合「对照」的语义。
    scrollColumn(el.desktopScroll, el.desktopPaper, desktopScale, nodeId);
    scrollColumn(el.phoneScroll, el.phonePaper, 1, nodeId);
    setActive(nodeId);
  }

  function setActive(nodeId) {
    const items = el.outlineList.querySelectorAll('.outline-item');
    for (let i = 0; i < items.length; i++) {
      items[i].classList.toggle('is-active', items[i].getAttribute('data-node') === nodeId);
    }
  }

  /** 当前可视区里最靠上的那个标题。一屏同时出现好几个时，正在读的是最上面那一个。 */
  function pickTopVisible() {
    let best = null;
    let bestAt = Infinity;
    for (let i = 0; i < visibleIds.length; i++) {
      const at = orderIds.indexOf(visibleIds[i]);
      if (at >= 0 && at < bestAt) { bestAt = at; best = visibleIds[i]; }
    }
    return best;
  }

  /**
   * 可视区高亮。
   *
   * 用 IntersectionObserver 而不是在 scroll 事件里算位置：
   * scroll 事件每帧都可能触发，在里面读 offsetTop / scrollTop 会强制同步排版，
   * 长文档下就是肉眼可见的卡顿；IntersectionObserver 由浏览器在排版结束后统一回调，
   * 一次回调就能拿到全部「进出可视区」的标题。
   *
   * 为什么盯手机栏：产物就是按 375px 固化的，手机栏才是「发出去之后读者看到的」那一份，
   * 大纲跟着它走才有意义。
   */
  function observeHeadings() {
    if (observer) { observer.disconnect(); observer = null; }
    visibleIds = [];

    const box = el.phoneScroll;
    const nodes = box.querySelectorAll('[data-mw-id]');
    if (!nodes.length) { setActive(null); return; }

    const owner = new Map();
    for (let i = 0; i < nodes.length; i++) {
      owner.set(nodes[i], nodes[i].getAttribute('data-mw-id'));
    }

    observer = new IntersectionObserver(function (entries) {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const id = owner.get(entry.target);
        const at = visibleIds.indexOf(id);
        if (entry.isIntersecting) {
          if (at < 0) visibleIds.push(id);
        } else if (at >= 0) {
          visibleIds.splice(at, 1);
        }
      }
      setActive(pickTopVisible());
    }, {
      root: box,
      // 只认上半屏。一屏里同时有三四个标题时，不加这个收窄会来回乱闪；
      // 下方收掉 80% 等于在说「只有落在顶部 20% 才算当前这一节」。
      rootMargin: '0px 0px -80% 0px',
      threshold: 0
    });

    for (let i = 0; i < nodes.length; i++) observer.observe(nodes[i]);
  }

  /* ==================== 分隔条 ==================== */

  function bindSplitter() {
    let dragging = false;

    function apply(clientX) {
      const rect = el.split.getBoundingClientRect();
      if (!(rect.width > 0)) return;
      const pct = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX,
        ((clientX - rect.left) / rect.width) * 100));
      splitPercent = pct;
      el.deviceDesktop.style.flexBasis = pct + '%';
      // 左栏变窄 → 缩放系数跟着变 → 高度补偿也要跟着变，否则滚动条长度会错
      scheduleFit();
    }

    el.splitter.addEventListener('pointerdown', function (event) {
      dragging = true;
      el.splitter.classList.add('is-dragging');
      document.documentElement.classList.add('is-resizing');
      // 捕获指针：手快的时候鼠标会瞬间离开 7px 宽的分隔条，
      // 不捕获的话 pointermove 直接断流，表现成「拖着拖着就不跟手了」。
      if (el.splitter.setPointerCapture) el.splitter.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    el.splitter.addEventListener('pointermove', function (event) {
      if (!dragging) return;
      apply(event.clientX);
    });

    function stop() {
      if (!dragging) return;
      dragging = false;
      el.splitter.classList.remove('is-dragging');
      document.documentElement.classList.remove('is-resizing');
    }
    el.splitter.addEventListener('pointerup', stop);
    el.splitter.addEventListener('pointercancel', stop);
  }

  /* ==================== 大纲折叠 ==================== */

  function setOutlineOpen(open) {
    el.outlineRail.classList.toggle('is-folded', !open);
    el.btnOutlineFold.setAttribute('aria-expanded', open ? 'true' : 'false');
    el.btnOutlineFold.title = open ? '折叠大纲' : '展开大纲';
    try {
      global.localStorage.setItem(KEY_OUTLINE_OPEN, open ? '1' : '0');
    } catch (err) {
      // 折叠状态记不住不影响使用，所以这里不打断用户，但也不能悄悄失败：
      // 只有真的写不进去（file:// 下被禁用）时才会走到这里。
      MW.util.toast('大纲折叠状态无法保存（本地存储不可用）：' + err.message, 'warn');
    }
  }

  function readOutlineOpen() {
    try {
      return global.localStorage.getItem(KEY_OUTLINE_OPEN) !== '0';
    } catch (err) {
      return true; // 读不到就按默认展开，不为此打扰用户
    }
  }

  /* ==================== 二维码 ==================== */

  function closeQr() {
    el.qrMask.hidden = true;
    el.qrBox.textContent = '';
  }

  function qrTip(text) {
    el.qrBox.textContent = '';
    const tip = document.createElement('div');
    tip.className = 'qr-tip';
    tip.textContent = text;
    el.qrBox.appendChild(tip);
  }

  function drawQr(url) {
    el.qrUrl.textContent = url;

    // 库没加载出来不能留一块空白：地址文本已经显示出来了，用户至少能手输
    if (!global.QRCode) {
      qrTip('缺少 vendor/qrcode.min.js，无法生成二维码。地址已经显示在下面，可以直接手输。');
      return;
    }

    if (/^https?:\/\/127\.0\.0\.1/.test(url)) {
      // 服务端没能取到局域网地址时会回退到 127.0.0.1，那个地址手机一定连不上。
      // 与其让用户扫半天打不开，不如当场说清楚。
      qrTip('服务只取到了 127.0.0.1，这个地址手机连不上。请确认电脑连着 WiFi 或网线，然后重开 serve.cmd。');
      return;
    }

    // qrcodejs 的 makeImage() 会把内部的 <img> 设成 display:block。
    // 容器此刻若是 display:none，它量到的尺寸是 0，画出来就是一块空白——
    // 所以遮罩必须先显示、再构造二维码。这里不需要额外处理，因为 showQr 已经先揭开了遮罩。
    el.qrBox.textContent = '';
    new global.QRCode(el.qrBox, {
      text: url,
      width: 196,
      height: 196,
      colorDark: '#1f2329',
      colorLight: '#ffffff',
      // 二维码里装的是 IP + 端口，中间错一个字符整条地址就废了。
      // 用最高纠错级别 H：屏幕上有点反光、摄像头稍微糊一点也还能扫出来。
      correctLevel: global.QRCode.CorrectLevel.H
    });
  }

  function showQr() {
    // 顺序很重要：先揭开遮罩再去找地址、画二维码。
    // 反过来（先画再揭开）会撞上上面注释里那个 display:none 的坑。
    el.qrMask.hidden = false;
    el.qrUrl.textContent = '正在获取局域网地址…';
    qrTip('正在获取局域网地址…');

    MW.sync.info().then(function (data) {
      if (!data || !data.lan) {
        el.qrUrl.textContent = '';
        qrTip('没有连上本机服务。请先双击运行 serve.cmd，再回来点一次「手机预览」。');
        return;
      }
      drawQr(data.lan);
    });
  }

  function copyUrl() {
    const url = el.qrUrl.textContent || '';
    if (!url || url.indexOf('http') !== 0) return;
    if (!global.navigator.clipboard) {
      MW.util.toast('这个浏览器不支持自动复制，地址已经显示在框里，点一下即可全选。', 'warn');
      return;
    }
    global.navigator.clipboard.writeText(url).then(function () {
      MW.util.toast('地址已复制');
    }, function (err) {
      MW.util.toast('复制失败：' + err.message + '。地址已经显示在框里，点一下即可全选。', 'warn');
    });
  }

  /* ==================== 绑定与引导 ==================== */

  function cacheElements() {
    el.split = $('split');
    el.splitter = $('splitter');
    el.deviceDesktop = $('deviceDesktop');
    el.devicePhone = $('devicePhone');
    el.deviceSeg = $('deviceSeg');
    el.phone = $('devicePhone');
    el.phoneName = $('phoneName');
    el.phoneWidth = $('phoneWidth');
    el.desktopScroll = $('desktopScroll');
    el.desktopFit = $('desktopFit');
    el.desktopScaler = $('desktopScaler');
    el.desktopPaper = $('desktopPaper');
    el.desktopArticle = $('desktopArticle');
    el.phoneScroll = $('phoneScroll');
    el.phonePaper = $('phonePaper');
    el.phoneArticle = $('phoneArticle');
    el.outlineRail = $('outlineRail');
    el.outlineList = $('outlineList');
    el.btnOutlineFold = $('btnOutlineFold');
    el.btnDark = $('btnDark');
    el.btnPhone = $('btnPhone');
    el.qrMask = $('qrMask');
    el.qrBox = $('qrBox');
    el.qrUrl = $('qrUrl');
    el.btnQrClose = $('btnQrClose');
    el.btnQrCopy = $('btnQrCopy');
  }

  function init() {
    cacheElements();
    setDevice(0);
    setOutlineOpen(readOutlineOpen());
    // 初始 50/50 由 CSS 的 .device-desktop { flex-basis: 50% } 给出，
    // 这里只在拖动时才写 inline，避免两处默认值互相打架。
    el.deviceDesktop.style.flexBasis = splitPercent + '%';

    bindSplitter();

    el.deviceSeg.addEventListener('click', function (event) {
      const btn = event.target.closest ? event.target.closest('.seg-btn') : null;
      if (btn) setDevice(btn.getAttribute('data-device'));
    });

    el.outlineList.addEventListener('click', function (event) {
      const btn = event.target.closest ? event.target.closest('.outline-item') : null;
      if (btn) jumpTo(btn.getAttribute('data-node'));
    });

    el.btnOutlineFold.addEventListener('click', function () {
      setOutlineOpen(el.outlineRail.classList.contains('is-folded'));
    });

    el.btnDark.addEventListener('click', function () {
      const on = !el.split.classList.contains('is-dark');
      el.split.classList.toggle('is-dark', on);
      el.btnDark.classList.toggle('is-on', on);
      el.btnDark.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    el.btnPhone.addEventListener('click', showQr);
    el.btnQrClose.addEventListener('click', closeQr);
    el.btnQrCopy.addEventListener('click', copyUrl);
    el.qrMask.addEventListener('click', function (event) {
      // 点遮罩空白处关闭，但点卡片内部不关
      if (event.target === el.qrMask) closeQr();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !el.qrMask.hidden) closeQr();
    });

    // 窗口尺寸变化会改变栏目宽度 → 缩放系数和高度补偿都要重算。
    // 用 ResizeObserver 盯滚动容器本身，比监听 window.resize 更准：
    // 分隔条拖动、面板折叠这些不触发 window.resize 的变化也能覆盖到。
    if (global.ResizeObserver) {
      new global.ResizeObserver(scheduleFit).observe(el.desktopScroll);
    } else {
      global.addEventListener('resize', scheduleFit);
    }
  }

  /** 预览 tab 从隐藏切回来时用：display:none 期间量不到宽度，缩放得补算一次。 */
  function refresh() {
    fitDesktop();
  }

  function resetScroll() {
    el.desktopScroll.scrollTop = 0;
    el.phoneScroll.scrollTop = 0;
  }

  MW.view = {
    PHASE: PHASE,
    DESKTOP_WIDTH: DESKTOP_WIDTH,
    DEVICES: DEVICES,
    init: init,
    paint: paint,
    refresh: refresh,
    resetScroll: resetScroll
  };
})(window);
