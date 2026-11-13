/*
 * panels/report.js —— 丢失样式登记面板
 *
 * 职责（P3 实现）：
 *   用户在手机上看到某处样式丢了，回到这里描述现象，工具把它落成一条
 *   兼容规则（写进 compat-rules），规则回灌进渲染管线，下次不再丢。
 *   这是整个产品唯一「越用越好用」的地方。
 *
 * 表单最终会采集这些字段（与 compat-rules 的 schema 对齐）：
 *   现象标题 / 生效对象（选择器或元素描述）/ 想补的声明 /
 *   复现设备（机型 + 系统）/ 来源（谁在什么条件下发现的）。
 * 为什么要强制填设备与来源：没有证据的规则无法复现，也就无法验证，
 * 时间一长整张表就退化成猜测集合。
 *
 * P0 行为：只渲染说明与字段预览，不做表单——表单一旦写出来，
 * 就会忍不住顺手接上保存逻辑，那是 P3 的活。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  const PHASE = 3;

  function renderPlaceholder(host) {
    host.textContent = '';
    const box = document.createElement('div');
    box.className = 'placeholder';

    const title = document.createElement('h3');
    title.textContent = '丢失样式登记（P3 启用）';
    box.appendChild(title);

    const lines = [
      '手机上发现样式丢失时，在这里登记一条规则：现象、作用对象、要补的声明、复现设备。',
      '登记的规则会写进兼容规则表，并在下次渲染时自动补上。'
    ];
    lines.forEach(function (text) {
      const p = document.createElement('div');
      p.textContent = text;
      box.appendChild(p);
    });

    const count = document.createElement('div');
    const rules = MW.compat ? MW.compat.all() : [];
    count.textContent = '当前规则表：' + rules.length + ' 条。';
    box.appendChild(count);

    host.appendChild(box);
  }

  function init(host) {
    if (!host) return;
    renderPlaceholder(host);
  }

  MW.panels = MW.panels || {};
  MW.panels.report = {
    PHASE: PHASE,
    init: init,
    render: renderPlaceholder
  };
})(window);
