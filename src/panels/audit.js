/*
 * panels/audit.js —— 样式体检面板
 *
 * 职责（P6 实现）：
 *   拿「固化并归一之后」的产物 DOM，把它实际出现的 CSS 声明与元素形态，
 *   逐条对照 compat-rules.js，回答一个问题：这一篇粘进公众号，哪些地方预计会坏。
 *
 * 为什么输入必须是产物 DOM，不能是 md 原文：
 *   规则表描述的是「微信会吃掉什么」，而 md 原文里根本没有样式。
 *   扫原文只会得到一堆 markdown 语法，永远判不出「我们有没有踩上某条规则」。
 *
 * 为什么它和 test/assert.html 不重复：
 *   断言页验的是「管线有没有写错」——开发期回归，输入是 12 个固定样本；
 *   体检面板验的是「用户手上这一篇有没有问题」——使用期诊断，输入是眼前这份产物。
 *   两者输入不同、受众不同、跑的时间点也不同，合并只会让两边都不敢改。
 *
 * 判定口径（与 compat-rules 的 status 四态对齐）：
 *   ❌ 已失效 —— 真机复核过、当前策略无效且规则没有兜底；
 *               或者命中了「产物里根本不该出现」的写法（那是渲染管线 bug）。
 *   ⚠️ 待确认 —— 命中了规则，但还没在真机上复核过（status=suspect），
 *               或者复核失败但当前写法仍有兜底。
 *   ✅ 安全   —— 命中了规则，且真机复核过当前写法有效（status=verified）。
 * 没命中的规则不进任何一组：它描述的风险不在这一篇里。
 * 把 25 条全列出来、没命中的也都标成「安全」，面板就退化成一份没人看的清单，
 * 而「哪一条与我有关」这个唯一有价值的信息反而被淹掉了。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  const PHASE = 6;

  /* ==================== 小工具 ==================== */

  /**
   * 十来行的 DOM 构造器。刻意在本文件里自带一份，没有抽进 util.js：
   * 目录约定把 util.js 的职责写死成「防抖、转义、编码嗅探、toast」，
   * 为了少写几行就往里塞 DOM 构造，会让那个文件的边界变得说不清。
   */
  function h(tag, attrs, kids) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        const value = attrs[key];
        if (value == null || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = String(value);
        else if (key === 'value') node.value = value;
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, String(value));
      });
    }
    (kids || []).forEach(function (kid) {
      if (kid == null) return;
      node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    });
    return node;
  }

  /* ==================== 声明名的别名归一 ==================== */

  /**
   * 固化器把 border-radius 拆成四个长名（whitelist.INLINE_PROPS 就是这么定的），
   * 而规则表里的 property 写的是 border-radius。不做归一，
   * 这类规则会 100% 漏报——这是「体检永远显示无问题」最常见的成因。
   */
  const PROP_ALIAS = {
    'border-top-left-radius': 'border-radius',
    'border-top-right-radius': 'border-radius',
    'border-bottom-right-radius': 'border-radius',
    'border-bottom-left-radius': 'border-radius'
  };

  function canonProp(name) {
    return PROP_ALIAS[name] || name;
  }

  const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

  /**
   * 「产物里根本不该出现的写法」。
   * 这些要么会被微信过滤（flex / grid / position / float），
   * 要么根本不在 whitelist.INLINE_PROPS 的正面清单里（box-shadow / rem / var(），
   * 要么早就该被归一器处理掉（class / id / 空段落 / ul / svg / 非 data: 图片）。
   * 所以命中它们不是「用户这篇有问题」，而是「生成端退化了」——
   * 这条界限必须画清楚，否则用户会去改自己的文章，而该改的是代码。
   */
  const HARD_IDS = {
    L01: 1, L02: 1, L03: 1, L04: 1, L05: 1, L06: 1, L07: 1,
    L09: 1, L10: 1, L12: 1, L14: 1, L15: 1, L16: 1, L18: 1,
    L19: 1, L20: 1, L21: 1
  };

  /* ==================== 产物扫描 ==================== */

  function pxOf(value) {
    const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value).trim());
    return m ? parseFloat(m[1]) : NaN;
  }

  /**
   * 简化版相对亮度，只用来判断「是不是接近纯白 / 纯黑」。
   * L25 关心的是「写死的浅底 + 深字」这种极端组合在暗黑模式下糊成一团，
   * 不需要真的算 WCAG 对比度，只需要把「纯白底 + 纯黑字」这一类挑出来。
   */
  function luminance(value) {
    const s = String(value || '').trim().toLowerCase();
    let r, g, b;
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
    if (hex) {
      let head = hex[1];
      if (head.length === 3) head = head[0] + head[0] + head[1] + head[1] + head[2] + head[2];
      r = parseInt(head.slice(0, 2), 16);
      g = parseInt(head.slice(2, 4), 16);
      b = parseInt(head.slice(4, 6), 16);
    } else {
      const rgb = /^rgba?\(([^)]+)\)$/.exec(s);
      if (!rgb) return null;
      const parts = rgb[1].split(',').map(function (x) { return parseFloat(x); });
      if (parts.length < 3 || parts.some(isNaN)) return null;
      r = parts[0]; g = parts[1]; b = parts[2];
    }
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  /**
   * 把产物扫成一份「事实清单」，规则判定只读这份清单。
   *
   * 为什么扫完再判、而不是边扫边判：
   * 同一条规则可能被多个元素命中（比如满屏都是 background-color），
   * 边扫边判的话要么重复报、要么得去重；先落成事实，判定就是一次纯函数调用。
   *
   * 为什么按 ';' 拆 style 是安全的：
   * 固化器（inline-styles.js 的 parseStyle）也是按 ';' 拆的，
   * 而 whitelist.INLINE_PROPS 里没有任何属性会产出分号或 data: URI。
   */
  function scan(root) {
    const ctx = {
      elements: 0,
      decls: [],
      props: Object.create(null),
      tags: Object.create(null),
      classCount: 0,
      idCount: 0,
      imgs: [],
      emptyP: 0,
      extremeBg: 0,
      text: ''
    };

    const nodes = [root];
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) nodes.push(all[i]);

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node || !node.tagName) continue;
      ctx.elements++;

      const tag = node.tagName.toLowerCase();
      ctx.tags[tag] = (ctx.tags[tag] || 0) + 1;
      if (node.className) ctx.classCount++;
      if (node.id) ctx.idCount++;

      const own = Object.create(null);
      const styleText = node.getAttribute('style') || '';
      if (styleText) {
        const parts = styleText.split(';');
        for (let j = 0; j < parts.length; j++) {
          const at = parts[j].indexOf(':');
          if (at < 0) continue;
          const raw = parts[j].slice(0, at).trim().toLowerCase();
          const value = parts[j].slice(at + 1).trim();
          if (!raw || !value) continue;

          const prop = canonProp(raw);
          ctx.decls.push({ raw: raw, prop: prop, value: value, tag: tag });
          if (!ctx.props[prop]) ctx.props[prop] = { count: 0, values: [], sample: tag };
          ctx.props[prop].count++;
          if (ctx.props[prop].values.length < 6) ctx.props[prop].values.push(value);
          own[raw] = value;
        }
      }

      if (tag === 'img') {
        ctx.imgs.push({
          src: String(node.getAttribute('src') || ''),
          alt: String(node.getAttribute('alt') || '')
        });
      }
      if (tag === 'p' && !String(node.textContent || '').trim() && !node.querySelector('img')) {
        ctx.emptyP++;
      }

      const bg = own['background-color'];
      const fg = own['color'];
      if (bg && fg) {
        const bl = luminance(bg);
        const fl = luminance(fg);
        if (bl != null && fl != null && bl >= 0.97 && fl <= 0.08) ctx.extremeBg++;
      }
    }

    // 整篇文字取一次就够：逐节点累加会把嵌套元素里的字重复计数，
    // emoji 会因此被判定成「出现了好几次」，虽然结论一样，但数字会骗人。
    ctx.text = String(root.textContent || '');
    return ctx;
  }

  function someDecl(ctx, fn) {
    for (let i = 0; i < ctx.decls.length; i++) {
      if (fn(ctx.decls[i])) return true;
    }
    return false;
  }

  /* ==================== 单条声明的判定（判定与举证共用） ==================== */

  const DECL_RULES = {
    L03: function (d) { return d.value.indexOf('var(') >= 0; },
    L04: function (d) { return d.raw === 'display' && /^(inline-)?(flex|grid)$/.test(d.value); },
    L05: function (d) {
      return (d.raw === 'position' && d.value !== 'static')
        || ['top', 'left', 'right', 'bottom', 'z-index'].indexOf(d.raw) >= 0;
    },
    L07: function (d) { return (d.raw === 'float' && d.value !== 'none') || d.raw === 'clear'; },
    L09: function (d) { return d.raw === 'box-shadow'; },
    L10: function (d) { return d.raw === 'background-image'; },
    L14: function (d) { return d.raw === 'overflow' || d.raw === 'overflow-x'; },
    L15: function (d) { return d.raw === 'white-space' && /^(pre|nowrap)$/.test(d.value); },
    L16: function (d) { return /\d(\.\d+)?rem\b/.test(d.value); },
    L17: function (d) { const px = pxOf(d.value); return d.raw === 'font-size' && px > 0 && px < 15; }
  };

  /* ==================== 内置 25 条的命中条件 ==================== */

  /**
   * 条件问的是「产物里有没有出现这条规则描述的那种写法」，
   * 而不是「规则表里有没有这条规则」——前者才是体检，后者只是读了一遍文件。
   */
  const BUILTIN_MATCH = {
    L01: function (c) { return !!(c.tags.style || c.tags.link || c.tags.script); },
    L02: function (c) { return c.classCount > 0 || c.idCount > 0; },
    L03: function (c) { return someDecl(c, DECL_RULES.L03); },
    L04: function (c) { return someDecl(c, DECL_RULES.L04); },
    L05: function (c) { return someDecl(c, DECL_RULES.L05); },
    // 伪元素只存在于样式表里，内联 style 里检不出来：条件恒为假，如实表达「测不了」
    L06: function () { return false; },
    L07: function (c) { return someDecl(c, DECL_RULES.L07); },
    L08: function (c) { return !!c.props['border-radius']; },
    L09: function (c) { return someDecl(c, DECL_RULES.L09); },
    L10: function (c) { return someDecl(c, DECL_RULES.L10); },
    L11: function (c) { return !!c.props['background-color']; },
    L12: function (c) { return !!(c.tags.ul || c.tags.ol || c.tags.li); },
    L13: function (c) {
      return !!(c.tags.table || c.tags.thead || c.tags.tbody
        || c.tags.tr || c.tags.th || c.tags.td);
    },
    L14: function (c) { return someDecl(c, DECL_RULES.L14); },
    // 只有裸 pre / nowrap 才危险；我们自己写的 pre-wrap 是策略本身，不该自己告自己
    L15: function (c) { return someDecl(c, DECL_RULES.L15); },
    L16: function (c) { return someDecl(c, DECL_RULES.L16); },
    L17: function (c) { return someDecl(c, DECL_RULES.L17); },
    L18: function (c) { return !!c.tags.a; },
    L19: function (c) {
      return c.imgs.some(function (img) { return img.src.indexOf('data:') !== 0; });
    },
    L20: function (c) { return !!c.tags.svg; },
    L21: function (c) { return c.emptyP > 0; },
    L22: function (c) { return !!c.props['letter-spacing']; },
    L23: function (c) { return EMOJI_RE.test(c.text); },
    // 「在编辑器里二次编辑会再剥一遍」说的不是本文产物的属性，没法从 DOM 判出来
    L24: function () { return false; },
    L25: function (c) { return c.extremeBg > 0; }
  };

  const KNOWN_TAGS = ['a', 'ul', 'ol', 'li', 'pre', 'code', 'svg', 'del', 'table', 'img', 'div'];

  function tokensOf(text) {
    return String(text || '').toLowerCase().match(/[a-z][a-z0-9-]*/g) || [];
  }

  /**
   * 用户登记的规则没有预置条件，只能从它的 property / target 反推一个尽力而为的匹配器。
   * 反推不出来就返回 null —— 面板会把这些规则单独列出来说「没能自动比对」，
   * 而不是假装它们通过了。
   */
  function userMatcher(rule) {
    const props = tokensOf(rule.property).map(canonProp);
    const tagPool = MW.whitelist.TAGS.concat(KNOWN_TAGS);
    const tags = tokensOf(rule.target).filter(function (t) { return tagPool.indexOf(t) >= 0; });
    if (!props.length && !tags.length) return null;

    return function (ctx) {
      for (let i = 0; i < props.length; i++) if (ctx.props[props[i]]) return true;
      for (let i = 0; i < tags.length; i++) if (ctx.tags[tags[i]]) return true;
      return false;
    };
  }

  function matcherFor(rule) {
    if (BUILTIN_MATCH[rule.id]) return BUILTIN_MATCH[rule.id];
    return userMatcher(rule);
  }

  /* ==================== 判定 ==================== */

  function judge(rule) {
    if (HARD_IDS[rule.id]) {
      // 顺序上先于 status：pipeline 本该消解掉的东西出现了，
      // 不管规则表把这条标成什么，都已经是 bug 了。
      return { group: 'broken', why: '产物里不该出现这种写法，属于渲染管线 bug——生成端本应在固化或归一阶段把它消解掉' };
    }
    if (rule.status === 'obsolete') return null;
    if (rule.status === 'failed') {
      return rule.strategy
        ? { group: 'warn', why: '真机复核发现原策略无效，但当前写法仍有兜底' }
        : { group: 'broken', why: '真机复核发现当前策略无效，而且这条规则没有兜底' };
    }
    if (rule.status === 'verified') return { group: 'ok', why: '真机复核过，当前写法有效' };
    return { group: 'warn', why: '命中了这条风险，但还没在真机上复核过' };
  }

  /** 举证：把命中它的具体声明挑几条出来。没有证据的红色告警等于让用户猜。 */
  function evidenceFor(rule, ctx) {
    const predicate = DECL_RULES[rule.id];
    if (predicate) {
      return ctx.decls.filter(predicate).slice(0, 4).map(function (d) {
        return d.raw + ':' + d.value + '（<' + d.tag + '>）';
      });
    }
    if (rule.id === 'L02') {
      return ['含 class 属性的元素 ' + ctx.classCount + ' 个',
        '含 id 属性的元素 ' + ctx.idCount + ' 个'];
    }
    if (rule.id === 'L19') {
      return ctx.imgs.filter(function (img) { return img.src.indexOf('data:') !== 0; })
        .slice(0, 3).map(function (img) { return '<img src="' + img.src.slice(0, 70) + '">'; });
    }
    const lower = String(rule.target || '').toLowerCase();
    return Object.keys(ctx.tags).filter(function (tag) {
      return new RegExp('\\b' + tag + '\\b').test(lower);
    }).slice(0, 4).map(function (tag) {
      return '<' + tag + '> × ' + ctx.tags[tag];
    });
  }

  /**
   * 体检主函数。out 是 pipeline.build 的返回值（也可以直接传 root 元素）。
   * 返回结构是「可被别的面板消费的数据」，渲染只是它的一种用途。
   */
  function analyze(out) {
    const empty = {
      ready: false,
      reason: '还没有可体检的产物',
      groups: { broken: [], warn: [], ok: [] },
      coverage: { total: 0, matched: 0, hard: 0, skipped: 0, unmatchable: 0 },
      unmatchable: [],
      dropped: []
    };

    const root = out && out.root ? out.root : out;
    if (!root || typeof root.querySelectorAll !== 'function') return empty;

    const ctx = scan(root);
    const rules = MW.compat && MW.compat.enabled ? MW.compat.enabled() : [];

    /*
     * 用户规则优先于内置规则：compat.all() 的顺序是「内置在前、用户在后」，
     * 这里按 id 建索引、后写覆盖先写，用户登记的同 id 规则就会盖掉内置那条。
     * 之所以不把这个判断放到 compat-rules.js 里，是因为那张表的 25 条是代码资产，
     * 它只负责「有什么规则」，不负责「谁说了算」。
     */
    const index = Object.create(null);
    const order = [];
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!rule || !rule.id) continue;
      if (!index[rule.id]) order.push(rule.id);
      index[rule.id] = rule;
    }

    const groups = { broken: [], warn: [], ok: [] };
    const unmatchable = [];
    let skipped = 0;

    order.forEach(function (id) {
      const rule = index[id];
      const matcher = matcherFor(rule);
      if (!matcher) { unmatchable.push(rule); return; }
      if (!matcher(ctx)) { skipped++; return; }
      const verdict = judge(rule);
      if (!verdict) { skipped++; return; }
      verdict.rule = rule;
      verdict.evidence = evidenceFor(rule, ctx);
      groups[verdict.group].push(verdict);
    });

    const matched = groups.broken.length + groups.warn.length + groups.ok.length;

    return {
      ready: true,
      reason: '',
      groups: groups,
      coverage: {
        total: order.length,
        matched: matched,
        hard: groups.broken.length,
        skipped: skipped,
        unmatchable: unmatchable.length
      },
      unmatchable: unmatchable,
      dropped: (out && out.meta && out.meta.dropped) || []
    };
  }

  /* ==================== 总评 ==================== */

  function areasOf(result) {
    const areas = [];
    result.groups.broken.concat(result.groups.warn).forEach(function (verdict) {
      const text = String(verdict.rule.property || verdict.rule.target || '').trim();
      if (text && areas.indexOf(text) < 0) areas.push(text);
    });
    return areas;
  }

  function summaryText(result) {
    const bad = result.groups.broken.length;
    const warn = result.groups.warn.length;
    const areas = areasOf(result).slice(0, 3).join('、');

    if (bad) {
      return '本文有 ' + bad + ' 处高风险'
        + (warn ? '、' + warn + ' 处待确认' : '')
        + '。高风险那几处是渲染管线该消解掉却没消解掉的写法，建议先修代码再复制'
        + (areas ? '（涉及：' + areas + '）' : '') + '。';
    }
    if (warn) {
      return '本文有 ' + warn + ' 处待确认，都不是渲染管线问题，'
        + '建议粘贴后重点看' + (areas || '上面列出的那几处') + '。';
    }
    return '本文没有发现已知的兼容风险。已按 ' + result.coverage.total + ' 条规则扫描，'
      + '其中 ' + result.coverage.matched + ' 条与本文相关。';
  }

  /* ==================== 渲染 ==================== */

  const GROUPS = [
    { key: 'broken', label: '已失效', cls: 'is-bad', mark: '×', hint: '按已知经验，这些地方粘过去一定会坏' },
    { key: 'warn', label: '待确认', cls: 'is-warn', mark: '!', hint: '命中了已知风险，但还没在真机上复核过' },
    { key: 'ok', label: '安全', cls: 'is-ok', mark: '✓', hint: '真机复核过，当前写法有效' }
  ];

  const expanded = Object.create(null);

  function fixtureText(rule) {
    return rule.fixture ? 'fixtures/' + rule.fixture : '无样本';
  }

  function kv(label, value) {
    return h('div', { class: 'pan-kv' }, [
      h('span', { class: 'pan-kv-k', text: label }),
      h('span', { class: 'pan-kv-v', text: value })
    ]);
  }

  function itemNode(verdict) {
    const rule = verdict.rule;
    const key = rule.id + '|' + verdict.group;
    const body = h('div', { class: 'pan-item-body', hidden: !expanded[key] }, [
      kv('规则 id', rule.id + (rule.builtin === false ? '（用户登记）' : '（内置）')),
      kv('预期行为', String(rule.expected || '—')),
      kv('兜底策略', String(rule.strategy || '（没有兜底）')),
      kv('对应样本', fixtureText(rule)),
      kv('上次验证', rule.lastVerified ? String(rule.lastVerified) : '从未复核'),
      kv('判定依据', verdict.why),
      verdict.evidence && verdict.evidence.length
        ? h('div', { class: 'pan-evidence' }, [
          h('span', { class: 'pan-kv-k', text: '命中的写法' }),
          h('ul', {}, verdict.evidence.map(function (line) {
            return h('li', { text: line });
          }))
        ])
        : null
    ]);

    const head = h('button', {
      class: 'pan-item-head', type: 'button',
      onclick: function () {
        expanded[key] = !expanded[key];
        body.hidden = !expanded[key];
        head.setAttribute('aria-expanded', expanded[key] ? 'true' : 'false');
      }
    }, [
      h('span', { class: 'pan-badge ' + verdict.group === 'broken' ? 'is-bad'
        : (verdict.group === 'warn' ? 'is-warn' : 'is-ok'), text: rule.id }),
      h('span', { class: 'pan-item-title', text: String(rule.property || rule.target || '') }),
      h('span', { class: 'pan-item-target', text: String(rule.target || '') }),
      h('span', { class: 'pan-caret', text: '›' })
    ]);

    return h('div', { class: 'pan-item ' + (GROUPS.filter(function (g) {
      return g.key === verdict.group;
    })[0] || {}).cls }, [head, body]);
  }

  function groupNode(group, verdicts) {
    const children = [
      h('div', { class: 'pan-group-head' }, [
        h('span', { class: 'pan-badge ' + group.cls, text: group.mark }),
        h('span', { class: 'pan-group-title', text: group.label + '（' + verdicts.length + '）' }),
        h('span', { class: 'pan-group-hint', text: group.hint })
      ])
    ];
    verdicts.forEach(function (verdict) { children.push(itemNode(verdict)); });
    return h('section', { class: 'pan-group' }, children);
  }

  function render(out) {
    const host = el.host;
    if (!host) return;

    host.textContent = '';
    const result = analyze(out);

    if (!result.ready) {
      host.appendChild(h('div', { class: 'placeholder' }, [
        h('h3', { text: '样式体检' }),
        h('div', { text: '还没有可体检的产物。在左侧写点 Markdown，或把 .md 文件拖进窗口，这里就会开始检查。' })
      ]));
      return;
    }

    const head = h('div', { class: 'pan-head' }, [
      h('div', { class: 'pan-summary ' + (result.groups.broken.length ? 'is-bad' : '') ,
        text: summaryText(result) }),
      h('div', { class: 'pan-meta', text: '扫描到 ' + result.coverage.total + ' 条规则：'
        + result.coverage.matched + ' 条与本文相关，'
        + result.coverage.skipped + ' 条未触发，'
        + result.coverage.unmatchable + ' 条无法自动比对。' })
    ]);
    host.appendChild(head);

    if (result.groups.broken.length) {
      host.appendChild(h('div', { class: 'pan-alert' }, [
        h('strong', { text: '这是渲染管线 bug。' }),
        h('span', { text: '产物里出现了 ' + result.groups.broken.map(function (v) {
          return v.rule.id;
        }).join('、') + ' 描述的写法，而固化与归一阶段本该把它们全部消解掉。'
          + '不要改文章，要改生成端。' })
      ]));
    }

    if (result.dropped.length) {
      host.appendChild(h('div', { class: 'pan-note', text: '另有 ' + result.dropped.length
        + ' 块内容在归一阶段被整块删除（' + result.dropped.map(function (d) {
          return '<' + d.tag + '>';
        }).slice(0, 6).join('、') + '）——这些标签微信留不住，连着内容一起丢了。' }));
    }

    GROUPS.forEach(function (group) {
      const verdicts = result.groups[group.key];
      if (!verdicts.length) return;
      host.appendChild(groupNode(group, verdicts));
    });

    if (!result.coverage.matched) {
      host.appendChild(h('div', { class: 'pan-note', text: '三组都是空的，说明这一篇没有踩到任何一条已知风险，'
        + '而不是「检查没跑」。上面那句规则条数就是证据。' }));
    }

    if (result.unmatchable.length) {
      host.appendChild(h('div', { class: 'pan-note', text: '有 ' + result.unmatchable.length
        + ' 条用户规则无法自动比对（property / target 里没有可识别的 CSS 属性名或标签名）：'
        + result.unmatchable.map(function (r) { return r.id; }).join('、')
        + '。它们的 property 或 target 需要写成具体属性名，体检才能参与判定。' }));
    }
  }

  /* ==================== 生命周期 ==================== */

  const el = { host: null };
  let bound = false;

  /**
   * 订阅「产物更新」。用事件而不是让面板轮询：
   * 「什么时候有新产物」只有 app.js 知道，轮询只会把这件事变成定时器猜谜。
   */
  function bind() {
    if (bound) return;
    bound = true;
    document.addEventListener('mw:result', function () {
      render(MW.app && MW.app.result ? MW.app.result() : null);
    });
  }

  function init(host) {
    if (!host) return;
    el.host = host;
    bind();
    render(MW.app && MW.app.result ? MW.app.result() : null);
  }

  /** 对外的体检入口，返回结构化的判定结果（渲染之外还能被别的面板消费）。 */
  function run(out) {
    return analyze(out);
  }

  MW.panels = MW.panels || {};
  MW.panels.audit = {
    PHASE: PHASE,
    init: init,
    render: render,
    run: run,
    analyze: analyze
  };
})(window);
