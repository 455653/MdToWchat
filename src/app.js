/*
 * app.js —— 引导与事件绑定
 *
 * 为什么它必须最后加载：
 * 它是唯一有副作用的文件（读 localStorage、挂事件、跑第一次渲染），
 * 前面所有模块都要先完成「向 window.MW 注册自己」这一步，它才能找到它们。
 *
 * 本文件负责六件事，不负责渲染逻辑本身——那在 pipeline 里；
 * 也不负责剪贴板机制本身——那在 clipboard 里：
 *   1. 恢复上次的文档 / 文件名 / 主题；
 *   2. 绑定输入通路（textarea、文件选择、拖拽、粘贴）与 tab 切换；
 *   3. 把 pipeline 的产物挂到文章容器上（空态、错误态的落位也在这里）；
 *   4. 复制的编排：体检 → 知情确认 → 写剪贴板 → 如实反馈（+ 复制源码、纯净页、Ctrl+S 存盘）；
 *   5. 快捷键，以及「关掉最上面那一层弹层」的唯一入口——
 *      弹层分散在三个模块里（确认框在本文件、二维码在 view、提示词在 report 面板），
 *      键盘事件却只有一条；集中在一处，才不会出现「改了快捷键、漏掉某个弹层」；
 *   6. 一次性外壳：首次引导、页脚那两个折叠面板（怎么用 / 自检）。
 *
 * 为什么复制要有「体检」这一步：
 *   「已复制」这个反馈本身不携带任何信息。用户需要知道的是
 *   「复制出去的那一份，有哪些地方预计会丢」——这才是他决定要不要粘的依据。
 *   所以主按钮的第一件事不是写剪贴板，而是先问产物一遍：现在有什么一定会丢？
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});
  const util = MW.util;

  // key 名集中在这里定义。散落各处最容易出的错是「写的时候 mw.doc、读的时候 mw.docs」，
  // 表现为「刷新后内容丢了」，而且不报错，极难查。
  const KEY_DOC = 'mw.doc';
  const KEY_NAME = 'mw.name';
  const KEY_REV = 'mw.rev';

  const DEFAULT_NAME = '未命名.md';
  const SAVE_DEBOUNCE = 500;   // 需求规定：输入停止 500ms 才落盘
  const RENDER_DEBOUNCE = 180; // 预览比落盘可以更灵敏，但不必每个按键都重建 DOM

  /**
   * 长文档用更长的输入防抖。
   * 50KB 是「几百段文字 + 几张图」的量级；到这一步，一次重渲染的代价已经明显大过
   * 「多看 0.5 秒旧画面」，而那 0.5 秒换来的是一次真正不卡手的输入。
   * 阈值按 UTF-8 字节算而不是按字符数：一个汉字三字节，按字符数算会把一份
   * 50KB 的中文文档当成 17KB，分档等于没分。
   */
  const LONG_DOC_BYTES = 50 * 1024;
  const RENDER_DEBOUNCE_SLOW = 800;

  /** 首次引导「知道了」的标记。它只影响下一次打开是否再弹，丢了也无所谓。 */
  const KEY_ONBOARD = 'mw.onboard';

  const state = {
    name: DEFAULT_NAME,
    hasFile: false,
    encoding: 'UTF-8',
    storageOk: true
  };

  let storageWarned = false;
  const el = {};
  let lastResult = null; // 最近一次管线产物，供控制台与后续面板取用

  /**
   * 用户手动映射进来的本地图片：{ 文件名: data:URI }。
   * 为什么需要它：外链图片与 file:// 下的相对路径都读不到像素，P5 只能落占位图；
   * 但那张原图往往就在用户手边，让他按文件名指认一次，产物里就能换成真图。
   * 键同时存原样与小写两份：md 里写的文件名大小写常常和磁盘上对不上，
   * media.js 的 resolveSource 也是按这两种形态各查一次。
   */
  const localImageMap = Object.create(null);

  const saveDebounced = util.debounce(function () { saveNow(); }, SAVE_DEBOUNCE);

  /*
   * 两个渲染防抖实例，而不是一个「到点再挑档位」的实例：
   * util.debounce 的 wait 在创建那一刻就定死了，想在同一个实例里换档就得自己
   * 重造一份定时器逻辑，反而把「什么时候该慢下来」这件事藏进定时器里。
   * 拆成两个之后，档位判断集中在 renderSoon 一处，读起来就是一句人话。
   */
  const renderDebouncedFast = util.debounce(function (options) { renderPreview(options); }, RENDER_DEBOUNCE);
  const renderDebouncedSlow = util.debounce(function (options) { renderPreview(options); }, RENDER_DEBOUNCE_SLOW);

  /**
   * 输入通路统一走这里。
   * 为什么不一律用 800ms：短文里那 0.8 秒会被读成「打字没反应」。
   * 为什么不一律用 180ms：长文里每停 180ms 就重建一次几百 KB 的 DOM，输入会一顿一顿。
   */
  function renderSoon(options) {
    const slow = util.utf8Bytes(el.input.value) > LONG_DOC_BYTES;
    (slow ? renderDebouncedSlow : renderDebouncedFast)(options);
  }

  function $(id) { return document.getElementById(id); }

  /* ==================== localStorage ==================== */

  function noteStorageError(err) {
    state.storageOk = false;
    // 只提示一次。Safari 的 file:// 会禁用 localStorage，
    // 若不做这个开关，防抖会每 500ms 弹一次错，页面直接变成噪音源。
    if (storageWarned) return;
    storageWarned = true;
    util.toast('本地存储不可用，刷新后内容不会保留：' + (err && err.message ? err.message : err), 'warn');
  }

  function probeStorage() {
    // 这里的 try/catch 是能力探测，不是吞异常：
    // 写探针失败会走 noteStorageError，用户一定能看见提示。
    try {
      localStorage.setItem('__mw_probe__', '1');
      localStorage.removeItem('__mw_probe__');
      return true;
    } catch (err) {
      noteStorageError(err);
      return false;
    }
  }

  function readKey(key) {
    if (!state.storageOk) return null;
    try {
      return localStorage.getItem(key);
    } catch (err) {
      noteStorageError(err);
      return null;
    }
  }

  function writeKey(key, value) {
    if (!state.storageOk) return false;
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (err) {
      noteStorageError(err);
      return false;
    }
  }

  /**
   * 每次保存把 mw.rev 加一。
   * 它的用途在 P2：手机端页面轮询这个数字，数字变了就说明桌面端改了内容，
   * 于是重新拉取。不做这件事，手机预览就只能靠手动刷新。
   */
  function bumpRev() {
    const next = (Number(readKey(KEY_REV)) || 0) + 1;
    writeKey(KEY_REV, String(next));
  }

  function saveNow() {
    const text = el.input.value;
    writeKey(KEY_DOC, text);
    // 只有真的载入过文件才写文件名。否则「纯手敲」的文档也会把「未命名.md」
    // 存进去，下次打开时被当成「已选文件」，顶栏的虚线框就永远消失了。
    writeKey(KEY_NAME, state.hasFile ? state.name : '');
    bumpRev();

    // 每次落盘顺带推给局域网同步服务，手机端 800ms 一次的轮询就是从那里取新内容的。
    // 失败不做处理：没开 serve.cmd 是常态（用户可能只是在自己电脑上用），
    // MW.sync 内部会在整场会话里最多提醒一次，不会每 500ms 弹一个提示。
    MW.sync.push({
      rev: Number(readKey(KEY_REV)) || 0,
      doc: text,
      name: state.hasFile ? state.name : '',
      theme: MW.panels.settings.get()
    });
  }

  /* ==================== 视图 ==================== */

  function renderFileName() {
    el.fileName.textContent = state.name;
    // 虚线框 = 「还没选文件」。手工敲文字不算选文件，所以以 hasFile 为准。
    el.fileName.classList.toggle('is-empty', !state.hasFile);
    el.fileName.title = state.hasFile ? state.name : '还没有选择文件';
  }

  /**
   * 渲染预览。P5 起是异步的：图片、公式与图表的内嵌需要等懒加载库与栅格化完成。
   *
   * 这里用「单飞」锁保证同一时刻只有一次渲染在跑：
   * 用户连续敲键盘时，防抖只是把调用收拢成「180ms 一次」，但每次仍是独立的
   * async 调用。没有这把锁，前一次还没 await 回来，后一次就先跑了，
   * 两次的产物挂到双栏上的顺序是不确定的，可能后跑的先完成、先跑的后完成，
   * 最终挂上去的是过时产物（「我改了两个字，预览反而退回去了」）。
   *
   * 返回值是 Promise<产物 | null>。null 只有一种情况：这次渲染失败，
   * 原因已经写进预览区的错误块、也弹过 toast 了，调用方只需「什么都不做」。
   *
   * options.reuse —— 表达「md 一字未改，只是主题变了」这个意图。
   *   这里只负责把意图传下去，能不能真复用由 pipeline 拿 md 原文对账决定：
   *   主题滑块一拖就是几十个事件，每个都从零解析一遍几百 KB 的 md 是纯浪费。
   */
  let renderToken = 0;

  function renderPreview(options) {
    const opts = options || {};
    const myToken = ++renderToken;
    const text = el.input.value;

    showRenderProgress(0, 0, '正在渲染…');

    return MW.pipeline.build(text, {
      encoding: state.encoding,
      images: localImageMap,
      reuse: !!opts.reuse,
      onProgress: function (info) {
        if (myToken !== renderToken) return; // 已经不是最新一次了，回调别再动 DOM
        showRenderProgress(info.done, info.total, info.label);
      }
    }).then(function (out) {
      if (myToken !== renderToken) return out; // 过时了：不挂载，但把产物交给调用方
      hideRenderProgress();

      MW.view.paint(out);

      el.stats.textContent = out.meta.chars + ' 字符 · ' + out.meta.lines + ' 行 · '
        + util.formatBytes(out.meta.bytes);

      // 自检按钮只对「手上有一份正常产物」的时候开放。
      // 空文档或解析失败时它跑出来必然是一片红，那不是自检结果，是自检的噪音；
      // 这两种状态直接禁用——禁用比「点了没反应」和「点出一片红」都更诚实。
      el.btnSelfCheck.disabled = !!(out.meta.empty || out.meta.error);

      // 多媒体告警接在统计后面：用户需要知道「有图占位了」「全文超 4MB」。
      // 复用渲染（主题变化）不重复播报：同一份告警在拖一次字号滑块的过程中
      // 会被弹十几次，最后整屏都是它。
      if (!out.meta.reused
        && out.meta.media && out.meta.media.warnings && out.meta.media.warnings.length) {
        out.meta.media.warnings.forEach(function (w) { util.toast(w, 'warn'); });
      }

      lastResult = out;
      // 通知面板「产物换了」。体检面板据此重跑一遍判定，登记面板据此刷新
      // 「问题位置」下拉（新文档的标题变了）。
      // 用事件而不是让面板自己去轮询：只有这里知道「什么时候有了一份新产物」，
      // 轮询只会把这件事变成定时器猜谜。放在单飞锁判断之后，过时产物不会发通知。
      document.dispatchEvent(new CustomEvent('mw:result'));
      return out;
    }).catch(function (err) {
      if (myToken !== renderToken) return null;
      hideRenderProgress();
      const message = err && err.message ? err.message : String(err);

      // 两处都要说，缺一不可：
      //   toast 负责「此刻告诉我」；预览区的错误块负责「我回头看时原因还在」。
      // 只 toast 的话，四秒后它就消失了，用户再往预览区一看只剩一页空白，
      // 分不清那是「没内容」还是「出错」——这正是最难自查的失败形态。
      MW.view.paintError({
        title: '渲染没能完成',
        message: message,
        hint: '改一下左侧内容就会自动重试；如果一直失败，刷新页面再试一次。'
      });
      el.btnSelfCheck.disabled = true;

      util.toast('渲染失败：' + message, 'error', '预览区已经写明原因。改完左侧内容会自动重试。');
      // 返回 null，不把错误继续抛出去：错误已经用 toast 让用户看见了，
      // 再抛出去只会在 applyText、beforeunload 这些没人接 then 的调用点
      // 变成一条 unhandled rejection，对用户而言是「多报了一次没用的错」。
      return null;
    });
  }

  function showRenderProgress(done, total, label) {
    if (!el.renderBar) return;
    if (!total) { el.renderBar.hidden = true; return; }
    el.renderBar.hidden = false;
    el.renderBarLabel.textContent = label || '';
    el.renderBarCount.textContent = done + ' / ' + total;
    el.renderBarFill.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
  }

  function hideRenderProgress() {
    if (!el.renderBar) return;
    el.renderBar.hidden = true;
  }

  /**
   * 唯一的「文档内容变了」入口。
   * 手工输入、拖拽、文件选择三条通路最终都走这里，
   * 这样统计、文件名、预览、落盘的行为不可能出现分叉。
   */
  function applyText(text, name, options) {
    const opts = options || {};
    const value = text == null ? '' : text;

    state.name = name || DEFAULT_NAME;
    state.hasFile = !!opts.fromFile;
    if (opts.encoding) state.encoding = opts.encoding;

    el.input.value = value;
    renderFileName();
    // renderPreview 是异步的：滚动重置得等产物真的挂上去，
    // 否则它量到的是上一份文档的高度，滚动条会停在一个不存在的位置上。
    renderPreview().then(function () { MW.view.resetScroll(); });
    // 落盘不等渲染：存的是 md 原文，与产物无关。
    if (opts.immediate) saveNow(); else saveDebounced();

    // 二期：告诉分步条「这是一次导入」。它据此走第 2 步的询问；
    // 手敲文字不算导入，所以只认 fromFile。「什么时候发生了一次导入」
    // 只有这里知道——让分步条自己去猜（例如监听 input）一定会猜错。
    if (opts.fromFile) document.dispatchEvent(new CustomEvent('mw:import'));
  }

  /**
   * 只替换编辑区正文，不动文件名 / 编码 / hasFile。
   * 二期的「回溯上一步」用它把上一个版本的正文写回来——那是编辑动作，
   * 不该顺带把「已载入文件」这个状态抹掉（那会让顶栏的虚线框重新出现）。
   *
   * 返回这次渲染的产物（Promise<产物 | null>）。润色面板要拿它读 meta.dropped，
   * 才知道有没有「会被公众号整块丢掉」的写法、要不要接着跑修订那一轮
   * （PLAN-II.md §9 的「前端算 + 回传」）。「回溯上一步」不接这个返回值，行为不变。
   */
  function setText(text) {
    el.input.value = text == null ? '' : text;
    // 落盘不等渲染：存的是 md 原文，与产物无关。
    saveNow();
    return renderPreview().then(function (out) {
      // 滚动重置得等产物真的挂上去，否则量到的是上一份文档的高度。
      MW.view.resetScroll();
      return out;
    });
  }

  /* ==================== 输入通路 ==================== */

  function loadFile(file) {
    util.readFile(file).then(function (res) {
      applyText(res.text, res.name, { immediate: true, fromFile: true, encoding: res.encoding });
      if (res.encoding === 'GBK') util.toast('已按 GBK 解码：' + res.name);
      if (res.lossy) util.toast('编码可能不是 UTF-8，建议另存为 UTF-8 后重新载入', 'warn');
    }).catch(function (err) {
      // 读文件失败必须让用户看见，不能只是「什么都没发生」。
      // 后半句是「接下来能做什么」：只说失败，用户下一步只能靠猜。
      util.toast(err.message, 'error', '可以换一个文件再试，或把内容直接粘进左侧输入框。');
    });
  }

  function bindFilePicker() {
    el.btnOpen.addEventListener('click', function () {
      // 先清空 value：不清空的话连续选同一个文件不会触发 change，
      // 用户会以为「点了没反应」。
      el.picker.value = '';
      el.picker.click();
    });

    el.picker.addEventListener('change', function () {
      const file = el.picker.files && el.picker.files[0];
      if (file) loadFile(file);
    });
  }

  /**
   * 把用户选中的图片读成 data: URI。
   * 用 FileReader 而不是 fetch：硬约束 3 禁止读本地文件，而 FileReader 收的是
   * <input type="file"> 交出来的 File 对象，是唯一合法的本地内容入口。
   */
  function readImageAsDataUri(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('读取图片失败：' + file.name)); };
      reader.readAsDataURL(file);
    });
  }

  /**
   * 「映射本地图片」：外链图片与相对路径在 file:// 下读不到像素，P5 只能落占位图。
   * 这一步让用户按文件名把真图交出来，同名（含大小写差异）的图片就会优先用它。
   * 不落盘：data: URI 动辄几百 KB，写进 localStorage 会很快撑爆配额，
   * 而那会让整个文档都存不进去——用「本次会话有效」换「文档永远存得住」。
   */
  function bindImagePicker() {
    el.btnMapImages.addEventListener('click', function () {
      // 先清空 value：与「打开 md」同理，不清空就选同一批文件不会再触发 change
      el.imagePicker.value = '';
      el.imagePicker.click();
    });

    el.imagePicker.addEventListener('change', function () {
      const files = el.imagePicker.files ? Array.prototype.slice.call(el.imagePicker.files) : [];
      if (!files.length) return;

      let okCount = 0;
      Promise.all(files.map(function (file) {
        return readImageAsDataUri(file).then(function (uri) {
          if (!uri) return;
          localImageMap[file.name] = uri;
          localImageMap[file.name.toLowerCase()] = uri;
          okCount++;
        }).catch(function (err) {
          util.toast(err.message, 'error', '这一张会继续显示占位图，其余图片不受影响。');
        });
      })).then(function () {
        if (!okCount) return;
        util.toast('已映射 ' + okCount + ' 张本地图片', 'ok', '同名的外链图片会改用它们，正在重新渲染。');
        renderSoon();
      });
    });
  }

  function bindDragAndDrop() {
    let depth = 0; // enter/leave 计数，见下方注释

    function carriesFiles(event) {
      const dt = event.dataTransfer;
      if (!dt) return false;
      const types = dt.types ? Array.from(dt.types) : [];
      return types.indexOf('Files') >= 0;
    }

    function show() { el.mask.classList.add('is-on'); }
    function hide() { depth = 0; el.mask.classList.remove('is-on'); }

    // 拖过子元素时，浏览器会在每个元素上分别触发 enter/leave。
    // 只用「有 enter 就显示、有 leave 就隐藏」会疯狂闪烁，
    // 所以用计数：enter 加一、leave 减一，减到 0 才真正隐藏。
    global.addEventListener('dragenter', function (event) {
      if (!carriesFiles(event)) return; // 页面内拖选文字不该弹遮罩
      event.preventDefault();
      depth++;
      show();
    });

    // 这一行是必须的：不 preventDefault，浏览器会认为页面不接受 drop，
    // 松手时既不触发 drop，还会用浏览器默认行为打开这个文件。
    global.addEventListener('dragover', function (event) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      // 拖拽过程中 DOM 变化可能产生多余的 dragleave，让计数提前掉到 0。
      // dragover 是持续触发的，用它兜底校正，遮罩就不会莫名消失。
      if (depth === 0) { depth = 1; show(); }
    });

    global.addEventListener('dragleave', function (event) {
      // 这里不加 carriesFiles 判断：部分浏览器在 dragleave 时 types 已为空，
      // 判断了会导致遮罩永远关不掉。计数减到负数由 Math.max 兜住。
      event.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) el.mask.classList.remove('is-on');
    });

    global.addEventListener('drop', function (event) {
      // 只接管「拖文件」这一种 drop。
      // 把选中文字拖进 textarea 是正常编辑行为，拦下它会把编辑器搞坏。
      if (!carriesFiles(event)) return;
      event.preventDefault();
      hide();
      const dt = event.dataTransfer;
      const file = dt && dt.files && dt.files[0];
      if (file) loadFile(file);
    });
  }

  function bindInput() {
    el.input.addEventListener('input', function () {
      // 手敲文字时不再算「已选文件」，但保留当前文件名显示，
      // 避免用户改两个字就看不到自己在编辑哪个文件。
      renderSoon();
      saveDebounced();
    });

    // 兜底：防抖窗口内刷新会丢掉最后几个字，落盘前补一次。
    global.addEventListener('beforeunload', function () { saveNow(); });
  }

  /**
   * 主题变更 → 重跑管线，但只重跑「与主题有关的那一段」。
   * 产物在 P2 起是把样式固化死在元素上的，改 CSS 变量不会自动回头改内联样式，
   * 不重跑就会出现「参数条显示 18px、预览还是 16px」。
   *
   * 为什么传 reuse:true：解析 + 降级 + 多媒体内嵌（尤其图片转 data: URI）是
   * 整条管线里最贵的一段，而它们与主题完全无关——主题只影响「元素算出来的样式」，
   * 也就是固化那一步读的东西。拖一次滑块就把几百 KB 的 md 重新解析一遍是纯浪费。
   * 这只是意图，pipeline 会拿 md 原文对账，对不上就老老实实走完整流程。
   *
   * 仍走防抖：拖滑块时 input 事件非常密集，每个事件都跑一次固化会明显卡手。
   */
  function bindTheme() {
    document.addEventListener('mw:theme', function () { renderSoon({ reuse: true }); });
  }

  function bindTabs() {
    el.tabs.addEventListener('click', function (event) {
      const btn = event.target.closest ? event.target.closest('.tab') : null;
      if (!btn) return;
      const name = btn.getAttribute('data-tab');

      const tabs = el.tabs.querySelectorAll('.tab');
      for (let i = 0; i < tabs.length; i++) {
        tabs[i].classList.toggle('is-active', tabs[i] === btn);
      }
      const panels = document.querySelectorAll('.tabpanel');
      for (let i = 0; i < panels.length; i++) {
        panels[i].classList.toggle('is-active', panels[i].getAttribute('data-panel') === name);
      }

      // 预览面板刚从 display:none 里出来时量不到宽度，左栏的缩放系数会停在旧值上。
      // 切回来补算一次，否则「先看体检、再切回预览」会看到一栏没缩放的内容。
      if (name === 'preview') MW.view.refresh();
    });
  }

  /* ==================== 复制到公众号 ==================== */

  /**
   * 复制前体检。
   *
   * 为什么不逐条去扫 class / <style> / flex / position：
   *   产物在离开管线之前已经被归一器洗过一遍，这些东西在生成端就不存在了，
   *   再去扫它们，扫到的永远是 0。那不是体检，是安慰剂。
   *
   * P5 之后「会丢的东西」只剩两类，这里就只回答这两类：
   *   1. 非 data: 的 img src —— 内嵌那一步漏了（这是 A7 的契约，留着当护栏）。
   *   2. 占位图 —— 图片位置还在，但内容不是原图。它才是 P5 之后真正会「丢」的一类，
   *      所以体检要把它翻出来，并告诉用户解法（去点「映射本地图片」）。
   */
  function scanRisks(out) {
    const risks = [];
    if (!out || !out.root || !out.root.querySelectorAll) return risks;

    const images = out.root.querySelectorAll('img');
    let remote = 0;
    for (let i = 0; i < images.length; i++) {
      const src = images[i].getAttribute('src') || '';
      if (src.indexOf('data:') !== 0) remote++;
    }
    if (remote) {
      risks.push({
        count: remote,
        text: remote + ' 张图片还是外链地址：粘到公众号后会提示「上传失败」（L19）。'
          + '这不该发生——图片内嵌这一步可能没跑到，请刷新后重试。'
      });
    }

    const media = out.meta && out.meta.media;
    if (media && media.placeholders) {
      risks.push({
        count: media.placeholders,
        text: media.placeholders + ' 张图片没能读到像素（外链或相对路径），产物里是占位图。'
          + '想换成真图：点顶栏「映射本地图片」，选同名文件后重新复制。'
      });
    }
    return risks;
  }

  let pendingConfirm = null;

  function closeConfirm() {
    el.confirmMask.hidden = true;
    el.confirmBody.textContent = '';
    pendingConfirm = null;
  }

  /**
   * 知情确认。
   * 为什么不用 window.confirm：原生 confirm 会吃掉这次点击的用户手势，
   * 关掉之后再调 navigator.clipboard.write 会被浏览器拒掉，
   * 表现成「点了确定反而复制失败」，且只在部分浏览器上复现。
   * 用这个框，「继续复制」那一次点击本身就是手势。
   *
   * 为什么把待执行的复制交给按钮回调而不是写在文案里：
   * 用户点「继续复制」之前，剪贴板一个字节都不该被动过。
   */
  function showConfirm(risks, onOk) {
    let total = 0;
    for (let i = 0; i < risks.length; i++) total += risks[i].count;

    el.confirmBody.textContent = '';
    const lead = document.createElement('p');
    lead.className = 'confirm-lead';
    lead.textContent = '有 ' + total + ' 处样式预计会丢失，仍要复制吗？';
    el.confirmBody.appendChild(lead);

    const list = document.createElement('ul');
    for (let i = 0; i < risks.length; i++) {
      const li = document.createElement('li');
      li.textContent = risks[i].text;
      list.appendChild(li);
    }
    el.confirmBody.appendChild(list);

    pendingConfirm = onOk;
    el.confirmMask.hidden = false;
  }

  /**
   * 写剪贴板。
   * 三层顺序不能变：富文本两条路都失败，才退成纯文本；
   * 而退成纯文本必须说「只复制了文字」，不能说「复制失败」——
   * 文字确确实实进去了，说失败会让用户再点一次，把已经成功的事变成白干。
   */
  function doCopy(out) {
    const plain = MW.clipboard.htmlToText(out.html);

    return MW.clipboard.copyRich(out.html, plain).then(function (method) {
      if (method !== 'failed') {
        util.toast('已复制，去公众号编辑器按 Ctrl+V 粘贴', 'ok', '粘完记得用手机的「预览」看一眼');
        return;
      }
      return MW.clipboard.copyText(plain).then(function (ok) {
        if (ok) {
          util.toast('只复制了文字，样式没带上', 'warn', '浏览器没放开富文本剪贴板，粘过去后需要自己调一下格式。');
        } else {
          util.toast('没能写进剪贴板', 'error', '可以点「打开纯净页」，在那一页里按 Ctrl+A、Ctrl+C 手动复制。');
        }
      });
    });
  }

  /**
   * 拿一份可复制的产物：手上已有就直接用，没有（首屏还没渲染完）就现渲染一次。
   * P5 起 renderPreview 返回的是 Promise，复制入口必须先 await 它——
   * 早先那种 `lastResult || renderPreview()` 的写法现在会拿到一个 Promise 对象，
   * 后面读 out.meta 全是 undefined，表现成「点了复制没反应」。
   */
  function ensureResult() {
    if (lastResult) return Promise.resolve(lastResult);
    return renderPreview();
  }

  /** 主操作：先体检，有风险就先问；没问题直接复制。不允许静默复制。 */
  function copyForWechat() {
    ensureResult().then(function (out) {
      // renderPreview 失败时返回 null（原因已经 toast 过），这里不再重复提示
      if (!out) return;

      if (out.meta.empty) {
        util.toast('编辑器里还没有内容，没什么可复制的', 'warn');
        return;
      }

      const risks = scanRisks(out);
      if (risks.length) {
        showConfirm(risks, function () { doCopy(out); });
        return;
      }
      doCopy(out);
    });
  }

  /** 次要操作：复制产物源码（带缩进），给公众号的「源码模式」与排查用。 */
  function copySource() {
    ensureResult().then(function (out) {
      if (!out) return;

      if (out.meta.empty) {
        util.toast('编辑器里还没有内容，没什么可复制的', 'warn');
        return;
      }

      const source = MW.clipboard.formatHtml(out.html);
      return MW.clipboard.copyText(source).then(function (ok) {
        if (ok) {
          util.toast('已复制源码（' + source.length + ' 字符）', 'ok',
            '公众号的「源码模式」可以直接粘，也可以粘进编辑器里排查。');
        } else {
          util.toast('没能写进剪贴板', 'error',
            '浏览器没放开剪贴板权限。可以在控制台执行 MW.clipboard.formatHtml(MW.app.result().html) 取出源码。');
        }
      });
    });
  }

  /**
   * 打开纯净页（?mode=copy）。
   * 地址用 location.href 去掉 query 再拼，而不是 location.origin + pathname：
   * file:// 下 location.origin 是字符串 "null"，拼出来的地址根本打不开，
   * 而双击 index.html 正是这个工具的主要用法。
   */
  function openCopyPage() {
    const base = global.location.href.split('?')[0].split('#')[0];
    global.open(base + '?mode=copy', '_blank');
  }

  /* ==================== Ctrl/Cmd+S 存盘 ==================== */

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /** 文件名：有文件名就用它，没有才用时间戳——用户得一眼认出这是哪一份。 */
  function downloadName() {
    if (state.hasFile && state.name) return state.name;
    const d = new Date();
    return '未命名-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
      + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + '.md';
  }

  /**
   * 把当前 md 存回本地。
   * 用 Blob + a[download] 而不是 File System Access API：
   * 后者只有 Chromium 有，且要在 https 或 localhost 下才给用，而这里必须在 file:// 下工作。
   */
  function saveToFile() {
    const blob = new Blob([el.input.value], { type: 'text/markdown;charset=utf-8' });
    const url = global.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName();

    // 必须挂进文档再点：游离节点上的 click() 在部分浏览器里不触发下载
    document.body.appendChild(a);
    a.click();
    a.remove();

    // 不能马上 revoke：下载还没开始就把 blob 地址作废，大文件上会直接失败。
    // 拖 4 秒的代价只是一个短时间内不会被回收的内存块。
    global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 4000);

    util.toast('已保存为 ' + a.download, 'ok', 'UTF-8 编码，内容和左侧输入框一致。');
  }

  /* ==================== 绑定 ==================== */

  function bindCopy() {
    el.btnCopy.addEventListener('click', copyForWechat);
    el.btnCopySrc.addEventListener('click', copySource);
    el.btnCopyPage.addEventListener('click', openCopyPage);

    el.btnConfirmCancel.addEventListener('click', closeConfirm);
    el.btnConfirmOk.addEventListener('click', function () {
      const run = pendingConfirm;
      // 先收起确认框再复制：卡片还盖在上面时，用户看不见下面刚弹出来的 toast
      closeConfirm();
      if (run) run();
    });
    el.confirmMask.addEventListener('click', function (event) {
      if (event.target === el.confirmMask) closeConfirm();
    });
  }

  /**
   * 快捷键。
   * 挂在 document 上而不是 textarea 上：Ctrl+Enter 多半是在刚写完正文时按的，
   * 那一刻焦点正在 textarea 里，挂 document 这条要求才成立。
   * 只对自己真正处理的组合键 preventDefault，别的按键一个都不碰——
   * 一旦顺手拦了别的键，输入法、Tab、方向键都会在这里坏掉。
   *
   * Esc 排在所有分支之前：它是「先逃出来」的键，该关掉眼前压着的那一层，
   * 而不是先判断「现在焦点在哪、有没有按 Ctrl」。
   */
  function bindShortcuts() {
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        // 关得掉才 preventDefault：页面上什么都没开着的时候，Esc 该留给浏览器
        // （例如退出全屏），不该被这里无声吃掉。
        if (closeTopLayer()) event.preventDefault();
        return;
      }

      // 确认框开着时只认 Esc（上面已处理）：否则连按两次 Ctrl+Enter
      // 会在框上再叠一层同样的问题说明。
      if (!el.confirmMask.hidden) return;

      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.isComposing) return; // 输入法组合中，Ctrl 组合交给输入法自己处理

      const key = String(event.key || '').toLowerCase();

      if (key === 'enter' && !event.altKey) {
        event.preventDefault();
        copyForWechat();
        return;
      }
      // Ctrl/Cmd+Shift+P 打开纯净页。
      // 为什么不占 Ctrl+P：那是打印，弹一次打印对话框用户就再也不会用这个快捷键了；
      // Ctrl+Shift+P 在网页里没有浏览器的默认行为（它只在 DevTools 聚焦时是命令面板）。
      if (key === 'p' && event.shiftKey && !event.altKey) {
        event.preventDefault();
        openCopyPage();
        return;
      }
      // Ctrl+Shift+S 是浏览器自己的「另存为」，不抢
      if (key === 's' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        saveToFile();
      }
    });
  }

  /* ==================== 弹层与页脚面板 ==================== */

  /**
   * 关掉「压在最上面的那一层」，关掉就返回 true。
   *
   * 为什么按「盖得越高越先关」的顺序来，而不是一次全关：
   * Esc 的语义是「退出眼前这一层」。一次全关会让用户按第一下就把确认框里的选择
   * 一起清掉——他明明只是想退出后面那层。
   *
   * 为什么集中在 app.js：这几层分散在三个模块里（确认框在本文件、二维码在 view、
   * 提示词在 report 面板），键盘事件却只有一条。分散写的话，以后加一层弹层，
   * Esc 就会悄悄漏掉它，而且没人会发现。
   */
  function closeTopLayer() {
    if (!el.onboardMask.hidden) { closeOnboard(); return true; }
    if (!el.confirmMask.hidden) { closeConfirm(); return true; }
    // 提示词弹层由面板自己创建/销毁，所以这里得先问它有没有，再让它关。
    if (MW.panels.report.hasPrompt()) { MW.panels.report.closePrompt(); return true; }
    if (!el.qrMask.hidden) { MW.view.closeQr(); return true; }
    if (!el.selfcheckPanel.hidden) { togglePanel('selfcheck', false); return true; }
    if (!el.helpPanel.hidden) { togglePanel('help', false); return true; }
    return false;
  }

  /* ==================== 首次使用引导 ==================== */

  function onboardSeen() {
    try {
      return localStorage.getItem(KEY_ONBOARD) === '1';
    } catch (err) {
      // 读不到就当「看过」。存储不可用（Safari 的 file://）时如果每次都弹，
      // 用户会撞上一个关不掉的引导——那比「少看一次引导」糟得多。
      return true;
    }
  }

  /**
   * 收起引导并记下标记。
   * Esc 和「知道了」走同一个出口：它们表达的是同一件事（我读过了）。
   * 若只把遮罩藏起来而不写标记，下次打开又会弹，用户会觉得这个键没生效。
   */
  function closeOnboard() {
    el.onboardMask.hidden = true;
    writeKey(KEY_ONBOARD, '1');
  }

  function maybeOnboard() {
    if (onboardSeen()) return;
    el.onboardMask.hidden = false;
  }

  /* ==================== 页脚：怎么用 / 自检 ==================== */

  /**
   * 页脚两个面板的展开/收起，并让它们互斥。
   * 为什么互斥：两者都是绝对定位、盖在页脚上方同一块区域；
   * 同时展开时后者会压住前者，看起来像「点了一个开了另一个」。
   */
  function togglePanel(name, force) {
    const isHelp = name === 'help';
    const panel = isHelp ? el.helpPanel : el.selfcheckPanel;
    const btn = isHelp ? el.btnHelp : el.btnSelfCheck;
    const next = force == null ? panel.hidden : !!force;

    panel.hidden = !next;
    // aria-expanded 跟着按钮一起变：它是按钮自己状态的唯一声明处，
    // 不跟着变的话，读屏软件会一直说「已展开」。
    btn.setAttribute('aria-expanded', String(next));

    if (next) {
      const other = isHelp ? el.selfcheckPanel : el.helpPanel;
      const otherBtn = isHelp ? el.btnSelfCheck : el.btnHelp;
      other.hidden = true;
      otherBtn.setAttribute('aria-expanded', 'false');
    }
  }

  /**
   * 跑一遍自检并把结果铺开。
   * 数据来自 MW.selfcheck（与 test/assert.html 同源的一份断言副本），
   * 判断逻辑在那边，这里只负责「画出来」——面板里不该有第二套判定标准。
   */
  function renderSelfcheck() {
    const report = MW.selfcheck.run(lastResult);

    el.selfcheckSummary.textContent = '';
    el.selfcheckList.textContent = '';

    if (report.error) {
      const line = document.createElement('div');
      line.className = 'selfcheck-row is-bad';
      const tag = document.createElement('span');
      tag.className = 'selfcheck-tag';
      tag.textContent = '未进行';
      line.appendChild(tag);
      const body = document.createElement('div');
      const text = document.createElement('div');
      text.className = 'selfcheck-detail';
      text.textContent = report.error;
      body.appendChild(text);
      line.appendChild(body);
      el.selfcheckSummary.appendChild(line);
      return;
    }

    const sum = document.createElement('div');
    sum.className = 'selfcheck-row ' + (report.allOk ? 'is-ok' : 'is-bad');
    const sumTag = document.createElement('span');
    sumTag.className = 'selfcheck-tag';
    sumTag.textContent = report.allOk ? '通过' : '未通过';
    sum.appendChild(sumTag);
    const sumBody = document.createElement('div');
    const sumTitle = document.createElement('div');
    sumTitle.className = 'selfcheck-title';
    sumTitle.textContent = '断言结果：' + report.passed + ' / ' + report.total;
    sumBody.appendChild(sumTitle);
    sum.appendChild(sumBody);
    el.selfcheckSummary.appendChild(sum);

    report.results.forEach(function (r) {
      const row = document.createElement('div');
      row.className = 'selfcheck-row ' + (r.ok ? 'is-ok' : 'is-bad');

      const tag = document.createElement('span');
      tag.className = 'selfcheck-tag';
      tag.textContent = r.ok ? '通过' : '未通过';
      row.appendChild(tag);

      const body = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'selfcheck-title';
      title.textContent = r.id + '　' + r.title;
      body.appendChild(title);

      // 通过时不用再复述失败的细节，展示断言本身在查什么更有用；
      // 未通过时才把 detail（实测到了什么）顶上来，那才是要读的那一行。
      const detail = document.createElement('div');
      detail.className = 'selfcheck-detail';
      detail.textContent = r.ok ? r.desc : (r.detail || r.desc);
      body.appendChild(detail);

      row.appendChild(body);
      el.selfcheckList.appendChild(row);
    });
  }

  function bindFooter() {
    el.btnHelp.addEventListener('click', function () {
      togglePanel('help', el.helpPanel.hidden);
    });

    el.btnSelfCheck.addEventListener('click', function () {
      const opening = el.selfcheckPanel.hidden;
      togglePanel('selfcheck', opening);
      // 只在展开时才跑断言：收起动作不该顺带做一次几十毫秒的扫描。
      if (opening) renderSelfcheck();
    });

    el.btnOnboardOk.addEventListener('click', closeOnboard);
  }

  /* ==================== 引导 ==================== */

  function cacheElements() {
    el.input = $('mdInput');
    el.fileName = $('fileName');
    el.btnOpen = $('btnOpen');
    el.picker = $('filePicker');
    el.btnMapImages = $('btnMapImages');
    el.imagePicker = $('imagePicker');
    el.mask = $('dragMask');
    el.tabs = $('tabs');
    el.stats = $('stats');
    el.renderBar = $('renderBar');
    el.renderBarLabel = $('renderBarLabel');
    el.renderBarCount = $('renderBarCount');
    el.renderBarFill = $('renderBarFill');
    el.auditHost = $('auditHost');
    el.reportHost = $('reportHost');
    el.historyHost = $('historyHost');
    el.polishHost = $('polishHost');
    el.stepsHost = $('stepsHost');
    el.btnCopy = $('btnCopy');
    el.btnCopySrc = $('btnCopySrc');
    el.btnCopyPage = $('btnCopyPage');
    el.confirmMask = $('confirmMask');
    el.confirmBody = $('confirmBody');
    el.btnConfirmOk = $('btnConfirmOk');
    el.btnConfirmCancel = $('btnConfirmCancel');
    // P7 的页脚与弹层。二维码遮罩在 view.js 里也有自己的一份引用，
    // 这里再取一次是为了让 Esc 能在同一个地方按顺序关掉所有层。
    el.qrMask = $('qrMask');
    el.btnHelp = $('btnHelp');
    el.helpPanel = $('helpPanel');
    el.btnSelfCheck = $('btnSelfCheck');
    el.selfcheckPanel = $('selfcheckPanel');
    el.selfcheckSummary = $('selfcheckSummary');
    el.selfcheckList = $('selfcheckList');
    el.onboardMask = $('onboardMask');
    el.btnOnboardOk = $('btnOnboardOk');
  }

  function restore() {
    const savedName = readKey(KEY_NAME);
    if (savedName) {
      state.name = savedName;
      state.hasFile = true; // 能读到名字，说明上一轮确实载入过文件
    }
    const savedDoc = readKey(KEY_DOC);
    if (savedDoc != null) el.input.value = savedDoc;

    renderFileName();
    renderPreview();
  }

  function init() {
    // 只读预览页（?mode=preview）走另一条引导路径，两条路必须在这里就分开：
    // 让它先跑一遍编辑器初始化，输入区、拖拽遮罩、三个面板就全被挂上了，
    // 而「这一页除了正文什么都不许有」正是它存在的意义。
    if (MW.previewMode && MW.previewMode.active) {
      MW.previewMode.init();
      return state;
    }

    cacheElements();
    state.storageOk = probeStorage();

    // 主题先于文档恢复：预览挂载时变量已经就位，避免看到一帧默认字号
    MW.panels.settings.init();
    // view 必须比 restore 早：restore 里的第一次 renderPreview 就要往两栏里挂产物
    MW.view.init();
    restore();

    MW.panels.audit.init(el.auditHost);
    MW.panels.report.init(el.reportHost);
    // 二期：分步条要排在版本面板之前——面板渲染时会读 MW.steps 判断
    // 「现在第几步」，反过来依赖会让首帧读到空的步骤状态。
    MW.steps.init(el.stepsHost);
    MW.panels.history.init(el.historyHost);
    MW.panels.polish.init(el.polishHost);

    bindInput();
    bindFilePicker();
    bindImagePicker();
    bindDragAndDrop();
    bindTheme();
    bindTabs();
    bindCopy();
    bindShortcuts();
    bindFooter();

    // 引导放在所有绑定之后：这样「知道了」和 Esc 都已经可用，
    // 不会出现「弹出来了但点不掉」的一瞬间。
    maybeOnboard();

    return state;
  }

  MW.app = {
    init: init,
    loadFile: loadFile,
    applyText: applyText,
    renderPreview: renderPreview,
    /** 读编辑区正文。二期的分步条与版本面板都只认这一个入口。 */
    text: function () { return el.input.value; },
    /** 只换正文（回溯上一步用），不动文件名与「已载入文件」。 */
    setText: setText,
    /** 把当前正文存回本地。版本面板的「保存这份 md」复用它，避免两份下载逻辑。 */
    saveToFile: saveToFile,
    /** 最近一次管线产物，供控制台与后续面板取用 */
    result: function () { return lastResult; },
    state: state
  };

  // 脚本放在 </body> 前，正常情况 DOM 已就绪；
  // 兼容有人把脚本挪进 <head> 的情况，否则会到处报 null。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
