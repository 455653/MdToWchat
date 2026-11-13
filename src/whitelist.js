/*
 * whitelist.js —— 白名单与降级映射
 *
 * 为什么需要这个文件：
 * 微信编辑器粘贴时会剥掉 class/id/style 标签，并丢弃一部分标签与属性。
 * 与其「先生成再被它删」，不如从生成端就只产出它肯留的东西——
 * 这份白名单就是「生成端的法律」，而不是「清洗端的补丁」。
 *
 * 白名单分六层，各层含义不同，不要混用：
 *   TAGS          —— 允许出现在产物里的标签（其余由 sanitize 降级或丢弃）
 *   ATTRS         —— 允许保留在产物里的属性
 *   FROZEN_ATTRS  —— 固化器（inline-styles.js）被允许写入的属性
 *   DEGRADE       —— 不被支持的语义标签 → 等价白名单标签的映射
 *   DROP_TAGS     —— 不可降级、必须整块删除的标签（连内容一起丢）
 *   INLINE_PROPS  —— 固化器允许写进 style 的 CSS 属性（防越权闸门）
 *
 * P1 起 sanitize.js 用它清洗；P2 起 inline-styles.js 用它决定「固化哪些属性」。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  /**
   * 微信图文编辑器能稳定保留的标签。
   *
   * P2 把这份清单收得更紧了：只留「视觉靠内联样式就能完全表达」的标签。
   * 被移出的标签全部走 DEGRADE：
   *   a → span（外链在公众号里必成死链，链接信息由 pipeline 用灰色域名补）
   *   code / pre → span / section（代码块的配色靠内联 style，标签本身不需要）
   *   del → s、div → section、ul/ol/li → section 序列（见 pipeline 的列表降级）
   * 收口之后，产物里不会再出现任何一个「样式依赖 class 才能成立」的标签。
   */
  const TAGS = [
    // 块级
    'section', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'figure', 'figcaption',
    // 行内
    'span', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'br', 'img'
  ];

  /**
   * 需要单独处理换行/间距的「文字块」。
   * A5 断言就是按这个集合逐个检查内联 font-size：
   * 集合里只放真正承载文字、会被微信默认字号接管的标签。
   * figure / table / tr 这类纯容器不放进来——它们没有文字，
   * 字号写在它们身上既无意义，也会让 A5 的报错失去指向性。
   */
  const BLOCK_TAGS = [
    'section', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'td', 'th', 'figcaption', 'hr'
  ];

  /** 自闭合标签：序列化时不能产出 </br>，也不能塞子节点。 */
  const VOID_TAGS = ['br', 'img', 'hr'];

  /**
   * 允许保留的属性。
   * style 是唯一承载视觉的属性——因为 class 必被剥掉，样式只能靠它。
   * 刻意不含 title / align / width / height：
   *   width/height 会把元素宽度写死（A6 的红线），必须在固化阶段换成 max-width:100%；
   *   href 只是降级过程中的「读数」，被读完就必须消失，不能留在产物里。
   */
  const ATTRS = ['style', 'src', 'alt', 'colspan', 'rowspan'];

  /**
   * 固化属性白名单：固化器只许写这些。
   * 这是一道「防越权」的闸——固化器最容易犯的错是顺手写上 class、
   * display:flex、width:900px，这三个分别违反 A2 / A4 / A6，所以属性层先卡住。
   */
  const FROZEN_ATTRS = ['style', 'src', 'alt', 'colspan', 'rowspan'];

  /**
   * 降级映射：语义正确但编辑器不留的标签 → 白名单内的等价标签。
   * 保留语义没有意义（编辑器不认），保留结构和视觉才是目的。
   * 映射结果必须落在 TAGS 内，否则归一器拆掉它时会把块级结构压平。
   */
  const DEGRADE = {
    article: 'section', aside: 'section', header: 'section', footer: 'section',
    main: 'section', nav: 'section', div: 'section',
    dl: 'section', dt: 'p', dd: 'p',
    mark: 'span', small: 'span',
    // code 已不在 TAGS 内，kbd/samp/var 只能退到 span（配色由固化器接管）
    kbd: 'span', samp: 'span', var: 'span',
    code: 'span',
    // pre 承载的是「代码块」这个块级语义，退到 section 而不是 span
    pre: 'section',
    a: 'span', del: 's',
    // 列表本体会被 pipeline 的列表降级改写成 section 序列；
    // 这里保留兜底映射，避免漏网的 ul/ol/li 被拆成散落文字。
    ul: 'section', ol: 'section', li: 'p',
    caption: 'p', tfoot: 'tbody',
    // 微信里 h1 视觉过重（正文首屏会被顶掉），统一降一级，视觉由内联样式补
    h1: 'h2'
  };

  /** 内容属于「原文」的标签：这些标签内部不做任何解析。 */
  const RAW_TEXT_TAGS = ['pre', 'code'];

  /**
   * 不可降级、必须整块删除的标签。
   *
   * 为什么这几类不适用「拆掉标签保文字」：它们要么靠脚本/插件/表单才能工作，
   * 要么承载的是「外部内容」而不是正文。拆掉标签留下的那点文字不是正文，
   * 留在产物里只会变成一段看起来像正文的垃圾——比删掉更难查。
   * 所以这里是「整块删」，并且删掉的东西要记进 sanitize 的 dropped 返回值，
   * 让用户知道「有内容没了」，而不是悄悄消失。
   *
   * link 也在这个表里：A3 明确要求产物内不得出现 <style> / <link>。
   */
  const DROP_TAGS = [
    'script', 'style', 'link', 'meta', 'base', 'noscript',
    'iframe', 'object', 'embed', 'video', 'audio', 'canvas', 'svg',
    'form', 'input', 'select', 'textarea', 'button'
  ];

  /**
   * 固化器允许写进元素 style 的 CSS 属性白名单。
   * 这是一份「正面清单」：不在里面的属性一律不写，即使浏览器算出了值。
   *
   * 刻意排除（写进去就是踩坑，不是遗漏）：
   *   width / height     —— 一律转成 max-width:100%，写死必然违反 A6
   *   overflow / display —— 会被微信过滤；布局改用 margin/padding 摆位
   *   position / float   —— 会被过滤，且会让后续元素脱离文档流
   *   transform / transition / animation —— 编辑器不执行，粘过去反而姿势错乱
   *   box-shadow         —— 微信会丢掉阴影，留着只会让人以为样式生效了
   */
  const INLINE_PROPS = [
    // 图片宽度：只允许 max-width:100%，允许 width 就会有人写死 900px（撞 A6）
    'max-width',
    // 文字
    'color', 'background-color',
    'font-size', 'font-weight', 'font-family', 'font-style', 'line-height',
    'letter-spacing', 'text-align', 'text-indent', 'text-decoration-line',
    'vertical-align', 'white-space', 'word-break', 'overflow-wrap',
    'list-style-type',
    // 间距
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    // 边框（只在宽度非 0 时才写 style/color，见 inline-styles.js）
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-right-radius', 'border-bottom-left-radius',
    'border-collapse'
  ];

  function isAllowedTag(name) {
    return TAGS.indexOf(String(name || '').toLowerCase()) >= 0;
  }

  function isAllowedAttr(name) {
    return ATTRS.indexOf(String(name || '').toLowerCase()) >= 0;
  }

  function isFrozenAttr(name) {
    return FROZEN_ATTRS.indexOf(String(name || '').toLowerCase()) >= 0;
  }

  function isVoidTag(name) {
    return VOID_TAGS.indexOf(String(name || '').toLowerCase()) >= 0;
  }

  function isBlockTag(name) {
    return BLOCK_TAGS.indexOf(String(name || '').toLowerCase()) >= 0;
  }

  /** 该标签是否必须整块删除（连内容一起丢，见 sanitize 的 dropped）。 */
  function isDropTag(name) {
    return DROP_TAGS.indexOf(String(name || '').toLowerCase()) >= 0;
  }

  function isInlineProp(name) {
    return INLINE_PROPS.indexOf(String(name || '').toLowerCase()) >= 0;
  }

  /** 取某个标签的降级结果；本来就在白名单里就原样返回。 */
  function degradeTag(name) {
    const lower = String(name || '').toLowerCase();
    if (isAllowedTag(lower)) return lower;
    return DEGRADE[lower] || 'span';
  }

  MW.whitelist = {
    TAGS: TAGS,
    BLOCK_TAGS: BLOCK_TAGS,
    VOID_TAGS: VOID_TAGS,
    ATTRS: ATTRS,
    FROZEN_ATTRS: FROZEN_ATTRS,
    DEGRADE: DEGRADE,
    RAW_TEXT_TAGS: RAW_TEXT_TAGS,
    DROP_TAGS: DROP_TAGS,
    INLINE_PROPS: INLINE_PROPS,
    isAllowedTag: isAllowedTag,
    isAllowedAttr: isAllowedAttr,
    isFrozenAttr: isFrozenAttr,
    isVoidTag: isVoidTag,
    isBlockTag: isBlockTag,
    isDropTag: isDropTag,
    isInlineProp: isInlineProp,
    degradeTag: degradeTag
  };
})(window);
