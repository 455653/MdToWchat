/*
 * compat-rules.js —— 兼容规则表（核心资产）
 *
 * 为什么它是核心资产：
 * 「md 转 html」十分钟能写完，但「手机上丢掉的样式能变成一条规则、
 * 下次不再丢」需要有人把失败经验沉淀下来。这张表就是那个水库。
 *
 * 表分两半，来源不同、生命周期也不同：
 *   BUILTIN —— 代码里的 25 条（L01–L25）。它们是我们已知的「微信会吃掉什么」，
 *             跟着仓库走、可 review、可 diff，不依赖任何人的浏览器。
 *   用户登记 —— localStorage['mw.rules'] 里的规则，来自「手机上看完发现丢样式 → 登记」。
 *              它是数据，会在 P3 接通全流程。
 *
 * status 只允许取四个值，初始一律 suspect：
 *   suspect   —— 现象见过（或结构性推理得到），但还没在真机上复核过
 *   verified  —— 真机复核过，当前策略确实有效
 *   failed    —— 复核发现当前策略无效（这条最有价值：它说明我们的做法是错的）
 *   obsolete  —— 微信已经修好，这条不再需要
 * 禁止为了「看起来完成度高」把 suspect 改成 verified：
 * 这张表的全部价值就在于「哪条真跑过、哪条还没有」分得清。
 * 一旦混进一条假的 verified，整张表就没有可信度了。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});
  const STORAGE_KEY = 'mw.rules';

  const STATUS = ['suspect', 'verified', 'failed', 'obsolete'];

  /**
   * 25 条已知兼容问题。
   *
   * 字段含义（每条都必须齐全，缺字段会让「复核」这一步无从下手）：
   *   id           规则编号，L01–L25，不复用、不重排
   *   target       命中的对象（选择器或元素类别）
   *   property     涉及的 CSS 属性 / 特性
   *   expected     微信端的实际表现（我们要观察到的现象）
   *   strategy     本工具的应对策略（生成端怎么绕开）
   *   status      见上方四态，初始一律 suspect
   *   fixture      用哪个样本复核；null 表示当前没有样本能复现它
   *   lastVerified 最近一次真机复核时间（ISO 字符串），没复核过就是 null
   */
  const BUILTIN = [
    {
      id: 'L01',
      target: 'style, link, script',
      property: '样式表 / 脚本标签',
      expected: '<style> 与 <link> 被整段剥掉，页面里写的样式一条都不生效',
      strategy: '生成端不产出这三个标签；所有视觉写成元素自身的 style',
      status: 'suspect',
      fixture: null,
      lastVerified: null
    },
    {
      id: 'L02',
      target: '[class], [id]',
      property: 'class / id 属性',
      expected: 'class 与 id 被剥掉，依赖它们的样式与锚点全部失效',
      strategy: '产物内不写 class / id；视觉靠内联 style，定位靠 data-mw-*',
      status: 'suspect',
      fixture: '01-basic.md',
      lastVerified: null
    },
    {
      id: 'L03',
      target: 'style 属性内的 var(--*)',
      property: 'CSS 自定义属性',
      expected: '变量在编辑器里不存在，var(--x) 解析失败，该条声明等于没写',
      strategy: '固化阶段把变量现读成字面值再写进 style，产物内不出现 var(',
      status: 'suspect',
      fixture: null,
      lastVerified: null
    },
    {
      id: 'L04',
      target: 'style 属性内的 display:flex / grid',
      property: 'display',
      expected: 'flex / grid 被过滤，并排布局塌成竖排，间距全变',
      strategy: '不产出 flex/grid；并排改 <table>，图标行改 inline-block 的 span',
      status: 'suspect',
      fixture: null,
      lastVerified: null
    },
    {
      id: 'L05',
      target: 'style 属性内的 position:*',
      property: 'position / top / left / z-index',
      expected: '定位被过滤，绝对定位的元素回到文档流，压住或错位',
      strategy: '不产出 position；错位用 margin / padding 摆',
      status: 'suspect',
      fixture: null,
      lastVerified: null
    },
    {
      id: 'L06',
      target: '::before / ::after',
      property: '伪元素',
      expected: '伪元素规则随样式表一起消失，靠伪元素画的圆点、箭头全部不见',
      strategy: '装饰内容改成真实元素：圆点用 • 文本，箭头用 › 文本，下划线用 border-bottom',
      status: 'suspect',
      fixture: null,
      lastVerified: null
    },
    {
      id: 'L07',
      target: 'style 属性内的 float',
      property: 'float / clear',
      expected: 'float 被过滤，环绕与并排效果消失，元素高度塌陷',
      strategy: '不产出 float；需要并排时用表格，其余一律普通块级流',
      status: 'suspect',
      fixture: null,
      lastVerified: null
    },
    {
      id: 'L08',
      target: 'style 属性内的 border-radius',
      property: 'border-radius',
      expected: '圆角时有时无（不同版本编辑器处理不一致），表现为「方角/圆角随机」',
      strategy: '不把圆角当布局依赖；圆角只用于装饰，掉了不影响可读性',
      status: 'suspect',
      fixture: '05-code-long.md',
      lastVerified: null
    },
    {
      id: 'L09',
      target: 'style 属性内的 box-shadow',
      property: 'box-shadow',
      expected: '阴影被丢掉，靠阴影表达的层次（卡片浮起）消失',
      strategy: '不产出 box-shadow；层次用背景色差与边框表达',
      status: 'suspect',
      fixture: null,
      lastVerified: null
    },
    {
      id: 'L10',
      target: 'style 属性内的 background-image',
      property: 'background-image',
      expected: '外链背景图加载失败或被剥掉，剩一块空白',
      strategy: '不产出 background-image；图片一律用 <img> 显式插入',
      status: 'suspect',
      fixture: null,
      lastVerified: null
    },
    {
      id: 'L11',
      target: 'style 属性内的 background-color',
      property: 'background-color',
      expected: '背景色在多数版本下能保留，但嵌套时可能被外层覆盖',
      strategy: '保留 background-color（代码块、提示块的浅底靠它），并显式写在最内层',
      status: 'suspect',
      fixture: '05-code-long.md',
      lastVerified: null
    },
    {
      id: 'L12',
      target: 'ul, ol, li',
      property: '列表（list-style-type / 缩进）',
      expected: '圆点与缩进各版本表现不一，常见是「圆点有、缩进没有」或缩进层层翻倍',
      strategy: '列表改写成 section 序列：序号/圆点是我们写的字符，缩进是自己写的 padding',
      status: 'suspect',
      fixture: '03-lists.md',
      lastVerified: null
    },
    {
      id: 'L13',
      target: 'table, thead, tbody, tr, th, td',
      property: '表格',
      expected: '表格本体能保留，但列宽写死 px 时会整体溢出、被截断',
      strategy: '表格 width:100%，列宽用百分比写在 th 上；不写 table-layout:fixed',
      status: 'suspect',
      fixture: '04-table-8col.md',
      lastVerified: null
    },
    {
      id: 'L14',
      target: 'pre, code, 长 URL',
      property: 'overflow-x: auto',
      expected: '没有横向滚动条，超宽内容直接把整页顶宽或就地被裁掉',
      strategy: '不给任何元素横向滚动；长行改成 pre-wrap + break-all 折行',
      status: 'suspect',
      fixture: '05-code-long.md',
      lastVerified: null
    },
    {
      id: 'L15',
      target: 'pre, code',
      property: 'white-space: pre',
      expected: '不折行的长行会撑破容器；空白是否保留也随版本变化',
      strategy: '代码块用 white-space:pre-wrap + word-break:break-all，显式写死',
      status: 'suspect',
      fixture: '05-code-long.md',
      lastVerified: null
    },
    {
      id: 'L16',
      target: 'style 属性内的 rem 单位',
      property: 'rem',
      expected: 'rem 相对根元素字号，进了编辑器根字号由对方决定，尺寸整体走样',
      strategy: '固化阶段把长度统一写 px，产物内不出现 rem',
      status: 'suspect',
      fixture: null,
      lastVerified: null
    },
    {
      id: 'L17',
      target: 'p, span 等文字元素',
      property: 'font-size（小于 15px）',
      expected: '微信正文有个字号下限，小于约 15px 的字号会被抬到下限，比例就乱了',
      strategy: '不产出小于 15px 的正文字号；需要「更小」时改层级而不是缩字号',
      status: 'suspect',
      fixture: null,
      lastVerified: null
    },
    {
      id: 'L18',
      target: 'a[href]',
      property: '链接',
      expected: '外链变成不可点的纯文本，href 被剥掉；页内锚点更是死链',
      strategy: '剥掉 href 只留文字，并在文字后补灰色的域名、文末汇总完整 URL',
      status: 'suspect',
      fixture: '12-link.md',
      lastVerified: null
    },
    {
      id: 'L19',
      target: 'img[src]',
      property: '外链图片',
      expected: '粘贴时提示「上传失败」，外链 src 不生效，图片位置剩一个叉或空白',
      strategy: '图片转 data: URI 再写入产物（P5 做，见 src/media.js）；同时用 max-width:100% 约束宽度',
      status: 'suspect',
      fixture: '06-image-huge.md',
      lastVerified: null
    },
    {
      id: 'L20',
      target: 'svg（内联）',
      property: '内联 SVG',
      expected: '内联 svg 会被整体剥掉，靠它画的图形全部消失',
      strategy: 'svg 列入丢弃表；需要图形时用图片代替',
      status: 'suspect',
      fixture: null,
      lastVerified: null
    },
    {
      id: 'L21',
      target: 'p > br, 连续空行',
      property: '空行 / 空段落',
      expected: '空 <p> 被压成 0 高度，连续回车看起来「被吃掉了」',
      strategy: '归一阶段删掉空段落；需要留白时改用上下的 margin',
      status: 'suspect',
      fixture: '01-basic.md',
      lastVerified: null
    },
    {
      id: 'L22',
      target: 'style 属性内的 letter-spacing',
      property: 'letter-spacing',
      expected: '字距时有时无，开了会显得正文被拉散，关了则与预览不一致',
      strategy: '默认不产出 letter-spacing；只在确有排版需要时按字面值写死',
      status: 'suspect',
      fixture: null,
      lastVerified: null
    },
    {
      id: 'L23',
      target: '正文中的 emoji',
      property: 'emoji 字符',
      expected: 'emoji 由读者设备渲染，不同系统长得不一样，行高也可能被顶高',
      strategy: '不把 emoji 当图标用（图标位置用文字或图片），正文里的 emoji 原样保留',
      status: 'suspect',
      fixture: '11-cjk-emoji.md',
      lastVerified: null
    },
    {
      id: 'L24',
      target: '整篇产物',
      property: '二次编辑',
      expected: '在编辑器里改一次再复制，微信会再剥一遍，第二次损失的是第一次侥幸留下的东西',
      strategy: '产物必须做到「第一遍就已经是最终形态」：不依赖任何会被剥掉的写法',
      status: 'suspect',
      fixture: null,
      lastVerified: null
    },
    {
      id: 'L25',
      target: '整篇产物',
      property: '暗黑模式',
      expected: '读者开暗黑模式时，写死的浅色背景 + 深色文字可能一起被反转，对比度变得不可读',
      strategy: '深色底片断（如代码块）尽量自带前景色，不给纯白底 + 纯黑字这种极端组合',
      status: 'suspect',
      fixture: null,
      lastVerified: null
    }
  ];

  let cache = null;

  function storageRead() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      // 读失败要么是存储被禁（Safari file://），要么是 JSON 被手改坏了。
      // 两种都不该让页面挂掉，但也不能装作没事——降级为空表并让用户知道。
      MW.util.toast('兼容规则读取失败，已按空表处理：' + err.message, 'warn');
      return [];
    }
  }

  function storageWrite(rules) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
    } catch (err) {
      MW.util.toast('兼容规则保存失败（本地存储不可用）：' + err.message, 'warn');
    }
  }

  /** 内置 25 条。每次返回新对象，调用方改了也不会污染源数据。 */
  function builtin() {
    return BUILTIN.map(function (rule) {
      return Object.assign({ builtin: true, enabled: true }, rule);
    });
  }

  /** 用户登记的规则（只读 localStorage 那一半，不含内置）。 */
  function stored() {
    if (cache === null) cache = storageRead();
    return cache;
  }

  function isBuiltinId(id) {
    for (let i = 0; i < BUILTIN.length; i++) {
      if (BUILTIN[i].id === id) return true;
    }
    return false;
  }

  /** 全部规则 = 内置 + 用户登记。 */
  function all() {
    return builtin().concat(stored().slice());
  }

  function enabled() {
    return all().filter(function (rule) { return rule && rule.enabled !== false; });
  }

  function getById(id) {
    return all().filter(function (rule) { return rule.id === id; })[0] || null;
  }

  /**
   * 新增或按 id 覆盖一条「用户登记」的规则。
   * 覆盖而不是追加：同一现象的规则被反复登记时，应该更新证据而不是堆重复项。
   * 内置规则改不了：它们是代码，不是数据。要改就得改 BUILTIN 并提交，
   * 否则会出现「我这台机器上 L13 是 verified、你那台是 suspect」这种没法复现的分歧。
   */
  function upsert(rule) {
    if (!rule || !rule.title) {
      // 这里不是「异常」，是调用方用错了 API。直接说清楚，避免写进一条脏数据。
      const err = new Error('规则缺少 title，未写入');
      MW.util.toast(err.message, 'error');
      return null;
    }
    if (isBuiltinId(rule.id)) {
      MW.util.toast('内置规则 ' + rule.id + ' 不能在页面里改写，请直接改 compat-rules.js', 'error');
      return null;
    }

    const list = stored().slice();
    const now = new Date().toISOString();
    const idx = list.findIndex(function (r) { return r.id === rule.id; });
    // 保留原 createdAt：规则被更新不等于规则是新的，
    // 登记时间在 P3 要用来排序「哪条经验更早踩到」。
    const prev = idx >= 0 ? list[idx] : null;

    const item = Object.assign({
      target: '',
      property: '',
      expected: '',
      strategy: '',
      status: 'suspect',
      fixture: null,
      lastVerified: null
    }, rule);

    item.id = rule.id || 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    item.title = String(rule.title);
    item.builtin = false;
    item.enabled = rule.enabled !== false;
    item.createdAt = (prev && prev.createdAt) || rule.createdAt || now;
    item.updatedAt = now;

    if (idx >= 0) list[idx] = item; else list.push(item);

    cache = list;
    storageWrite(list);
    return item;
  }

  /** 删掉一条用户登记的规则；内置规则删不掉（本来就不在存储里）。 */
  function remove(id) {
    const list = stored().filter(function (r) { return r.id !== id; });
    cache = list;
    storageWrite(list);
    return list.length;
  }

  /** 清空「用户登记」的那一半。内置的 25 条是代码，清不掉也不该被清掉。 */
  function clear() {
    cache = [];
    storageWrite(cache);
  }

  /**
   * 规则 → CSS 声明文本。
   * 后续阶段的固化器会拿着 target 去匹配元素，再把这里产出的声明并进内联 style。
   */
  function declToStyleText(decl) {
    if (!decl) return '';
    return Object.keys(decl).map(function (k) {
      return k + ':' + decl[k];
    }).join(';');
  }

  MW.compat = {
    STORAGE_KEY: STORAGE_KEY,
    STATUS: STATUS,
    BUILTIN: BUILTIN,
    all: all,
    enabled: enabled,
    getById: getById,
    upsert: upsert,
    remove: remove,
    clear: clear,
    declToStyleText: declToStyleText
  };
})(window);
