/*
 * panels/polish.js —— AI 润色区（二期 P7）
 *
 * 它在哪：分步条正下方的一条带子。
 * 它何时出现：只在「第 2 步 + 用户答了『需要』」时。
 *   这个判断不在这里做，一律问 MW.steps——PLAN-II.md §5 说「分步条是唯一的状态机」，
 *   润色区自己再算一遍「现在第几步」迟早会和分步条对不上。
 *
 * 产物去哪：润色结束后，把**服务端清洗过的完整正文**灌进左侧编辑区（MW.app.setText），
 *   用户接着改。这里一个字节都不写库——落库只有一个动作：版本面板的「保存这份 md」
 *   （PLAN-II.md §7）。本面板只把 runId 通过一个事件交给版本面板，
 *   让那次保存能记成 origin='ai_polish' 并挂上 run_id（§7、§14.2）。
 *
 * 为什么会有两轮（B2，PLAN-II.md §9）：
 *   第一轮流式润色完，稿子先灌进编辑区并跑一遍一期管线；管线会算出 meta.dropped，
 *   也就是「有哪些写法粘进公众号会被整块丢掉」（whitelist.js 的 DROP_TAGS）。
 *   有的话，就带着 runId + 这份清单**在同一条 run 上**再发一次请求——服务端先落一条
 *   check 报告（零 token），再跑 revise 只改那几处。兼容规则只有 compat-rules.js 一份，
 *   所以判定在前端、后端只接住结论（§9 的「前端算 + 回传」）。
 *   没有会丢的东西就到此为止。**实测这一条才是常态**：解析器配的是 html:false（原始
 *   HTML 被转义成纯文本）、mermaid 与公式都栅格化成了 <img>，所以 dropped 基本恒为空，
 *   第二轮是给「哪天管线真丢了东西」留的保险丝（PLAN-II.md §9）。
 *
 * 为什么不把逐段 delta 直接写进编辑区：
 *   编辑区每变一次就要重跑整条一期管线（解析 → 固化 → 归一）。一篇长文会有几百段
 *   delta，等于几百次整管线重渲染，编辑区会持续跳、光标也会被抢走。
 *   所以流式内容先显示在本面板自己的小窗里（纯文本，几乎零成本），定稿只在最后灌一次。
 *
 * 后端不在时（PLAN-II.md §11.5）：这里显示一句说明，用户照样能手动编辑、
 *   「进入定稿」照走。这条路上不会有任何 /agent/* 请求成功，也不会有任何东西落库。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  const PHASE = 7;

  /* ==================== 小工具 ==================== */

  /** 与 audit.js / history.js 同款的十来行构造器；不往 util.js 里塞 DOM 构造。 */
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

  /**
   * 当前编辑的是哪篇文档（落进 agent_runs.doc_id 用）。
   *
   * 这个 id 归版本面板管（它存在 localStorage.mw.agent.docId）。这里不去读那个 key：
   * 两个面板各自读同一个 key，等于把「谁是这份状态的 owner」搞糊了。
   * 后端对此也不强求——doc_id 为空时，等用户点保存那一版会把它补上
   * （store.save_version 里的 COALESCE），所以拿不到就照常发请求。
   */
  function currentDocId() {
    const hist = MW.panels && MW.panels.history;
    if (!hist || !hist.state) return null;
    try {
      return hist.state().docId || null;
    } catch (err) {
      return null;
    }
  }

  /* ==================== 状态 ==================== */

  const el = { host: null };

  const state = {
    /** idle | running | done | failed | offline */
    status: 'idle',
    /**
     * running 时在跑哪一段，其余时候是 ''：
     *   'polish' 第一轮流式润色；
     *   'compat' 第一轮完了、正在跑管线看有哪些写法会被丢掉（没有网络请求）；
     *   'revise' 第二轮，只改被丢掉的那几处。
     */
    phase: '',
    /** 已经跑完几轮：0=还没跑，1=润色完了，2=兼容性修订也完了 */
    round: 0,
    /** 流式期间累积的**未清洗**原文，只用于显示 */
    text: '',
    chars: 0,
    /** 兼容性检查发现会被丢掉几处；第二轮修订成功后是这一轮改动前的计数 */
    droppedCount: 0,
    /** 第二轮是否真的改了稿子。false 表示「检查过了，没东西要改」，编辑区不动 */
    revised: false,
    /** 服务端的收尾提示（例如「超过 180 秒，先停在这里」） */
    note: '',
    /** 这一轮是否被护栏提前停下（超时 / 取消 / 预算用尽），见 finish() */
    truncated: false,
    error: '',
    /** 这一份正文是哪次润色产出的，交给版本面板 */
    runId: null,
    /** { promise, cancel }；非 null 表示正在跑 */
    run: null,
    canceling: false,
    bound: false
  };

  function reset() {
    state.status = 'idle';
    state.phase = '';
    state.round = 0;
    state.text = '';
    state.chars = 0;
    state.droppedCount = 0;
    state.revised = false;
    state.note = '';
    state.truncated = false;
    state.error = '';
  }

  /* ==================== 动作 ==================== */

  function start() {
    if (state.run) return;

    const text = MW.app && MW.app.text ? MW.app.text() : '';
    if (!text.trim()) {
      MW.util.toast('编辑区是空的，没有可以润色的内容', 'warn');
      return;
    }

    reset();
    state.status = 'running';
    state.phase = 'polish';
    state.round = 1;
    send({
      docId: currentDocId() || undefined,
      title: (MW.app.state && MW.app.state.name) || '未命名',
      contentMd: text
    });
  }

  /**
   * 发一轮流式请求，并把这一轮的收尾接给 finish()。
   * 两轮（第一轮润色、第二轮兼容性修订）在「怎么发、怎么显示 delta」上完全一样，
   * 差别只在 payload 和收尾后要做什么——收尾的分叉全在 finish()/toCompatCheck() 里。
   */
  function send(payload) {
    const job = MW.agent.polish(payload, function (event) {
      if (typeof event.delta === 'string' && event.delta) {
        state.text += event.delta;
        state.chars = state.text.length;
        paintLive();
      }
    });

    state.run = job;
    // 立刻重画一次：cancelRun 的可点性看的是 state.run，而它在上面这一行之前仍是
    // null。若把重画留给调用方（start / toCompatCheck 都在 send 之前 render 过了），
    // 「取消」按钮会停在 disabled，整轮润色都点不动（B3 验收时抓到）。
    render();
    job.promise.then(function (res) {
      state.run = null;
      state.canceling = false;
      finish(res);
    });
  }

  function cancelRun() {
    if (!state.run || state.canceling) return;
    state.canceling = true;
    render();
    // 两条路一起走（B3，PLAN-II.md §8.3）：
    //   · abort 断连接——请求还没发出去时也有效，这是唯一能覆盖第一轮开头的手段；
    //   · 显式 /agent/cancel——当 run 已跨过第一轮（state.runId 有值）时补一次，
    //     它让「取消」被后端明确记下，不依赖 TCP 断开被及时察觉。
    // 后端两条路落到同一段收尾代码，所以不会重复收尾。
    if (state.runId) MW.agent.cancel(state.runId);
    state.run.cancel();
  }

  function finish(res) {
    if (res.canceled) {
      // 用户自己取消：回到「还没跑」的样子，按钮回到「开始润色」，随时可以重来。
      // 编辑区保持原样——若是在第二轮取消，里面是已经润色过的那一稿，不会白跑。
      reset();
      render();
      return;
    }

    if (!res.ok) {
      state.status = res.offline ? 'offline' : 'failed';
      state.error = res.offline
        ? '没连上本机的润色服务。双击 serve.cmd 后点「再试一次」；'
          + '不想等也可以直接在左侧手动改，编辑、预览、复制都不受影响。'
        : (res.error || '润色失败');
      render();
      return;
    }

    const done = res.done;
    if (!done || done.ok === false) {
      // 走到「已回 200 但最后一帧说失败」：上游返回的东西剥完不像文章（后端已丢弃），
      // 或上游把流掐断在半路。两种都必须说清楚，绝不能把半成品悄悄塞进编辑区。
      state.status = 'failed';
      state.error = (done && done.error) || '流结束了，但没有收到结果，可以重试一次。';
      render();
      return;
    }

    // 以最后一帧为准（routes._polish_stream 的说明）：delta 是未清洗的原文，
    // 剥 ``` 围栏与开场白那一步在后端做，成品只在这一帧里。
    state.text = done.text || '';
    state.chars = typeof done.chars === 'number' ? done.chars : state.text.length;
    state.runId = done.runId || null;
    state.note = done.note || '';
    state.error = '';
    // 第二轮才会有 revised；第一轮拿不到，一律当 false。
    state.revised = done.revised === true;
    // 被护栏提前停下（超时 / 取消 / 预算）时，后端会在末帧标 truncated。
    state.truncated = done.truncated === true;

    // 已经停下的话就不再往下走：稿子是半截的，再跑一轮兼容性检查与修订没有意义，
    // 只会把一次「已经停下」拖成两次请求。半截稿照样交给用户，note 里说明了差什么
    // ——这正是 §10「把已经流出来的部分交给用户并说清还差什么」的做法。
    if (state.round < 2 && !state.truncated) {
      toCompatCheck();
      return;
    }

    // 第二轮（修订）也完了、或第一轮被护栏停下（此时 state.truncated 为 true），
    // 这一份就是当前能拿到的终稿。revised 为 false 表示这一轮什么都没改
    // （服务端判定没问题、修订没跑起来、或第二轮被停下），编辑区里已经是同一份，
    // 不必重灌——尤其第二轮被停下时，编辑区里那份上一轮的完整稿比半截的修订稿好。
    state.status = 'done';
    state.phase = '';
    if (state.truncated && state.round < 2) {
      // 第一轮被停下：把**已经生成的部分**交给用户（§10）。
      // 正常的第一轮不是走这里——它走 toCompatCheck()，那里已经灌过了。
      if (state.text) MW.app.setText(state.text);
    } else if (state.revised && state.text) {
      MW.app.setText(state.text);
    }
    announce();
    render();
  }

  /**
   * 第一轮润色完了要走的那一段：先把稿子灌进编辑区，等管线出产物，
   * 再读 meta.dropped 决定「到此为止」还是「接着跑修订」。
   *
   * 为什么必须等渲染完才读 dropped：dropped 是 sanitize.run 在整条管线末尾算出来的，
   * 没渲染完就没有这份清单。所以 app.setText 二期起返回渲染产物（见 app.js 的 setText）。
   */
  function toCompatCheck() {
    const polished = state.text;

    // 先切到「检查中」。这段时间编辑区正在整篇重渲染（可能上百毫秒），
    // 状态行若还写着「正在润色」会让人以为模型还在写。
    // 这一段也不清空小窗：里面是刚拿到的那份润色稿，看着比一片空白诚实。
    state.phase = 'compat';
    render();

    const rendered = MW.app.setText(polished);
    // 拿不到渲染产物（例如调用方没返回）就退化成「第一轮即终稿」：
    // 少了 dropped 这份清单只是少一轮修订，没有理由因此让整次润色失败。
    const waiting = rendered && typeof rendered.then === 'function'
      ? rendered : Promise.resolve(null);

    waiting.then(function (out) {
      const dropped = out && out.meta && out.meta.dropped;

      // 这段时间里编辑区在整篇重渲染，用户可能已经点了「上一步」或「改主意」。
      // 那时就不再发第二轮：请求一发出去就占住全局锁，而他已经不在看这一屏了。
      // 编辑区留着第一轮那稿，他回来点「重新润色」即可。
      const stillHere = !!(MW.steps && MW.steps.current() === 'polish'
        && MW.steps.answer() === 'yes');

      if (!stillHere || !dropped || !dropped.length) {
        state.status = 'done';
        state.phase = '';
        state.revised = false;
        state.droppedCount = 0;
        announce();
        render();
        return;
      }

      // 有会被整块丢掉的写法：带着 runId + 这份清单，在同一条 run 上再跑一轮修订。
      // 小窗清空，从这里开始显示的只有修订这一轮的 delta。
      state.round = 2;
      state.droppedCount = dropped.length;
      state.phase = 'revise';
      state.text = '';
      state.chars = 0;
      send({
        docId: currentDocId() || undefined,
        title: (MW.app.state && MW.app.state.name) || '未命名',
        contentMd: polished,
        runId: state.runId,
        // 只回传后端认识的两个字段；pipeline 的 dropped 项正好就是 {tag, preview}。
        dropped: dropped.map(function (item) {
          return { tag: item.tag, preview: item.preview };
        })
      });
    });
  }

  /** 告诉版本面板「现在编辑区里这份正文来自第 N 次润色」。 */
  function announce() {
    document.dispatchEvent(new CustomEvent('mw:polish',
      { detail: { runId: state.runId, chars: state.chars, revised: state.revised,
        droppedCount: state.droppedCount } }));
  }

  /* ==================== 渲染 ==================== */

  function statusNodes() {
    if (state.status === 'running') {
      // compat 这一段没有 delta 可收（服务端只在 revise 时才吐字），所以不挂字数。
      if (state.phase === 'compat') {
        return ['正在检查公众号兼容性…看润色后的稿子有没有会被整块丢掉的写法。'];
      }
      if (state.phase === 'revise') {
        return ['正在修订 ' + state.droppedCount + ' 处会被丢掉的内容…已收到 ',
          h('b', { id: 'polishCount', text: state.chars + ' 字' })];
      }
      return ['正在润色…已收到 ',
        h('b', { id: 'polishCount', text: state.chars + ' 字' })];
    }
    if (state.status === 'done') {
      if (state.truncated) {
        // 被护栏停下的稿子：说清「编辑区里现在是哪一份」，别再用「完成」误导。
        const what = state.round >= 2
          ? '这一轮修订中途停下了，左侧编辑区里保留的是上一轮那稿（' + state.chars + ' 字）。'
          : '润色中途停下了，左侧编辑区里是已经生成的部分（' + state.chars + ' 字）。';
        return [what + '原因见下方说明。可以接着手动改，或再点一次「重新润色」。'];
      }
      const head = state.revised
        ? '润色 + 兼容性修订完成，共 ' + state.chars + ' 字，已经填进左侧编辑区。'
        : '润色完成，共 ' + state.chars + ' 字，已经填进左侧编辑区。';
      return [head + '改到满意再点「进入定稿」，然后去「版本」里保存这份 md。'];
    }
    if (state.status === 'failed') return ['这一轮润色没有成功。'];
    if (state.status === 'offline') return ['本机润色服务没连上。'];
    return ['点「开始润色」，DeepSeek 会把这篇草稿按公众号体裁重写一遍。'
      + '原文里的事实、数据、代码不会被改，改的是结构和行文。'];
  }

  function buttons() {
    if (state.status === 'running') {
      // 第一轮结束到第二轮发出之间还要跑一遍整条管线（compat 那一段），
      // 那段时间没有可中断的请求（state.run 是 null），按钮就应当是灰的，
      // 而不是一个点了没反应的「取消」。
      return [h('button', {
        type: 'button', class: 'btn', id: 'polishCancel',
        disabled: state.canceling || !state.run, on: cancelRun,
        text: state.canceling ? '取消中…' : '取消'
      })];
    }
    if (state.status === 'done') {
      return [h('button', {
        type: 'button', class: 'btn', id: 'polishStart', on: start, text: '重新润色'
      })];
    }
    return [h('button', {
      type: 'button', class: 'btn btn-primary', id: 'polishStart', on: start,
      text: state.status === 'idle' ? '开始润色' : '再试一次'
    })];
  }

  function bodyNode() {
    const kids = [
      h('div', { class: 'polish-head' }, [
        h('span', { class: 'polish-title', text: 'AI 润色' }),
        h('span', { class: 'polish-status' }, statusNodes()),
        h('span', { class: 'polish-actions' }, buttons())
      ])
    ];

    if (state.status === 'running' || (state.status === 'done' && state.text)) {
      kids.push(h('pre', { class: 'polish-live', id: 'polishLive', text: state.text }));
    }
    if (state.note) kids.push(h('div', { class: 'polish-note', text: state.note }));
    if (state.error) kids.push(h('div', { class: 'polish-error', text: state.error }));

    return h('div', { class: 'polish-body' }, kids);
  }

  function render() {
    const host = el.host;
    if (!host) return;

    const show = MW.steps && MW.steps.current() === 'polish'
      && MW.steps.answer() === 'yes';
    host.hidden = !show;
    if (!show) {
      host.textContent = '';
      return;
    }

    host.textContent = '';
    host.appendChild(bodyNode());
  }

  /** 流式期间只改两个文本节点，不整块重建——重建会把按钮的 hover / 焦点抖掉。 */
  function paintLive() {
    const count = document.getElementById('polishCount');
    if (count) count.textContent = state.chars + ' 字';
    const live = document.getElementById('polishLive');
    if (live) live.textContent = state.text;
  }

  /* ==================== 生命周期 ==================== */

  function bind() {
    if (state.bound) return;
    state.bound = true;

    // 离开第 2 步就取消在跑的润色。收尾（把 run 标成 canceled、释放全局锁）在后端，
    // 这里只负责把连接断掉——「可中断、不留僵尸 run」是 PLAN-II.md §10 的护栏。
    document.addEventListener('mw:step', function (ev) {
      const step = ev.detail && ev.detail.step;
      if (step && step !== 'polish') cancelRun();
      render();
    });

    document.addEventListener('mw:step-answer', function () { render(); });

    // 关页 / 刷新同理：直接把连接断掉，后端的写操作立刻失败并走它的 finally。
    global.addEventListener('pagehide', function () {
      if (state.run) state.run.cancel();
    });
  }

  function init(host) {
    if (!host) return;
    el.host = host;
    bind();
    render();
  }

  MW.panels = MW.panels || {};
  MW.panels.polish = {
    PHASE: PHASE,
    init: init,
    render: render,
    /** 供控制台排查用：看一眼这一次润色跑到哪了 */
    state: function () {
      return {
        status: state.status, phase: state.phase, round: state.round,
        chars: state.chars, runId: state.runId, revised: state.revised,
        droppedCount: state.droppedCount, truncated: state.truncated,
        running: !!state.run, error: state.error
      };
    }
  };
})(window);
