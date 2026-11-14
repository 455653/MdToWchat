/*
 * panels/report.js —— 丢失样式登记、规则草稿与修复提示词
 *
 * 这个面板承担闭环的后半段，也是整个产品里唯一「越用越好用」的地方：
 *   文章在手机上翻了车 → 回到这里把现象描述清楚 → 得到一条规则草稿
 *   和一段可以直接发给开发 AI 的修复提示词 → 规则进表、体检下次就认得这件事。
 *
 * 为什么「登记」和「规则编辑器」放在同一个文件、同一个面板里：
 *   目录约定只有三个面板文件（settings / audit / report），不为一个新功能多开文件；
 *   而且登记与规则表本来就是同一条工作流的两端——写完登记立刻能看到它变成哪条规则，
 *   用户才会相信「我写的东西真的进了系统」，而不是填完表单掉进黑洞。
 *
 * 为什么截图要降级成缩略图：
 *   localStorage 的配额是所有键共用的。一张 2MB 的截图编码成 base64 后接近 3MB，
 *   而配额被吃满的后果不是「截图存不上」，是连 mw.doc（那篇文章）都存不上。
 *   宁可存一张糊一点的缩略图，也不能让它威胁到「文档永远存得住」这条底线。
 *
 * 数据落在两个键里：
 *   mw.reports —— 登记记录（本文件自有）
 *   mw.rules   —— 用户登记的规则（由 compat-rules.js 管，这里只通过它的 API 读改写）
 * 刻意不自己往 mw.rules 写 localStorage：compat-rules 内部有一份 cache，
 * 绕过它写会让面板看到的和体检判定的不是同一份数据。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  const PHASE = 6;

  const KEY_REPORTS = 'mw.reports';
  const MAX_REPORTS = 200;

  /**
   * 截图的体积上限。
   * 规格要求「超过 300KB 只存缩略图，原图不入库」，但 300KB 是文件大小，
   * 真正占配额的是 base64 字符串（约为文件体积的 1.37 倍），所以再加一道
   * 「编码后」的兜底线。两道线都在，是为了挡住两种不同的撑爆方式：
   * 一张超大图，和多张「刚好没超」的图。
   */
  const SHOT_SOURCE_LIMIT = 300 * 1024;
  const SHOT_ENCODED_LIMIT = 400 * 1024;
  const SHOT_WIDTH = 600;
  const SHOT_WIDTH_SMALL = 400;

  /**
   * fixtures/ 目录里现有的 12 个样本（取自 fixtures/README.md）。
   * 为什么硬编码而不是运行时列目录：
   * 硬约束 3 禁止 fetch/XHR 读本地文件，而 file:// 下目录也不可枚举——
   * 这是「尽力检查」能做到的全部。写死这张表，规则编辑器至少能挡住
   * 「fixture 名拼错」这类最常见的登记错误。
   */
  const FIXTURES = [
    '01-basic.md', '02-headings.md', '03-lists.md', '04-table-8col.md',
    '05-code-long.md', '06-image-huge.md', '07-quote-nested.md',
    '08-admonitions.md', '09-math.md', '10-mermaid.md',
    '11-cjk-emoji.md', '12-link.md'
  ];

  /**
   * 「丢失了什么」的十个选项。
   * prop   —— 转译成技术语言时用的 CSS 属性名，提示词的第 ② 块靠它
   * rules  —— 这一项最可能相关的内置规则（用来预填「不是这个」的候选与草稿）
   * 没有对应规则的项（边框 / 字重 / 对齐）刻意留空数组，而不是硬凑一个 id：
   * 硬凑的结果是用户勾了「不是 L08」，而那条规则跟边框毫无关系。
   */
  const LOST = [
    { key: 'bg', label: '背景色', prop: 'background-color', rules: ['L11', 'L25'] },
    { key: 'border', label: '边框', prop: 'border', rules: [] },
    { key: 'radius', label: '圆角', prop: 'border-radius', rules: ['L08'] },
    { key: 'fontSize', label: '字号', prop: 'font-size', rules: ['L17', 'L16'] },
    { key: 'weight', label: '字重', prop: 'font-weight', rules: [] },
    { key: 'align', label: '对齐', prop: 'text-align', rules: [] },
    { key: 'spacing', label: '间距', prop: 'margin / padding', rules: ['L21'] },
    { key: 'icon', label: '图标', prop: '伪元素 / emoji / svg', rules: ['L06', 'L20', 'L23'] },
    { key: 'image', label: '图片', prop: 'img src / background-image', rules: ['L19', 'L10'] },
    { key: 'other', label: '其他', prop: '', rules: [] }
  ];

  /**
   * 位置与现象里的关键词 → 规则 id。
   * 「丢失了什么」只能说出属性，说不了对象；而 L13 这种规则问的是「哪一块」。
   * 所以在位置文字和现象描述上再扫一遍关键词，让「表格」这两个字也能参与推测。
   */
  const KEYWORDS = [
    { re: /表格|table|单元格|列宽|行高/i, ids: ['L13'] },
    { re: /列表|项目符号|圆点|序号|缩进/, ids: ['L12'] },
    { re: /代码|code|不折行|横向滚动/i, ids: ['L14', 'L15'] },
    { re: /链接|网址|url|href/i, ids: ['L18'] },
    { re: /图片|照片|img|图标/i, ids: ['L19'] },
    { re: /emoji|表情/i, ids: ['L23'] },
    { re: /空行|回车|段距|留白/, ids: ['L21'] }
  ];

  const RULE_FIELDS = ['id', 'target', 'property', 'expected', 'strategy',
    'status', 'fixture', 'lastVerified'];

  const STATUS_LABEL = {
    suspect: '待复核',
    verified: '已验证',
    failed: '已失效',
    obsolete: '已过时'
  };

  /* ==================== 小工具 ==================== */

  /**
   * 轻量 DOM 构造器。与 audit.js 里那份是同一个东西，刻意各留一份：
   * 目录约定把 util.js 的职责写死成「防抖、转义、编码嗅探、toast」，
   * 为了省二十行代码就往里塞 DOM 构造，会让那个文件的边界说不清。
   * 两个面板之间互相 require 更糟——它们是平级兄弟，不该有依赖。
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
        else if (key === 'checked' || key === 'disabled' || key === 'selected') node[key] = !!value;
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

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /** 导出文件名里的日期戳。带日期是为了让用户一眼认出「这是哪一天导的」。 */
  function stamp() {
    const d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
      + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  function timeText(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /**
   * UA 摘要。只取「哪个系统 + 哪个浏览器」这一层，不贴整串 UA：
   * 整串 UA 有上百字符，登进提示词里既占地方又没人看。
   * 注意它填的是「你正在用工具的这个浏览器」，而不是出问题的那台手机——
   * 所以这个输入框是可编辑的，用户应当把它改成真机型号（验收里写的是 iPhone 13）。
   */
  function uaSummary() {
    const ua = String((global.navigator && global.navigator.userAgent) || '');
    const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS'
      : /Android/.test(ua) ? 'Android'
      : /Mac OS X/.test(ua) ? 'macOS'
      : /Windows/.test(ua) ? 'Windows'
      : /Linux/.test(ua) ? 'Linux'
      : '未知系统';
    const br = /Edg\//.test(ua) ? 'Edge'
      : /Chrome\//.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox'
      : /Safari\//.test(ua) ? 'Safari'
      : '未知浏览器';
    return os + ' · ' + br;
  }

  /* ==================== 登记记录的存取 ==================== */

  let warned = false;

  /**
   * 只提示一次。
   * 照抄 settings.js 的做法：这个面板的写操作会被连续触发（每改一个草稿字段就落一次盘），
   * 存储不可用时若不做这个开关，每次击键都会弹一个 toast，面板直接变成噪音源。
   */
  function warnOnce(message, kind) {
    if (warned) return;
    warned = true;
    MW.util.toast(message, kind || 'warn');
  }

  function readReports() {
    try {
      const raw = localStorage.getItem(KEY_REPORTS);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      warnOnce('登记记录读取失败，已按空列表处理：' + err.message);
      return [];
    }
  }

  function writeReports(list) {
    try {
      localStorage.setItem(KEY_REPORTS, JSON.stringify(list));
      return true;
    } catch (err) {
      warnOnce('登记记录保存失败（本地存储不可用或已写满）：' + err.message, 'error');
      return false;
    }
  }

  function saveReports() {
    return writeReports(reports);
  }

  let reports = [];
  let expandedId = null;
  let confirmingDelete = null;

  /* ==================== 表单状态 ==================== */

  /**
   * 表单的值只存这一份，DOM 每次都由它渲染出来。
   * 为什么不让 DOM 当唯一真相：面板会因为「规则表变了」「登记列表变了」重绘，
   * 重绘时若从 DOM 反读，用户正在填的内容会随重绘一起消失。
   * 真相放在这里，重绘就只是「把状态再画一遍」。
   */
  const form = {
    where: '',
    whereManual: '',
    lost: '',
    phenomenon: '',
    device: uaSummary(),
    wechat: '',
    excluded: Object.create(null),
    shot: null
  };

  function lostOf(key) {
    for (let i = 0; i < LOST.length; i++) if (LOST[i].key === key) return LOST[i];
    return null;
  }

  function outlineList() {
    return Array.isArray(MW.outline) ? MW.outline : [];
  }

  function outlineItem(nodeId) {
    const list = outlineList();
    for (let i = 0; i < list.length; i++) if (list[i].nodeId === nodeId) return list[i];
    return null;
  }

  /** 当前表单里的「问题位置」文字。整篇时是空串。 */
  function whereTextOf() {
    if (form.where === '__manual__') return String(form.whereManual || '').trim();
    if (!form.where) return '';
    const item = outlineItem(form.where);
    return item ? item.text : '';
  }

  /** 已保存记录的位置文字（记录里存的是快照，不回查当前大纲）。 */
  function whereText(report) {
    const w = report.where;
    if (!w) return '整篇';
    return w.text || (w.manual ? '手动指定' : '未指定');
  }

  function resetForm() {
    form.where = '';
    form.whereManual = '';
    form.lost = '';
    form.phenomenon = '';
    form.device = uaSummary();
    form.wechat = '';
    form.excluded = Object.create(null);
    form.shot = null;
  }

  /* ==================== 推测相关规则 ==================== */

  /**
   * 从「丢失了什么 + 位置 + 现象」推测可能相关的规则 id。
   * 这只是推测：结果会预填成草稿和「不是这个」的候选项，最终以用户的勾选为准。
   * 推测不出来就是空数组，而不是兜一个默认 id —— 兜错 id 比没有更坏，
   * 因为它会让用户以为自己确认过一条其实毫不相干的规则。
   */
  function guessIds(lostKey, positionText, phenomenon) {
    const ids = [];
    const lost = lostOf(lostKey);
    if (lost) {
      lost.rules.forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
    }
    const hay = String(positionText || '') + ' ' + String(phenomenon || '');
    KEYWORDS.forEach(function (k) {
      if (!k.re.test(hay)) return;
      k.ids.forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
    });
    return ids;
  }

  function candidates() {
    return guessIds(form.lost, whereTextOf(), form.phenomenon);
  }

  function ruleLabel(id) {
    const rule = MW.compat.getById(id);
    if (!rule) return id;
    const text = rule.property || rule.target || '';
    return text ? id + '（' + text + '）' : id;
  }

  /* ==================== 截图 ==================== */

  /**
   * 等比缩到指定宽度并转成 JPEG。
   * 先铺一层白底再画：截图多数不透明，但带透明通道的 PNG 直接转 JPEG 会变成黑块，
   * 一张黑图存进去比不存更糟——用户会以为截图功能坏了。
   */
  function thumbnail(dataUrl, maxWidth) {
    return new Promise(function (resolve, reject) {
      const img = new global.Image();
      img.onload = function () {
        const w0 = img.naturalWidth || img.width || maxWidth;
        const h0 = img.naturalHeight || img.height || maxWidth;
        const scale = Math.min(1, maxWidth / w0);
        const w = Math.max(1, Math.round(w0 * scale));
        const h = Math.max(1, Math.round(h0 * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.onerror = function () { reject(new Error('截图解码失败，换一张试试')); };
      img.src = dataUrl;
    });
  }

  function readAsDataUri(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('读取截图失败')); };
      reader.readAsDataURL(file);
    });
  }

  /**
   * File → 入库用的截图对象。
   * 两道体积线（文件大小、编码后长度）任意一条越过就降级成缩略图；
   * 缩略图再超线就缩得更小一次。不循环降级：两次之后还超标说明这张图异常，
   * 与其无限缩下去，不如让用户知道「这张图太大，只能存这么糊的」。
   */
  function prepareShot(file) {
    return readAsDataUri(file).then(function (dataUrl) {
      const oversized = (file.size && file.size > SHOT_SOURCE_LIMIT)
        || dataUrl.length > SHOT_ENCODED_LIMIT;
      const name = file.name || '粘贴的截图';

      if (!oversized) return { name: name, dataUrl: dataUrl, thumb: false };

      return thumbnail(dataUrl, SHOT_WIDTH).then(function (small) {
        if (small.length <= SHOT_ENCODED_LIMIT) {
          return { name: name, dataUrl: small, thumb: true };
        }
        return thumbnail(dataUrl, SHOT_WIDTH_SMALL).then(function (smaller) {
          return { name: name, dataUrl: smaller, thumb: true };
        });
      });
    });
  }

  function acceptShot(file) {
    prepareShot(file).then(function (shot) {
      form.shot = shot;
      renderShot();
      if (shot.thumb) {
        MW.util.toast('截图超过 300KB，只存了缩略图', 'warn', '原图不入库，避免挤占本地存储把文档挤掉。');
      }
    }).catch(function (err) {
      MW.util.toast(err && err.message ? err.message : String(err), 'error');
    });
  }

  /* ==================== 规则草稿 ==================== */

  /**
   * 依据登记内容预填一条规则草稿。
   *
   * status 取 suspect 而不是规格里写的 confirmed：
   * compat-rules 的四态（suspect / verified / failed / obsolete）里没有 confirmed，
   * 而用户刚从真机上看到的现象，恰好就是 suspect 的定义——
   * 「现象见过，但当前策略还没在真机上复核过」。
   * 硬塞一个表里不认的值，规则编辑器与体检都会把它判成非法，
   * 所以这里做的是「语义对齐」，不是「降级妥协」。
   */
  function buildDraft(report) {
    const lost = lostOf(report.lost);
    const ids = guessIds(report.lost, report.positionText, report.phenomenon);
    const lead = ids.length ? MW.compat.getById(ids[0]) : null;
    const position = report.positionText || '整篇';
    const now = new Date();

    return {
      id: 'r-' + now.getTime().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      title: (lost ? lost.label : '样式') + '在「' + position + '」处丢失',
      target: lead ? lead.target : position,
      property: (lost && lost.prop) || (lost ? lost.label : ''),
      expected: report.phenomenon,
      strategy: '',
      status: 'suspect',
      fixture: lead ? lead.fixture : null,
      lastVerified: null
    };
  }

  /* ==================== 修复提示词 ==================== */

  /**
   * 六块内容缺一不可，顺序也是刻意的：
   *   ① 背景 —— AI 不知道这是什么项目，缺了这块它会把「微信过滤」当成普通浏览器兼容问题
   *   ② 现象 —— 用技术语言重述，但保留用户原话，避免转述时把细节磨掉
   *   ③ 复现 —— 指出确切的 fixture 与那一块，否则 AI 只能靠猜
   *   ④ 已排除 —— 用户勾过的「不是这个」，防止 AI 去修一个已经被排除的方向
   *   ⑤ 具体要求 —— 改哪个文件、改哪条规则、是否新增 fixture
   *   ⑥ 验收 + 禁止 —— 没有这两条，AI 最省事的做法是改配色或加依赖来「让现象消失」
   */
  function buildPrompt(report) {
    const lost = lostOf(report.lost);
    const ids = guessIds(report.lost, report.positionText, report.phenomenon);
    const leadId = ids.length ? ids[0] : '';
    const lead = leadId ? MW.compat.getById(leadId) : null;
    const draft = report.draft || {};
    const fixture = (lead && lead.fixture) || draft.fixture || '';
    const ruleId = draftMergedId(report) || leadId || draft.id || '（待定）';
    const rule = MW.compat.getById(ruleId);
    const position = report.positionText || '整篇';

    const device = String((report.device && report.device.device) || '未知设备').trim();
    const wechat = String((report.device && report.device.wechat) || '').trim();

    const excluded = (report.excluded || []).map(function (id) {
      const r = MW.compat.getById(id);
      return '- 不是 ' + id + (r && r.property ? '（' + r.property + '）' : '')
        + '：登记时已被用户明确排除，不要再往这个方向查。';
    });

    const fixtureLine = fixture
      ? '仓库里的 fixtures/' + fixture
      : '（这条登记没有对应样本，需要新建一个 fixture）';

    const requirements = [];
    requirements.push('- 改哪个文件：src/compat-rules.js（只改这一处；如果结论是渲染管线的问题，'
      + '再考虑 src/pipeline.js 或 src/inline-styles.js，但要在提交说明里写清为什么）。');
    requirements.push('- 改哪条规则：' + ruleId + (rule && rule.strategy
      ? '，当前 strategy 是「' + rule.strategy + '」'
      : '') + '。把 strategy 改成能真正绕开该现象的做法；如果现象证明当前 strategy 无效，'
      + '把 status 从 suspect 改成 failed，并在 expected 里写清 failed 的原因。');
    requirements.push(fixture
      ? '- 是否新增 fixture：先复用 fixtures/' + fixture + '；只有当它复现不了时才新增一个。'
      : '- 是否新增 fixture：需要新增。文件名沿用 fixtures/ 的两位数字前缀命名，'
        + '并加进 fixtures/README.md 的清单。');
    requirements.push('- 不要动与本现象无关的渲染步骤、不要顺手重构。');

    const forbidden = [
      '- 不许引入任何第三方依赖，不许引 CDN（第三方库只能放 vendor/ 且必须是 UMD）。',
      '- 不许使用 ES Module 语法（file:// 下 type="module" 会被 CORS 拦）。',
      '- 不许改主题配色（--mw-* 变量）与 whitelist.js 的白名单，除非本问题就是白名单缺失。',
      '- 不许把 status 直接从 suspect 改成 verified 来「让体检变绿」：verified 只代表真机复核过。',
      '- 不许改 test/assert.html 里已有断言的语义来迁就实现。'
    ];

    return [
      '【项目背景】',
      'MdWeChat 是一个纯前端工具：把 Markdown 转成「能直接粘进微信公众号图文编辑器、'
        + '且不会被它吃掉样式」的富文本。微信编辑器在粘贴时会剥掉 <style>、class、id，'
        + '过滤 flex/grid/position，所以产物在渲染阶段就把样式固化进每个元素的 style 属性，'
        + '并把标签限制在白名单内（src/whitelist.js）。src/compat-rules.js 是兼容规则表，'
        + '记录「微信会吃掉什么、我们怎么绕」。',
      '',
      '【现象】',
      '产物粘进公众号后，「' + position + '」这一块的' + (lost ? lost.label : '样式') + '丢失。',
      '对应声明：' + ((lost && lost.prop) || '（未指明具体属性）'),
      '用户原话：' + String(report.phenomenon || '（未填）'),
      '复核设备：' + device + (wechat ? '，微信 ' + wechat : '，微信版本未填'),
      '',
      '【复现方式】',
      '1. 双击 index.html（纯前端，file:// 下即可运行，不需要安装任何东西）；',
      '2. 把 ' + fixtureLine + ' 拖进窗口；',
      '3. 切到「体检」页，看规则 ' + ruleId + ' 那一行；',
      '4. 点「复制到公众号」，粘进公众号编辑器，在 ' + device + ' 上查看「' + position + '」这一块。',
      '',
      '【已排除项】',
      excluded.length ? excluded.join('\n')
        : '（用户没有勾选任何排除项。不要假设原因，先按上面的复现方式把现象做出来。）',
      '',
      '【需要做的】',
      requirements.join('\n'),
      '',
      '【验收方式】',
      '1. 重新渲染 ' + (fixture ? 'fixtures/' + fixture : '新建的 fixture') + '，'
        + '体检页里 ' + ruleId + ' 不再落进「待确认」；',
      '2. 产物里与「' + ((lost && lost.prop) || '该属性') + '」相关的写法，符合改后的 strategy；',
      '3. test/assert.html 仍是 12/12 通过；',
      '4. 真机复核后在 ' + ruleId + ' 上填 lastVerified（ISO 时间）并把 status 改成 verified，'
        + '没在真机上跑过就不许填。',
      '',
      '【禁止事项】',
      forbidden.join('\n')
    ].join('\n');
  }

  /** 草稿真正进了规则表之后，提示词里该引用的 id 是它在表里的 id。 */
  function draftMergedId(report) {
    if (!report.draftMerged || !report.draft) return '';
    return report.draft.id || '';
  }

  /* ==================== 提示词弹窗 ==================== */

  let promptMask = null;

  /**
   * 提示词必须可编辑再发。
   * 生成的文本是「起点」不是「终点」：用户最清楚自己手机上看到的是什么，
   * 让他改完再发，比让他拿着一份改不动的文本去跟 AI 解释便宜得多。
   */
  function openPrompt(text) {
    closePrompt();

    const textarea = h('textarea', { class: 'prompt-text', spellless: '', value: text });
    textarea.value = text;

    const copyBtn = h('button', {
      type: 'button', class: 'btn btn-primary', text: '复制提示词',
      onclick: function () {
        MW.clipboard.copyText(textarea.value).then(function (ok) {
          if (ok) {
            MW.util.toast('已复制修复提示词', 'ok', '直接粘给开发 AI 即可，背景、复现、验收都在里面。');
          } else {
            MW.util.toast('没能写进剪贴板', 'error', '可以在文本框里全选后按 Ctrl+C 手动复制。');
          }
        });
      }
    });

    const card = h('div', { class: 'prompt-card' }, [
      h('div', { class: 'prompt-head' }, [
        h('h3', { class: 'prompt-title', text: '修复提示词' }),
        h('span', { class: 'form-hint', text: '六块内容缺一不可，改完再发' })
      ]),
      textarea,
      h('div', { class: 'prompt-actions' }, [
        h('button', { type: 'button', class: 'btn', text: '关闭', onclick: closePrompt }),
        copyBtn
      ])
    ]);

    promptMask = h('div', { class: 'prompt-mask', onclick: function (event) {
      if (event.target === promptMask) closePrompt();
    } }, [card]);

    document.body.appendChild(promptMask);
    textarea.focus();
  }

  function closePrompt() {
    if (promptMask && promptMask.parentNode) promptMask.parentNode.removeChild(promptMask);
    promptMask = null;
  }

  /* ==================== 规则表：校验与应用 ==================== */

  let builtinIndex = null;

  function builtins() {
    if (!builtinIndex) {
      builtinIndex = Object.create(null);
      MW.compat.BUILTIN.forEach(function (rule) { builtinIndex[rule.id] = rule; });
    }
    return builtinIndex;
  }

  function box(value) { return value === undefined ? null : value; }

  function diffFields(a, b) {
    return RULE_FIELDS.filter(function (key) {
      return JSON.stringify(box(a[key])) !== JSON.stringify(box(b[key]));
    });
  }

  /**
   * 校验。返回错误文案数组，空数组表示通过。
   * 每条错误都带上「第几项 + id + 哪个字段」，因为「保存被拒绝」本身不是信息，
   * 「L13 的 status 写成了 done」才是——验收第 7 条要的就是这个。
   */
  function validateRules(list) {
    const errors = [];
    if (!Array.isArray(list)) return ['顶层必须是一个 JSON 数组（当前是 ' + typeof list + '）'];

    const seen = Object.create(null);
    list.forEach(function (item, i) {
      const at = '第 ' + (i + 1) + ' 项' + (item && item.id ? '（' + item.id + '）' : '');

      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(at + '：不是一个规则对象');
        return;
      }
      if (!item.id || typeof item.id !== 'string') {
        errors.push(at + '：id 缺失或不是字符串');
      } else if (seen[item.id]) {
        errors.push(at + '：id 重复（' + item.id + ' 在前面已经出现过）');
      } else {
        seen[item.id] = true;
      }

      const isBuiltin = !!builtins()[item.id];
      // 内置那 25 条没有 title 字段（它们是代码，不靠 title 区分），所以只对用户规则要求 title
      if (!isBuiltin && !item.title) errors.push(at + '：title 缺失（规则表要求每条用户规则都有标题）');

      if (MW.compat.STATUS.indexOf(item.status) < 0) {
        errors.push(at + '：status 非法 —— 只允许 ' + MW.compat.STATUS.join(' / ')
          + '，收到 ' + JSON.stringify(item.status));
      }

      if (item.fixture != null && item.fixture !== '' && FIXTURES.indexOf(item.fixture) < 0) {
        errors.push(at + '：fixture「' + item.fixture + '」不在 fixtures/ 目录里'
          + '（现有样本：' + FIXTURES.join('、') + '）');
      }

      if (isBuiltin) {
        const changed = diffFields(item, builtins()[item.id]);
        if (changed.length) {
          errors.push(at + '：这是内置规则，不能在页面里改写（改动字段：' + changed.join('、')
            + '）。内置规则是代码，请直接改 src/compat-rules.js。');
        }
      }
    });

    return errors;
  }

  /**
   * 把编辑结果落盘。
   * 全程走 compat-rules 的 upsert / remove，不自己写 localStorage：
   * 它内部有一份 cache，绕过去写会让面板看到的和体检判定的不是同一份数据。
   * 内置 id 一律跳过——upsert 本来也会拒绝，这里先跳过是为了不做无谓的报错。
   */
  function applyRules(list) {
    const builtin = builtins();
    const desired = list.filter(function (rule) { return rule && rule.id && !builtin[rule.id]; });
    const desiredIds = desired.map(function (rule) { return rule.id; });

    // 删掉「用户规则里有、编辑结果里没有」的那些：文本域是整体状态，删掉一行就是删掉一条规则
    MW.compat.all().filter(function (rule) { return rule.builtin !== true; })
      .forEach(function (rule) {
        if (desiredIds.indexOf(rule.id) < 0) MW.compat.remove(rule.id);
      });

    let failed = 0;
    desired.forEach(function (rule) {
      if (!MW.compat.upsert(rule)) failed++;
    });
    return { saved: desired.length - failed, failed: failed };
  }

  /** 规则表 → 编辑器里的 JSON。字段顺序固定，`git diff` 才看得懂。 */
  function editorRules() {
    return MW.compat.all().map(function (rule) {
      const copy = {};
      copy.id = rule.id;
      if (rule.title) copy.title = rule.title;
      RULE_FIELDS.slice(1).forEach(function (key) { copy[key] = box(rule[key]); });
      return copy;
    });
  }

  /* ==================== 渲染 ==================== */

  const el = {
    host: null,
    checks: null,
    shotBox: null,
    manualWrap: null,
    editor: null,
    editorErrors: null,
    summary: null
  };

  function kv(label, value) {
    return h('div', { class: 'pan-kv' }, [
      h('span', { class: 'pan-kv-k', text: label }),
      h('span', { class: 'pan-kv-v', text: String(value) })
    ]);
  }

  function field(label, control, hint) {
    return h('div', { class: 'form-row' }, [
      h('span', { class: 'form-label', text: label }),
      h('div', { class: 'form-field' }, hint ? [control, h('span', { class: 'form-hint', text: hint })] : [control])
    ]);
  }

  function selectNode(value, options, onchange) {
    const sel = h('select', { onchange: onchange });
    options.forEach(function (opt) {
      sel.appendChild(h('option', { value: opt.value, text: opt.label }));
    });
    sel.value = value;
    return sel;
  }

  function renderChecks() {
    const box = el.checks;
    if (!box) return;
    box.textContent = '';

    const ids = candidates();
    if (!ids.length) {
      box.appendChild(h('span', { class: 'form-hint',
        text: '还没有候选规则 —— 先选「丢失了什么」，或把现象写清楚。' }));
      return;
    }
    ids.forEach(function (id) {
      const input = h('input', {
        type: 'checkbox', checked: !!form.excluded[id],
        onchange: function () { form.excluded[id] = this.checked; }
      });
      box.appendChild(h('label', { class: 'form-check' }, [
        input,
        h('span', { text: '不是 ' + ruleLabel(id) })
      ]));
    });
  }

  function renderShot() {
    const box = el.shotBox;
    if (!box) return;
    box.textContent = '';

    if (!form.shot) {
      box.appendChild(h('span', { class: 'form-hint',
        text: '可选。可以在这个面板里直接 Ctrl+V 粘贴截图，或点右边的选择文件。' }));
      return;
    }
    box.appendChild(h('img', { class: 'shot-thumb', src: form.shot.dataUrl, alt: form.shot.name }));
    box.appendChild(h('span', { class: 'form-hint',
      text: form.shot.name + (form.shot.thumb ? '（已存为缩略图）' : '') }));
    box.appendChild(h('button', {
      type: 'button', class: 'btn btn-ghost', text: '移除截图',
      onclick: function () { form.shot = null; renderShot(); }
    }));
  }

  function formNode() {
    const whereOptions = [{ value: '', label: '整篇 / 不确定' }];
    outlineList().forEach(function (item) {
      const pad = item.level > 1 ? '　'.repeat(item.level - 1) : '';
      whereOptions.push({ value: item.nodeId, label: pad + 'H' + item.level + ' ' + String(item.text).slice(0, 40) });
    });
    whereOptions.push({ value: '__manual__', label: '手动指定…' });

    const whereSelect = selectNode(form.where, whereOptions, function () {
      form.where = this.value;
      if (el.manualWrap) el.manualWrap.hidden = form.where !== '__manual__';
      renderChecks();
    });

    const manualInput = h('input', {
      type: 'text', value: form.whereManual, placeholder: '例如：第一张表格、文末的代码块',
      oninput: function () { form.whereManual = this.value; }
    });
    // 这个 wrapper 的引用要在 renderChecks 之前备好，onchange 里会用到 el.manualWrap
    el.manualWrap = h('div', { hidden: form.where !== '__manual__' }, [manualInput]);

    const lostSelect = selectNode(form.lost, [{ value: '', label: '请选择' }].concat(
      LOST.map(function (item) { return { value: item.key, label: item.label }; })
    ), function () {
      form.lost = this.value;
      renderChecks();
    });

    const phenomenonInput = h('input', {
      type: 'text', value: form.phenomenon, placeholder: '一句话说清手机上看到什么，例如：单元格的字变成 17px',
      oninput: function () { form.phenomenon = this.value; }
    });
    // 现象描述会参与推测，但它每敲一个字都重绘候选框会打断输入，
    // 所以单独挂一个防抖：停止输入 400ms 再刷新候选项。
    const syncChecks = MW.util.debounce(renderChecks, 400);
    phenomenonInput.addEventListener('input', function () { syncChecks(); });

    const deviceInput = h('input', {
      type: 'text', value: form.device,
      oninput: function () { form.device = this.value; }
    });
    const wechatInput = h('input', {
      type: 'text', value: form.wechat, placeholder: '例如 8.0.44',
      oninput: function () { form.wechat = this.value; }
    });

    el.checks = h('div', { class: 'form-checks' });
    el.shotBox = h('div', { class: 'shot-box' });

    const picker = h('input', {
      type: 'file', accept: 'image/*', hidden: true,
      onchange: function () {
        const file = this.files && this.files[0];
        this.value = '';
        if (file) acceptShot(file);
      }
    });

    const body = h('div', { class: 'form-grid' }, [
      field('问题位置', h('div', { class: 'form-field' }, [whereSelect, el.manualWrap])),
      field('丢失了什么', lostSelect),
      field('现象描述', phenomenonInput, '必填。用大白话，不要写「显示异常」这种没法复现的描述。'),
      field('设备', deviceInput, '默认填的是当前浏览器的摘要。出问题的是手机，请改成真机型号。'),
      field('微信版本', wechatInput),
      field('已排除', el.checks, '勾上「不是这个」的方向，生成提示词时会带上，避免 AI 白查一遍。'),
      field('截图', h('div', { class: 'form-field' }, [
        el.shotBox,
        h('button', {
          type: 'button', class: 'btn btn-ghost', text: '选择截图文件',
          onclick: function () { picker.value = ''; picker.click(); }
        }),
        picker
      ]))
    ]);

    renderChecks();
    renderShot();

    return h('section', { class: 'pan-group' }, [
      h('div', { class: 'pan-group-head' }, [
        h('span', { class: 'pan-group-title', text: '登记一条丢失样式' }),
        h('span', { class: 'pan-group-hint', text: '只保留能复现的信息，越具体越有用' })
      ]),
      body,
      h('div', { class: 'form-actions' }, [
        h('button', { type: 'button', class: 'btn btn-primary', text: '提交登记', onclick: submit }),
        h('button', { type: 'button', class: 'btn btn-ghost', text: '清空表单',
          onclick: function () { resetForm(); render(); } })
      ])
    ]);
  }

  function draftNode(report) {
    const draft = report.draft;
    if (!draft) return null;

    const bind = function (key) {
      return function () {
        draft[key] = this.value;
        saveReports();
      };
    };

    return h('div', { class: 'draft-box' }, [
      h('div', { class: 'draft-head' }, [
        h('span', { class: 'pan-group-title', text: '规则草稿' }),
        h('span', { class: 'pan-group-hint', text: report.draftMerged
          ? '已合并进规则表（mw.rules）'
          : '推测出来的，确认或改完再合并' })
      ]),
      kv('规则 id', draft.id),
      field('标题', h('input', { type: 'text', value: draft.title, oninput: bind('title') })),
      field('生效对象', h('input', { type: 'text', value: draft.target, oninput: bind('target') })),
      field('涉及属性', h('input', { type: 'text', value: draft.property, oninput: bind('property') })),
      field('预期表现', h('input', { type: 'text', value: draft.expected, oninput: bind('expected') })),
      field('兜底策略', h('textarea', { value: draft.strategy, placeholder: '生成端要怎么绕开它？留空也可以先合并，体检会把它列为「无兜底」。',
        oninput: bind('strategy') })),
      field('对应样本', selectNode(draft.fixture || '', [{ value: '', label: '（无样本）' }].concat(
        FIXTURES.map(function (name) { return { value: name, label: name }; })
      ), bind('fixture'))),
      field('状态', selectNode(draft.status, MW.compat.STATUS.map(function (value) {
        return { value: value, label: value + '（' + STATUS_LABEL[value] + '）' };
      }), bind('status')), '四态：待复核 / 已验证 / 已失效 / 已过时。刚看到的现象属于「待复核」。'),
      h('div', { class: 'form-actions' }, [
        h('button', {
          type: 'button', class: 'btn btn-primary',
          text: report.draftMerged ? '更新规则表' : '合并进规则表',
          onclick: function () { mergeDraft(report); }
        }),
        h('button', {
          type: 'button', class: 'btn', text: '生成修复提示词',
          onclick: function () { openPrompt(buildPrompt(report)); }
        })
      ])
    ]);
  }

  function itemNode(report) {
    const open = expandedId === report.id;
    const done = report.status === 'done';

    const body = h('div', { class: 'pan-item-body', hidden: !open }, [
      kv('位置', whereText(report)),
      kv('丢失项', (lostOf(report.lost) || { label: report.lost }).label),
      kv('现象', report.phenomenon),
      kv('设备', ((report.device && report.device.device) || '未填')
        + ((report.device && report.device.wechat) ? '，微信 ' + report.device.wechat : '')),
      kv('登记时间', timeText(report.at)),
      kv('已排除', (report.excluded || []).length ? (report.excluded || []).map(ruleLabel).join('、') : '无'),
      report.shot
        ? h('div', { class: 'pan-kv' }, [
          h('span', { class: 'pan-kv-k', text: '截图' }),
          h('span', { class: 'pan-kv-v' }, [
            h('img', { class: 'shot-thumb', src: report.shot.dataUrl, alt: report.shot.name })
          ])
        ])
        : null,
      draftNode(report),
      h('div', { class: 'form-actions' }, [
        h('button', {
          type: 'button', class: 'btn', text: done ? '标记待处理' : '标记已解决',
          onclick: function () { toggleStatus(report); }
        }),
        confirmingDelete === report.id
          ? h('button', { type: 'button', class: 'btn btn-danger', text: '确认删除？',
            onclick: function () { removeReport(report); } })
          : h('button', { type: 'button', class: 'btn btn-ghost', text: '删除',
            onclick: function () { confirmingDelete = report.id; render(); } })
      ])
    ]);

    const head = h('button', {
      class: 'pan-item-head', type: 'button',
      onclick: function () {
        expandedId = open ? null : report.id;
        confirmingDelete = null;
        render();
      }
    }, [
      h('span', { class: 'pan-badge ' + (done ? 'is-ok' : 'is-warn'), text: done ? '已解决' : '待处理' }),
      h('span', { class: 'pan-item-title', text: whereText(report) }),
      h('span', { class: 'pan-item-target', text:
        (lostOf(report.lost) || { label: report.lost }).label + ' · ' + report.phenomenon }),
      h('span', { class: 'item-time', text: timeText(report.at) }),
      h('span', { class: 'pan-caret', text: open ? '⌄' : '›' })
    ]);

    return h('div', { class: 'pan-item' }, [head, body]);
  }

  function rulesNode() {
    const builtinCount = MW.compat.BUILTIN.length;
    const userCount = MW.compat.all().filter(function (r) { return r.builtin !== true; }).length;

    el.editor = h('textarea', { class: 'rules-editor', spellless: '' });
    el.editor.value = JSON.stringify(editorRules(), null, 2);
    el.editor.addEventListener('input', validateEditorNow);

    el.editorErrors = h('div', { class: 'editor-errors' });

    return h('section', { class: 'pan-group' }, [
      h('div', { class: 'pan-group-head' }, [
        h('span', { class: 'pan-group-title', text: '规则表' }),
        h('span', { class: 'pan-group-hint', text: '内置 ' + builtinCount + ' 条 · 用户 ' + userCount + ' 条' })
      ]),
      h('div', { class: 'form-grid' }, [
        h('div', { class: 'form-hint', text: '内置 25 条（L01–L25）是代码，改动会被拒绝，要改请改 src/compat-rules.js；'
          + '带 r- 前缀的是你自己登记的规则，随便改。保存后会立刻影响体检页的判定。' }),
        el.editor,
        el.editorErrors,
        h('div', { class: 'form-actions' }, [
          h('button', { type: 'button', class: 'btn', text: '校验', onclick: validateEditorNow }),
          h('button', { type: 'button', class: 'btn btn-primary', text: '保存规则表', onclick: saveEditor })
        ])
      ])
    ]);
  }

  /** 实时校验：只报错、不落盘。让用户在按保存之前就知道哪一行有问题。 */
  function validateEditorNow() {
    const box = el.editorErrors;
    if (!box) return true;
    box.textContent = '';

    let parsed;
    try {
      parsed = JSON.parse(el.editor.value);
    } catch (err) {
      box.appendChild(h('div', { text: 'JSON 解析失败：' + err.message }));
      return false;
    }
    const errors = validateRules(parsed);
    if (!errors.length) {
      box.appendChild(h('span', { class: 'form-hint', text: '格式与取值都正确，可以保存。' }));
      return true;
    }
    errors.slice(0, 20).forEach(function (msg) { box.appendChild(h('div', { text: msg })); });
    if (errors.length > 20) box.appendChild(h('div', { text: '……还有 ' + (errors.length - 20) + ' 条问题' }));
    return false;
  }

  function saveEditor() {
    if (!validateEditorNow()) {
      MW.util.toast('规则表没有保存：有字段不合法', 'error', '具体哪一行、哪个字段有问题，看文本框下面的提示。');
      return;
    }
    const parsed = JSON.parse(el.editor.value);
    const result = applyRules(parsed);

    if (result.failed) {
      MW.util.toast('有 ' + result.failed + ' 条规则没能写入', 'error', '内置规则不能在页面里改写，请改 src/compat-rules.js。');
    } else {
      MW.util.toast('规则表已保存（用户规则 ' + result.saved + ' 条）', 'ok', '体检页的判定已按新规则重算。');
    }
    // 规则变了 = 体检的判定依据变了。产物没变，但结论会变，
    // 所以借用同一条「产物可用」事件让体检面板重算一遍，而不是新造一个事件名。
    document.dispatchEvent(new CustomEvent('mw:result'));
    render();
  }

  function summaryText() {
    const pending = reports.filter(function (r) { return r.status !== 'done'; }).length;
    if (!reports.length) return '还没有登记记录。手机上发现样式丢了，回到这里记一条。';
    if (!pending) return reports.length + ' 条登记都已解决，闭环没有遗留。';
    return pending + ' 条待处理，共 ' + reports.length + ' 条登记。';
  }

  function toolbarNode() {
    const picker = h('input', {
      type: 'file', accept: '.json,application/json', hidden: true,
      onchange: function () {
        const file = this.files && this.files[0];
        this.value = '';
        if (file) importFromFile(file);
      }
    });

    return h('div', { class: 'pan-toolbar' }, [
      h('button', { type: 'button', class: 'btn', text: '导出 JSON', onclick: exportJson }),
      h('button', {
        type: 'button', class: 'btn', text: '导入 JSON',
        onclick: function () { picker.value = ''; picker.click(); }
      }),
      h('span', { class: 'pan-meta', text: '导出的是登记记录与用户规则；内置 25 条在 compat-rules.js 里，不随文件走。' }),
      picker
    ]);
  }

  function render() {
    const host = el.host;
    if (!host) return;

    // 把滚动位置与焦点先记住：面板重绘后用户往往还在输入框里，
    // 不恢复的话每按一次按钮光标都会跳回面板顶部。
    const activeId = document.activeElement && host.contains(document.activeElement)
      ? document.activeElement.getAttribute('data-draft-key') : null;
    const scrollTop = host.scrollTop;

    host.textContent = '';

    const pending = reports.filter(function (r) { return r.status !== 'done'; }).length;

    host.appendChild(h('div', { class: 'pan-head' }, [
      h('div', { class: 'pan-summary ' + (pending ? 'is-warn' : ''), text: summaryText() }),
      h('div', { class: 'pan-meta', text: '登记记录存在浏览器本地（localStorage 的 mw.reports），'
        + '换机器或清缓存都会丢，重要记录请导出成 JSON。上限 ' + MAX_REPORTS + ' 条。' })
    ]));

    host.appendChild(toolbarNode());
    host.appendChild(formNode());

    const listChildren = [
      h('div', { class: 'pan-group-head' }, [
        h('span', { class: 'pan-group-title', text: '登记记录（最新在前）' }),
        h('span', { class: 'pan-group-hint', text: reports.length + ' / ' + MAX_REPORTS })
      ])
    ];
    if (!reports.length) {
      listChildren.push(h('div', { class: 'pan-note', text: '还没有记录。上面填一条提交后，这里会出现它。' }));
    } else {
      reports.forEach(function (report) { listChildren.push(itemNode(report)); });
    }
    host.appendChild(h('section', { class: 'pan-group' }, listChildren));

    host.appendChild(rulesNode());

    host.scrollTop = scrollTop;
    void activeId;
  }

  /* ==================== 动作 ==================== */

  function submit() {
    const phenomenon = String(form.phenomenon || '').trim();
    if (!form.lost) {
      MW.util.toast('请选择「丢失了什么」', 'warn', '这一项决定了推测哪条规则，以及提示词里写什么属性。');
      return;
    }
    if (!phenomenon) {
      MW.util.toast('请填「现象描述」', 'warn', '用一句话说清手机上看到什么，这是这条登记唯一不可替代的部分。');
      return;
    }
    if (reports.length >= MAX_REPORTS) {
      MW.util.toast('登记已达上限 ' + MAX_REPORTS + ' 条', 'warn',
        '请先「导出 JSON」留档，再从列表里删掉已经处理不了的旧记录。');
      return;
    }

    const manual = form.where === '__manual__';
    const position = whereTextOf();
    const head = manual ? null : outlineItem(form.where);

    const report = {
      id: 'rpt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      at: new Date().toISOString(),
      where: form.where
        ? { nodeId: head ? head.nodeId : '', level: head ? head.level : 0, text: position, manual: manual }
        : null,
      positionText: position,
      lost: form.lost,
      phenomenon: phenomenon,
      device: { device: String(form.device || '').trim() || '未填', wechat: String(form.wechat || '').trim() },
      excluded: Object.keys(form.excluded).filter(function (id) { return form.excluded[id]; }),
      shot: form.shot,
      status: 'open',
      resolvedAt: null,
      draft: null,
      draftMerged: false
    };
    report.draft = buildDraft(report);

    reports.unshift(report);
    expandedId = report.id;
    confirmingDelete = null;
    resetForm();
    saveReports();
    render();

    const guess = report.draft.property ? '，草稿指向 ' + report.draft.property : '';
    MW.util.toast('已登记', 'ok', '展开这条可以把草稿合并进规则表，或生成修复提示词' + guess + '。');
  }

  function toggleStatus(report) {
    report.status = report.status === 'done' ? 'open' : 'done';
    report.resolvedAt = report.status === 'done' ? new Date().toISOString() : null;
    saveReports();
    render();
    MW.util.toast(report.status === 'done' ? '已标记为解决' : '已改回待处理', 'ok',
      report.status === 'done' ? '记录不会删除，闭环的痕迹要留着。' : '');
  }

  function removeReport(report) {
    reports = reports.filter(function (r) { return r.id !== report.id; });
    if (expandedId === report.id) expandedId = null;
    confirmingDelete = null;
    saveReports();
    render();
    MW.util.toast('已删除这条登记', 'warn', '它带来的规则草稿如果已经合并进规则表，需要自己去规则表里删。');
  }

  function mergeDraft(report) {
    const draft = report.draft;
    if (!draft) return;
    if (!String(draft.title || '').trim()) {
      MW.util.toast('草稿缺少标题，没能合并', 'error', '规则表要求每条规则都有标题。');
      return;
    }
    const saved = MW.compat.upsert(draft);
    if (!saved) return; // upsert 自己已经把原因 toast 过了

    report.draftMerged = true;
    saveReports();
    document.dispatchEvent(new CustomEvent('mw:result'));
    render();
    MW.util.toast('草稿已合并进规则表', 'ok', '体检页已经按新规则重算，规则表里也能看到它。');
  }

  /* ==================== 导入导出 ==================== */

  function userRules() {
    return MW.compat.all().filter(function (rule) { return rule.builtin !== true; });
  }

  function downloadJson(payload) {
    const text = JSON.stringify(payload, null, 2);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = global.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mdwechat-' + stamp() + '.json';

    // 必须挂进文档再点：游离节点上的 click() 在部分浏览器里不触发下载
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 不能马上 revoke：下载还没开始就作废 blob 地址，大文件上会直接失败
    global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 4000);

    return a.download;
  }

  function exportJson() {
    const name = downloadJson({
      kind: 'mdwechat-state',
      version: 1,
      exportedAt: new Date().toISOString(),
      reports: reports,
      rules: userRules()
    });
    MW.util.toast('已导出 ' + name, 'ok',
      reports.length + ' 条登记、' + userRules().length + ' 条用户规则。内置 25 条在代码里，无需导出。');
  }

  /** 兼容三种输入：本工具导出的包、裸的规则数组、裸的登记数组。 */
  function normalizeImport(parsed) {
    if (Array.isArray(parsed)) {
      const looksLikeRules = parsed.some(function (item) {
        return item && item.status && (item.property !== undefined || item.target !== undefined);
      });
      return looksLikeRules ? { reports: [], rules: parsed } : { reports: parsed, rules: [] };
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('文件内容既不是数组也不是对象，无法识别');
    }
    return {
      reports: Array.isArray(parsed.reports) ? parsed.reports : [],
      rules: Array.isArray(parsed.rules) ? parsed.rules : []
    };
  }

  function importText(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error('不是合法的 JSON：' + err.message);
    }

    const incoming = normalizeImport(parsed);

    let addedReports = 0;
    incoming.reports.forEach(function (item) {
      if (!item || !item.id) return;
      if (reports.some(function (r) { return r.id === item.id; })) return;
      reports.push(item);
      addedReports++;
    });
    // 倒序：最新的在前。导入的记录时间戳是历史时间，也应该落到它该在的位置上
    reports.sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
    if (reports.length > MAX_REPORTS) {
      const dropped = reports.length - MAX_REPORTS;
      reports = reports.slice(0, MAX_REPORTS);
      MW.util.toast('导入后超过上限，已按时间保留最新的 ' + MAX_REPORTS + ' 条', 'warn',
        '较早的 ' + dropped + ' 条没有导入，原文件里还在。');
    }
    saveReports();

    let addedRules = 0;
    incoming.rules.forEach(function (rule) {
      if (!rule || !rule.id) return;
      // 内置 id 一律按内置处理：导入文件里的同 id 条目不能覆盖代码里的规则
      if (builtins()[rule.id]) return;
      if (MW.compat.upsert(rule)) addedRules++;
    });

    document.dispatchEvent(new CustomEvent('mw:result'));
    render();
    MW.util.toast('导入完成', 'ok',
      '新增 ' + addedReports + ' 条登记、' + addedRules + ' 条用户规则；同 id 的按「用户规则优先」合并。');
  }

  function importFromFile(file) {
    const reader = new FileReader();
    reader.onload = function () {
      try {
        importText(String(reader.result || ''));
      } catch (err) {
        MW.util.toast(err && err.message ? err.message : String(err), 'error', '文件：' + file.name);
      }
    };
    reader.onerror = function () {
      MW.util.toast('读取文件失败：' + file.name, 'error');
    };
    reader.readAsText(file);
  }

  /* ==================== 生命周期 ==================== */

  let bound = false;

  function onPaste(event) {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image/') === 0) {
        const file = items[i].getAsFile();
        if (!file) continue;
        // 只接管图片粘贴；文字粘贴是正常输入，拦下来会把表单搞坏
        event.preventDefault();
        acceptShot(file);
        return;
      }
    }
  }

  function bind() {
    if (bound) return;
    bound = true;

    // 新产物 = 标题变了，「问题位置」下拉得跟着换。
    // 这里不复用 render()：整面板重绘会打断用户正在填的表单。
    document.addEventListener('mw:result', function () {
      if (!el.host || !el.manualWrap) return;
      const select = el.host.querySelector('select');
      if (!select) return;
      const keep = select.value;
      const options = [{ value: '', label: '整篇 / 不确定' }];
      outlineList().forEach(function (item) {
        const pad = item.level > 1 ? '　'.repeat(item.level - 1) : '';
        options.push({ value: item.nodeId, label: pad + 'H' + item.level + ' ' + String(item.text).slice(0, 40) });
      });
      options.push({ value: '__manual__', label: '手动指定…' });
      select.textContent = '';
      options.forEach(function (opt) {
        select.appendChild(h('option', { value: opt.value, text: opt.label }));
      });
      select.value = keep;
    });
  }

  function init(host) {
    if (!host) return;
    el.host = host;
    reports = readReports();
    bind();
    host.addEventListener('paste', onPaste);
    render();
  }

  MW.panels = MW.panels || {};
  MW.panels.report = {
    PHASE: PHASE,
    init: init,
    render: render,
    /** 供控制台与后续阶段取用：登记记录、规则校验、提示词生成 */
    reports: function () { return reports.slice(); },
    validateRules: validateRules,
    buildPrompt: buildPrompt,
    /**
     * 供 app.js 的 Esc 统一关闭调用。
     * 报告面板自己只管「遮罩被点」和「遮罩内的关闭按钮」两条路径，
     * 键盘这条路径集中到 app.js，免得两处各写一份、以后改快捷键时漏掉一处。
     */
    closePrompt: closePrompt,
    /** 有没有开着的提示词弹层。Esc 要按优先级依次关，得先问一层。 */
    hasPrompt: function () { return !!promptMask; }
  };
})(window);
