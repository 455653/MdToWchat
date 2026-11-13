/*
 * clipboard.js —— 剪贴板
 *
 * 职责（P4 实现）：
 *   把 pipeline 的产物写进剪贴板，并如实回报「这次是怎么写进去的」。
 *   两种 MIME 必须一起写：公众号编辑器读的是 text/html，而只写 html 的话，
 *   粘进普通输入框（记事本、微信对话框）会变成一片空白；反过来只写 plain，
 *   粘进公众号则样式全丢。产物只有一个来源（pipeline 的 out.html），
 *   纯文本由它现推——不是另做一份，避免「预览一份、复制另一份」。
 *
 * 为什么必须两层（这是本文件存在的全部理由）：
 *   异步 Clipboard API 是正道：一次写入两种 MIME、不碰选区、不往页面里塞临时节点。
 *   但它有两个硬前提——secure context 与用户手势，而且 ClipboardItem 在
 *   部分浏览器（尤其旧 Safari）上根本不支持。双击 index.html 在 file:// 下用这个工具时，
 *   这两条都不能假定成立。所以第一层失败就退到 document.execCommand('copy')：
 *   它老、它脏、它要造临时节点，但它在 file:// 下几乎总能成功，
 *   而且它复制出去的那一份正好就是 text/html —— 微信认这个格式。
 *   两层都失败才认输，并且要把「退到哪、败在哪」交给调用方，让它给得出人话解释。
 *
 * 为什么临时容器必须用 finally 移除：
 *   它是个 position:fixed、left:-10000px、opacity:0 的 contenteditable。
 *   留在页面里用户看不见，但之后按 Tab、按 Ctrl+A 时的选区会莫名跳进去；
 *   而「复制完检查元素搜不到 contenteditable」本身就是验收项。
 *   异常路径（选区建立失败、execCommand 抛错）恰恰是最容易漏掉移除的那条路，
 *   所以移除必须写在 finally 里，不能写在成功分支后面。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  const PHASE = 4;

  /** copyRich 的三种结果：走了哪条路，或者两条都没走通。 */
  const VIA_API = 'api';
  const VIA_EXEC = 'exec';
  const FAILED = 'failed';

  /** 会被当成「一整行」的标签：产物的块级结构靠这张表还原成换行。 */
  const TEXT_BLOCK_TAGS = [
    'p', 'section', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr',
    'div', 'ul', 'ol', 'li', 'pre', 'hr'
  ];

  function isTextBlock(tag) {
    return TEXT_BLOCK_TAGS.indexOf(tag) >= 0;
  }

  /**
   * 这个元素内部的空白是不是「有意义」的。
   * 代码块靠 white-space:pre-wrap 保住换行与缩进，纯文本兜底与源码格式化
   * 都必须对它原样放行——把它当普通段落压掉空格，代码就废了。
   */
  function preservesSpace(el) {
    const ws = el.style && el.style.whiteSpace;
    return ws === 'pre' || ws === 'pre-wrap' || ws === 'pre-line' || ws === 'break-spaces';
  }

  /**
   * 用 <template> 承载待分析的 HTML 字符串。
   * 两个理由，缺一不可：
   *   1. template 的内容不参与渲染、不加载图片——把外链 <img> 塞进去不会发起请求。
   *      这里只做字符串变换，不该有网络副作用。
   *   2. 它仍然是真解析器：表格、嵌套结构都能得到一个正常的 DOM 树，
   *      用正则去啃 HTML 只会在代码块里的尖括号上翻车。
   */
  function parseFragment(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html == null ? '' : html);
    return tpl.content;
  }

  /* ==================== 第一层：异步 Clipboard API ==================== */

  function clipboardApi() {
    return global.navigator && global.navigator.clipboard ? global.navigator.clipboard : null;
  }

  /**
   * 写富文本。
   * 用 Blob 而不是字符串：ClipboardItem 对字符串的支持比 Blob 晚，
   * 而 Blob 从一开始就在规范里。
   * 失败原因很多（没权限、file:// 下 document 失焦、不支持 ClipboardItem），
   * 全部统一成 false —— 调用方只需知道「该走第二层了」，
   * 它也没法按原因分头处理。
   */
  function writeRichViaApi(html, text) {
    const api = clipboardApi();
    if (!api || typeof api.write !== 'function' || !global.ClipboardItem) {
      return Promise.resolve(false);
    }

    let item = null;
    try {
      item = new global.ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' })
      });
    } catch (err) {
      // 构造就抛错 = 这个浏览器只认别的写法，直接让第二层接手。
      // 这是能力探测，不是吞异常：结果会被如实回报成 'exec' 或 'failed'。
      item = null;
    }
    if (!item) return Promise.resolve(false);

    try {
      // write() 必须在用户手势的同步调用栈里发起，所以这里不放进 then 里延迟调用。
      return api.write([item]).then(function () { return true; }, function () { return false; });
    } catch (err) {
      return Promise.resolve(false);
    }
  }

  function writeTextViaApi(text) {
    const api = clipboardApi();
    if (!api || typeof api.writeText !== 'function') return Promise.resolve(false);
    try {
      return api.writeText(text).then(function () { return true; }, function () { return false; });
    } catch (err) {
      return Promise.resolve(false);
    }
  }

  /* ==================== 第二层：execCommand ==================== */

  /**
   * 造一个「可见但看不见」的容器。
   * 为什么不能用 display:none / visibility:hidden：
   *   隐藏的元素建立不了 Range 选区，execCommand('copy') 复制到的会是空的，
   *   而且这个失败是静默的——现象是「点了复制，粘出来什么都没有」，极难查。
   * 所以走 position:fixed + 移到屏幕外 + opacity:0：元素照常参与排版
   * （选区能建立），但用户看不见，也不会撑出滚动条。
   */
  function hiddenHolder() {
    const holder = document.createElement('div');
    // contenteditable 是关键：只有可编辑区域里的内容才会被 execCommand 当「选中内容」复制
    holder.setAttribute('contenteditable', 'true');
    holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText = 'position:fixed;top:0;left:-10000px;width:1px;height:1px;'
      + 'opacity:0;overflow:hidden;';
    return holder;
  }

  /**
   * 把 holder 的内容选中并复制，然后无条件把它移出文档。
   * 返回 execCommand 的布尔结果。
   */
  function copyThroughSelection(holder) {
    document.body.appendChild(holder);

    const selection = global.getSelection ? global.getSelection() : null;
    // 先记下用户原来的光标：复制产物不该顺手把人家在正文里的插入点弄丢
    const saved = selection && selection.rangeCount ? selection.getRangeAt(0) : null;

    let ok = false;
    try {
      // preventScroll：容器虽然在屏幕外，聚焦仍可能让浏览器去「滚到它那里」
      if (holder.focus) holder.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(holder);
      selection.removeAllRanges();
      selection.addRange(range);
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    } finally {
      // 这个 finally 是本函数的重点：不管成功、失败还是中途抛错，容器都必须离场。
      // 留在页面里它就是个不可见的 contenteditable，用户按一下 Tab 就会跳进去。
      try {
        if (selection) {
          selection.removeAllRanges();
          if (saved && saved.startContainer && saved.startContainer.isConnected) {
            selection.addRange(saved);
          }
        }
      } catch (err) {
        // 光标恢复失败不影响剪贴板结果（内容已经写进去了），
        // 所以这里不能把它升级成「复制失败」——最多用户丢一次插入点位置。
      }
      if (holder.parentNode) holder.parentNode.removeChild(holder);
    }
    return ok;
  }

  function writeRichViaExec(html) {
    if (!document.body || typeof document.execCommand !== 'function') return false;
    const holder = hiddenHolder();
    // 容器里放的就是 pipeline 的 out.html —— 复制出去的那一份与预览看到的是同一个字符串
    holder.innerHTML = html;
    return copyThroughSelection(holder);
  }

  function writeTextViaExec(text) {
    if (!document.body || typeof document.execCommand !== 'function') return false;
    const holder = hiddenHolder();
    // pre-wrap 是必须的：不加它，纯文本里的换行在复制时会被折叠成空格，
    // 粘出去就是一大段没有段落的话。
    holder.style.whiteSpace = 'pre-wrap';
    holder.textContent = text;
    return copyThroughSelection(holder);
  }

  /* ==================== 产物 → 纯文本 ==================== */

  function lastChar(chunks) {
    for (let i = chunks.length - 1; i >= 0; i--) {
      if (chunks[i].length) return chunks[i].charAt(chunks[i].length - 1);
    }
    return '';
  }

  function breakLine(chunks) {
    if (chunks.length && lastChar(chunks) !== '\n') chunks.push('\n');
  }

  function walkText(node, chunks, pre) {
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];

      if (child.nodeType === 3) {
        const raw = child.nodeValue || '';
        // 非保留空白区：连续空白压成一个空格（段落换行交给块级标签还原）。
        // 放在这里而不是最后统一做，是为了不把代码块里的缩进一起压掉。
        chunks.push(pre ? raw : raw.replace(/\s+/g, ' '));
        continue;
      }
      if (child.nodeType !== 1) continue;

      const tag = child.tagName.toLowerCase();

      if (tag === 'br') { chunks.push('\n'); continue; }
      if (tag === 'hr') { breakLine(chunks); chunks.push('----------\n'); continue; }
      if (tag === 'img') {
        // 图片本身带不过去，alt 是它唯一还能留下的信息
        const alt = child.getAttribute('alt');
        if (alt) chunks.push('[' + alt + ']');
        continue;
      }
      if (tag === 'td' || tag === 'th') {
        // 表格用制表符分列：粘到别的表格里能自动分格，粘到纯文本里也看得出边界
        const last = lastChar(chunks);
        if (last !== '\n' && last !== '\t' && last !== '') chunks.push('\t');
        walkText(child, chunks, pre);
        continue;
      }

      const childPre = pre || preservesSpace(child);
      if (isTextBlock(tag)) {
        breakLine(chunks);
        walkText(child, chunks, childPre);
        breakLine(chunks);
      } else {
        walkText(child, chunks, childPre);
      }
    }
  }

  /**
   * 产物 → 纯文本。保留段落换行、列表符号（列表符号已经是产物里的真字符）、
   * 代码块缩进，去掉所有标签。
   */
  function htmlToText(html) {
    const chunks = [];
    walkText(parseFragment(html), chunks, false);

    return chunks.join('')
      .replace(/[ \t]+\n/g, '\n')   // 去掉行尾空白
      .replace(/\n{3,}/g, '\n\n')   // 连续空行最多留一行
      .replace(/^\s+|\s+$/g, '');
  }

  /* ==================== 产物 → 缩进后的源码 ==================== */

  /**
   * 产物里的行内标签。它们出现在哪一行就留在哪一行，
   * 一旦在它们之间换行，粘进「源码模式」就可能凭空多出一个空格。
   */
  const INLINE_TAGS = ['a', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'br', 'img'];

  function attrText(el) {
    const attrs = el.attributes;
    let out = '';
    for (let i = 0; i < attrs.length; i++) {
      out += ' ' + attrs[i].name + '="' + MW.util.escapeHtml(attrs[i].value) + '"';
    }
    return out;
  }

  /** 子节点全是文字或行内标签 → 这一整块留在同一行。 */
  function hasOnlyInlineContent(el) {
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (child.nodeType !== 1) continue;
      if (INLINE_TAGS.indexOf(child.tagName.toLowerCase()) < 0) return false;
    }
    return true;
  }

  function indentOf(depth) {
    let s = '';
    for (let i = 0; i < depth; i++) s += '  ';
    return s;
  }

  function formatElement(el, depth, lines) {
    const tag = el.tagName.toLowerCase();

    // 代码块（以及任何 pre 空白区）整段原样输出，绝不拆行：
    // 往 pre-wrap 的内容里插一个换行，粘到公众号的源码模式里就真的多出一空行。
    if (preservesSpace(el) || hasOnlyInlineContent(el)) {
      lines.push(indentOf(depth) + el.outerHTML);
      return;
    }

    lines.push(indentOf(depth) + '<' + tag + attrText(el) + '>');
    formatChildren(el, depth + 1, lines);
    lines.push(indentOf(depth) + '</' + tag + '>');
  }

  function formatChildren(parent, depth, lines) {
    const kids = parent.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (child.nodeType === 1) {
        formatElement(child, depth, lines);
      } else if (child.nodeType === 3) {
        const text = child.nodeValue || '';
        // 标签之间的空白在产物里没有意义，丢掉它才不会出现一堆空行
        if (text.trim()) lines.push(indentOf(depth) + MW.util.escapeHtml(text));
      }
    }
  }

  /**
   * 产物 → 带缩进的源码字符串。
   * 为什么不用「正则给每个 > 后面加换行」这种一行写法：
   * 那会把代码块内容、行内 strong/span 之间的文字一起拆开，
   * 粘进公众号的源码模式后，行内元素之间多出的空白会变成肉眼可见的空格。
   * 所以这里走 DOM：只在「块级元素的边界」换行，行内一律整段带走。
   */
  function formatHtml(html) {
    const lines = [];
    formatChildren(parseFragment(html), 0, lines);
    return lines.join('\n');
  }

  /* ==================== 对外入口 ==================== */

  /**
   * 富文本复制。返回 'api' / 'exec' / 'failed'。
   * 返回 Promise 而不是布尔：第一层天生是异步的，调用方从第一天起按 Promise 写，
   * 这里再换代实现时不用动任何调用点。
   */
  function copyRich(html, text) {
    const rich = String(html == null ? '' : html);
    const plain = text == null ? htmlToText(rich) : String(text);

    return writeRichViaApi(rich, plain).then(function (ok) {
      if (ok) return VIA_API;
      return writeRichViaExec(rich) ? VIA_EXEC : FAILED;
    });
  }

  /** 只写纯文本。用于富文本两层都失败时的兜底，以及「复制源码」。 */
  function copyText(text) {
    const plain = String(text == null ? '' : text);
    return writeTextViaApi(plain).then(function (ok) {
      if (ok) return true;
      return writeTextViaExec(plain);
    });
  }

  MW.clipboard = {
    PHASE: PHASE,
    copyRich: copyRich,
    copyText: copyText,
    htmlToText: htmlToText,
    formatHtml: formatHtml
  };
})(window);
