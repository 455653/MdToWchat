/*
 * sanitize.js —— 归一器
 *
 * 职责（P2 起）：
 *   按 whitelist 把固化后的 DOM 归一，让它只含「微信一定留得住」的东西：
 *   - 标签不在 TAGS 里的走 DEGRADE 映射；映射不到就拆掉标签保留文字；
 *   - 标签在 DROP_TAGS 里的整块删除（连内容一起丢），并记进返回的 dropped；
 *   - 属性只留 ATTRS（style / src / alt / colspan / rowspan），其余全删——
 *     onclick、class、id、href 都在这一步消失；
 *   - 清掉空段落，微信会把空 <p> 压成 0 高度；
 *   - 最外层补一个 <section>，写入主题的字体 / 字号 / 行高 / 字色。
 *     整篇文章离开本工具后会被微信重新套一层外壳，地基建在这一层才不依赖继承。
 *
 * 为什么归一排在固化之后（顺序在 pipeline 里定死）：
 *   固化读的是「元素在 375px 舞台上的计算样式」，它要求 DOM 保持渲染时的原样——
 *   尤其要保留 <a>/<pre>/<code> 这些「有语义才有样式」的标签，
 *   否则归一先改结构，固化器就得为两套结构分别写样式。
 *   先把样式算完写死，再换标签，被换掉元素的 style 会原样跟着走（renameElement）。
 *
 * 为什么白名单必须收口在解析器之外：
 *   markdown-it 的产物形态由插件与版本决定（脚注插件产出 <section> 与 <hr>、
 *   任务列表插件产出 <input>、代码块带 language-* class）。
 *   把「产物里允许出现什么」写在解析器外面，这份约束才不会随某个插件的升级而失效。
 *
 * 为什么本文件必须排在 pipeline 所有降级步骤之后：
 *   脚注、任务列表、外链三步都要靠 class 认元素（ol.footnotes-list、
 *   input[type=checkbox]、a），归一一旦提前，它们就失去了钩子。
 *   到这里 class 的使命结束，一次性抹干净。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  const PHASE = 2;

  /**
   * 唯一被允许绕开 ATTRS 的属性前缀。
   * data-mw-id 是标题的定位符（P3 侧栏跳转、P6 登记问题时选位置都要读它），
   * data-mw-root 是预览区那套 --mw-* 地基的挂钩。
   * 它们不参与排版，被公众号剥掉也无所谓，但产物在离开本工具之前必须还能被读回来——
   * 所以这一层要放它们过去，而不是靠「反正 A2 只管 class」的侥幸。
   */
  const KEEP_PREFIX = 'data-mw-';

  /** 固化器没加载时的兜底字体栈；正常路径下与 inline-styles 用同一份。 */
  const FALLBACK_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", '
    + '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif';

  /**
   * 最外层 section 的地基：[CSS 属性, 变量名, 兜底值]。
   * 值刻意从 :root 上的变量现读，而不是从参数面板的对象读——
   * 面板只是变量的写入口，读变量这一条路径在「变量被人手改过」时也不会失真。
   */
  const FOUNDATION = [
    ['font-size', '--mw-font-size', '16px'],
    ['line-height', '--mw-line-height', '1.75'],
    ['color', '--mw-color', '#3f3f3f']
  ];

  function keepAttr(name) {
    if (name.indexOf(KEEP_PREFIX) === 0) return true;
    return MW.whitelist.isAllowedAttr(name);
  }

  /**
   * 属性过滤。
   * class 与 id 没有单独的分支，它们本来就不在 ATTRS 里，会被同一段代码清掉。
   * 刻意不写 `if (name === 'class' || name === 'id') remove`：
   * 那会变成第二个判定入口，以后改 ATTRS 时就会漏掉这里。
   */
  function cleanAttributes(el) {
    const attrs = el.attributes;
    for (let i = attrs.length - 1; i >= 0; i--) {
      const name = attrs[i].name;
      if (!keepAttr(name)) el.removeAttribute(name);
    }
  }

  /** 往元素已有的 style 后面追加一条声明（不覆盖已有声明）。 */
  function appendDecl(el, name, value) {
    const cur = String(el.getAttribute('style') || '');
    const sep = cur && cur.charAt(cur.length - 1) !== ';' ? ';' : '';
    el.setAttribute('style', cur + sep + name + ':' + value + ';');
  }

  /**
   * 换标签：属性与子节点原样搬过去，只改元素本身。
   * 属性原样搬走是关键——固化好的 style 正是在这一步跟着走的。
   * 为什么不用 innerHTML 重建：那等于把子树交给解析器再跑一遍，
   * 已经写好的内联 style 里的引号、代码块里的尖括号都可能被二次转义。
   */
  function renameElement(el, tagName) {
    const next = document.createElement(tagName);
    const attrs = el.attributes;
    for (let i = 0; i < attrs.length; i++) {
      next.setAttribute(attrs[i].name, attrs[i].value);
    }
    while (el.firstChild) next.appendChild(el.firstChild);
    if (el.parentNode) el.parentNode.replaceChild(next, el);
    return next;
  }

  /**
   * 拆标签保文字：把子节点提到父节点上，再删掉自己。
   * 为什么映射不到就拆而不是硬塞成 span：
   * 塞成 span 会凭空造出一层行内层级，把块级结构压平成一段文字；
   * 而「拆掉」最坏的结果只是少一层无意义的包裹，文字一个都不会丢。
   */
  function unwrapElement(el) {
    const parent = el.parentNode;
    // 没有父节点说明传进来的就是根（例如有人把 <svg> 当 root 交给本函数）。
    // 这种情况无处可拆，保持原样：拆不动比拆坏强。
    if (!parent) return null;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    return null;
  }

  /**
   * 整块删除。删掉的东西必须留下痕迹：
   * 「产物里少了半段图表的说明」和「图表本来就没写说明」在页面上长得一样，
   * 不把 dropped 交出去，用户永远分不清是自己没写，还是被工具吃掉了。
   */
  function dropSubtree(el, dropped) {
    dropped.push({
      tag: el.tagName.toLowerCase(),
      preview: String(el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 120)
    });
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  /** 单节点归一入口，被 run 逐个调用。返回存活下来的元素（被删/被拆时为 null）。 */
  function runNode(node, dropped) {
    // 只处理元素节点：文本节点天然安全，注释节点由调用方负责清理
    if (!node || node.nodeType !== 1) return node;

    const wl = MW.whitelist;
    const tag = node.tagName.toLowerCase();

    // 不可降级的先删，避免它躲过下面的白名单判断
    if (wl.isDropTag(tag)) {
      dropSubtree(node, dropped);
      return null;
    }

    /*
     * <font> 是唯一的特例：它的外观写在 color / face / size 属性上，不在 style 里。
     * 直接拆掉会把颜色一起丢掉，所以要先把 color 翻成 style 再换成 span。
     * 必须在 cleanAttributes 之前读 color——读晚了属性已经被删了。
     * face / size 不翻译：字体栈由固化器统一收敛，字号由主题决定，
     * 把一个已废弃标签的这两个属性当权威反而会和主题打架。
     */
    if (tag === 'font') {
      const color = node.getAttribute('color');
      cleanAttributes(node);
      if (color) appendDecl(node, 'color', color);
      return renameElement(node, 'span');
    }

    cleanAttributes(node);

    if (wl.isAllowedTag(tag)) return node;

    const mapped = wl.DEGRADE[tag];
    if (mapped) return renameElement(node, mapped);
    return unwrapElement(node);
  }

  /**
   * 空段落判定。
   * 为什么「空」不能只看 textContent：<p><img></p> 的文字也是空的，
   * 但它有可见内容，删掉就等于丢图。
   */
  function isBlankParagraph(p) {
    if (p.querySelector('img')) return false;
    return p.textContent.replace(/\s+/g, '').length === 0;
  }

  function removeBlankParagraphs(root) {
    // querySelectorAll 返回静态列表，删节点不会让遍历错位
    const list = root.querySelectorAll('p');
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (p.parentNode && isBlankParagraph(p)) p.parentNode.removeChild(p);
    }
  }

  /* ==================== 地基 ==================== */

  function themeVar(name, fallback) {
    const value = global.getComputedStyle(document.documentElement).getPropertyValue(name);
    return String(value == null ? '' : value).trim() || fallback;
  }

  /**
   * 给最外层 section 写地基。
   * 字号 / 行高 / 字色必须写字面值，不能写 var(--mw-*)——
   * 变量在微信编辑器里不存在，写进去等于没写（验收⑥也是按字面值查的）。
   */
  function applyFoundation(section) {
    const stack = (MW.inlineStyles && MW.inlineStyles.FONT_STACK) || FALLBACK_FONT_STACK;
    let text = 'font-family:' + stack + ';';
    for (let i = 0; i < FOUNDATION.length; i++) {
      text += FOUNDATION[i][0] + ':' + themeVar(FOUNDATION[i][1], FOUNDATION[i][2]) + ';';
    }
    section.setAttribute('style', text);
  }

  /* ==================== 入口 ==================== */

  /**
   * 归一入口。返回 { root, dropped }：
   *   root    —— 新的最外层 section（地基所在层），内容全在它下面；
   *   dropped —— [{ tag, preview }]，被整块删掉的标签清单。
   *
   * 为什么返回值不是「传进来的那个 root」：
   *   最外层要包一层地基，既然结构变了，就不能再返回旧节点的引用骗调用方。
   *   传进来的 root 会被掏空（子节点移进新 section），调用方拿到返回值后
   *   应该把新 section 挂回自己原来的容器。
   */
  function run(root, options) {
    const dropped = [];
    if (!root) return { root: root, dropped: dropped };

    // 先快照再处理。遍历过程中会改树（换标签、拆标签、删子树），
    // 快照保证每个元素恰好被处理一次，也不会出现「正在遍历的节点已被移走」。
    const elements = Array.prototype.slice.call(root.querySelectorAll('*'));
    for (let i = elements.length - 1; i >= 0; i--) runNode(elements[i], dropped);

    // 空段落放在最后扫：前面拆掉标签之后，原本不空的段落才可能真正变空
    // （例如 <p><某未知标签></某未知标签></p>）。
    removeBlankParagraphs(root);

    const outer = document.createElement('section');
    applyFoundation(outer);
    while (root.firstChild) outer.appendChild(root.firstChild);

    return { root: outer, dropped: dropped };
  }

  MW.sanitize = {
    PHASE: PHASE,
    run: run,
    runNode: runNode
  };
})(window);
