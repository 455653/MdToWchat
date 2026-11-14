/*
 * pipeline.js —— 渲染管线编排
 *
 * 为什么需要一个「编排」文件而不是把逻辑写在 app.js 里：
 * 渲染是分阶段的流水线（解析 → 固化 → 归一 → 兼容规则回灌），
 * 每一段都要能被单独测试、单独替换。放在这里，app.js 只负责「什么时候调」，
 * 不负责「怎么调」，测试页也能直接拿到一个纯函数去断言。
 *
 * build(mdText, options) → Promise<{ root, html, meta, outline }>
 *   root    —— 文章根节点，带 data-mw-root 标记，且不带 class
 *   html    —— root.innerHTML，即真正要被写入剪贴板的 HTML
 *   meta    —— { empty, chars, lines, bytes, encoding, headings, dropped, media?, error? }
 *              dropped 是归一阶段整块删除的标签清单，面板据此告诉用户「有内容没了」
 *              media 是 P5 的多媒体统计（内嵌张数、占位图数、体积、告警）
 * options.images      —— { 文件名: dataURI }，用户手动映射进来的本地图片
 * options.onProgress  —— 进度回调：多媒体内嵌（src/media.js）与长文档的固化分块
 *                        （src/inline-styles.js）都用同一个形状 { done, total, label }，
 *                        app.js 那一条进度条因此可以同时接住这两种来源。
 * options.reuse       —— true 表示「md 一个字没改，只是主题变了」：复用上一次的
 *                        解析/降级/多媒体内嵌结果，只重跑固化 + 归一。
 *                        主题滑块拖动时这才是真正的成本大头，见「解析结果缓存」。
 *   outline —— [{ level, text, nodeId }]，同一份数据也挂在 window.MW.outline
 *
 * 契约（会被 test/assert.html 按阶段检查）：
 *   A1 产物非空。
 *   A2 产物内不得出现 class 属性 —— 微信必剥 class，
 *      留着它会让人误以为样式生效；钩子一律用 data-mw-*。
 *   A3 产物内不得出现 <style> / <link>。
 *   A4 产物内不得出现 display:flex / display:grid / position。
 *   A5 每个块级元素都要带内联 font-size。
 *   A6 没有元素把宽度写死超过 375px。
 *   A7 所有 img 的 src 都是 data: URI —— 外链图片在微信里必「上传失败」。
 *   A8 目录（outline）里的标题数与 md 源里的标题数逐级相等 —— 两边分别来自
 *      渲染后的 DOM 与解析出的 token 流，对得上才说明「标题既渲染出来了、也被收进了目录」。
 *   A9 产物内不得出现 href="#…" 开头的链接 —— 公众号没有可用的锚点，页内跳转必是死链。
 *   A10 产物内不得出现 svg / canvas / iframe —— 会被整块剥掉，
 *      图形必须先在本机栅格化成 PNG（见 src/media.js）。
 *
 * 管线顺序（顺序本身就是设计，不要调换）：
 *   parse → 多媒体摘取 → 布局降级 → 多媒体内嵌 → 挂 375px 舞台 → 固化 → 归一 → 输出
 *   · 布局降级必须在固化之前：固化读的是「元素在舞台上的布局」，
 *     先固化再改结构，新造出来的节点没被算过样式，前面算好的那份也对不上新结构。
 *   · 固化必须在归一之前：固化要认 <a>/<pre>/<code> 这些「有语义才有样式」的标签，
 *     归一换完标签它们就没了；而归一换标签时会把固化好的 style 原样带走，不丢样式。
 *   · 内容要先搬进带 data-mw-root 的 root 再固化，固化才能命中
 *     `.article [data-mw-root]` 那套 --mw-* 地基规则——否则算出来的是浏览器默认样式。
 *   · 多媒体要在「摘取」与「内嵌」两处分别接进来（见 src/media.js）：
 *     摘取必须早于布局降级（此刻 mermaid 围栏还是 <pre><code>，认得出；代码块里的
 *     $x^2$ 也还没被改形，能安全跳过）；内嵌必须早于固化（固化读的是最终布局，
 *     晚插进来的 <img> 不会被写上样式，A5/A6 也会跟着漏）。
 *   · 也因此 build() 是 async 的：函数签名里那一个 await 是形状的一部分，
 *     不是「顺手加的异步」。
 *
 * 预览区显示的必须是固化 + 归一之后的产物：不存在「预览看一套、复制另一套」。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  /** 本文件当前实现到第几阶段。测试页用它决定哪些断言计分。 */
  const PHASE = 5;

  /* ==================== vendor 存在性检查 ==================== */

  /**
   * 必需的离线库。
   * 为什么要在页面里先探一次，而不是直接调用：
   * file:// 下 <script src> 加载失败是静默失败——没有报错、没有控制台提示，
   * 只会让后面的代码拿到 undefined，然后抛出
   * 「Cannot read properties of undefined (reading 'parse')」。
   * 那个报错和真实原因（vendor/xxx.js 没放进来）差了十万八千里，
   * 所以这里点名列出到底缺哪个文件，并把提示画进预览区。
   */
  const VENDOR_LIBS = [
    { file: 'vendor/markdown-it.min.js', name: 'markdownit', label: 'markdown-it' },
    { file: 'vendor/markdown-it-footnote.min.js', name: 'markdownitFootnote', label: 'markdown-it-footnote' },
    { file: 'vendor/markdown-it-task-lists.min.js', name: 'markdownitTaskLists', label: 'markdown-it-task-lists' },
    { file: 'vendor/highlight.min.js', name: 'hljs', label: 'highlight.js' }
  ];

  function missingVendor() {
    return VENDOR_LIBS.filter(function (lib) { return !global[lib.name]; });
  }

  /**
   * 缺库时的错误块。
   * 它必须长在预览区里，而不是只往控制台打一行：
   * 用户不会开控制台，而「页面一片空白 + 控制台 undefined」是最难自查的失败形态。
   */
  function buildVendorError(missing) {
    const box = document.createElement('section');
    box.setAttribute('style', 'background:#fff6f6;border:1px solid #f0c2c2;border-radius:6px;padding:12px 14px;');

    const title = document.createElement('p');
    title.setAttribute('style', 'font-weight:600;color:#c62828;');
    title.textContent = '离线库没有加载，渲染无法进行';
    box.appendChild(title);

    missing.forEach(function (lib) {
      const line = document.createElement('p');
      line.textContent = '缺少 ' + lib.file + '（' + lib.label + '）';
      box.appendChild(line);
    });

    const hint = document.createElement('p');
    hint.setAttribute('style', 'color:#6b7280;');
    hint.textContent = '这些文件必须放在 vendor/ 目录下，且用 UMD 版本——本工具不引 CDN，也不做构建。';
    box.appendChild(hint);

    return box;
  }

  /* ==================== markdown-it 实例 ==================== */

  let parser = null;

  /**
   * 解析器是懒建的：它是整条管线里唯一有「外部依赖」的环节，
   * 而缺库的情况要能被 build 优雅地报出来（见上面的错误块），
   * 所以绝不能在加载本文件时就去 new 它。
   */
  function getParser() {
    if (parser) return parser;

    parser = global.markdownit({
      // 安全底线，不是可选项：html:false 让 md 里写的标签只能作为文字出现。
      // 关掉它，01-basic.md 里那句 <div onclick> 就是一条能执行的注入路径。
      html: false,
      // 裸 URL 自动识别成 <a>，再由下面的降级步骤统一处理。
      // 不识别反而会漏掉一个降级点：一段裸 URL 在公众号里同样是不可点的死文本。
      linkify: true,
      // 智能引号与省略号，中文写作里出现 "…" 的概率远高于想保留直引号
      typographer: true,
      // 中文写作习惯是单换行即换行，与英文 md 的软换行语义不同
      breaks: true,
      // 代码高亮的产物必须自带内联颜色，见 highlightFence
      highlight: highlightFence
    });

    parser.use(global.markdownitFootnote);
    parser.use(global.markdownitTaskLists);

    return parser;
  }

  /* ==================== 代码高亮 ==================== */

  /**
   * token 类名 → 内联声明。
   *
   * 为什么不引 highlight.js 的主题样式表：
   * 主题样式表靠 class 上色，而 class 在粘进公众号时会被整条剥掉，
   * 结果就是「代码粘过去一片黑」——这是本工具要解决的问题本身，
   * 所以在 P1 就把颜色直接写进每个 span 的 style 属性。
   * 取色参考 GitHub 浅色主题，只为可读，不做品牌还原。
   */
  const TOKEN_STYLE = {
    'hljs-keyword': 'color:#d73a49;',
    'hljs-built_in': 'color:#005cc5;',
    'hljs-type': 'color:#005cc5;',
    'hljs-literal': 'color:#005cc5;',
    'hljs-number': 'color:#005cc5;',
    'hljs-property': 'color:#005cc5;',
    'hljs-formula': 'color:#005cc5;',
    'hljs-string': 'color:#032f62;',
    'hljs-regexp': 'color:#032f62;',
    'hljs-symbol': 'color:#032f62;',
    'hljs-bullet': 'color:#032f62;',
    'hljs-code': 'color:#032f62;',
    'hljs-comment': 'color:#6a737d;font-style:italic;',
    'hljs-quote': 'color:#6a737d;font-style:italic;',
    'hljs-doctag': 'color:#6a737d;',
    'hljs-meta': 'color:#6a737d;',
    'hljs-title': 'color:#6f42c1;',
    'hljs-section': 'color:#6f42c1;font-weight:600;',
    'hljs-attr': 'color:#6f42c1;',
    'hljs-attribute': 'color:#6f42c1;',
    'hljs-selector-id': 'color:#6f42c1;',
    'hljs-selector-class': 'color:#6f42c1;',
    'hljs-selector-attr': 'color:#6f42c1;',
    'hljs-selector-pseudo': 'color:#6f42c1;',
    'hljs-name': 'color:#22863a;',
    'hljs-tag': 'color:#22863a;',
    'hljs-selector-tag': 'color:#22863a;',
    'hljs-addition': 'color:#22863a;',
    'hljs-deletion': 'color:#b31d28;',
    'hljs-variable': 'color:#e36209;',
    'hljs-template-variable': 'color:#e36209;',
    'hljs-operator': 'color:#d73a49;',
    'hljs-link': 'color:#032f62;text-decoration:underline;',
    'hljs-params': 'color:#24292e;',
    'hljs-punctuation': 'color:#24292e;',
    'hljs-subst': 'color:#24292e;',
    'hljs-emphasis': 'color:#24292e;font-style:italic;',
    'hljs-strong': 'color:#24292e;font-weight:600;'
  };

  /**
   * highlight.js 的入口。
   * 关键约定：返回值不能以 <pre 开头——那样 markdown-it 会把整段当作成品直接输出，
   * 我们就没有机会再套容器、也没机会再走归一。这里只返回「内部的那些 span」。
   */
  function highlightFence(code, lang) {
    const name = String(lang == null ? '' : lang).trim().toLowerCase();
    // 没有语言标注，或者高亮器不认识这个标注：退回纯文本。
    // 「退化成纯文本」是必须显式写的分支——不写就会是「没有高亮的代码」，
    // 那和「高亮失败」在页面上长得一模一样，出问题时分不清。
    if (!name || !global.hljs.getLanguage(name)) return MW.util.escapeHtml(code);

    const result = global.hljs.highlight(code, { language: name, ignoreIllegals: true });
    return tokenHtmlToInline(result.value);
  }

  /**
   * 把 highlight.js 产出的 class 换成 style。
   * 用 <template> 承载这段 HTML：它不进入文档流、不触发图片与脚本加载，
   * 是「只想解析不想插入」时最合适的容器。
   */
  function tokenHtmlToInline(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;

    const spans = tpl.content.querySelectorAll('span');
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      const classes = String(span.getAttribute('class') || '').split(/\s+/);
      let style = '';
      // 取类名里第一个能对上配色表的：highlight.js 会写出
      // class="hljs-title function_" 这种「主类 + 修饰类」的组合，
      // 修饰类没有颜色，不能因为先遇到它就把整个 span 判成无色。
      for (let j = 0; j < classes.length; j++) {
        if (TOKEN_STYLE[classes[j]]) { style = TOKEN_STYLE[classes[j]]; break; }
      }
      if (style) span.setAttribute('style', style);
      // 类名在这里就地删掉：它一定会被公众号剥掉，
      // 留在产物里只会让人误以为「还有一层 class 样式在起作用」。
      span.removeAttribute('class');
    }

    const box = document.createElement('div');
    box.appendChild(tpl.content);
    return box.innerHTML;
  }

  /* ==================== 代码块容器 ==================== */

  const CODE_BOX_STYLE = 'background:#f6f8fa;border-radius:6px;padding:12px 14px;';
  // 这里写死一个基色：#24292e 是浅色主题下的代码基色。
  // 为什么连纯文本代码块也要显式给色：公众号会用自己的默认文字色接管，
  // 「没有颜色声明的代码块」在不同主题下深浅不一，看起来就像高亮失败了。
  const CODE_PRE_STYLE = 'margin:0;color:#24292e;'
    + 'font-family:Consolas,Menlo,"Courier New","Microsoft YaHei",monospace;'
    + 'white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere;';
  const CODE_TAG_STYLE = 'font-family:inherit;background:none;padding:0;'
    + 'white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere;';

  /**
   * 给每个代码块套一层容器。
   *
   * 为什么不让 <pre><code> 自己扛全部：
   * 「块感」（背景、圆角、内边距）和「文字怎么折行」是两件事，
   * 混在一层里以后想改背景就得动折行属性。所以外层 section 只管块感，
   * 内层只管折行——这也是公众号里唯一能站住的写法。
   *
   * 折行用 pre-wrap + break-all 是硬要求：
   * 手机上没有横向滚动条，一行 200 字符的代码只能折行显示；
   * 而 break-all 保证「一个 100 字符的长单词」也不会把容器顶宽。
   */
  function wrapCodeBlocks(holder) {
    const pres = holder.querySelectorAll('pre');
    for (let i = 0; i < pres.length; i++) {
      const pre = pres[i];
      const box = document.createElement('section');
      box.setAttribute('style', CODE_BOX_STYLE);

      if (pre.parentNode) pre.parentNode.insertBefore(box, pre);
      box.appendChild(pre);

      pre.setAttribute('style', CODE_PRE_STYLE);
      const code = pre.querySelector('code');
      if (code) code.setAttribute('style', CODE_TAG_STYLE);
    }
  }

  /* ==================== 降级共用零件 ==================== */

  /** 工具自动生成的三个区块（目录、链接、注释）共用同一个浅底框，视觉上是一类东西。 */
  const BOX_STYLE = 'background:#f7f8fa;border-radius:6px;padding:12px 14px;margin:0 0 1.2em;';
  const LABEL_STYLE = 'font-weight:600;';

  function boxLabel(text) {
    const p = document.createElement('p');
    p.setAttribute('style', LABEL_STYLE);
    p.textContent = text;
    return p;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /* ==================== 脚注降级 ==================== */

  /**
   * 脚注：公众号里锚点跳转无效，所以不保留任何可跳转的东西。
   * 三件事：
   *   1. 正文上标从 <sup><a href="#fn1">[1]</a></sup> 变成 <sup>1</sup>；
   *   2. 文末生成「注释」小节，逐条列出脚注正文，序号与上标一一对应；
   *   3. 注释块一律追加到文档最末尾。
   *
   * 第 3 点为什么必须显式做：插件自己会把脚注块放在「最后一个脚注引用」后面，
   * 这个位置受版本实现影响（它并不是「文档末尾」的硬保证）。
   * 依赖它就会出现「脚注区域插在正文中间」这种最典型的错法，
   * 所以这里的做法是「摘掉原块 → 重建 → 追加到末尾」，不依赖插件的落点。
   */
  function degradeFootnotes(holder) {
    const refs = holder.querySelectorAll('sup.footnote-ref');
    for (let i = 0; i < refs.length; i++) {
      const sup = refs[i];
      const anchor = sup.querySelector('a');
      const href = anchor ? (anchor.getAttribute('href') || '') : '';
      const matched = /#fn(\d+)/.exec(href);
      // 编号优先从 href 里取（那是脚注的真实编号），取不到才退回上标自身的数字。
      // 直接写上标里的文字是不行的，插件写的是「[1]」，我们要的是纯数字。
      sup.textContent = matched ? matched[1] : String(sup.textContent).replace(/[^\d]/g, '');
    }

    const oldList = holder.querySelector('ol.footnotes-list');
    const oldSection = holder.querySelector('.footnotes');
    if (!oldList && !oldSection) return;

    const items = oldList ? oldList.querySelectorAll('li') : [];
    const notes = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // 回跳链接（↩︎）指向 #fnref1，在公众号里是死链，整条摘掉
      const backrefs = item.querySelectorAll('.footnote-backref');
      for (let j = backrefs.length - 1; j >= 0; j--) backrefs[j].parentNode.removeChild(backrefs[j]);
      const matched = /^fn(\d+)$/.exec(item.getAttribute('id') || '');
      notes.push({ number: matched ? matched[1] : String(i + 1), item: item });
    }

    const sep = holder.querySelector('.footnotes-sep');
    if (sep && sep.parentNode) sep.parentNode.removeChild(sep);
    const block = oldSection || oldList;
    if (block && block.parentNode) block.parentNode.removeChild(block);

    const section = document.createElement('section');
    section.setAttribute('style', BOX_STYLE);
    section.appendChild(boxLabel('注释'));

    notes.forEach(function (note) {
      const only = note.item.children.length === 1 ? note.item.firstElementChild : null;
      if (only && only.tagName === 'P') {
        // 单段脚注直接用原段落当行容器：再造一层 <p> 会变成 <p> 套 <p>，
        // 浏览器会把外层提前闭合，序列化出来的结构和看到的不一样。
        only.insertBefore(document.createTextNode(note.number + '\u3000'), only.firstChild);
        section.appendChild(only);
      } else {
        // 分段脚注的容器必须是 section 而不是 div：div 不在 P2 的标签白名单里，
        // 用 div 就得靠归一时再换一次标签——而那时固化已经做完，
        // 新换出来的 section 不会带上字号，A5 会以「块级元素缺 font-size」失败。
        const line = document.createElement('section');
        line.appendChild(document.createTextNode(note.number + '\u3000'));
        while (note.item.firstChild) line.appendChild(note.item.firstChild);
        section.appendChild(line);
      }
    });

    holder.appendChild(section);
  }

  /* ==================== 任务列表勾选框降级 ==================== */

  /**
   * markdown-it-task-lists 产出的是 <input type="checkbox">。
   * input 不在白名单里（form 系是刻意排除的），而归一器的默认规则会把它
   * 拆成一个空 span——「已完成 / 未完成」这个状态就一起丢了。
   * 与其让状态信息在归一时蒸发，不如在这里就把勾选框换成两个纯文本符号：
   * 状态留住了，产物里也不会出现一个公众号必删的表单控件。
   */
  function degradeTaskCheckboxes(holder) {
    const boxes = holder.querySelectorAll('input[type="checkbox"]');
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      const mark = box.hasAttribute('checked') ? '☑ ' : '☐ ';
      if (box.parentNode) box.parentNode.replaceChild(document.createTextNode(mark), box);
    }
  }

  /* ==================== 外链降级 ==================== */

  const SCHEME_RE = /^[a-z][a-z0-9+.\-]*:/i;

  /**
   * 百分号解码。markdown-it 会把非 ASCII 链接整段编码，
   * 直接展示会得到「%E4%BE%8B%E5%AD%90」这种东西。
   * 这里确实需要 try/catch：decodeURIComponent 对残缺序列会抛错，
   * 而「解码失败就显示原始串」本来就是我们要的行为，
   * 不是把异常藏起来——所以异常路径直接返回原文。
   */
  function decodeSafe(text) {
    try {
      return decodeURIComponent(text);
    } catch (err) {
      return text;
    }
  }

  /**
   * 判断这是哪种链接。
   * 分三类是因为它们在公众号里的下场不同：
   *   anchor   —— 页内跳转，公众号没有可用锚点，只能留文字；
   *   relative —— 相对路径，粘出去以后没有宿主，同样是死链；
   *   absolute —— 真外链，值得在文末列出来让人手抄或在电脑上点开。
   * 只有 absolute 才有域名可展示、可登记，前两类硬凑一个「域名」只会误导人。
   */
  function linkInfo(href) {
    const raw = String(href == null ? '' : href).trim();
    if (!raw) return { kind: 'none', url: '', host: '' };
    if (raw.charAt(0) === '#') return { kind: 'anchor', url: raw, host: '' };

    // 协议相对链接（//example.com/x）在公众号里同样不可点，但它有宿主，按外链处理
    if (raw.indexOf('//') === 0) {
      return { kind: 'absolute', url: raw, host: decodeSafe(raw.slice(2).split(/[/?#]/)[0]) };
    }
    if (!SCHEME_RE.test(raw)) return { kind: 'relative', url: raw, host: '' };

    if (/^mailto:/i.test(raw)) {
      // mailto 没有 host，取 @ 后面那一段当「域名」，读者才有东西可抄
      const afterAt = raw.split('@')[1] || '';
      return { kind: 'absolute', url: raw, host: decodeSafe(afterAt.split('?')[0]) };
    }

    const rest = raw.replace(SCHEME_RE, '');
    const host = rest.indexOf('//') === 0 ? rest.slice(2).split(/[/?#]/)[0] : '';
    return { kind: 'absolute', url: raw, host: decodeSafe(host) };
  }

  function domainTag(host) {
    const span = document.createElement('span');
    span.setAttribute('style', 'color:#9aa0a6;font-size:0.85em;');
    // 前置空格不能省：没有它，域名会和链接文字粘成「参考链接example.com」
    span.textContent = ' ' + host;
    return span;
  }

  /**
   * 正文里所有 <a> 一律剥掉 href。
   *
   * 为什么不是直接把 <a> 换成纯文本节点：<a> 里可能嵌着图片
   * （12-link.md 里的图片链接就是），取 textContent 会把图片一起抹掉。
   * 只摘 href，元素结构原样保留，图片和文字都不会丢。
   *
   * 文末的「链接」小节按完整 URL 去重：同一篇文章里同一个地址被引两次很常见，
   * 清单里出现两行一样的 URL 只会让读者以为是两个不同的链接。
   */
  function degradeLinks(holder) {
    const anchors = holder.querySelectorAll('a');
    const seen = Object.create(null);
    const collected = [];

    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const info = linkInfo(a.getAttribute('href'));
      a.removeAttribute('href');

      if (info.host) a.parentNode.insertBefore(domainTag(info.host), a.nextSibling);
      if (info.kind === 'absolute' && !seen[info.url]) {
        seen[info.url] = true;
        collected.push(info);
      }
    }

    if (collected.length) {
      const section = document.createElement('section');
      section.setAttribute('style', BOX_STYLE);
      section.appendChild(boxLabel('链接'));

      collected.forEach(function (item, index) {
        const line = document.createElement('p');
        // 序号 + 域名 + 完整 URL。域名单独给一格，是为了让读者一眼看出
        // 「这条是哪家的」，不用去头去尾读那一长串路径。
        line.textContent = pad2(index + 1) + '\u3000'
          + (item.host ? item.host + '\u3000' : '') + item.url;
        section.appendChild(line);
      });

      holder.appendChild(section);
    }

    return collected;
  }

  /* ==================== 布局降级 ==================== */

  /**
   * 往元素已有的 style 后面追加声明（不覆盖已有声明）。
   * 表格的对齐标记（text-align）是 markdown-it 直接写在 style 上的，
   * 覆盖式写法会把它们清掉——那属于「为了改列宽顺手改了别的东西」。
   */
  function putStyle(el, text) {
    const cur = String(el.getAttribute('style') || '');
    const sep = cur && cur.charAt(cur.length - 1) !== ';' ? ';' : '';
    el.setAttribute('style', cur + sep + text);
  }

  /** 列表标记。为什么用全角空格（U+3000）而不是半角：中文序号后接半角空格会像是粘在文字上。 */
  const LIST_MARKER_BULLET = '\u2022\u3000';

  /**
   * 列表降级：ul / ol / li 一律改写成 section 序列。
   *
   * 为什么不用 ul/ol/li：微信编辑器对列表的支持各版本不一，实际表现是「缩进和圆点
   * 时有时无」，而它又必须靠浏览器默认样式才成立——产物里没有样式表，默认样式就是
   * 「听天由命」。改成 section 之后，圆点/序号是我们自己写的字符，缩进是自己写的
   * padding，就变成了和其它元素一样的「纯内联样式」问题，可控。
   *
   * 为什么从最内层开始处理：内层先变成 section，外层再把它搬进新 item 时结构已经稳定，
   * 不会出现「搬走了一半、剩下的嵌套列表找不到父节点」。
   */
  function degradeLists(holder) {
    const lists = Array.prototype.slice.call(holder.querySelectorAll('ul, ol')).reverse();

    for (let i = 0; i < lists.length; i++) {
      const list = lists[i];
      if (!list.parentNode) continue; // 外层降级时已被整块搬走

      const ordered = list.tagName === 'OL';
      const startAttr = parseInt(list.getAttribute('start'), 10);
      let index = isNaN(startAttr) ? 1 : startAttr;

      const box = document.createElement('section');
      box.setAttribute('style', 'margin:0 0 1.2em;');

      const items = Array.prototype.slice.call(list.children);
      for (let j = 0; j < items.length; j++) {
        const li = items[j];
        if (li.tagName !== 'LI') continue;

        const item = document.createElement('section');
        // 悬挂缩进：标记与正文都从 1.2em 起，折行后也对齐。
        // 嵌套列表因为整个 item 段被父级的 padding 推右，缩进会自然叠加，
        // 所以这里不必再按层深算一次——算两次反而会把深层挤成窄缝。
        item.setAttribute('style', 'padding-left:1.2em;margin:0 0 0.3em;');

        // 任务列表项已经由 degradeTaskCheckboxes 写成「☑ / ☐」，它就是标记本身，
        // 再补一个圆点会得到「• ☑ 某事」这种双层标记。
        const isTask = /\btask-list-item\b/.test(String(li.getAttribute('class') || ''));
        if (!isTask) {
          item.appendChild(document.createTextNode(ordered ? (index + '. ') : LIST_MARKER_BULLET));
        }

        while (li.firstChild) item.appendChild(li.firstChild);
        box.appendChild(item);
        index++;
      }

      if (box.children.length) list.parentNode.replaceChild(box, list);
      else list.parentNode.removeChild(list); // 空列表：连壳一起删，不留一个空 section
    }
  }

  /**
   * 表格降级：表格一律 width:100%，列宽按列数均分写在 th 上，且只能用百分比。
   *
   * 为什么只给百分比：写 px 就是给了它一个「在窄屏必然溢出」的尺寸，
   * 这是 A6 钉死的红线。百分比是相对容器算的，容器多宽它就多宽。
   * 为什么列宽写在 th 而不是 td：th 是每列的第一格，写在它上面
   * 等价于「声明这一列的宽度」，重复写在每个 td 上只会让 style 文本长四倍。
   * 刻意不写 table-layout:fixed：那会把超长单元格强行按平均宽度切，
   * 内容一旦比格宽就被压成一条竖缝——8 列样本上这一点尤其明显。
   */
  function degradeTables(holder) {
    const tables = holder.querySelectorAll('table');

    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      putStyle(table, 'width:100%;border-collapse:collapse;');

      const row = table.querySelector('tr');
      if (!row) continue;
      const cells = row.children;
      if (!cells.length) continue;

      const pct = Math.floor((100 / cells.length) * 100) / 100;
      for (let j = 0; j < cells.length; j++) putStyle(cells[j], 'width:' + pct + '%;');
    }
  }

  /**
   * 布局降级总入口。必须在固化之前调用（P2 的硬要求，顺序不能反）。
   * flex / grid / position / float / 伪元素这几类在微信里必被过滤的布局，
   * 我们自己的生成端从第一天起就不产出（见 whitelist.INLINE_PROPS 的排除说明），
   * 所以真正需要在这里改写的只有「列表」和「表格列宽」两件事。
   */
  function degradeLayout(holder) {
    degradeLists(holder);
    degradeTables(holder);
  }

  /* ==================== 大纲与目录 ==================== */

  /**
   * 给标题编号并产出大纲。
   *
   * 必须在「外链降级」之前调用：降级会在 <a> 后面插一个灰色域名 span，
   * 如果先降级再取文字，标题里带链接的话大纲会多出「example.com」这一截，
   * 目录里就会出现「03　参考链接 example.com」这种对不上的文字。
   *
   * 文字一律取 textContent 而不是 innerHTML：
   * textContent 是「节点树里所有文字拼起来」，它天然剥掉了行内标记——
   * 标题写成 `### 带 \`代码\` 的标题` 时，这里拿到的就是「带 代码 的标题」，
   * 目录里不会出现反引号，也不会出现一个字面量 <code> 标签。
   */
  function collectHeadings(holder) {
    const headings = holder.querySelectorAll('h1,h2,h3,h4,h5,h6');
    const outline = [];

    for (let i = 0; i < headings.length; i++) {
      const el = headings[i];
      const nodeId = 'h-' + (i + 1);
      // data-mw-id 是 P3 侧栏跳转的锚点，也是 P6「登记问题时选位置」的定位符。
      // 用属性而不是 id：id 会被公众号剥掉，而且会和脚注插件生成的 id 撞车。
      el.setAttribute('data-mw-id', nodeId);
      outline.push({
        level: Number(el.tagName.slice(1)),
        text: String(el.textContent || '').replace(/\s+/g, ' ').trim(),
        nodeId: nodeId
      });
    }

    return outline;
  }

  /** 目录阈值：二级标题少于 3 个就不插目录。 */
  const TOC_MIN_H2 = 3;

  /**
   * 目录。
   * 为什么只收二级标题：手机上三四级标题也塞进去，目录会变成一张比正文还长的目录，
   * 而它又不能点，纯粹是负担。二级标题才是「一节」的粒度。
   * 为什么纯文本不带 <a>：公众号里没有可用锚点，带链接只会得到一堆点不动的假链接。
   */
  function insertToc(holder, outline) {
    const h2 = outline.filter(function (item) { return item.level === 2; });
    if (h2.length < TOC_MIN_H2) return false;

    const section = document.createElement('section');
    section.setAttribute('style', BOX_STYLE);
    section.appendChild(boxLabel('目录'));

    h2.forEach(function (item, index) {
      const line = document.createElement('p');
      // 「两位序号 + 全角空格」：全角空格（U+3000）的宽度约等于一个汉字，
      // 半角空格在中文序号后面显得过窄，序号会像是粘在标题上。
      line.textContent = pad2(index + 1) + '\u3000' + item.text;
      section.appendChild(line);
    });

    holder.insertBefore(section, holder.firstChild);
    return true;
  }

  /* ==================== 统计 ==================== */

  function emptyHeadingCounts() {
    return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, total: 0 };
  }

  /**
   * 按 level 统计 md 源里的标题数。
   * 数据源刻意选 token 流而不是渲染后的 DOM：
   * 它是「md 里写了几个几级标题」的独立答案，A8 拿它和 DOM 对账才有意义；
   * 若两边都从 DOM 数，就只是同一份数据自己和自己相等。
   */
  function countHeadingsByLevel(tokens) {
    const counts = emptyHeadingCounts();
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'heading_open') continue;
      const level = Number(String(tokens[i].tag).slice(1));
      if (counts[level] == null) continue;
      counts[level]++;
      counts.total++;
    }
    return counts;
  }

  /* ==================== 解析异常的错误块 ==================== */

  /**
   * 解析/渲染这一步出异常时的错误块。
   *
   * 为什么必须画在预览区里、而不是只 toast 一下或者只往控制台打一行：
   * 解析异常最糟糕的表现形态是「白屏」——用户看不见任何线索，只能猜。
   * 错误必须长在用户正在看的那块区域里，并且带上「接下来能做什么」。
   */
  function buildErrorBlock(title, message, at, hint) {
    const box = document.createElement('section');
    box.setAttribute('style', 'background:#fff6f6;border:1px solid #f0c2c2;border-radius:6px;padding:12px 14px;');

    const head = document.createElement('p');
    head.setAttribute('style', 'font-weight:600;color:#c62828;margin:0 0 8px;');
    head.textContent = title;
    box.appendChild(head);

    if (at) {
      const pos = document.createElement('p');
      pos.setAttribute('style', 'margin:0 0 6px;');
      pos.textContent = '出错位置：' + at;
      box.appendChild(pos);
    }

    const reason = document.createElement('p');
    reason.setAttribute('style', 'margin:0 0 8px;');
    reason.textContent = '原因：' + message;
    box.appendChild(reason);

    const next = document.createElement('p');
    next.setAttribute('style', 'color:#6b7280;margin:0;');
    next.textContent = hint;
    box.appendChild(next);

    return box;
  }

  /**
   * 尽力从异常里取出「出错位置」。
   * 不编造：取不到就返回空串，错误块里那一行整个不显示。
   * 编一个假的「第 1 行」比不显示更坏——它会让人去改一个没问题的位置。
   */
  function positionOf(err) {
    if (!err) return '';
    const parts = [];
    if (err.line != null) parts.push('第 ' + err.line + ' 行');
    if (err.column != null) parts.push('第 ' + err.column + ' 列');
    if (err.index != null) parts.push('第 ' + (Number(err.index) + 1) + ' 个字符');
    return parts.join('，');
  }

  const PARSE_HINT = '可以先把出错位置附近那一段删掉再试；'
    + '如果整份文档都打不开，请用别的编辑器「另存为 UTF-8」后重新载入。';

  /* ==================== 解析结果缓存 ==================== */

  /**
   * 主题变更时只重跑固化，不重跑解析。
   *
   * 为什么值得缓存：解析 + 降级 + 多媒体内嵌（尤其图片转 data: URI）
   * 是整条管线里最贵的一段，而它与主题完全无关——主题只影响
   * 「元素算出来的样式」，也就是固化那一步读的东西。
   * 用户拖一次字号滑块就要把几百 KB 的 md 重新解析一遍，是纯浪费。
   *
   * 缓存什么、不缓存什么：
   *   存 holder 的 innerHTML（此时已经过全部降级与多媒体内嵌）
   *   —— 从它开始正好接上「搬进 root → 固化 → 归一」。
   *   不存 DOM 节点：第一次构建结束时 holder 的子节点已经被搬走了，
   *   留着那个空壳没有意义，而 innerHTML 可以在复用时重新解析出一份新的。
   *
   * 为什么用 md 原文做键：主题变化时原文一字未改，这是最直接也最可靠的判等。
   *   app.js 传来的 reuse 只是一个「值得一试」的意图，真正决定能不能复用的是这里。
   */
  const cache = { text: null, holderHtml: '', outline: [], meta: null };

  function takeCache(text) {
    if (cache.meta && cache.text === text) return cache;
    return null;
  }

  function putCache(text, holderHtml, outline, meta) {
    cache.text = text;
    cache.holderHtml = holderHtml;
    cache.outline = outline;
    // 存一份浅拷贝：meta.dropped 每次归一都会重新算，直接存引用会被下一次构建改写
    cache.meta = Object.assign({}, meta);
  }

  /* ==================== 主流程 ==================== */

  /**
   * 主流程。P5 起是异步的：产物里要内嵌图片、公式与图表，
   * 而公式与图表的引擎是懒加载的，必须等它们回来、栅格化完成才能固化。
   * P7 起固化本身也可能是异步的（长文档分块写入），所以这里也要 await 它。
   */
  async function build(mdText, options) {
    const opts = Object.assign({ encoding: 'UTF-8', bytes: null }, options || {});
    const text = mdText == null ? '' : String(mdText);

    const root = document.createElement('div');
    // 用属性而不是 class 做标记：class 一定会被微信剥掉，
    // 所以产物的样式钩子从第一天起就只能靠 data-*。
    root.setAttribute('data-mw-root', '');

    const bytes = opts.bytes == null ? MW.util.utf8Bytes(text) : opts.bytes;
    const meta = {
      empty: text.trim().length === 0,
      chars: MW.util.countChars(text),
      // 空文本算 0 行，而不是 1 行——统计栏显示「0 行」比「1 行」更符合直觉
      lines: text.length === 0 ? 0 : text.split('\n').length,
      bytes: bytes,
      encoding: opts.encoding || 'UTF-8',
      headings: emptyHeadingCounts()
    };

    // 每次构建都把大纲重置掉：上一份文档的大纲留在 window 上，
    // 会让 Console 里的 window.MW.outline 和眼前的预览对不上。
    MW.outline = [];

    /*
     * 复用分支：md 没变、只是主题变了，跳过解析与内嵌，直接重跑固化。
     * 位置刻意放在 vendor 检查之前——缺库时根本走不到这里（缓存是空的）。
     */
    const hit = opts.reuse ? takeCache(text) : null;
    if (hit) {
      const holder = document.createElement('div');
      holder.innerHTML = hit.holderHtml;

      const outline = hit.outline.slice();
      MW.outline = outline;

      while (holder.firstChild) root.appendChild(holder.firstChild);

      // 复用路径里唯一真正要做的事：按新主题重新算一遍样式
      await MW.inlineStyles.apply(root, { onProgress: opts.onProgress });

      const reused = MW.sanitize.run(root, opts);
      root.appendChild(reused.root);

      meta.headings = hit.meta.headings;
      meta.media = hit.meta.media;
      meta.dropped = reused.dropped;
      // 打上这个标记，app.js 才不会把同一批多媒体告警再播一遍。
      // 拖一次主题滑块会触发十几次复用渲染，每次都重播等于整屏都是告警。
      meta.reused = true;

      return { root: root, html: root.innerHTML, meta: meta, outline: outline };
    }

    const missing = missingVendor();
    if (missing.length) {
      root.appendChild(buildVendorError(missing));
      meta.error = '缺少 ' + missing.map(function (lib) { return lib.file; }).join('、');
      return { root: root, html: root.innerHTML, meta: meta, outline: [] };
    }

    let html = '';
    try {
      const activeParser = getParser();
      const env = {};
      const tokens = activeParser.parse(text, env);
      meta.headings = countHeadingsByLevel(tokens);

      // 用同一份 token 流去渲染，而不是再调一次 render：
      // render 内部会重新 parse，脚注插件把状态记在 env 上，
      // 解析两遍等于让插件在同一个 env 上跑两轮，是白做功也是隐患。
      html = activeParser.renderer.render(tokens, activeParser.options, env);
    } catch (err) {
      // 解析异常要变成「看得见的错误块」，不是抛出去让别人白屏。
      // 这里不算吞异常：错误原因、位置（能取到时）与下一步该做什么都在页面上。
      const message = err && err.message ? err.message : String(err);
      root.appendChild(buildErrorBlock('这段 Markdown 没能解析', message, positionOf(err), PARSE_HINT));
      meta.error = message;
      return { root: root, html: root.innerHTML, meta: meta, outline: [] };
    }

    const holder = document.createElement('div');
    // 这里用 innerHTML 是安全的，两条理由缺一不可：
    //   1. html:false 让 md 里的原始标签在解析阶段就变成转义文本
    //      （01-basic.md 那句 <div onclick> 走到这里已经是 &lt;div&gt;）；
    //   2. 代码高亮的片段来自 highlight.js，它对代码内容做过转义。
    // 也就是说，能到这个变量里的字符串不可能含「用户可控的尖括号」。
    holder.innerHTML = html;

    /*
     * P5 第一步：把异步富内容从正文里摘成占位节点。
     * 必须在这里做，理由有两条，都跟「此刻的形状」有关：
     *   · mermaid 围栏此刻还是 <pre><code class="language-mermaid">，一眼可辨；
     *     等下 wrapCodeBlocks 把它包成 section 之后再想认出哪块是图表就只能靠猜。
     *   · 代码块里的 $x^2$ 此刻还在 <pre>/<code> 里，摘公式时能整块跳过；
     *     改形之后就没有这个可靠的边界了。
     */
    if (MW.media) MW.media.prepare(holder);

    wrapCodeBlocks(holder);
    degradeTaskCheckboxes(holder);

    // 布局降级：列表 → section 序列、表格 → 百分比列宽。
    // 必须排在固化之前——固化读的是元素在舞台上的布局，结构变了那份读数就作废。
    degradeLayout(holder);

    // 大纲必须在链接降级之前取，理由见 collectHeadings 的注释
    const outline = collectHeadings(holder);
    MW.outline = outline;

    degradeLinks(holder);
    // 注释放在最后追加：摘掉插件的原块再重建，保证它永远在文档最末尾
    degradeFootnotes(holder);

    insertToc(holder, outline);

    /*
     * P5 第二步：真正内嵌多媒体内容（图片 → 公式 → 图表）。
     * 落点固定在这里，且必须在固化之前：
     * 固化读的是元素在 375px 舞台上的最终布局，晚插进来的 <img> 没被算过样式，
     * A5（块级元素带 font-size）与 A6（宽度上界）都会跟着漏。
     *
     * 识别到公式/图表才会去注入 MathJax 与 Mermaid（各约 2 MB / 3 MB），
     * 普通文档这一步是零成本的空转，首屏 1 秒可交互这条不受影响。
     */
    if (MW.media) {
      meta.media = await MW.media.render(holder, {
        images: opts.images,
        onProgress: opts.onProgress
      });
    }

    /*
     * 缓存就落在这里：此刻 holder 已经过全部降级与多媒体内嵌，
     * 正是「主题变了要重跑的那一段」的起点。再往后（搬进 root、固化、归一）
     * 全都是主题相关的，不能缓存。
     */
    putCache(text, holder.innerHTML, outline, meta);

    /*
     * 内容先搬进带 data-mw-root 的 root 再固化。
     * 这一步不是「顺手整理 DOM」：固化要求被固化的节点正好挂在
     * `.article [data-mw-root]` 这套地基规则下，否则算出来的是浏览器默认样式
     * （16px 黑字、行高 normal），整个主题就白设了。
     */
    while (holder.firstChild) root.appendChild(holder.firstChild);

    // 固化：把浏览器算出来的样式写死进每个元素的 style（长文档会分块，见 inline-styles.js）
    await MW.inlineStyles.apply(root, { onProgress: opts.onProgress });

    // 归一：白名单清洗，并在最外层补一个带主题地基的 section
    const clean = MW.sanitize.run(root, opts);
    root.appendChild(clean.root);
    meta.dropped = clean.dropped;

    return { root: root, html: root.innerHTML, meta: meta, outline: outline };
  }

  MW.pipeline = {
    PHASE: PHASE,
    VENDOR_LIBS: VENDOR_LIBS,
    build: build
  };
})(window);
