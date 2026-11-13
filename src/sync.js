/*
 * sync.js —— 局域网同步通道
 *
 * 为什么需要它（P3 里最容易走错的一步）：
 *   直觉做法是「手机端每 800ms 读一次 localStorage 的 mw.rev」。
 *   但 localStorage 是「每台设备 + 每个浏览器」各自独立的存储，
 *   手机浏览器里根本没有电脑写进去的那份 mw.doc——轮询同一个键名，
 *   轮到的永远是空字符串。让两台设备看到同一份内容，中间必须有一个
 *   双方都能访问的落点，那就是 serve.py 里的 /sync。
 *
 * 两端共用这一份实现：
 *   电脑端 push()  把 { rev, doc, name, theme } 发上去；
 *   手机端 pull()  按 rev 拉，没变就只回一个「没变」，不重传整篇文档。
 *
 * 关于硬约束 3（禁止用 fetch 读本地文件）：
 *   这里 fetch 的是 http://IP:8000/sync，一个局域网 HTTP 端点，
 *   不是 file:// 下的本地路径；md 内容也依旧只从文件选择器 / 拖拽 /
 *   textarea 三条通路进来。这一条在 P3 动手前已经跟需求方确认过。
 *
 * 失败时的态度：不让它静默。
 *   服务没开是常态（用户可能刚打开 index.html），所以不能每次请求都弹提示；
 *   但一直不提示就等于「手机上看不到变化却不知道为什么」。
 *   折中：一次会话只提醒一次，并明确给出「怎么才能连上」。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  const PHASE = 3;

  /** 默认端口与 serve.cmd / serve.py 保持一致，三处都是 8000。 */
  const DEFAULT_PORT = 8000;
  /** 单次请求超时。轮询间隔是 800ms，超时必须更短，否则请求会越堆越多。 */
  const TIMEOUT_MS = 2500;
  /** 失败后的冷却时间：够短，用户中途启动 serve.cmd 也能自动接上；够长，不拖慢编辑。 */
  const RETRY_MS = 10000;

  const state = { base: null, lastFailAt: 0, warned: false };

  /**
   * 候选地址，按「最可能通」排序。
   * 预览页本身就是 serve.py 发出来的，同源那个一定通，所以排第一。
   * 后面的两个是为了「直接双击 index.html」这种用法——那种情况下
   * 页面跑在 file:// 上，没有同源可言，只能按默认端口去猜本机服务。
   */
  function candidates() {
    const list = [];
    if (/^https?:$/.test(global.location.protocol)) list.push(global.location.origin);
    list.push('http://localhost:' + DEFAULT_PORT);
    list.push('http://127.0.0.1:' + DEFAULT_PORT);
    return list.filter(function (item, at) { return list.indexOf(item) === at; });
  }

  function requestJson(url, options) {
    const opts = Object.assign({ method: 'GET', cache: 'no-store' }, options || {});
    // 没有超时的 fetch 会在服务不可达时长时间挂着，800ms 一次的轮询很快就堆成一串，
    // 表现出来就是「手机突然不更新了」——现象和真正的原因隔得很远，很难查。
    const ctrl = global.AbortController ? new global.AbortController() : null;
    if (ctrl) opts.signal = ctrl.signal;
    const timer = global.setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);

    return global.fetch(url, opts).then(function (res) {
      global.clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }, function (err) {
      global.clearTimeout(timer);
      throw err;
    });
  }

  function noteFail() {
    state.base = null;
    state.lastFailAt = Date.now();
    if (state.warned) return;
    state.warned = true;
    MW.util.toast('没连上本机同步服务，手机预览不会跟着更新。请双击运行 serve.cmd，'
      + '并在它打印的「本机访问」地址里编辑。', 'warn');
  }

  /**
   * 探测本机服务地址，成功的结果会被缓存。
   * 探测期间的失败是预期情况（服务可能就没开），所以逐个吞掉换下一个，
   * 全部失败由调用方统一按「没连上」处理，不会把异常藏起来。
   */
  function findBase() {
    if (state.base) return Promise.resolve(state.base);

    let chain = Promise.resolve(null);
    candidates().forEach(function (origin) {
      chain = chain.then(function (found) {
        if (found) return found;
        return requestJson(origin + '/sync').then(function (data) {
          return data && typeof data.rev === 'number' ? origin : null;
        }, function () { return null; });
      });
    });
    return chain.then(function (found) {
      state.base = found;
      return found;
    });
  }

  /**
   * 电脑端：把当前内容推给本机服务。
   * 返回 Promise<boolean>，失败不 reject——调用方是「每次落盘都顺带推一次」，
   * 让它去处理异常只会写出一个永远走不到的分支。
   */
  function push(payload) {
    if (state.lastFailAt && Date.now() - state.lastFailAt < RETRY_MS) {
      return Promise.resolve(false);
    }
    return findBase().then(function (base) {
      if (!base) { noteFail(); return false; }
      return requestJson(base + '/sync', {
        method: 'POST',
        // text/plain 让这个请求落进「简单请求」，不触发预检；
        // 服务端读的是原始 body，内容类型是什么并不影响它解析 JSON。
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(payload)
      }).then(function () { return true; }, function () {
        noteFail();
        return false;
      });
    });
  }

  /**
   * 手机端：按 rev 拉内容。
   * 返回 { rev, unchanged, doc, name, theme, lan }；unchanged 为真时不含 doc。
   * 拿不到服务时返回 null，由调用方决定「维持现状」还是「提示」。
   */
  function pull(rev) {
    const query = (rev == null || rev === '') ? '' : '?rev=' + encodeURIComponent(String(rev));
    return findBase().then(function (base) {
      if (!base) return null;
      return requestJson(base + '/sync' + query).catch(function () { return null; });
    });
  }

  /** 取一份服务端自报的家底（含它算出来的局域网地址）。二维码面板用它。 */
  function info() {
    return findBase().then(function (base) {
      if (!base) return null;
      return requestJson(base + '/sync').then(function (data) {
        return Object.assign({ base: base }, data);
      }, function () { return null; });
    });
  }

  MW.sync = {
    PHASE: PHASE,
    DEFAULT_PORT: DEFAULT_PORT,
    findBase: findBase,
    push: push,
    pull: pull,
    info: info
  };
})(window);
