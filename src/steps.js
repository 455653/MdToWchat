/*
 * steps.js —— 顶部分步条（二期唯一的流程状态机）
 *
 * 为什么它必须「唯一」：
 *   二期的链路带一个分叉（要不要润色），于是「现在第几步」「下一步是什么」
 *   变成两个以上模块都想知道的事。如果版本面板自己判断一次、润色面板再判断一次，
 *   迟早出现「面板以为在第 3 步、分步条以为在第 2 步」——它不报错，只让用户一脸问号。
 *   所以这里的规则是死的：谁都不许自己算，一律问 MW.steps.current()。
 *
 * 为什么只有四格，流程却有七步（PLAN-II §1）：
 *   四格是给人看的粒度，七步是实现粒度。把七步全摆上去，用户每次都要重新数一遍。
 *
 * 第 2 步是一条真正的分叉：
 *   选「不需要」→ 直接跳到 ④，整条链路退化成一期：不连后端、不落库。
 *   这条路上不许出现任何 /agent 请求（PLAN-II §11.5）——本文件因此刻意
 *   只调用 MW.agent 里与「保存版本」有关的东西之外一个都不碰。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  const PHASE = 7;

  /**
   * 四个格子。no 用圆圈数字而不是 1/2/3/4：与页脚「怎么用」里的五步流程
   * 是两套编号，用不同字形才不会被读成同一串编号。
   */
  const CELLS = [
    { id: 'import', no: '\u2460', label: '导入',
      hint: '把 .md 拖进窗口，或点右上角「打开 md」' },
    { id: 'polish', no: '\u2461', label: '润色',
      hint: '先定一件事：这篇草稿要不要 AI 润色' },
    { id: 'edit', no: '\u2462', label: '编辑定稿',
      hint: '在左侧改到满意，再去右栏「版本」里点「保存这份 md」' },
    { id: 'format', no: '\u2463', label: '转格式',
      hint: '右侧预览就是要复制走的那一份，点「复制到公众号」即可' }
  ];

  const el = { host: null };

  const state = {
    current: 'import',
    /** null=还没回答；'yes' / 'no'=第 2 步已经答过 */
    answered: null
  };

  /**
   * 「这一格上有没有东西在等用户回话」变了。
   *
   * 为什么要有这个事件：润色区（panels/polish.js）只在「第 2 步 + 答过『需要』」
   * 时才该出现，而它不该自己去猜用户的点击——它只认 MW.steps 的答案。
   * 状态机改了就喊一声，比让润色区监听 DOM 上那两个按钮可靠得多。
   */
  function answeredChanged() {
    document.dispatchEvent(new CustomEvent('mw:step-answer',
      { detail: { answered: state.answered } }));
  }

  function indexOf(id) {
    for (let i = 0; i < CELLS.length; i++) { if (CELLS[i].id === id) return i; }
    return -1;
  }

  function cellOf(id) {
    const at = indexOf(id);
    return at < 0 ? CELLS[0] : CELLS[at];
  }

  /** 编辑区当前有没有内容。没有内容时 ① 走不到 ②。 */
  function hasText() {
    return !!(MW.app && MW.app.text && MW.app.text().trim());
  }

  /** 「下一步」在现在这一步能不能点。 */
  function canNext() {
    if (state.current === 'import') return hasText();
    if (state.current === 'polish') return state.answered === 'yes';
    if (state.current === 'edit') return true;
    return false; // ④ 之后没有下一步
  }

  function nextLabel() {
    if (state.current === 'polish' && state.answered === 'yes') return '进入定稿';
    return '下一步';
  }

  function hintFor() {
    if (state.current === 'import' && !hasText()) {
      return '还没有内容：拖入一份 .md，或直接在左侧写点什么';
    }
    if (state.current === 'polish' && state.answered === 'yes') {
      return '润色区在下面（本机服务没开时它会说明一句，手动编辑照样能走完）';
    }
    return cellOf(state.current).hint;
  }

  /* ==================== 渲染 ==================== */

  function trackHtml() {
    const at = indexOf(state.current);
    return '<ol class="steps-track">' + CELLS.map(function (cell, i) {
      const cls = 'step' + (i === at ? ' is-active' : '') + (i < at ? ' is-done' : '');
      return '<li class="' + cls + '" data-step="' + cell.id + '">'
        + '<span class="step-no">' + cell.no + '</span>'
        + '<span class="step-label">' + cell.label + '</span>'
        + '</li>';
    }).join('') + '</ol>';
  }

  /** 第 2 步的询问条。答过之后换成一句说明，不再反复问（PLAN-II §11.9）。 */
  function askHtml() {
    if (state.current !== 'polish') return '';

    if (state.answered === null) {
      return '<div class="steps-ask" id="stepAsk">'
        + '<span class="steps-ask-text">要不要让 AI 润色这篇草稿？</span>'
        + '<button type="button" class="btn" id="stepAnswerNo">不需要</button>'
        + '<button type="button" class="btn btn-primary" id="stepAnswerYes">需要</button>'
        + '</div>';
    }

    return '<div class="steps-ask is-note" id="stepAsk">'
      + '<span class="steps-ask-text">'
      + '已选择：需要 AI 润色。下面的润色区会调 DeepSeek 把这篇草稿按公众号体裁重写一遍；'
      + '跑完（或者你中途改主意）都可以在左侧接着手动改，「进入定稿」不受影响。'
      + '</span>'
      + '<button type="button" class="btn btn-ghost" id="stepAnswerUndo">改主意</button>'
      + '</div>';
  }

  function render() {
    const host = el.host;
    if (!host) return;

    const at = indexOf(state.current);
    host.innerHTML = trackHtml()
      + '<div class="steps-side">'
      + '<span class="steps-hint">' + hintFor() + '</span>'
      + '<button type="button" class="btn" id="stepPrev"'
      + (at <= 0 ? ' disabled' : '') + '>上一步</button>'
      + '<button type="button" class="btn btn-primary" id="stepNext"'
      + (canNext() ? '' : ' disabled') + '>' + nextLabel() + '</button>'
      + '</div>'
      + askHtml();

    bind();
  }

  function bind() {
    const host = el.host;
    const prev = host.querySelector('#stepPrev');
    const next = host.querySelector('#stepNext');
    const no = host.querySelector('#stepAnswerNo');
    const yes = host.querySelector('#stepAnswerYes');
    const undo = host.querySelector('#stepAnswerUndo');

    if (prev) prev.addEventListener('click', function () { go(CELLS[indexOf(state.current) - 1].id); });
    if (next) next.addEventListener('click', nextStep);
    if (no) no.addEventListener('click', function () { answer('no'); });
    if (yes) yes.addEventListener('click', function () { answer('yes'); });
    if (undo) undo.addEventListener('click', function () {
      state.answered = null;
      render();
      answeredChanged();
    });
  }

  /* ==================== 状态迁移 ==================== */

  /**
   * 迁到某一格。
   * 进 ② 一律把上一次的回答清掉：11.9 说过「退回第 2 步」就是用户改主意的入口，
   * 保留旧答案等于把这个入口焊死。
   */
  function go(id) {
    if (indexOf(id) < 0) return;
    if (id === 'polish') state.answered = null;
    state.current = id;
    render();
    document.dispatchEvent(new CustomEvent('mw:step', { detail: { step: id } }));
    answeredChanged();
  }

  function nextStep() {
    if (!canNext()) return;
    if (state.current === 'import') { go('polish'); return; }
    if (state.current === 'polish') { go('edit'); return; }
    if (state.current === 'edit') { go('format'); return; }
  }

  /**
   * 回答第 2 步。
   * 「不需要」直接跳到 ④——注意这里一个后端调用都没有，
   * 后面的保存 / 回溯全是用户自己的选择，分叉本身绝不触发 /agent。
   */
  function answer(kind) {
    state.answered = kind;
    if (kind === 'no') { go('format'); return; }
    render();
    answeredChanged();
  }

  /* ==================== 生命周期 ==================== */

  function bindOnce() {
    // 上传 / 拖入一份 .md 就走第 2 步：分叉在这里，不在「敲下第一个字」那里。
    // （手敲的稿子走「下一步」进来，见 §1「上传草稿」的定义。）
    document.addEventListener('mw:import', function () {
      if (state.current === 'polish') { state.answered = null; render(); return; }
      go('polish');
    });

    // 内容变化会影响 ① 的「下一步」能不能点，以及各步的提示语。
    // 用事件而不是轮询：只有这里在意的两件事都是「刚刚发生了什么」。
    document.addEventListener('mw:result', function () {
      if (state.current === 'import') render();
    });
  }

  function init(host) {
    if (!host) return;
    el.host = host;
    bindOnce();
    render();
  }

  MW.steps = {
    PHASE: PHASE,
    init: init,
    go: go,
    current: function () { return state.current; },
    /** 供面板显示「AI 润色选的是哪一边」。 */
    answer: function () { return state.answered; }
  };
})(window);
