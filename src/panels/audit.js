/*
 * panels/audit.js —— 样式体检面板
 *
 * 职责（P2 实现）：
 *   逐条跑产物契约（A3–A7），把「这份 HTML 里哪些地方到了微信会坏」列出来：
 *   - 出现 flex/grid/position 的元素；
 *   - 缺内联 font-size 的块级元素；
 *   - 宽度写死超过 375px 的元素（手机上必然溢出）；
 *   - 非 data: URI 的图片（会被提示上传失败）。
 *
 * 为什么它和 test/assert.html 不重复：
 *   断言页验的是「管线有没有写错」，体检面板验的是「用户手上这一篇有没有问题」。
 *   前者是开发期的回归，后者是使用期的诊断，输入不同、受众不同。
 *
 * P0 行为：渲染一段说明文字，告诉用户这个面板什么时候能用。
 * 不返回 DOM 结构以外的任何东西——init 是幂等的，重复调用只会重绘占位。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  const PHASE = 2;

  function renderPlaceholder(host) {
    host.textContent = '';
    const box = document.createElement('div');
    box.className = 'placeholder';

    const title = document.createElement('h3');
    title.textContent = '样式体检（P2 启用）';
    box.appendChild(title);

    const lines = [
      '这里会逐条检查当前预览产物的兼容性：布局属性、内联字号、超宽元素、图片地址。',
      '本阶段只搭了骨架，检查逻辑与渲染管线的固化器一起在 P2 落地。'
    ];
    lines.forEach(function (text) {
      const p = document.createElement('div');
      p.textContent = text;
      box.appendChild(p);
    });

    host.appendChild(box);
  }

  /** 对外的体检入口。P0 返回空数组，代价是「没有结论」而不是「结论是没问题」。 */
  function run(root, options) {
    return [];
  }

  function init(host) {
    if (!host) return;
    renderPlaceholder(host);
  }

  MW.panels = MW.panels || {};
  MW.panels.audit = {
    PHASE: PHASE,
    init: init,
    run: run,
    render: renderPlaceholder
  };
})(window);
