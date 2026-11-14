/*
 * panels/history.js —— 版本面板（保存 / 回溯上一步）
 *
 * 版本口径（PLAN-II §7，实现时必须照它来）：
 *   编辑区里始终有一个「当前版本号」。内容首次进编辑区时是 1。
 *   **只有点「保存这份 md」才写库**；只改不点保存，什么都不写、版本号也不动。
 *   所以「当前版本号」= 已保存的最大 seq，没有已保存版本时显示 1。
 *
 * 「回溯上一步」是纯前端动作（PLAN-II §11.1）：
 *   它只改编辑区内容（把上一个已保存版本的正文拉回来替换），不写库、不动版本号。
 *   要留下痕迹仍得点保存——于是「回退 + 保存 = 新增一版（内容是旧的、seq 是新的）」，
 *   连按两次回溯也能回到回退前的状态。
 *   一条都没保存过时，它回到「进入编辑区时的初始内容」（baseline），语义是撤销这一轮编辑。
 *
 * 为什么「保存这份 md」既下载又落库（PLAN-II §4）：
 *   第 5 步落下的就是那份「文章 md」——一份存本地磁盘（浏览器下载），
 *   一份（后端在时）落进 versions 表。它们本来就是同一份东西的两种归宿。
 *   后端不在时仍会下载，只是不落库并如实说明（PLAN-II §11.5）。
 *
 * P7 补的一处：首次保存时，正文若来自 AI 润色，origin 记 'ai_polish' 并带上 runId
 *   （PLAN-II §7、§14.2）。这个「来自哪次润色」由润色面板用 mw:polish 事件通报过来——
 *   版本面板是这份状态的 owner，润色区不该反过来去写它的状态。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  const PHASE = 7;

  /** 记录「这个浏览器当前在编辑哪篇文档」。没有它，重开页面就接不回版本历史。 */
  const KEY_DOC_ID = 'mw.agent.docId';

  const ORIGIN_TEXT = {
    import: '导入原文',
    ai_polish: 'AI 润色',
    manual: '手动编辑',
    rollback: '回退'
  };

  /* ==================== 小工具 ==================== */

  /** 与 audit.js 同款的十来行构造器；理由见那个文件——不往 util.js 里塞 DOM 构造。 */
  function h(tag, attrs, kids) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        const value = attrs[key];
        if (value == null || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = String(value);
        else if (key === 'on') node.addEventListener('click', value);
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

  function readDocId() {
    try {
      const raw = localStorage.getItem(KEY_DOC_ID);
      const num = Number(raw);
      return Number.isInteger(num) && num > 0 ? num : null;
    } catch (err) {
      return null;
    }
  }

  function writeDocId(value) {
    try {
      if (value == null) localStorage.removeItem(KEY_DOC_ID);
      else localStorage.setItem(KEY_DOC_ID, String(value));
    } catch (err) {
      // 存不下就每次重开都从「新文档」开始，功能不中断——不值得为它打断用户
    }
  }

  /** "2026-11-13T10:22:31" → "2026-11-13 10:22"。解析失败就原样返回。 */
  function prettyTime(raw) {
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(raw || ''));
    return m ? m[1] + ' ' + m[2] : String(raw || '');
  }

  /* ==================== 状态 ==================== */

  const el = { host: null };

  const state = {
    docId: null,
    online: false,
    /** 后端回的版本元数据，seq 升序；离线时一直是空数组 */
    versions: [],
    /** seq → contentMd。正文按需单取（列表刻意不回正文，PLAN-II §8.1） */
    contents: {},
    /** 编辑区内容「基于」哪一版：-1 = 基于 baseline，还没保存过 */
    cursor: -1,
    /** 进入编辑区时的初始内容。只活在本次会话，不进库 */
    baseline: '',
    /**
     * 编辑区里这份正文来自哪一次润色（P7）。null = 不是润色来的。
     * 只在「第一次保存」时用它决定 origin 与 run_id（PLAN-II §7）；
     * 保存过之后，后面的版本按口径一律 manual，这个值就作废了。
     */
    pendingRunId: null,
    busy: false,
    bound: false
  };

  /** 当前版本号 = 最大的 seq；一版都还没保存时是 1。 */
  function currentSeq() {
    return state.versions.length ? state.versions[state.versions.length - 1].seq : 1;
  }

  function currentText() {
    return MW.app && MW.app.text ? MW.app.text() : '';
  }

  /**
   * 「回溯上一步」会回到的那一份内容。
   * 拿不到（还没取过正文）时返回 null，此时按钮按「可点」处理——
   * 点了会去把正文取回来，比事先禁用更符合直觉。
   */
  function rollbackTarget() {
    const idx = state.cursor - 1;
    if (idx < 0) return state.baseline;
    return state.contents[idx] != null ? state.contents[idx] : null;
  }

  function canRollback() {
    if (state.busy) return false;
    const target = rollbackTarget();
    if (target == null) return true;
    return currentText() !== target;
  }

  /* ==================== 后端 ==================== */

  /** 探服务 + 拉版本列表。把「连不上」当成一种正常状态，不抛异常。 */
  function hydrate() {
    return MW.agent.available().then(function (ok) {
      state.online = ok;
      if (!ok || !state.docId) return null;
      return MW.agent.versions(state.docId).then(function (res) {
        if (!res.ok) { state.online = false; return null; }
        if (!res.data || !res.data.doc) {
          // 库被清了 / 换了机器：本地那个 docId 已经不存在，当作新文档重新开始
          state.docId = null;
          writeDocId(null);
          return null;
        }
        state.versions = res.data.versions || [];
        state.cursor = state.versions.length - 1;
        return null;
      });
    });
  }

  /** 保存后按 docId 重拉一遍列表：seq 由后端算，前端不猜。 */
  function refresh() {
    if (!state.docId) return Promise.resolve();
    return MW.agent.versions(state.docId).then(function (res) {
      if (!res.ok || !res.data || !res.data.doc) return;
      state.docId = res.data.doc.id;
      state.versions = res.data.versions || [];
      state.cursor = state.versions.length - 1;
    });
  }

  /** 按需取某一版正文并缓存。返回 Promise<string|null>。 */
  function loadContent(idx) {
    if (idx < 0) return Promise.resolve(state.baseline);
    if (state.contents[idx] != null) return Promise.resolve(state.contents[idx]);
    const meta = state.versions[idx];
    if (!meta) return Promise.resolve(null);

    return MW.agent.version(meta.id).then(function (res) {
      if (!res.ok) {
        MW.util.toast('取第 ' + meta.seq + ' 版正文失败：' + res.error, 'error',
          '版本正文是单独取的，双击 serve.cmd 后重试。');
        return null;
      }
      state.contents[idx] = res.data.contentMd;
      return state.contents[idx];
    });
  }

  /* ==================== 动作 ==================== */

  function doSave() {
    if (state.busy) return;
    const text = currentText();
    if (!text.trim()) {
      MW.util.toast('编辑区是空的，没什么可保存的', 'warn');
      return;
    }

    // 无论后端在不在，都存一份到本地磁盘——这是「保存这份 md」的字面意思。
    if (MW.app && MW.app.saveToFile) MW.app.saveToFile();

    if (!state.online) {
      MW.util.toast('已下载 .md；本机版本服务没连上，这一版没有落库', 'warn',
        '双击 serve.cmd，再点面板里的「重试连接」；之后保存的版本才会进版本历史。');
      return;
    }

    const first = !state.versions.length;
    // 第一次保存要分清正文是从哪来的：上传原文 → import，AI 润色结果 → ai_polish
    // （PLAN-II §7）。runId 只在后一种情况带，它把这一版挂回那次润色。
    const runId = first ? state.pendingRunId : null;
    state.busy = true;
    render();

    MW.agent.save({
      docId: state.docId || undefined,
      title: (MW.app.state && MW.app.state.name) || '未命名',
      contentMd: text,
      origin: first ? (runId ? 'ai_polish' : 'import') : 'manual',
      runId: runId || undefined
    }).then(function (res) {
      state.busy = false;
      if (!res.ok) {
        state.online = false;
        render();
        MW.util.toast('落库失败：' + res.error, 'error',
          '本地 .md 已经下载好了；版本服务连不上，这一版没有记进历史。');
        return null;
      }
      // 这一版已经落库，正文的「来源」也就定下来了；后面再保存一律 manual。
      state.pendingRunId = null;
      if (res.data && res.data.docId) {
        state.docId = res.data.docId;
        writeDocId(state.docId);
      }
      return refresh().then(function () {
        // 刚保存的那一版正文就攥在手上，顺带缓存，省一次往返
        if (state.cursor >= 0) state.contents[state.cursor] = text;
        render();
        MW.util.toast('已保存为第 ' + currentSeq() + ' 版', 'ok',
          '同时下载了一份 .md 到本地。');
      });
    });
  }

  function doRollback() {
    if (!canRollback()) return;
    const idx = state.cursor - 1;

    if (idx < 0) {
      // 一版都还没保存过：回到进编辑区时的初始内容，等于撤销这一轮编辑
      applyContent(state.baseline);
      state.cursor = -1;
      render();
      MW.util.toast('已回到进入编辑区时的内容', 'ok', '这是纯前端动作，版本号没有变化。');
      return;
    }

    loadContent(idx).then(function (text) {
      if (text == null) return;
      state.cursor = idx;
      applyContent(text);
      render();
      MW.util.toast('已回到第 ' + state.versions[idx].seq + ' 版的正文', 'ok',
        '版本号不变，库里也还是 ' + state.versions.length + ' 条。要留下这一版，点「保存这份 md」。');
    });
  }

  /** 只换编辑区正文，不动文件名 / 「已载入文件」这些状态——那是编辑，不是重新导入。 */
  function applyContent(text) {
    if (MW.app && MW.app.setText) MW.app.setText(text);
  }

  function doRetry() {
    MW.agent.forget();
    hydrate().then(function () { render(); });
  }

  /* ==================== 渲染 ==================== */

  function headNode() {
    const seq = currentSeq();
    const summary = state.versions.length
      ? '当前版本 v' + seq + '：历史里共有 ' + state.versions.length + ' 版。'
      : '当前版本 v1：还没有保存过任何版本（只改不保存，版本号就不动）。';

    const back = state.online
      ? '后端：已连接'
      : '后端：未连接（双击 serve.cmd 后点「重试连接」）';

    return h('div', { class: 'pan-head' }, [
      h('div', { class: 'pan-summary' + (state.online ? '' : ' is-warn'), text: summary }),
      h('div', { class: 'pan-meta', text: back })
    ]);
  }

  function toolbarNode() {
    return h('div', { class: 'pan-toolbar' }, [
      h('button', {
        type: 'button', class: 'btn btn-primary', id: 'histSave',
        disabled: state.busy, on: doSave,
        text: state.busy ? '保存中…' : '保存这份 md'
      }),
      h('button', {
        type: 'button', class: 'btn', id: 'histRollback',
        disabled: !canRollback(), on: doRollback, text: '回溯上一步'
      }),
      h('button', {
        type: 'button', class: 'btn btn-ghost', id: 'histRetry',
        on: doRetry, text: '重试连接'
      }),
      h('span', { class: 'pan-meta',
        text: '「保存这份 md」= 下载一份 .md + 记一版。「回溯上一步」只改编辑区，不记版本。' })
    ]);
  }

  function versionRow(meta, idx) {
    const at = idx === state.cursor;
    return h('li', { class: 'hist-item' + (at ? ' is-cursor' : '') }, [
      h('span', { class: 'hist-seq', text: 'v' + meta.seq }),
      h('span', { class: 'hist-origin', text: ORIGIN_TEXT[meta.origin] || meta.origin }),
      h('span', { class: 'hist-chars', text: meta.chars + ' 字' }),
      h('span', { class: 'hist-time', text: prettyTime(meta.createdAt) }),
      at ? h('span', { class: 'hist-flag', text: '编辑区基于这一版' }) : null
    ]);
  }

  function listNode() {
    if (!state.versions.length) {
      return h('div', { class: 'pan-note', text: state.online
        ? '还没有保存过版本。改到满意后点上面的「保存这份 md」，第一版会记为 v1。'
        : '版本服务没连上，读不到历史。这期间「保存这份 md」仍会把 .md 下载到本地，只是不落库。' });
    }

    return h('ol', { class: 'hist-list' }, state.versions.map(function (meta, idx) {
      return versionRow(meta, idx);
    }).reverse());
  }

  function render() {
    const host = el.host;
    if (!host) return;

    host.textContent = '';
    host.appendChild(headNode());
    host.appendChild(toolbarNode());
    host.appendChild(listNode());
  }

  /* ==================== 生命周期 ==================== */

  function bind() {
    if (state.bound) return;
    state.bound = true;

    // 内容变了 → 「回溯上一步」的可点状态要跟着变。
    // 用 mw:result 而不是监听 textarea：这个面板不该知道编辑器长什么样。
    document.addEventListener('mw:result', function () { render(); });

    // P7：润色面板把「现在编辑区这份正文是第几次润色的产物」通报过来。
    // 只记下、不落库——落库仍然只发生在用户点「保存这份 md」那一刻。
    document.addEventListener('mw:polish', function (ev) {
      state.pendingRunId = (ev.detail && ev.detail.runId) || null;
    });

    // 重新导入一份草稿：编辑区内容换了主人，上一次润色的溯源关系也就断了。
    document.addEventListener('mw:import', function () { state.pendingRunId = null; });
  }

  function init(host) {
    if (!host) return;
    el.host = host;
    bind();

    state.baseline = currentText();
    state.docId = readDocId();
    render();

    // 探测放在渲染之后：分步条与编辑区不该等一次网络往返才可用。
    hydrate().then(function () { render(); });
  }

  MW.panels = MW.panels || {};
  MW.panels.history = {
    PHASE: PHASE,
    init: init,
    render: render,
    /** 供控制台排查用：看一眼当前版本口径是怎么算的 */
    state: function () {
      return {
        docId: state.docId, online: state.online, cursor: state.cursor,
        seq: currentSeq(), count: state.versions.length
      };
    }
  };
})(window);
