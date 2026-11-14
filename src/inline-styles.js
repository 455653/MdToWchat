/*
 * inline-styles.js —— 固化器
 *
 * 职责（P2 实现）：
 *   把「浏览器算好的样式」写死进每个元素的 style 属性。
 *   微信粘贴时只留元素自身 style，所以任何靠 class、<style> 的样式都会失效——
 *   样式必须在渲染阶段就固化成内联声明，这就是本文件存在的唯一理由。
 *
 * 两条不可动摇的前提（写错任何一条，产物要么样式全丢、要么整页错版）：
 *   1. 舞台绝不能 display:none —— 那样 getComputedStyle 拿不到布局值，
 *      所有尺寸类属性都会算成 0，产物看起来就像「样式全丢」。
 *      正确的隐藏姿势是「移出屏幕 + visibility:hidden」：照常参与布局，只是看不见。
 *   2. 舞台宽度必须固定成 375px —— 用桌面宽度算，百分比、折行、图片尺寸全错，
 *      固化出来的会是「桌面版样式」，粘到手机上是另一回事。
 *
 * 允许写入的属性由 whitelist.INLINE_PROPS 限定（正面清单，防越权）。
 * 固化器最容易犯的三个错（写 class、写 display:flex、写 width:900px）
 * 分别撞 A2 / A4 / A6，都在断言里钉住。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  const PHASE = 2;

  /** 舞台宽度：375px 是手机逻辑宽度，也是公众号正文在手机上的可用宽度上界。 */
  const STAGE_WIDTH = 375;
  /** 舞台左右内边距：手机上正文两侧本来就留白，固化时必须把这段留白算进去。 */
  const STAGE_PAD = 16;

  /**
   * 字体族统一成两套微信安全栈。
   * 为什么不照抄 getComputedStyle 返回的原值：
   * 原值里带着 -apple-system / "Segoe UI" 这类「本机可能没有」的字体名，
   * 固化进产物后，读者设备上的回退链与本机完全不同，看起来就是「字体变了」。
   * 这里收敛成「苹果能命中苹方、安卓能命中系统黑体」的最小集合。
   */
  const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", '
    + '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif';
  const MONO_STACK = 'Consolas, Menlo, "Courier New", "Microsoft YaHei", monospace';

  /**
   * 会继承的属性：与父级算出来的值相同就不写。
   * 为什么可以跳过：继承是浏览器与微信编辑器都保证的行为，
   * 父级写一次，子级拿到的就是同一个值，没必要每个子级重复一遍。
   * color / font-size / line-height 刻意不在此列，见 gather() 的注释。
   */
  const INHERITED_PROPS = [
    'font-weight', 'font-style', 'text-align', 'text-indent', 'letter-spacing',
    'white-space', 'word-break', 'overflow-wrap'
  ];

  const SIDES = ['top', 'right', 'bottom', 'left'];
  const RADII = [
    'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-right-radius', 'border-bottom-left-radius'
  ];

  /* ==================== 舞台 ==================== */

  let stage = null;

  /**
   * 舞台是一个「宽 375px、移出屏幕、对用户不可见但照常布局」的容器。
   * 复用同一个节点而不是每次新建：新建会在 body 上反复挂载/卸载，
   * 每次都触发一轮完整重排，长文档下能明显感觉到卡顿。
   */
  function ensureStage() {
    if (stage && stage.parentNode) return stage;

    stage = document.createElement('div');
    // 关键：挂上 .article 这个类。预览区那套 --mw-* 规则就是文章外观的「地基」，
    // 舞台与预览共用同一份地基，固化出来的样式才等于预览看到的样式；
    // 若给舞台另写一套样式，就等于「预览看一套、产物另一套」。
    stage.className = 'article';
    stage.setAttribute('data-mw-stage', '');

    const s = stage.style;
    s.position = 'fixed';
    s.top = '0';
    s.left = '-10000px';
    s.width = STAGE_WIDTH + 'px';
    s.paddingLeft = STAGE_PAD + 'px';
    s.paddingRight = STAGE_PAD + 'px';
    s.boxSizing = 'border-box';
    // 隐藏用 visibility 而不是 display：前者不参与绘制但保留布局，后者连布局都没了
    s.visibility = 'hidden';

    document.body.appendChild(stage);
    return stage;
  }

  /* ==================== 值归一 ==================== */

  function hex2(n) {
    const v = Math.max(0, Math.min(255, Math.round(n)));
    return (v < 16 ? '0' : '') + v.toString(16);
  }

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  /**
   * 颜色归一：rgb()/rgba() → #rrggbb；alpha < 1 时保留 rgba()。
   * 为什么转：hex 更短、没有空格格式差异，也不会被误当成某个编辑器的内部语法。
   * 非 rgb 写法（transparent、关键字）原样返回，不猜。
   */
  function toColor(value) {
    const text = String(value == null ? '' : value).trim();
    const m = /^rgba?\(([^)]+)\)$/i.exec(text);
    if (!m) return text;
    const parts = m[1].split(',').map(function (s) { return s.trim(); });
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    const a = parts.length > 3 ? Number(parts[3]) : 1;
    if (!(a < 1)) return '#' + hex2(r) + hex2(g) + hex2(b);
    return 'rgba(' + Math.round(r) + ', ' + Math.round(g) + ', ' + Math.round(b) + ', ' + round3(a) + ')';
  }

  /**
   * 长度归一：小数 px 四舍五入成整数，0 一律写成 0。
   * 解析不出数值（如 letter-spacing 的 normal）时返回空串，调用方据此跳过——
   * 「跳过」和「写 0」是两回事：0 是明确声明，空串是「这一项不适用」。
   */
  function toPx(value) {
    const text = String(value == null ? '' : value).trim();
    const n = parseFloat(text);
    if (!isFinite(n)) return '';
    if (n === 0) return '0';
    return Math.round(n) + 'px';
  }

  /** 行高：normal 原样保留，其余量成整数 px（getComputedStyle 返回的已是 px）。 */
  function toLineHeight(value) {
    const text = String(value == null ? '' : value).trim();
    if (text === 'normal') return 'normal';
    const n = parseFloat(text);
    if (!isFinite(n)) return 'normal';
    return n === 0 ? '0' : Math.round(n) + 'px';
  }

  /** 圆角：0 不写，其余原样（保留 50% 这类百分比写法）。 */
  function toRadius(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text || text === '0px' || text === '0' || text === '0%') return '';
    return text;
  }

  function stackOf(fontFamily) {
    return /monospace/i.test(String(fontFamily || '')) ? MONO_STACK : FONT_STACK;
  }

  /**
   * 继承型属性的「该不该写」判定。
   * 返回空串表示「与默认值等价，不写也不会看错」，从而避免每个元素都背一串
   * font-weight:400;font-style:normal;white-space:normal 这种纯噪音。
   */
  function propValue(prop, raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (prop === 'font-weight') return (text === '400' || text === 'normal') ? '' : text;
    if (prop === 'font-style') return text === 'normal' ? '' : text;
    if (prop === 'text-align') return (text === 'left' || text === 'start') ? '' : text;
    if (prop === 'text-indent' || prop === 'letter-spacing') {
      const v = toPx(text);
      return (v && v !== '0') ? v : '';
    }
    return text === 'normal' ? '' : text;
  }

  /* ==================== 采集 ==================== */

  /**
   * 遍历整棵子树，先「全部读」再「全部写」。
   *
   * 为什么必须分两趟：写内联 style 会改变后代的计算样式（继承属性尤其明显），
   * 边读边写就会出现「后面的元素拿到的值被前面的写入污染」。
   * 两趟法让所有读数都发生在 DOM 没被改动的时刻。
   */
  function gather(el, parentFull, writes, isRoot) {
    const cs = global.getComputedStyle(el);
    const tag = el.tagName.toLowerCase();

    // 父级记录：用于判断「继承型属性是否与父级相同」，相同就不写
    const full = { __family: stackOf(cs.fontFamily) };
    for (let i = 0; i < INHERITED_PROPS.length; i++) {
      const prop = INHERITED_PROPS[i];
      full[prop] = propValue(prop, cs.getPropertyValue(prop));
    }

    const out = {};

    /*
     * 地基三件套：color / font-size / line-height 无条件写死。
     * 这里刻意不做「与父级相同就跳过」的优化，两条理由：
     *   1. A5 断言要求每个块级元素自带内联 font-size，验收⑥也要求在段落 style
     *      里直接读到 color/font-size/line-height 的字面值；
     *   2. 产物离开本工具后会被微信重新套一层外壳，把地基寄希望于「继承」
     *      在实战里不可靠——「看起来一样」优先于「体积很小」。
     */
    out['color'] = toColor(cs.color);
    const fontSize = toPx(cs.fontSize);
    out['font-size'] = fontSize || String(cs.fontSize).trim();
    out['line-height'] = toLineHeight(cs.lineHeight);

    // 字体族：只在变化时写（每 个 span 都背半行字体栈太臃肿），根节点必写
    if (isRoot || !parentFull || parentFull.__family !== full.__family) {
      out['font-family'] = full.__family;
    }

    // 背景色不继承：透明一律不写，写了会把父级背景整个盖住
    const bg = toColor(cs.backgroundColor);
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') out['background-color'] = bg;

    // 其余继承型属性：与父级相同就交给继承
    for (let i = 0; i < INHERITED_PROPS.length; i++) {
      const prop = INHERITED_PROPS[i];
      if (full[prop] === '') continue;
      if (parentFull && parentFull[prop] === full[prop]) continue;
      out[prop] = full[prop];
    }

    /*
     * 间距与边框。
     * 块级元素的四向 margin 一律写死（哪怕是 0）：微信会给 p / h1..h6 / blockquote
     * 套上它自己的默认外边距，不显式归零就会凭空多出间距。
     * 这是「看起来一样优先于体积」最典型的一处取舍——0 也要写出来。
     */
    const isBlockBox = MW.whitelist.isBlockTag(tag)
      || tag === 'table' || tag === 'thead' || tag === 'tbody' || tag === 'tr' || tag === 'figure';

    for (let i = 0; i < SIDES.length; i++) {
      const side = SIDES[i];

      const margin = toPx(cs.getPropertyValue('margin-' + side));
      if (isBlockBox) out['margin-' + side] = margin || '0';
      else if (margin && margin !== '0') out['margin-' + side] = margin;

      const padding = toPx(cs.getPropertyValue('padding-' + side));
      if (padding && padding !== '0') out['padding-' + side] = padding;

      const bw = toPx(cs.getPropertyValue('border-' + side + '-width'));
      if (bw && bw !== '0') {
        out['border-' + side + '-width'] = bw;
        out['border-' + side + '-style'] = cs.getPropertyValue('border-' + side + '-style');
        out['border-' + side + '-color'] = toColor(cs.getPropertyValue('border-' + side + '-color'));
      }
    }

    for (let i = 0; i < RADII.length; i++) {
      const radius = toRadius(cs.getPropertyValue(RADII[i]));
      if (radius) out[RADII[i]] = radius;
    }

    const collapse = cs.getPropertyValue('border-collapse');
    if (collapse && collapse !== 'separate') out['border-collapse'] = collapse;

    const deco = cs.getPropertyValue('text-decoration-line');
    if (deco && deco !== 'none') out['text-decoration-line'] = deco;

    const align = cs.getPropertyValue('vertical-align');
    if (align && align !== 'baseline') out['vertical-align'] = align;

    // 列表已被 pipeline 改写成 section + 手写序号，这里只兜底残余的 list-style-type
    const listStyle = cs.getPropertyValue('list-style-type');
    if (listStyle && listStyle !== 'disc' && listStyle !== 'none') out['list-style-type'] = listStyle;

    if (tag === 'img') {
      // 图片一律「最大宽度撑满容器」：写死 px 宽在窄屏必然溢出（A6）。
      // width / height 属性会把比例与尺寸写死，一并摘掉，交给 max-width 自适应。
      out['max-width'] = '100%';
      el.removeAttribute('width');
      el.removeAttribute('height');
    }

    writes.push({ el: el, decl: gate(out) });

    const kids = el.children;
    for (let i = 0; i < kids.length; i++) gather(kids[i], full, writes, false);
  }

  /**
   * 越权闸门：只放行 whitelist.INLINE_PROPS 里的属性。
   * 这道闸是「防自己」的——以后往 gather 里加属性时，
   * 若忘了把它登记进白名单，它会被静默丢掉，而不是悄悄混进产物。
   */
  function gate(decl) {
    const out = {};
    Object.keys(decl).forEach(function (name) {
      if (MW.whitelist.isInlineProp(name)) out[name] = decl[name];
    });
    return out;
  }

  /* ==================== 写入 ==================== */

  /** 把 "a:1;b:2" 拆成对象。产物内的 style 不含 data: URI，按 ';' 拆是安全的。 */
  function parseStyle(text) {
    const map = {};
    String(text || '').split(';').forEach(function (chunk) {
      const idx = chunk.indexOf(':');
      if (idx < 0) return;
      const name = chunk.slice(0, idx).trim().toLowerCase();
      const value = chunk.slice(idx + 1).trim();
      if (name && value) map[name] = value;
    });
    return map;
  }

  function serializeStyle(map) {
    return Object.keys(map).map(function (name) {
      return name + ':' + map[name];
    }).join(';');
  }

  /**
   * 写入一个元素的固化结果。
   * 与已有 style 合并而不是覆盖：布局降级写过的 width:100%/max-width、
   * 代码高亮的颜色都已经在 style 里，覆盖掉它们等于把前面几步的成果清空。
   * 冻结值优先级最高——它是浏览器真正算出来的值，比任何手写声明都权威。
   * 同时删掉 class 与 id：它们一定会被微信剥掉，留着只会让人误以为样式生效。
   */
  function writeStyle(el, decl) {
    const map = parseStyle(el.getAttribute('style'));
    Object.keys(decl).forEach(function (name) { map[name] = decl[name]; });
    const text = serializeStyle(map);
    if (text) el.setAttribute('style', text);
    el.removeAttribute('class');
    el.removeAttribute('id');
  }

  /* ==================== 入口 ==================== */

  /**
   * 分块阈值：节点数超过它才分块。
   * 为什么要有下限：分块本身要付出「多次事件循环往返」的代价，
   * 一篇普通文章（几百个节点）同步写完只要几毫秒，分块只会让它变慢，
   * 还平白多出几次进度条刷新。
   */
  const CHUNK_THRESHOLD = 2000;
  /** 每块写多少个元素。取得比较小是为了让长文档在写入期间仍能响应输入。 */
  const CHUNK_SIZE = 800;

  /**
   * 分块写入。
   *
   * 为什么只分「写」不分「读」：
   *   采集（gather）是一次性的读操作——它不改 DOM，所以浏览器算一次布局就够了，
   *   之后每个元素的计算样式都是现成的；而写入会改 style 属性，
   *   虽然浏览器也会批量延迟重算，但在两趟之间让出主线程，
   *   至少能保证输入框和滑块在长文档上不被一次长任务憋住。
   *
   * 为什么写入可以在舞台外做：writeStyle 只做「合并 style 属性 + 删 class/id」，
   *   它不读任何计算样式。所以先挂舞台采集、摘下来再写，结果与挂着写完全一致，
   *   而且避免了「两次渲染同时在舞台上写」这类并发风险。
   */
  function writeInChunks(writes, onProgress) {
    const total = writes.length;

    return new Promise(function (resolve) {
      let i = 0;

      function step() {
        const end = Math.min(i + CHUNK_SIZE, total);
        for (; i < end; i++) writeStyle(writes[i].el, writes[i].decl);

        onProgress({ done: i, total: total, label: '正在固化样式' });

        if (i >= total) { resolve(); return; }
        MW.util.nextIdle(step);
      }

      step();
    });
  }

  /**
   * 固化入口：把 root 挂到 375px 舞台上算样式，写完 style 后摘下来返回 Promise<root>。
   *
   * 为什么是异步的（P7 起）：
   *   超过 CHUNK_THRESHOLD 个节点的文档，写入阶段会分块并让出主线程，
   *   同时通过 options.onProgress 报出百分比——120KB 的文档不再让页面毫无反馈地僵住。
   *   阈值以下仍然同步写完，所以短文档的行为和 P2 完全一样，没有任何额外延迟。
   *
   * options.onProgress(info) 的 info 形如 { done, total, label }，
   * 与 media.js 的进度回报同形，app.js 那一个进度条可以同时接这两种来源。
   */
  function apply(root, options) {
    const opts = options || {};
    if (!root) return Promise.resolve(root);

    const host = ensureStage();
    host.appendChild(root);

    const writes = [];
    try {
      gather(root, null, writes, true);
    } finally {
      // finally 只做清理，不吞异常：真出错了要让它冒到页面错误块上
      if (root.parentNode === host) host.removeChild(root);
    }

    const total = writes.length;

    // 没有进度回调，或文档不够长：一次写完。短文档上它比任何分块方案都快。
    if (typeof opts.onProgress !== 'function' || total <= CHUNK_THRESHOLD) {
      for (let i = 0; i < total; i++) writeStyle(writes[i].el, writes[i].decl);
      return Promise.resolve(root);
    }

    return writeInChunks(writes, opts.onProgress).then(function () { return root; });
  }

  MW.inlineStyles = {
    PHASE: PHASE,
    STAGE_WIDTH: STAGE_WIDTH,
    FONT_STACK: FONT_STACK,
    MONO_STACK: MONO_STACK,
    apply: apply,
    /** 舞台节点（供测试与调试查看）；首次调用会创建它。 */
    stage: ensureStage
  };
})(window);
