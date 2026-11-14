/*
 * selfcheck.js —— 页内自检
 *
 * 为什么这份数据不在 pipeline 里，而是一个独立文件：
 *   断言消费产物，不该长在生产链路上。pipeline 是「把 md 变成产物」，
 *   断言是「产物到底合不合格」——两者出错的原因和修法都不同，
 *   混在一起以后，读 pipeline 的人会以为断言也在参与渲染。
 *
 * 为什么这里又抄了一份 test/assert.html 的十条断言：
 *   验收要求「页面内『自检』按钮输出同样的结果」，而 assert.html 是验收基准，
 *   不能为了共用去改它（改了基准就等于自己给自己发合格证）。
 *   两份数据因此是刻意重复的：assert.html 那份是验收基准，这一份是产品内的自查。
 *   改断言时必须同时改两处——这条代价换的是「基准永远独立于产品代码」。
 *
 * 本文件只定义数据与一个纯函数 run(out)，不碰 DOM、不读 localStorage、
 * 不在加载期做任何事，所以放在 app.js 之前任意位置都可以。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  /** 与 pipeline.PHASE 对齐：低于等于它的断言才计分。 */
  const PHASE = 5;

  /**
   * 块级标签清单必须延迟取。
   * 在加载期取一次当然也能拿到（whitelist.js 排在前面），但那样就把
   * 「文件加载顺序」变成了一个隐性依赖；延迟到 run() 里取，
   * 顺序怎么变都不会静默退化成「所有标签都不是块级」（A5 会因此假通过）。
   */
  function blockTags() {
    return (MW.whitelist && MW.whitelist.BLOCK_TAGS) || [];
  }

  /** 遍历 root 自身与全部后代。断言要连根节点一起检查，根节点也在产物里。 */
  function eachElement(root, fn) {
    fn(root);
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) fn(all[i]);
  }

  function tagOf(el) { return el.tagName.toLowerCase(); }

  const ASSERTIONS = [
    {
      id: 'A1', phase: 0, title: '产物非空',
      desc: 'pipeline 返回带内容的 root：有子节点，且 innerHTML 不是空白',
      run: function (out) {
        const children = out.root ? out.root.children.length : 0;
        const ok = !!out.root && !out.meta.empty && out.html.trim().length > 0 && children > 0;
        return {
          ok: ok,
          detail: '子节点 ' + children + ' 个，HTML ' + out.html.length + ' 字符'
        };
      }
    },
    {
      id: 'A2', phase: 0, title: '产物内不含 class 属性',
      desc: '微信必剥 class，产物依赖 class 等于样式一定失效，所以一个都不许有',
      run: function (out) {
        const hit = out.root.hasAttribute('class') ? out.root : out.root.querySelector('[class]');
        if (!hit) return { ok: true, detail: '未发现 class 属性' };
        return {
          ok: false,
          detail: '<' + tagOf(hit) + ' class="' + (hit.getAttribute('class') || '') + '">'
        };
      }
    },
    {
      id: 'A3', phase: 2, title: '产物内不含 style / link 标签',
      desc: '<style> 与 <link> 会被微信整段剥掉，留着只会让人误以为样式生效了',
      run: function (out) {
        const self = (tagOf(out.root) === 'style' || tagOf(out.root) === 'link') ? out.root : null;
        const hit = self || out.root.querySelector('style, link');
        if (!hit) return { ok: true, detail: '未发现 style / link 标签' };
        return { ok: false, detail: '发现 <' + tagOf(hit) + '> 标签' };
      }
    },
    {
      id: 'A4', phase: 2, title: '产物内不含 flex / grid / position',
      desc: '这三类布局能力会被微信过滤，写了也不生效，属于必须提前避开的坑',
      run: function (out) {
        const bad = [];
        const isBad = function (text) {
          return /display\s*:\s*(?:inline-)?(?:flex|grid)/i.test(text) || /position\s*:/i.test(text);
        };
        eachElement(out.root, function (el) {
          const style = el.getAttribute('style') || '';
          if (isBad(style)) bad.push('<' + tagOf(el) + ' style="' + style + '">');
        });
        const styles = out.root.querySelectorAll('style');
        for (let i = 0; i < styles.length; i++) {
          if (isBad(styles[i].textContent)) bad.push('<style> 内出现布局属性');
        }
        if (!bad.length) return { ok: true, detail: '未发现 flex / grid / position' };
        return { ok: false, detail: bad.slice(0, 3).join('；') };
      }
    },
    {
      id: 'A5', phase: 2, title: '每个块级元素带内联 font-size',
      desc: '不带内联字号的块级元素会被微信的默认字号接管，行内样式必须逐个写死',
      run: function (out) {
        const blocks = blockTags();
        const missing = [];
        eachElement(out.root, function (el) {
          const tag = tagOf(el);
          if (tag === 'hr') return; // 分隔线没有文字，不需要字号
          if (blocks.indexOf(tag) < 0) return;
          if (!/font-size\s*:/i.test(el.getAttribute('style') || '')) missing.push(tag);
        });
        if (!missing.length) return { ok: true, detail: '所有块级元素都带 font-size' };
        return { ok: false, detail: missing.length + ' 个块级元素缺 font-size：' + missing.slice(0, 5).join(', ') };
      }
    },
    {
      id: 'A6', phase: 2, title: '没有元素把宽度写死超过 375px',
      desc: '375px 是手机端可用内容宽度上界，写死超过它必然溢出或被截断',
      run: function (out) {
        const LIMIT = 375;
        const bad = [];
        eachElement(out.root, function (el) {
          const style = el.getAttribute('style') || '';
          const re = /(?:^|;)\s*(?:min-|max-)?width\s*:\s*([\d.]+)px/gi;
          let m;
          while ((m = re.exec(style)) !== null) {
            if (Number(m[1]) > LIMIT) bad.push('<' + tagOf(el) + '> width:' + m[1] + 'px');
          }
          const attrW = Number(el.getAttribute('width'));
          if (attrW > LIMIT) bad.push('<' + tagOf(el) + '> width="' + attrW + '"');
        });
        if (!bad.length) return { ok: true, detail: '未发现宽度写死超过 ' + LIMIT + 'px 的元素' };
        return { ok: false, detail: bad.slice(0, 3).join('；') };
      }
    },
    {
      id: 'A7', phase: 5, title: '所有 img 使用 data: URI',
      desc: '外链图片在粘贴时提示上传失败，必须先把图片转成 data: URI 再写进产物',
      run: function (out) {
        const imgs = out.root.querySelectorAll('img');
        const bad = [];
        for (let i = 0; i < imgs.length; i++) {
          const src = imgs[i].getAttribute('src') || '';
          if (!/^data:/i.test(src)) bad.push(src.slice(0, 60) || '(空 src)');
        }
        if (!bad.length) {
          return { ok: true, detail: imgs.length ? '全部 ' + imgs.length + ' 张图片都是 data: URI' : '产物内没有图片' };
        }
        return { ok: false, detail: bad.length + ' 张图片不是 data: URI：' + bad.slice(0, 2).join(' | ') };
      }
    },
    {
      id: 'A8', phase: 1, title: '目录与 md 中的标题数量逐级一致',
      desc: '按 level 逐级对账：outline（从渲染后的 DOM 收集）与 meta.headings（从 token 流统计）必须完全相等，允许 ±0',
      run: function (out) {
        // 两份数据来源不同：outline 来自渲染后的标题元素，meta.headings 来自解析出的 token 流。
        // 都从 DOM 数就只是同一份数据自己和自己相等，验不出「标题渲染出来了但没进目录」。
        const inOutline = {};
        (out.outline || []).forEach(function (item) {
          inOutline[item.level] = (inOutline[item.level] || 0) + 1;
        });

        const source = (out.meta && out.meta.headings) || {};
        const diff = [];
        for (let level = 1; level <= 6; level++) {
          const fromMd = source[level] || 0;
          const fromOutline = inOutline[level] || 0;
          if (fromMd !== fromOutline) {
            diff.push('h' + level + '：md ' + fromMd + ' / 目录 ' + fromOutline);
          }
        }
        const totalMd = source.total || 0;
        const totalOutline = (out.outline || []).length;
        if (totalMd !== totalOutline) diff.push('合计：md ' + totalMd + ' / 目录 ' + totalOutline);

        if (!diff.length) return { ok: true, detail: '共 ' + totalOutline + ' 个标题，逐级一致' };
        return { ok: false, detail: diff.slice(0, 3).join('；') };
      }
    },
    {
      id: 'A9', phase: 1, title: '产物内不含 href="#…" 的链接',
      desc: '公众号没有可用的锚点，页内跳转一定是死链；脚注上标与目录都必须降级成纯文本或 sup',
      run: function (out) {
        const hits = [];
        eachElement(out.root, function (el) {
          const href = el.getAttribute ? el.getAttribute('href') : null;
          if (href && href.charAt(0) === '#') hits.push('<' + tagOf(el) + ' href="' + href + '">');
        });
        if (!hits.length) return { ok: true, detail: '未发现 # 开头的 href' };
        return { ok: false, detail: hits.length + ' 处：' + hits.slice(0, 3).join('；') };
      }
    },
    {
      id: 'A10', phase: 5, title: '产物内不含 svg / canvas / iframe',
      desc: '这三类标签会被微信整块剥掉（whitelist 的 DROP_TAGS 里就有它们），'
        + '所以图形必须先在本机栅格化成 PNG 再写进产物',
      run: function (out) {
        const self = ['svg', 'canvas', 'iframe'].indexOf(tagOf(out.root)) >= 0 ? out.root : null;
        const hit = self || out.root.querySelector('svg, canvas, iframe');
        if (!hit) return { ok: true, detail: '未发现 svg / canvas / iframe' };
        return { ok: false, detail: '发现 <' + tagOf(hit) + '> 标签' };
      }
    }
  ];

  /** 当前阶段计分的断言。phase 高于当前阶段的不计分，也不显示。 */
  function active() {
    return ASSERTIONS.filter(function (a) { return a.phase <= PHASE; });
  }

  /**
   * 跑一遍全部断言。
   *
   * 单条断言里的 try/catch 不是吞异常：它把「断言自己崩了」变成一条
   * 明确写出来的失败（detail 里带原因），而不是让整个自检停在半路、
   * 页面看起来像「点了没反应」。用户看到的是「A5 执行出错：xxx」，
   * 这比一条 unhandled rejection 有用得多。
   */
  function run(out) {
    if (!out || !out.root) {
      return {
        results: [],
        passed: 0,
        total: 0,
        allOk: false,
        error: '现在还没有可自检的产物。先载入一份 md，等预览出来再点「自检」。'
      };
    }

    const results = active().map(function (a) {
      let r;
      try {
        r = a.run(out);
      } catch (err) {
        r = { ok: false, detail: '断言执行出错：' + (err && err.message ? err.message : err) };
      }
      return {
        id: a.id,
        title: a.title,
        desc: a.desc,
        ok: !!r.ok,
        detail: r.detail || ''
      };
    });

    const passed = results.filter(function (r) { return r.ok; }).length;
    return {
      results: results,
      passed: passed,
      total: results.length,
      allOk: passed === results.length && results.length > 0
    };
  }

  MW.selfcheck = {
    PHASE: PHASE,
    ASSERTIONS: ASSERTIONS,
    active: active,
    run: run
  };
})(window);
