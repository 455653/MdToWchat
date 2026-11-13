/*
 * app.js —— 引导与事件绑定
 *
 * 为什么它必须最后加载：
 * 它是唯一有副作用的文件（读 localStorage、挂事件、跑第一次渲染），
 * 前面所有模块都要先完成「向 window.MW 注册自己」这一步，它才能找到它们。
 *
 * 本文件负责四件事，不负责第五件：
 *   1. 恢复上次的文档 / 文件名 / 主题；
 *   2. 绑定输入通路（textarea、文件选择、拖拽、粘贴）与 tab 切换；
 *   3. 把 pipeline 的产物挂到文章容器上；
 *   4. 复制的编排：体检 → 知情确认 → 写剪贴板 → 如实反馈（+ 复制源码、纯净页、Ctrl+S 存盘）。
 *   不负责渲染逻辑本身——那在 pipeline 里；也不负责剪贴板机制本身——那在 clipboard 里。
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
  const renderDebounced = util.debounce(function () { renderPreview(); }, RENDER_DEBOUNCE);

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
   * 原因已经用它自己的 toast 说过了，调用方只需「什么都不做」。
   */
  let renderToken = 0;

  function renderPreview() {
    const myToken = ++renderToken;
    const text = el.input.value;

    showRenderProgress(0, 0, '正在渲染…');

    return MW.pipeline.build(text, {
      encoding: state.encoding,
      images: localImageMap,
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

      // 多媒体告警接在统计后面：用户需要知道「有图占位了」「全文超 4MB」
      if (out.meta.media && out.meta.media.warnings && out.meta.media.warnings.length) {
        out.meta.media.warnings.forEach(function (w) { util.toast(w, 'warn'); });
      }

      lastResult = out;
      return out;
    }).catch(function (err) {
      if (myToken !== renderToken) return null;
      hideRenderProgress();
      util.toast('渲染失败：' + (err && err.message ? err.message : err), 'error');
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
  }

  /* ==================== 输入通路 ==================== */

  function loadFile(file) {
    util.readFile(file).then(function (res) {
      applyText(res.text, res.name, { immediate: true, fromFile: true, encoding: res.encoding });
      if (res.encoding === 'GBK') util.toast('已按 GBK 解码：' + res.name);
      if (res.lossy) util.toast('编码可能不是 UTF-8，建议另存为 UTF-8 后重新载入', 'warn');
    }).catch(function (err) {
      // 读文件失败必须让用户看见，不能只是「什么都没发生」
      util.toast(err.message, 'error');
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
          util.toast(err.message, 'error');
        });
      })).then(function () {
        if (!okCount) return;
        util.toast('已映射 ' + okCount + ' 张本地图片', 'ok', '同名的外链图片会改用它们，正在重新渲染。');
        renderDebounced();
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
      renderDebounced();
      saveDebounced();
    });

    // 兜底：防抖窗口内刷新会丢掉最后几个字，落盘前补一次。
    global.addEventListener('beforeunload', function () { saveNow(); });
  }

  /**
   * 主题变更 → 重跑管线。
   * 产物在 P2 起是把样式固化死在元素上的，改 CSS 变量不会自动回头改内联样式，
   * 不重跑就会出现「参数条显示 18px、预览还是 16px」。
   * 走防抖：拖滑块时 input 事件非常密集，每个事件都重建一次 DOM 会明显卡手。
   */
  function bindTheme() {
    document.addEventListener('mw:theme', function () { renderDebounced(); });
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
   * 只对这两个组合键 preventDefault，别的按键一个都不碰——
   * 一旦顺手拦了别的键，输入法、Tab、方向键都会在这里坏掉。
   */
  function bindShortcuts() {
    document.addEventListener('keydown', function (event) {
      // 确认框开着时只认 Esc：否则连按两次 Ctrl+Enter 会在框上再叠一层同样的问题说明
      if (!el.confirmMask.hidden) {
        if (event.key === 'Escape') closeConfirm();
        return;
      }

      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.isComposing) return; // 输入法组合中，Ctrl 组合交给输入法自己处理

      const key = String(event.key || '').toLowerCase();

      if (key === 'enter' && !event.altKey) {
        event.preventDefault();
        copyForWechat();
        return;
      }
      // Ctrl+Shift+S 是浏览器自己的「另存为」，不抢
      if (key === 's' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        saveToFile();
      }
    });
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
    el.btnCopy = $('btnCopy');
    el.btnCopySrc = $('btnCopySrc');
    el.btnCopyPage = $('btnCopyPage');
    el.confirmMask = $('confirmMask');
    el.confirmBody = $('confirmBody');
    el.btnConfirmOk = $('btnConfirmOk');
    el.btnConfirmCancel = $('btnConfirmCancel');
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

    bindInput();
    bindFilePicker();
    bindImagePicker();
    bindDragAndDrop();
    bindTheme();
    bindTabs();
    bindCopy();
    bindShortcuts();

    return state;
  }

  MW.app = {
    init: init,
    loadFile: loadFile,
    applyText: applyText,
    renderPreview: renderPreview,
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
