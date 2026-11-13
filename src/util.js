/*
 * util.js —— 基础工具层
 *
 * 为什么单独抽一个文件、且必须最先加载：
 * 它是唯一被其它所有模块依赖的底座（编码嗅探、toast、防抖），
 * 不先执行它，后面任何模块在初始化期调用这些能力都会拿到 undefined。
 *
 * 本文件负责：防抖、HTML 转义、字符/字节统计、编码嗅探、文件读取、toast。
 * 它不碰 LED 渲染，也不碰 DOM 结构，保持「无副作用可复用」。
 */
(function (global) {
  'use strict';

  // file:// 下没有模块系统，window.MW 是唯一可靠的命名空间。
  // 每个文件都用这行做幂等初始化，谁先加载都不会被覆盖。
  const MW = (global.MW = global.MW || {});
  const util = (MW.util = MW.util || {});

  /**
   * 防抖。用于「停止输入 500ms 后再落盘」这类场景：
   * 每个按键都写 localStorage 会在长文档上产生可感知的卡顿。
   */
  function debounce(fn, wait) {
    let timer = 0;
    return function debounced() {
      const args = arguments;
      const self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  /**
   * HTML 转义。P0 的管线走 textContent，用不到它；
   * 但 P1 之后要拼 HTML 字符串（高亮、行号等），届时必须用它，
   * 先放在这里，避免以后有人图省事直接拼 template string。
   */
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /**
   * 按「码点」数长度。
   * 不用 text.length：它是 UTF-16 码元数，一个 emoji 会被算成 2，
   * 统计栏上显示「字符数」时会出现对不上的情况。
   */
  function countChars(text) {
    return Array.from(String(text == null ? '' : text)).length;
  }

  /** 当前文本的 UTF-8 字节数，用来显示 X KB。 */
  function utf8Bytes(text) {
    return new TextEncoder().encode(String(text == null ? '' : text)).length;
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /* ============================ 编码嗅探 ============================ */

  const REPLACEMENT = '\uFFFD';       // TextDecoder 遇到非法字节序列时产出的替换字符
  const SUSPECT_RATIO = 0.002;        // 0.2%，判定「这份文本可能不是 UTF-8」的阈值

  function countReplacement(text) {
    const arr = Array.from(text || '');
    let n = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] === REPLACEMENT) n++;
    return n;
  }

  /**
   * 用指定编码解码。
   * 这里确实需要 try/catch：new TextDecoder(label) 对不认识的 label 会抛错，
   * 而「浏览器不支持 gbk」是必须让用户知道的事实，所以不吞异常——
   * 交给 onUnsupported 回调去 toast，再返回 null 表示不可用。
   */
  function decodeWith(bytes, label, onUnsupported) {
    try {
      return new TextDecoder(label, { fatal: false }).decode(bytes);
    } catch (err) {
      if (onUnsupported) onUnsupported(err);
      return null;
    }
  }

  /**
   * 编码嗅探。真实痛点：中文 Windows 导出的 md 经常是 GBK，
   * 按 UTF-8 强读会得到满屏「锟斤拷」，而且用户完全不知道该怪谁。
   *
   * 策略是「比较」而不是「猜」：
   *   1. 先按 UTF-8 解，统计替换字符数量与占比；
   *   2. 占比超过 0.2% 时再按 GBK 解一次，谁替换字符少就用谁；
   *   3. 最终结果如果仍然有超阈值的替换字符，说明两种都不是，提示用户转存 UTF-8。
   */
  function sniffAndDecode(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

    // 带 BOM 的文件直接按 UTF-8 解，并丢掉 BOM——
    // 否则 U+FEFF 会作为正文首字符显示出来。
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      const text = decodeWith(bytes.subarray(3), 'utf-8', function (err) {
        toast('UTF-8 解码失败：' + err.message, 'error');
      });
      return { text: text == null ? '' : text, encoding: 'UTF-8', bad: 0, ratio: 0, lossy: false };
    }

    const utf8 = decodeWith(bytes, 'utf-8', function (err) {
      toast('UTF-8 解码失败：' + err.message, 'error');
    }) || '';
    const utf8Bad = countReplacement(utf8);
    const utf8Ratio = utf8.length ? utf8Bad / countChars(utf8) : 0;

    if (utf8Ratio <= SUSPECT_RATIO) {
      return { text: utf8, encoding: 'UTF-8', bad: utf8Bad, ratio: utf8Ratio, lossy: false };
    }

    const gbk = decodeWith(bytes, 'gbk', function (err) {
      toast('浏览器不支持 GBK 解码，已按 UTF-8 处理：' + err.message, 'warn');
    });
    if (gbk == null) {
      return { text: utf8, encoding: 'UTF-8', bad: utf8Bad, ratio: utf8Ratio, lossy: true };
    }

    const gbkBad = countReplacement(gbk);
    if (gbkBad < utf8Bad) {
      const ratio = gbkBad / countChars(gbk);
      return { text: gbk, encoding: 'GBK', bad: gbkBad, ratio: ratio, lossy: ratio > SUSPECT_RATIO };
    }
    return { text: utf8, encoding: 'UTF-8', bad: utf8Bad, ratio: utf8Ratio, lossy: true };
  }

  /* ============================ 文件读取 ============================ */

  const ALLOWED_EXT = ['md', 'markdown', 'txt'];

  function extOf(name) {
    const s = String(name || '');
    const i = s.lastIndexOf('.');
    return i < 0 ? '' : s.slice(i + 1).toLowerCase();
  }

  function isAllowedFile(name) {
    return ALLOWED_EXT.indexOf(extOf(name)) >= 0;
  }

  /**
   * 读文件并解码。返回的 Promise 在失败时 reject，
   * 由调用方决定怎么提示——不在这里静默返回空字符串，
   * 否则用户会以为「文件是空的」，实际是读失败。
   *
   * 只用 FileReader 而不是 fetch：硬约束 3 禁止在 file:// 下读本地路径。
   */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('没有拿到文件')); return; }

      if (!isAllowedFile(file.name)) {
        const ext = extOf(file.name);
        reject(new Error('只支持 .md / .markdown / .txt 文件，当前是' + (ext ? '「.' + ext + '」' : '「无扩展名」')));
        return;
      }

      const reader = new FileReader();
      reader.onerror = function () {
        const reason = reader.error && reader.error.message ? reader.error.message : '未知原因';
        reject(new Error('读取「' + file.name + '」失败：' + reason));
      };
      reader.onload = function () {
        const buf = reader.result;
        const res = sniffAndDecode(buf);
        res.name = file.name;
        res.bytes = buf.byteLength;
        resolve(res);
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /* ============================ toast ============================ */

  /**
   * 轻提示。宿主容器按需创建（第一次调用时才建），
   * 这样空页面上不会凭空多出一个空 div 影响布局审查。
   * 出错一定要让用户看见：不写 console.log 了事。
   *
   * sub 是可选的第二行小字，用于「主句说完、还有一句提醒」的场景
   * （P4 复制成功：主句告诉用户去哪儿粘，小字提醒粘完要看一眼手机）。
   * 它刻意做成同一张卡片里的第二行而不是第二个 toast：
   * 分成两条卡片后，两条会一起消隐、一起堆叠，读起来像两件事，
   * 而「已复制」和「记得看一眼」本来就是同一件事的两句话。
   */
  function toast(message, kind, sub) {
    if (!document.body) return;
    let host = document.getElementById('mw-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'mw-toast-host';
      host.className = 'toast-host';
      document.body.appendChild(host);
    }
    const item = document.createElement('div');
    item.className = 'toast' + (kind ? ' toast--' + kind : '');
    item.textContent = String(message);
    if (sub) {
      const line = document.createElement('div');
      line.className = 'toast-sub';
      line.textContent = String(sub);
      item.appendChild(line);
    }
    host.appendChild(item);
    setTimeout(function () {
      item.classList.add('is-out');
      setTimeout(function () { item.remove(); }, 260);
    }, 3400);
  }

  util.debounce = debounce;
  util.escapeHtml = escapeHtml;
  util.countChars = countChars;
  util.utf8Bytes = utf8Bytes;
  util.formatBytes = formatBytes;
  util.sniffAndDecode = sniffAndDecode;
  util.readFile = readFile;
  util.isAllowedFile = isAllowedFile;
  util.extOf = extOf;
  util.toast = toast;
})(window);
