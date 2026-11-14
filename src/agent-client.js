/*
 * agent-client.js —— /agent/* 的可选后端通道（二期 P6 起，P7 加润色通道）
 *
 * 它与 sync.js 是同一个口子的两种用法：
 *   sync.js 管「手机预览」（/sync，内存态、丢了无所谓）；
 *   本文件管「版本仓库」（/agent/*，落 SQLite 磁盘）。
 * P7 又在这个口子上加了唯一一条流式通道：POST /agent/polish。
 * 两者共用同一个地址探测思路，但各自持有自己的 state——
 * 手机预览连不上不代表版本服务连不上（例如只改了 serve.py 的一半），
 * 混用一个 base 会让一个失效拖垮另一个。
 *
 * 关于硬约束 3（禁止用 fetch 读本地文件）：
 *   这里 fetch 的是 http://localhost:8000/agent/*，一个 HTTP 端点；
 *   md 正文始终只从文件选择器 / 拖拽 / textarea 进来，不由本文件读取。
 *
 * 失败时的态度（与 sync.js 一致，但更克制）：
 *   后端没开是常态，所以自动探测失败不弹提示（探测在页面初始化时就会发生一次）；
 *   只有「用户明确点了保存」而又连不上，才提示一次，并说清怎么解决。
 *   关键：失败不缓存成「永久不可用」——用户中途双击 serve.cmd 要能立刻接上。
 */
