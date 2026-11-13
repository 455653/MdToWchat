/*
 * media.js —— P5 多媒体内容内嵌
 *
 * 微信编辑器对外部资源的处理方式决定了这个文件存在的理由：
 *   · 外链图片（http/https）在粘贴时提示「上传失败」，图片位置剩一个叉或空白；
 *   · WebP、SVG、Canvas 一律不被支持；
 *   · 内联 SVG 会被整体剥掉（whitelist 的 DROP_TAGS 里就有 svg / canvas / iframe）。
 * 所以产物里唯一能站住的图片形式是「PNG 的 data: URI」：它自带像素、不依赖网络、
 * 也不依赖任何被剥掉的标签。公式与图表因此都必须先在本机栅格化成 PNG。
 *
 * 本文件分两段生命周期，落点由 pipeline.js 固定：
 *   prepare(holder)  —— 同步，在「代码块套容器」之前跑。
 *                       此刻 mermaid 还是 <pre><code class="language-mermaid">，
 *                       一眼可辨；等 wrapCodeBlocks 把它包成 section，再想认出
 *                       哪一块是图表就只能靠猜。公式也一样，得在代码块被改形之前
 *                       把文字节点摘出来，否则 <pre> 里的 $x^2$ 会被当成公式。
 *   render(holder)   —— 异步，在「固化之前」跑（固化读的是最终布局，
 *                       晚插进来的节点不会被固化）。它负责真正加载 MathJax /
 *                       Mermaid、栅格化，并把结果替换回 DOM。
 *
 * 三条不许破的边界：
 *   1. 不许 fetch / XMLHttpRequest 读任何东西。外链图片不下载，改成本地生成的占位图，
 *      原地址写进 alt 与 data-mw-src 留底；想还原就由用户手动选本地文件映射。
 *   2. 不许把 data: URI 写进 style 属性。inline-styles.js 的 parseStyle 是按 ';' 拆的，
 *      而 base64 里会出现 ';'（charset 参数）与 ':'，写进 style 会把那一步拆碎。
 *      图片一律走 <img src="data:...">。
 *   3. 渲染失败必须让原文可见。fixtures 09/10 里的空块与语法错误块，
 *      宁可显示成代码文本，也绝不能显示成空白——「一片空白」是最难查的现象。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  /** 本文件实现到第 5 阶段。 */
  const PHASE = 5;

  /* ==================== 常量 ==================== */

  /** 图片最长边上限。1200px 在 375px 舞台上以 2 倍以上 DPR 看仍然清晰，再大只是浪费体积。 */
  const MAX_EDGE = 1200;
  const JPEG_QUALITY = 0.82;
  /** PNG 压缩后超过这个体积就转 JPEG（白底）。照片类内容 PNG 往往比 JPEG 大一个量级。 */
  const PNG_BUDGET = 400 * 1024;
  /** 单图与全篇的告警线。不做硬性拦截：把「图上不去」变成「什么都复制不了」是更差的交换。 */
  const WARN_IMAGE = 500 * 1024;
  const WARN_TOTAL = 4 * 1024 * 1024;

  /** 公式按 3 倍栅格化：公式里常有上下标与分式，1 倍会糊。 */
  const MATH_SCALE = 3;
  /** 图表按 2.5 倍：节点里的字号本来就大，2.5 倍足够，再高体积涨得快。 */
  const MERMAID_SCALE = 2.5;
  /** MathJax 的 viewBox 单位是「每 em 1000 单位」，按 16px 正文换算成像素。 */
  const MATH_EM = 16;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';

  /** 图片统一写法：块级、居中、最大宽度撑满。
   *  display:block 只能在这里自己写——固化器的 INLINE_PROPS 里没有 display
   *  （见 whitelist 的注释），而 A4 只禁 flex / grid / position，block 是安全的。
   *  宽度一律交给 max-width:100%，绝不写死 px（A6 的红线）。 */
  const IMG_STYLE = 'max-width:100%;height:auto;display:block;margin:0 auto;';

  /* ==================== 工具 ==================== */

  /** 本脚本自己的 URL。 */
  const SELF = document.currentScript;

  /**
   * 拼出 vendor 文件的绝对地址。
   *
   * 为什么不用页面的相对路径：index.html 在 code/ 下，test/assert.html 在 code/test/ 下，
   * 两者到 vendor/ 的相对路径不一样（vendor/ 与 ../vendor/）。
   * 拿本脚本（src/media.js）的 URL 反推一层，两个页面都能算对。
   */
  function vendorUrl(file) {
    let base = '';
    if (SELF && SELF.src) {
      base = SELF.src.replace(/[^\/]*$/, '');
    } else {
      const list = document.getElementsByTagName('script');
      for (let i = list.length - 1; i >= 0; i--) {
        const src = list[i].getAttribute('src') || '';
        if (/media\.js(\?|$)/.test(src)) { base = list[i].src.replace(/[^\/]*$/, ''); break; }
      }
    }
    return base + '../vendor/' + file;
  }

  /** 动态注入脚本。file:// 下「动态」注入的 script 会正常触发 error，静态标签不会。 */
  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('无法加载 ' + url)); };
      document.head.appendChild(script);
    });
  }

  /** 估算 data: URI 的实际字节数（base64 每 4 个字符 3 字节，末尾的 = 不算）。 */
  function dataUriBytes(uri) {
    const text = String(uri || '');
    const comma = text.indexOf(',');
    if (comma < 0) return text.length;
    const head = text.slice(0, comma);
    const body = text.slice(comma + 1);
    if (/;base64$/i.test(head) || /;base64;/i.test(head)) {
      const pad = body.slice(-2) === '==' ? 2 : (body.slice(-1) === '=' ? 1 : 0);
      return Math.max(0, Math.floor(body.length * 3 / 4) - pad);
    }
    try { return decodeURIComponent(body).length; } catch (err) { return body.length; }
  }

  function fitSize(width, height, maxEdge) {
    const longest = Math.max(width, height);
    if (longest <= maxEdge) return { w: Math.round(width), h: Math.round(height) };
    const ratio = maxEdge / longest;
    return { w: Math.max(1, Math.round(width * ratio)), h: Math.max(1, Math.round(height * ratio)) };
  }

  /** 把地址截短到可读长度；data: URI 不能整条塞进占位图。 */
  function shortSrc(raw) {
    const text = String(raw || '');
    if (/^data:/i.test(text)) return '（已内嵌的本地数据）';
    return text.length > 78 ? text.slice(0, 75) + '…' : text;
  }

  /** 取地址里的文件名，用于「本地图片映射」。 */
  function basenameOf(raw) {
    let text = String(raw || '').split('#')[0].split('?')[0];
    const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    text = text.slice(cut + 1);
    try { text = decodeURIComponent(text); } catch (err) { /* 保持原样 */ }
    return text;
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('图片解码失败')); };
      img.src = src;
    });
  }

  /**
   * 画布导出。先试 PNG；超预算就铺白底转 JPEG。
   * 铺白底这一步不能省：JPEG 没有 alpha 通道，透明像素会被涂成黑色，
   * 而正文里的截图多半是白底、四周透明。
   */
  function exportDataUri(canvas) {
    const png = canvas.toDataURL('image/png');
    if (dataUriBytes(png) <= PNG_BUDGET) return png;

    const flat = document.createElement('canvas');
    flat.width = canvas.width;
    flat.height = canvas.height;
    const ctx = flat.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(canvas, 0, 0);
    return flat.toDataURL('image/jpeg', JPEG_QUALITY);
  }

  /* ==================== 图片 ==================== */

  /**
   * 判定一个 src 能不能读到像素。
   *   data:           能（已经在本机）
   *   本地文件映射中  能（用户手动选过同名文件）
   *   其余            不能。http/https 不许自动下载（硬约束 3 与本阶段的明确要求），
   *                   相对路径在 file:// 下也读不到，统一落占位图。
   */
  function resolveSource(raw, localImages) {
    const text = String(raw || '');
    if (/^data:/i.test(text)) return { kind: 'data', value: text };

    // 有协议头就是远端。排除 Windows 盘符（C:\...），它不是协议。
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) {
      return { kind: 'remote', value: text };
    }

    const name = basenameOf(text);
    if (name) {
      if (localImages[name]) return { kind: 'local', value: localImages[name] };
      const lower = name.toLowerCase();
      if (localImages[lower]) return { kind: 'local', value: localImages[lower] };
    }
    return { kind: 'remote', value: text };
  }

  /** 按字符宽度折行（中英混排没有空格可依，只能按字符量）。 */
  function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
    const chars = String(text || '').split('');
    let line = '';
    let lines = 0;
    for (let i = 0; i < chars.length; i++) {
      const test = line + chars[i];
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, y + lines * lineHeight);
        lines++;
        line = chars[i];
        if (lines >= maxLines - 1) {
          // 最后一行塞不下的部分用省略号收尾，宁可截断也不让它溢出画布
          let rest = '';
          for (let j = i; j < chars.length; j++) rest += chars[j];
          while (rest && ctx.measureText(line + '…').width < maxWidth) {
            line += rest.charAt(0);
            rest = rest.slice(1);
          }
          ctx.fillText(line + (rest ? '…' : ''), x, y + lines * lineHeight);
          return;
        }
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, x, y + lines * lineHeight);
  }

  /**
   * 生成占位图。
   * 为什么不是「把外链原样留着，让用户自己决定」：产物是要粘进公众号的终态，
   * 留一个外链 src 等于留一个必然失败的结果；而把图整块删掉又会让用户
   * 找不到「这里本来有张图」。占位图两头都占：位置在、地址在、还提示了解法。
   */
  function makePlaceholder(main, sub) {
    const W = 640;
    const H = 220;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#f7f8fa';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = '#cfd3d9';
    ctx.lineWidth = 2;
    if (ctx.setLineDash) ctx.setLineDash([8, 6]);
    ctx.strokeRect(1, 1, W - 2, H - 2);
    if (ctx.setLineDash) ctx.setLineDash([]);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = '#8a9099';
    ctx.font = '600 22px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText('图片未内嵌', W / 2, H / 2 - 30);

    ctx.font = '15px Consolas, Menlo, "Courier New", monospace';
    wrapText(ctx, main, W / 2, H / 2 + 12, W - 64, 22, 2);

    ctx.fillStyle = '#a7adb6';
    ctx.font = '13px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText('外链图片公众号会提示「上传失败」，地址已记在 alt 里', W / 2, H - 28);

    return canvas.toDataURL('image/png');
  }

  /** 解码 → 缩放 → 重新编码。这是「所有图片都变成 PNG data: URI」的落点。 */
  function shrinkToDataUri(source) {
    return loadImage(source).then(function (img) {
      const w0 = img.naturalWidth || img.width;
      const h0 = img.naturalHeight || img.height;
      if (!w0 || !h0) throw new Error('图片尺寸为 0');

      const size = fitSize(w0, h0, MAX_EDGE);
      const canvas = document.createElement('canvas');
      canvas.width = size.w;
      canvas.height = size.h;
      const ctx = canvas.getContext('2d');
      // 透明底先铺白：JPEG 分支需要，PNG 分支铺了也无害（正文本身就是白底）
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size.w, size.h);
      ctx.drawImage(img, 0, 0, size.w, size.h);
      return exportDataUri(canvas);
    });
  }

  async function processImages(root, state, report) {
    const imgs = Array.prototype.slice.call(root.querySelectorAll('img'));
    const result = { total: imgs.length, done: 0, failed: 0, placeholders: 0, bytes: 0, warnings: [] };
    if (!imgs.length) return result;

    report.label('正在内嵌图片');

    // 超限图先只记数，循环结束后汇总成一条告警。
    // 逐张报会给一篇有大图的文章弹出十几个 toast，那等于没有提示。
    let oversized = 0;
    let oversizedMax = 0;

    for (let i = 0; i < imgs.length; i++) {
      const el = imgs[i];
      const raw = el.getAttribute('src') || '';
      const alt = el.getAttribute('alt') || '';
      let dataUri = null;
      let placeholder = false;

      // 同一张图在文中出现多次时复用同一份 data: URI：
      // 重复内嵌会把产物体积按出现次数翻倍，而它们本来就是同一张图。
      if (raw && state.cache.has(raw)) {
        dataUri = state.cache.get(raw);
        placeholder = state.placeholders.has(raw);
      } else {
        const resolved = resolveSource(raw, state.localImages);
        if (resolved.kind === 'data' || resolved.kind === 'local') {
          try {
            dataUri = await shrinkToDataUri(resolved.value);
          } catch (err) {
            // 解不开就落占位：一张图坏了不该让整篇文章渲染不出来
            dataUri = null;
          }
        }
        if (!dataUri) {
          dataUri = makePlaceholder(alt || '图片', shortSrc(raw));
          placeholder = true;
        }
        if (raw) {
          state.cache.set(raw, dataUri);
          if (placeholder) state.placeholders.add(raw);
        }
      }

      if (placeholder) result.placeholders++;

      const bytes = dataUriBytes(dataUri);
      result.bytes += bytes;
      if (bytes > WARN_IMAGE) {
        oversized++;
        if (bytes > oversizedMax) oversizedMax = bytes;
      }

      el.setAttribute('src', dataUri);
      // alt 不能空着：剪贴板的纯文本导出会把 alt 当作图片的替身文字（见 clipboard.js）
      if (!alt) el.setAttribute('alt', shortSrc(raw) || '图片');
      el.setAttribute('style', IMG_STYLE);
      result.done++;
      report.step();
    }

    if (oversized) {
      result.warnings.push('有 ' + oversized + ' 张图片内嵌后仍有 '
        + MW.util.formatBytes(oversizedMax) + '（最大的一张），粘贴与加载都会变慢。');
    }
    return result;
  }

  /* ==================== 公式 ==================== */

  /**
   * 从文字里切出公式片段。
   *
   * 判据里最要紧的一条是「闭定界符后面不能紧跟数字」：
   * 09-math.md 里那句「价格是 $100 和 $200」如果按「一对 $ 就是公式」去切，
   * 会切出 "$100 和 $" 这种把一句话拦腰截断的东西。
   * 钱数的 $ 后面一定跟着数字（$100、$2.5），公式的 $ 后面不会。
   *
   * $$…$$ 与 \[…\] 是块级，$…$ 与 \(…\) 是行内。整体按「块级优先」匹配，
   * 否则 $$ 会被先当成两个行内的 $ 各自配一次。
   */
  const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g;

  function splitMath(text) {
    const parts = [];
    let last = 0;
    let matched = false;

    MATH_RE.lastIndex = 0;
    let m;
    while ((m = MATH_RE.exec(text)) !== null) {
      const inlineDollar = m[3] != null;
      const display = m[1] != null || m[2] != null;
      const inner = display ? (m[1] != null ? m[1] : m[2]) : (inlineDollar ? m[3] : m[4]);

      let ok = String(inner).trim() !== '';
      if (ok && inlineDollar) {
        const after = text.charAt(m.index + m[0].length);
        if (/\d/.test(after)) ok = false; // $100 和 $200 → 是钱，不是公式
      }
      if (!ok) {
        // 这一处不成立，从它的下一个字符继续找，避免整段被一个假定界符带偏
        MATH_RE.lastIndex = m.index + 1;
        continue;
      }

      if (m.index > last) parts.push({ type: 'text', value: text.slice(last, m.index) });
      parts.push({ type: 'math', value: m[0], inner: String(inner), display: display });
      last = m.index + m[0].length;
      matched = true;
    }

    if (!matched) return null;
    if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
    return parts;
  }

  function collectTextNodes(node, out) {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) { out.push(child); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.nodeName.toLowerCase();
      // 代码块里的 $x^2$ 是待显示的代码，不是公式
      if (tag === 'pre' || tag === 'code') continue;
      if (child.hasAttribute && child.hasAttribute('data-mw-math')) continue;
      collectTextNodes(child, out);
    }
  }

  /** 把 mermaid 围栏与公式从正文里摘出来，换成带标记的占位节点。同步执行。 */
  function prepare(holder) {
    if (!holder) return;

    // 1) mermaid 围栏：此刻还是 <pre><code class="language-mermaid">…</code></pre>
    const codes = Array.prototype.slice.call(holder.querySelectorAll('pre > code'));
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      const classes = String(code.getAttribute('class') || '');
      if (!/(^|\s)language-mermaid(\s|$)/.test(classes)) continue;
      const pre = code.parentNode;
      if (!pre || !pre.parentNode) continue;

      const box = document.createElement('div');
      box.setAttribute('data-mw-mermaid', '');
      // 原文先原样存着：渲染失败要一个字不差地吐回去
      box.textContent = code.textContent || '';
      pre.parentNode.replaceChild(box, pre);
    }

    // 2) 公式：只在文字节点上做，且跳过代码块
    const nodes = [];
    collectTextNodes(holder, nodes);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const parts = splitMath(node.data);
      if (!parts) continue;

      const frag = document.createDocumentFragment();
      parts.forEach(function (part) {
        if (part.type === 'text') {
          frag.appendChild(document.createTextNode(part.value));
          return;
        }
        const span = document.createElement('span');
        span.setAttribute('data-mw-math', part.display ? 'display' : 'inline');
        // 统一换成正斜杠定界符再交给 MathJax：
        //   · \(…\) / \[…\] 是 MathJax 最可靠的两种定界符，不用去依赖它对 $ 的宽容度；
        //   · 原文另存一份，渲染失败时用它还原，用户看到的还是自己写的 $…$。
        span.setAttribute('data-mw-raw', part.value);
        span.textContent = part.display
          ? '\\[' + part.inner + '\\]'
          : '\\(' + part.inner + '\\)';
        frag.appendChild(span);
      });
      node.parentNode.replaceChild(frag, node);
    }
  }

  /** 公式渲染失败：还原成用户写的原文，并摘掉标记（免得后续再被当作公式处理）。 */
  function restoreMath(span) {
    const raw = span.getAttribute('data-mw-raw');
    if (raw != null) span.textContent = raw;
    span.removeAttribute('data-mw-raw');
    span.removeAttribute('data-mw-math');
  }

  let mathjaxPromise = null;

  function ensureMathJax() {
    if (global.MathJax && global.MathJax.typesetPromise) return Promise.resolve();
    if (mathjaxPromise) return mathjaxPromise;

    // 配置必须在脚本加载「之前」挂上：MathJax 启动时读一次，
    // 加载完再改它已经带着默认配置跑起来了。
    if (!global.MathJax) {
      global.MathJax = {
        tex: {
          inlineMath: [['\\(', '\\)']],
          displayMath: [['\\[', '\\]']],
          processEscapes: true
        },
        /*
         * fontCache: 'local' 是这一步的关键。
         * 默认的 'global' 把字形路径集中放在文档里一个隐藏 <svg> 里，每处公式用
         * <use xlink:href="#MJX-…"> 引用。而我们要做的是「把单个 SVG 序列化成
         * data: URI 再当图片画到 canvas 上」——在图片文档里，指向另一个文档的
         * <use> 不会被解析，画出来就是一张空图（表现为「公式全没了」，极难查）。
         * 'local' 让每个公式的 SVG 自带 <defs>，序列化出去就是自洽的。
         * 下面 inlineGlobalDefs() 还留了一道兜底。
         */
        svg: { fontCache: 'local' },
        // 关掉菜单与无障碍 MathML：产物里不需要交互，也不需要 <math> 标签
        options: { enableMenu: false, enableAssistiveMml: false },
        // 不许它一加载就 typeset 整页：那会把应用外壳也排一遍，又慢又没意义
        startup: { typeset: false }
      };
    }

    mathjaxPromise = loadScript(vendorUrl('mathjax-tex-svg.js')).catch(function (err) {
      mathjaxPromise = null;
      throw err;
    });
    return mathjaxPromise;
  }

  /**
   * 兜底：若字形仍以 <use> 引用文档级缓存，就把被引用到的节点搬进这份克隆里。
   * 正常情况下 fontCache:'local' 已经解决，这里是为了「配置没生效」时不至于画出一张白图。
   */
  function inlineGlobalDefs(clone) {
    const uses = clone.querySelectorAll('use');
    if (!uses.length) return;

    const ids = {};
    for (let i = 0; i < uses.length; i++) {
      const href = uses[i].getAttribute('xlink:href') || uses[i].getAttribute('href') || '';
      if (href.charAt(0) === '#') ids[href.slice(1)] = true;
    }
    const keys = Object.keys(ids);
    if (!keys.length) return;

    const cache = document.getElementById('MJX-SVG-global-cache');
    if (!cache) return;

    const defs = document.createElementNS(SVG_NS, 'defs');
    let moved = false;
    keys.forEach(function (id) {
      const source = cache.querySelector('#' + id);
      if (!source) return;
      defs.appendChild(source.cloneNode(true));
      moved = true;
    });
    if (moved) clone.insertBefore(defs, clone.firstChild);
  }

  /**
   * 把 SVG 画成 PNG data: URI。
   * 走的是「SVG 字符串 → data: URI → <img> → canvas」这条路，
   * 全程离线，不碰网络；canvas 也不会被 data: URI 污染，toDataURL 是可用的。
   */
  function rasterize(svg, pxWidth, pxHeight, vbWidth, vbHeight) {
    return new Promise(function (resolve, reject) {
      const w = Math.max(1, Math.round(pxWidth));
      const h = Math.max(1, Math.round(pxHeight));

      const clone = svg.cloneNode(true);
      clone.setAttribute('xmlns', SVG_NS);
      clone.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:xlink', XLINK_NS);
      if (!clone.getAttribute('viewBox')) {
        clone.setAttribute('viewBox', '0 0 ' + vbWidth + ' ' + vbHeight);
      }
      clone.setAttribute('width', String(w));
      clone.setAttribute('height', String(h));
      // 摘掉 vertical-align / max-width 这类只对网页布局有意义的声明
      clone.removeAttribute('style');
      inlineGlobalDefs(clone);

      let serialized;
      try {
        serialized = new XMLSerializer().serializeToString(clone);
      } catch (err) {
        reject(err);
        return;
      }

      const img = new Image();
      img.onload = function () {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve(exportDataUri(canvas));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = function () { reject(new Error('SVG 无法栅格化')); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(serialized);
    });
  }

  /** MathJax 的 viewBox 以「每 em 1000 单位」计量，按 16px 正文换算成像素再乘倍数。 */
  function mathSvgToPng(svg) {
    const vb = svg.getAttribute('viewBox');
    if (!vb) throw new Error('公式缺少 viewBox');
    const nums = vb.trim().split(/[\s,]+/).map(Number);
    const w = nums[2] / 1000 * MATH_EM;
    const h = nums[3] / 1000 * MATH_EM;
    if (!w || !h) throw new Error('公式尺寸为 0');
    return rasterize(svg, w * MATH_SCALE, h * MATH_SCALE, nums[2], nums[3]);
  }

  async function renderMath(holder, report) {
    const spans = Array.prototype.slice.call(holder.querySelectorAll('[data-mw-math]'));
    const result = { total: spans.length, done: 0, failed: 0 };
    if (!spans.length) return result;

    report.label('正在加载公式引擎');

    try {
      await ensureMathJax();
      await global.MathJax.startup.promise;
      await global.MathJax.typesetPromise(spans);
    } catch (err) {
      spans.forEach(restoreMath);
      result.failed = spans.length;
      report.fail('公式引擎不可用（' + err.message + '），公式已按原文显示');
      for (let i = 0; i < spans.length; i++) report.step();
      return result;
    }

    report.label('正在栅格化公式');

    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      // typesetPromise 完成后，MathJax 会在原位置生成 <mjx-container>，其内是我们能拿到的 SVG
      const container = span.querySelector('mjx-container');
      const svg = container ? container.querySelector('svg') : null;
      if (!svg) {
        restoreMath(span);
        result.failed++;
        report.step();
        continue;
      }

      const display = span.getAttribute('data-mw-math') === 'display';
      try {
        const png = await mathSvgToPng(svg);
        const img = document.createElement('img');
        img.setAttribute('src', png);
        img.setAttribute('alt', (span.getAttribute('data-mw-raw') || '公式').slice(0, 120));
        img.setAttribute('style', display
          ? 'max-width:100%;height:auto;display:block;margin:12px auto;'
          : 'max-width:100%;height:auto;vertical-align:middle;');
        span.parentNode.replaceChild(img, span);
        result.done++;
      } catch (err) {
        restoreMath(span);
        result.failed++;
      }
      report.step();
    }
    return result;
  }

  /* ==================== 图表 ==================== */

  let mermaidPromise = null;

  function ensureMermaid() {
    if (global.mermaid && global.mermaid.render) return Promise.resolve();
    if (mermaidPromise) return mermaidPromise;

    mermaidPromise = loadScript(vendorUrl('mermaid.min.js')).then(function () {
      if (!global.mermaid) throw new Error('mermaid 没有挂到全局变量上');
      global.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: 'neutral',
        fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
        /*
         * htmlLabels:false 不是为了「更规范」，是栅格化的硬前提。
         * mermaid 默认用 <foreignObject> 包住节点文字，而 SVG 一旦被当作图片
         * （我们正是这么用的），foreignObject 里的 HTML 不会被渲染——
         * 结果是一张只有线框、没有字的图，看起来像「文字被吃掉了」。
         * 换成 <text> 之后，序列化出去的 SVG 自带全部文字。
         *
         * useMaxWidth:false 让 SVG 写出真实像素宽高而不是 width="100%"，
         * 否则栅格化时算不出该画多大。
         */
        flowchart: { htmlLabels: false, useMaxWidth: false },
        class: { htmlLabels: false, useMaxWidth: false },
        state: { useMaxWidth: false },
        er: { useMaxWidth: false },
        sequence: { useMaxWidth: false },
        gantt: { useMaxWidth: false },
        journey: { useMaxWidth: false },
        pie: { useMaxWidth: false },
        gitGraph: { useMaxWidth: false }
      });
    }).catch(function (err) {
      mermaidPromise = null;
      throw err;
    });
    return mermaidPromise;
  }

  function mermaidSvgToPng(svg) {
    let w = parseFloat(svg.getAttribute('width'));
    let h = parseFloat(svg.getAttribute('height'));
    let vbW = 0;
    let vbH = 0;
    const vb = svg.getAttribute('viewBox');
    if (vb) {
      const nums = vb.trim().split(/[\s,]+/).map(Number);
      vbW = nums[2];
      vbH = nums[3];
    }
    if (!isFinite(w) || w <= 0) w = vbW;
    if (!isFinite(h) || h <= 0) h = vbH;
    if (!w || !h) throw new Error('图表尺寸为 0');
    return rasterize(svg, w * MERMAID_SCALE, h * MERMAID_SCALE, vbW || w, vbH || h);
  }

  /**
   * 图表渲染失败时的降级：把原始定义显示成代码块。
   * 10-mermaid.md 明确要求「没渲染成图就必须原样显示成代码文本，绝不能空白」，
   * 所以这里保留原文，并额外加一行说明——用户看到代码才知道该去改语法。
   */
  function fallbackMermaid(box, raw) {
    const section = document.createElement('section');
    section.setAttribute('style',
      'background:#f6f8fa;border-radius:6px;padding:12px 14px;');

    const label = document.createElement('p');
    label.setAttribute('style', 'font-weight:600;');
    label.textContent = 'mermaid 图表（未能渲染，按原文显示）';

    const pre = document.createElement('pre');
    pre.setAttribute('style', 'margin:0;color:#24292e;'
      + 'font-family:Consolas,Menlo,"Courier New","Microsoft YaHei",monospace;'
      + 'white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere;');
    pre.textContent = raw;

    section.appendChild(label);
    section.appendChild(pre);
    if (box.parentNode) box.parentNode.replaceChild(section, box);
  }

  /** mermaid 渲染失败时会在 body 里留下临时容器，不清掉会越积越多。 */
  function cleanupMermaidTemp(id) {
    const list = [id, 'd' + id];
    for (let i = 0; i < list.length; i++) {
      const node = document.getElementById(list[i]);
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
  }

  function parseSvg(text) {
    const doc = new DOMParser().parseFromString(String(text), 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('图表 SVG 解析失败');
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg') throw new Error('图表没有产出 SVG');
    return root;
  }

  async function renderMermaid(holder, report) {
    const boxes = Array.prototype.slice.call(holder.querySelectorAll('[data-mw-mermaid]'));
    const result = { total: boxes.length, done: 0, failed: 0 };
    if (!boxes.length) return result;

    report.label('正在加载图表引擎');

    let engine = null;
    let loadError = null;
    try {
      await ensureMermaid();
      engine = global.mermaid;
    } catch (err) {
      loadError = err;
    }

    if (loadError) {
      report.fail('图表引擎不可用（' + loadError.message + '），图表已按原文显示');
    } else {
      report.label('正在栅格化图表');
    }

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      const raw = box.textContent || '';

      if (!engine) {
        fallbackMermaid(box, raw);
        result.failed++;
        report.step();
        continue;
      }

      const id = 'mw-mermaid-' + Date.now().toString(36) + '-' + i;
      try {
        // 空定义与语法错误都在这里被挡下：交给 fallback，绝不留空白
        if (!raw.trim()) throw new Error('图表定义是空的');
        const rendered = await engine.render(id, raw);
        const svgText = rendered && rendered.svg;
        if (!svgText) throw new Error('图表没有产出 SVG');
        const png = await mermaidSvgToPng(parseSvg(svgText));

        const img = document.createElement('img');
        img.setAttribute('src', png);
        img.setAttribute('alt', '图表：' + raw.trim().split('\n')[0].slice(0, 60));
        img.setAttribute('style', IMG_STYLE);
        box.parentNode.replaceChild(img, box);
        result.done++;
      } catch (err) {
        cleanupMermaidTemp(id);
        fallbackMermaid(box, raw);
        result.failed++;
      }
      report.step();
    }
    return result;
  }

  /* ==================== 进度 ==================== */

  /**
   * 进度回报。
   * 分母是「这一轮要处理的媒体个数」，它在开始时就能数出来（图片数 + 公式数 + 图表数），
   * 所以进度条不会出现「先涨到 100% 再回退」这种假动作。
   */
  function makeReport(onProgress) {
    let total = 0;
    let done = 0;
    let label = '';

    function emit(extra) {
      if (typeof onProgress !== 'function') return;
      const payload = { done: done, total: total, label: label };
      if (extra) Object.keys(extra).forEach(function (key) { payload[key] = extra[key]; });
      onProgress(payload);
    }

    return {
      setTotal: function (n) { total = n; emit(); },
      label: function (text) { label = text; emit(); },
      step: function () { done++; emit(); },
      fail: function (message) { emit({ error: message }); },
      finish: function () { emit({ finished: true }); }
    };
  }

  /* ==================== 入口 ==================== */

  /**
   * 处理 root 里的全部多媒体内容。
   * @param {Element} root      当前正文容器（此时还没被固化）
   * @param {Object}  options   { images: { 文件名: dataURI }, onProgress }
   * @returns {Promise<Object>} 统计，供 pipeline 写进 meta.media
   */
  async function render(root, options) {
    const opts = options || {};
    const report = makeReport(opts.onProgress);

    const state = {
      /** src → data: URI。重复图片复用同一份，产物体积不按出现次数翻倍。 */
      cache: new Map(),
      /** src → 是否是占位图（复用缓存时要跟着一起复用这个判断） */
      placeholders: new Set(),
      /** 用户手动映射的本地图片：文件名 → data: URI */
      localImages: opts.images || {}
    };

    const summary = {
      images: 0, math: 0, mermaid: 0,
      placeholders: 0, failed: 0, bytes: 0, warnings: []
    };

    if (!root) { report.finish(); return summary; }

    // 分母先数出来：进度条一开始就要有准确的总量。
    // 标签先写上，否则进度条会有一瞬间显示成 0/0 而无文字。
    report.label('正在处理多媒体内容');
    report.setTotal(
      root.querySelectorAll('img').length
      + root.querySelectorAll('[data-mw-math]').length
      + root.querySelectorAll('[data-mw-mermaid]').length
    );

    // 顺序固定：图片 → 公式 → 图表。
    // 图片是同步的（解码即可），先做完能让用户最快看到「图出现」；
    // 两个大库按需加载，各自只在真的出现对应的东西时才会被注入。
    const images = await processImages(root, state, report);
    const math = await renderMath(root, report);
    const mermaid = await renderMermaid(root, report);

    summary.images = images.done;
    summary.math = math.done;
    summary.mermaid = mermaid.done;
    summary.placeholders = images.placeholders;
    summary.failed = images.failed + math.failed + mermaid.failed;
    summary.bytes = images.bytes;
    summary.warnings = images.warnings.slice();

    if (summary.placeholders) {
      summary.warnings.push(summary.placeholders + ' 张图片读不到像素（外链或相对路径），'
        + '已用占位图代替。原地址记在 alt 里，点顶栏「映射本地图片」选同名文件即可换回真图。');
    }
    if (summary.failed) {
      summary.warnings.push(summary.failed + ' 处公式或图表没能渲染，已按原文显示。');
    }
    if (summary.bytes > WARN_TOTAL) {
      summary.warnings.push('全文内嵌图片约 ' + MW.util.formatBytes(summary.bytes)
        + '，超过 4 MB。粘贴会明显变慢，建议先把大图压一下再插入。');
    }

    report.finish();
    return summary;
  }

  MW.media = {
    PHASE: PHASE,
    prepare: prepare,
    render: render,
    /** 供测试与排查使用 */
    splitMath: splitMath,
    dataUriBytes: dataUriBytes,
    MAX_EDGE: MAX_EDGE
  };
})(window);