(function (global) {
  'use strict';

  const MW = (global.MW = global.MW || {});

  const PHASE = 7;

  /** 与 serve.cmd / serve.py / sync.js 保持一致，三处都是 8000。 */
  const DEFAULT_PORT = 8000;
  /** 单次请求超时。本机 SQLite 是毫秒级的，2.5s 足够，超了就是没连上。 */
  const TIMEOUT_MS = 2500;
  /** 自动探测失败后的冷却：够短，用户中途启动服务能自动接上；够长，不拖慢编辑。 */
  const RETRY_MS = 10000;

  const state = { base: null, lastFailAt: 0, warned: false };

  /**
   * 候选地址，按「最可能通」排序。
   * 页面本身就是 serve.py 发出来的，同源那个一定通，所以排第一；
   * 后两个是为了「直接双击 index.html」——页面跑在 file:// 上，没有同源可言。
   */
  function candidates() {
    const list = [];
    if (/^https?:$/.test(global.location.protocol)) list.push(global.location.origin);
    list.push('http://localhost:' + DEFAULT_PORT);
    list.push('http://127.0.0.1:' + DEFAULT_PORT);
    return list.filter(function (item, at) { return list.indexOf(item) === at; });
  }

  /** 一次性提示「没连上」，整场会话最多一次。 */
  function noteFail() {
    state.base = null;
    state.lastFailAt = Date.now();
    if (state.warned) return;
    state.warned = true;
    MW.util.toast('没连上本机的版本服务，这一版不会落库。双击 serve.cmd 后重试即可；'
      + '编辑、预览、复制都不受影响。', 'warn');
  }

  /**
   * 请求一个 /agent 接口，永不 reject。
   * 统一返回 { ok, status, data?, error? }——调用方（面板）需要在界面上
   * 把失败说清楚，而不是靠 catch 出一个异常再猜它是什么。
   * status 取 0 表示「连都没连上」，与 4xx/5xx 区分开：前者要提醒用户开服务，
   * 后者是服务自己在报错，提示文案完全不同。
   */
  function request(url, options) {
    const opts = Object.assign({ method: 'GET', cache: 'no-store' }, options || {});
    const ctrl = global.AbortController ? new global.AbortController() : null;
    if (ctrl) opts.signal = ctrl.signal;
    const timer = global.setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);

    return global.fetch(url, opts).then(function (res) {
      global.clearTimeout(timer);
      return res.json().then(function (data) {
        if (!res.ok) {
          return { ok: false, status: res.status,
            error: (data && data.error) || ('HTTP ' + res.status) };
        }
        return { ok: true, status: res.status, data: data };
      }, function () {
        // 回了非 JSON（例如 serve.py 的 404 页面）：状态码本身足够说明问题
        return { ok: false, status: res.status, error: 'HTTP ' + res.status };
      });
    }, function (err) {
      global.clearTimeout(timer);
      return { ok: false, status: 0, error: (err && err.message) || String(err) };
    });
  }

  /**
   * 探针。
   * 用 GET /agent/versions（不带 docId）而不是另开一个 /ping：
   * routes.py 对「缺 docId」刻意回空壳（doc=null、versions=[]）而不是报错，
   * 那个空壳就是给这里用的。多一个接口就多一处要同步维护的东西。
   */
  function probe(origin) {
    return request(origin + '/agent/versions').then(function (res) {
      return res.ok && res.data && Array.isArray(res.data.versions) ? origin : null;
    });
  }

  /**
   * 探测本机服务地址，成功的结果会被缓存。
   * force=true 时无视冷却、重新探一遍——用户点「保存」连不上之后手动重试，
   * 不该被 10 秒冷却挡在门外，那会让人以为「点了没反应」。
   */
  function findBase(force) {
    if (state.base && !force) return Promise.resolve(state.base);
    if (!force && state.lastFailAt && Date.now() - state.lastFailAt < RETRY_MS) {
      return Promise.resolve(null);
    }

    let chain = Promise.resolve(null);
    candidates().forEach(function (origin) {
      chain = chain.then(function (found) {
        if (found) return found;
        return probe(origin);
      });
    });
    return chain.then(function (found) {
      state.base = found;
      if (found) state.lastFailAt = 0;
      return found;
    });
  }

  /** 服务在不在。自动探测失败不提示——「没开后端」是合法的用法，不是错误。 */
  function available() {
    return findBase(false).then(function (base) { return !!base; });
  }

  /** 忘掉缓存地址，下一次请求重新探测。供面板提供「重试」用。 */
  function forget() {
    state.base = null;
    state.lastFailAt = 0;
  }

  function offline() {
    return { ok: false, offline: true, error: '没有连上本机版本服务' };
  }

  /**
   * POST /agent/save  {docId?, title, contentMd, origin}
   *                 → {docId, version:{id, seq, createdAt}}
   * docId 省略即「首次保存」，后端自建文档并给 seq=1——
   * 这正是「第一次点保存才有版本 1」的落点。
   */
  function save(payload) {
    return findBase(true).then(function (base) {
      if (!base) { noteFail(); return offline(); }
      return request(base + '/agent/save', {
        method: 'POST',
        // text/plain 让请求落进「简单请求」不触发预检；服务端读原始 body，
        // 内容类型不影响它解析 JSON（与 sync.js 的 push 同一手法）。
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        if (!res.ok) {
          if (res.status === 0) noteFail(); // 只在「连都没连上」时提示
          return { ok: false, error: res.error };
        }
        return { ok: true, data: res.data };
      });
    });
  }

  /** GET /agent/versions?docId= → {doc, versions}；不带 docId 回空壳（探测用）。 */
  function versions(docId) {
    return findBase(false).then(function (base) {
      if (!base) return offline();
      const q = docId ? '?docId=' + encodeURIComponent(docId) : '';
      return request(base + '/agent/versions' + q).then(function (res) {
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: res.data };
      });
    });
  }

  /** GET /agent/version?id= → {id, seq, contentMd, origin, createdAt}。按需单取正文。 */
  function version(id) {
    return findBase(false).then(function (base) {
      if (!base) return offline();
      return request(base + '/agent/version?id=' + encodeURIComponent(id)).then(function (res) {
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: res.data };
      });
    });
  }

  /* ==================== 流式润色（P7） ==================== */

  /** 一帧 SSE 原文 → 事件对象。解析不出来返回 null（保活注释、半截 JSON 都走这里）。 */
  function parseFrame(raw) {
    const dataLines = [];
    raw.split('\n').forEach(function (line) {
      line = line.replace(/\r$/, '');
      if (!line || line.charAt(0) === ':') return;
      if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).replace(/^ /, ''));
    });
    if (!dataLines.length) return null;
    try {
      return JSON.parse(dataLines.join('\n'));
    } catch (err) {
      return null;
    }
  }

  /**
   * 读 SSE 流，把每一帧交给 onEvent，返回最后一帧（done:true 的那个）。
   *
   * 半帧处理是本文件最容易写错的一段：按空行切帧，**最后一段不完整的必须
   * 留在 buffer 里等下一块**。写成「按 chunk 切完就丢」的表现是长文里偶尔
   * 少半句话或蹦一个乱码字，几十次才复现一次——所以这里宁可多两行循环。
   * 另一半是多字节汉字跨块：TextDecoder 的 stream:true 就是为它准备的
   * （与后端 llm.py 的增量解码器同一个理由，见 PLAN-II.md §12 第 2 条）。
   */
  function readStream(body, onEvent) {
    const reader = body.getReader();
    const decoder = new global.TextDecoder('utf-8');
    let buffer = '';
    let final = null;

    function emit(raw) {
      const event = parseFrame(raw);
      if (!event) return;
      if (event.done) final = event;
      if (onEvent) onEvent(event);
    }

    function pump() {
      return reader.read().then(function (chunk) {
        // \r 在流里只可能是行尾（JSON 字符串里的 \r 是转义过的 \\r），去掉它
        // 就能让 "data: x\r\n\r\n" 与 "data: x\n\n" 走同一条切帧逻辑。
        buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done })
          .replace(/\r/g, '');

        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          emit(buffer.slice(0, at));
          buffer = buffer.slice(at + 2);
        }
        if (chunk.done) {
          if (buffer.trim()) emit(buffer);   // 上游少写了收尾空行时的兜底
          return final;
        }
        return pump();
      });
    }

    return pump();
  }

  /**
   * 流式请求失败时的统一返回。
   *
   * 为什么要单独一个函数：中断/失败发生在**两个不同阶段**，而它们落进两个不同的
   * rejection 分支——fetch 还没回来时中断，落在 fetch 那一支；已经开始读流之后
   * 中断（用户点了取消、或关了页面），body 流会报错，落在 readStream 那一支。
   * 两处若各写一份判断，迟早有一处漏掉 AbortError——漏掉的表现不是报错，
   * 而是「点了取消，界面一直转圈」，外加控制台一条 unhandled rejection。
   */
  function streamFailed(err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, canceled: true, error: '已取消' };
    }
    return { ok: false, status: 0,
      error: '读取润色结果时连接断了（' + ((err && err.message) || String(err)) + '），可以重试。' };
  }

  /**
   * POST /agent/polish  {docId?, title, contentMd, runId?, dropped?} → SSE
   *
   * 两种形状（B2 起）：不带 runId/dropped ＝ 第一轮润色；带齐那两个 ＝ 在**同一条 run**
   * 上续跑第二轮（先落零 token 的 check，再按 dropped 决定要不要跑 revise）。
   * 第二轮才会收到 `step:'revise'` 的 delta，末帧也才带 `revised` / `droppedCount`。
   * 这里对两种形状一视同仁——分叉全在 panels/polish.js 里。
   *
   * 为什么不用 EventSource：它只支持 GET，而润色的请求体是整篇草稿（可能几十 KB）。
   * 所以这里用 fetch + response.body.getReader() 手动解帧——与后端 serve.py 的
   * stream_events()/_sse_events() 是同一件事的两端。
   *
   * 返回值刻意是 { promise, cancel } 而不是一个 Promise：「可中断」是 PLAN-II.md §10
   * 的护栏之一，而中断要用那个 AbortController；把它藏在闭包里、调用方拿不到，
   * 等于没有中断能力。
   *
   * 这里**不设前端超时**：流式请求该活多久由后端的总时长上限（180 秒）说了算，
   * 前端再压一个短超时只会把「模型正在慢慢写」误判成失败。
   */
  function polish(payload, onEvent) {
    // 控制器必须**同步**建好。写成「在 findBase() 的回调里才创建」的话，
    // 探测还没回来的那段时间里 ctrl 是 null，此时点「取消」abort 会静默失效——
    // 表现是按钮变成「取消中…」，然后流照常跑完、结果照常写进编辑区。
    // 本机探测只要几毫秒，人手动点不到；但 file:// 下候选地址有多个、
    // 头一个要等满 2.5 秒超时的时候，这个窗口宽到足够点一次。
    const ctrl = global.AbortController ? new global.AbortController() : null;

    const promise = findBase(true).then(function (base) {
      if (!base) {
        return { ok: false, offline: true, error: '没有连上本机版本服务' };
      }

      const opts = {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(payload)
      };
      if (ctrl) opts.signal = ctrl.signal;

      return global.fetch(base + '/agent/polish', opts).then(function (res) {
        if (!res.ok) {
          // 4xx/5xx 一定是普通 JSON（校验失败 / 没配 Key / 已有 run 在跑），
          // 因为后端在写第一个字节的流之前就把状态码定下来了，见 routes._polish。
          return res.json().then(function (data) {
            return { ok: false, status: res.status,
              error: (data && data.error) || ('HTTP ' + res.status) };
          }, function () {
            return { ok: false, status: res.status, error: 'HTTP ' + res.status };
          });
        }
        if (!res.body || !res.body.getReader) {
          return { ok: false, status: res.status,
            error: '这个浏览器读不了流式响应，换 Chrome / Edge 再试。' };
        }
        return readStream(res.body, onEvent).then(function (final) {
          return { ok: true, done: final };
        }, streamFailed);
      }, streamFailed);
    });

    return {
      promise: promise,
      cancel: function () { if (ctrl) ctrl.abort(); }
    };
  }

  /**
   * POST /agent/cancel {runId} → {ok, runId, status[, alreadyFinished]}
   *
   * B3 的显式取消（PLAN-II.md §8.3）。它与 abort 是两条并行的路，不是替代关系：
   * abort 断的是**连接**，后端从生成器被 close 得知；本接口置一个标记，后端
   * 读到下一帧就自己停。两者落到后端同一段收尾代码，所以行为一致。
   *
   * 为什么两条都要留着：abort 在「请求还没发出去」时也有效，而本接口需要
   * runId——第一轮流在一开始并不知道 runId（它在末帧才回来），那时只能靠 abort。
   * 反过来，run 已经跨过第一轮之后（知道 runId 了），显式取消更稳：
   * 它不依赖 TCP 断开被及时察觉。
   *
   * 与 polish 一样永不 reject：失败在界面上说清楚，不靠异常。
   */
  function cancel(runId) {
    if (!runId) return Promise.resolve({ ok: false, error: '没有 runId，无法取消' });
    return findBase(false).then(function (base) {
      if (!base) return offline();
      return request(base + '/agent/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ runId: runId })
      }).then(function (res) {
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: res.data };
      });
    });
  }

  MW.agent = {
    PHASE: PHASE,
    available: available,
    forget: forget,
    save: save,
    versions: versions,
    version: version,
    polish: polish,
    cancel: cancel
  };
})(window);
