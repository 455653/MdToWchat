# -*- coding: utf-8 -*-
"""
routes.py —— /agent/* 的处理函数（二期 P6）

这一层的边界写死为：收 dict（或 None）→ 返 (status, dict)。
它不碰 HTTP 头、不碰 SQL、不做业务判断。

为什么校验只做「形状」，不做「业务」：
  调用者只有 serve.py 一个，它是自己人；而这里的数据来自浏览器，是边界。
  边界上校验、内部信任，是唯一不会两边都漏的做法。
  所以这里只回答「contentMd 是不是字符串」这类问题，
  「这篇文档存不存在」由 store 去撞，撞出来归到这里翻成一个状态码。

刻意不规划 POST /agent/rollback（PLAN-II.md §8.1）：
  回退在编辑区完成，要留下痕迹仍走 /agent/save。
  留一个「回退即写库」的接口，等于留一条绕过保存按钮偷偷写库的路，
  与 §7 的版本口径直接打架。

B3 补的护栏（PLAN-II.md §9 的 B 档三步、§10 工程护栏）：
  · 整条链的总时长上限 —— 一条 run 跨两次 HTTP 请求（第一轮 polish、第二轮
    check+revise），「每轮各自计时」会让第二轮把这条护栏绕过去，所以计时口径
    改成整条链（_chain_started）。
  · 单步上限 —— 一次上游调用最长跑多久，证据落在 agent_steps.latency_ms。
  · 整条 run 的 token 预算 —— 跨轮累加，用尽时**不发请求**、优雅收尾（§14.5）。
  · 最多修订 1 轮 —— 第二轮之后再有人拿同一条 run 续跑，直接拒掉。
  · POST /agent/cancel —— 把「断连」换成一次显式请求；断连那条路照旧可用，
    两者落到同一段收尾代码（_polish_stream 的 finally）。
"""

import json
import threading
import time
from datetime import datetime

from agent import llm, prompts, store

# PLAN-II.md §7 里 origin 的四个枚举值。
# 本期前端只会发前三个；rollback 留着，是为了将来真要做「回退即成一版」
# 时不用改表、不用改这里。
ORIGINS = ('import', 'ai_polish', 'manual', 'rollback')

ORIGIN_TEXT = {
    'import': '导入原文',
    'ai_polish': 'AI 润色',
    'manual': '手动编辑',
    'rollback': '回退'
}

# 整条链（所有轮加起来）的总时长上限（PLAN-II.md §10「总时长上限」）。
# 超时就停，但**不吞掉已经流出来的部分**——把它交给用户并说清还差什么。
# 180 秒对一篇 3000 字的文章很宽松了；真撞上说明上游在拖，继续等只会更糟。
#
# B3 起它管的是**整条链**而不是「一次润色」：一条 run 会跨两次 HTTP 请求
# （第一轮 polish、第二轮 check+revise），每轮各自计时的写法会让第二轮
# 把这条护栏整个绕过去（§10 明说）。跨轮计时见 _chain_started()。
POLISH_MAX_SECONDS = 180

# 单步上限：一次上游调用最长跑多久。它比整条链上限短，作用是让「某一轮自己卡住」
# 单独暴露出来——否则第一步吃掉 170 秒后，第二步只剩 10 秒，用户看到的是
# 「明明还有时间却停了」。证据是 agent_steps.latency_ms（B3 验收会看这一列）。
STEP_MAX_SECONDS = 120

# 整条 run 的总 token 上限（输入 + 输出）。默认值给得很宽松——一篇 3000 字的稿子
# 一轮约 1.5k 输入 + 0.5k 输出，两轮也就 4k 上下，正常根本碰不到；它挡的是
# 「check 反复判定要修订」这类跑飞的情况。可在 agent/config.json 里用
# polishMaxTokens 覆盖（§14.5 的验收就是把它调到很小来观察「优雅停下」）。
# 为什么不是「每轮各算」：与总时长同理，预算是**整条 run**的，跨轮累加。
POLISH_MAX_TOKENS = 24000

# 最多修订几轮。B2 事实上只有一轮（dropped 非空才走），这里把它写成显式的上限：
# 第二轮之后再有人拿同一条 run 续跑，直接拒掉，而不是静默再跑一轮。
MAX_REVISE_ROUNDS = 1

# 「取消」的显式信号（B3 的 POST /agent/cancel）。run_id → True 表示已被请求取消，
# 流式主循环每收到一个 delta 就查一次。
#
# 为什么用模块级的 dict 而不是 threading.Event：「同时只允许一个 run」这条护栏
# 已经把并发收成了串行，这里只需要一个「说过要停」的标记。取值/置值都是单条原子
# 操作，不需要额外的锁；生命周期与 run 的流一致——开跑时置 False，收尾时删掉
# （见 _polish_stream 的 finally）。留一个 True 在字典里也无害：run 已经结束，
# 不会再有人来查它。
CANCEL_REQUESTED = {}

# 「同时只允许一个 run」（PLAN-II.md §10）。ThreadingHTTPServer 每请求一个线程，
# 跑几分钟会占线程；并发还会让 SQLite 写锁打架、被上游限流。
# 这里用一把非阻塞锁把它拦在门口，冲突时回 409 而不是排队——
# 排队会让第二个用户以为「点了没反应」。
RUN_LOCK = threading.Lock()


def init():
    """建表。serve.py 启动时调一次（内部幂等）。"""
    store.init()


# ------------------------------------------------------------------ 工具

def _bad(message):
    return 400, {'ok': False, 'error': message}


def _int_param(raw):
    """解析查询串里的整数。返回 (值, 错误响应)；两者恰有一个为 None。

    注意「缺参数」不算错：/agent/versions 不带 docId 是合法的探测请求，
    它回一个空的 versions 列表——前端拿它当「服务在不在」的探针。
    """
    if raw is None or raw == '':
        return None, None
    if not raw.lstrip('-').isdigit():
        return None, _bad('参数必须是整数：%r' % raw)
    return int(raw), None


def _opt_int(body, field):
    """请求体里的可选正整数（docId / runId）。返回 (值, 错误响应)。"""
    value = body.get(field)
    if value is None:
        return None, None
    # bool 是 int 的子类，这里必须单独挡掉，否则 True 会被当成 1
    if isinstance(value, bool) or not isinstance(value, int):
        return None, _bad('%s 必须是整数或省略（收到 %s）' % (field, type(value).__name__))
    if value <= 0:
        return None, _bad('%s 必须是正整数：%r' % (field, value))
    return value, None


def _draft(body):
    """校验「一次保存」和「一次润色」共同的那三个字段。

    save 与 polish 的请求体形状是一样的（PLAN-II.md §8.2 明说「请求体同 save」），
    所以校验也只该有一处——两份校验迟早会分叉，然后出现「保存能过、润色报错」
    这种让人摸不着头脑的差异。
    """
    if not isinstance(body, dict):
        return None, _bad('请求体必须是 JSON 对象')

    content = body.get('contentMd')
    if not isinstance(content, str):
        return None, _bad('contentMd 必须是字符串（收到 %s）' % type(content).__name__)
    if not content.strip():
        return None, _bad('contentMd 是空的，没有可处理的内容')

    title = body.get('title')
    if title is None:
        title = '未命名'
    if not isinstance(title, str):
        return None, _bad('title 必须是字符串')
    title = title.strip() or '未命名'

    doc_id, err = _opt_int(body, 'docId')
    if err:
        return None, err

    return {'contentMd': content, 'title': title, 'docId': doc_id}, None


# 一次最多接受前端回传多少条 dropped。它是浏览器发上来的数组，属于边界输入，
# 不能假设它规规矩矩——真实的一篇稿子丢掉几十处已经很夸张了。
DROPPED_MAX = 200


def _dropped(body):
    """解析前端回传的兼容性结果（PLAN-II.md §9 的「前端算 + 回传」）。

    为什么是前端算：兼容规则只有一份，在 src/compat-rules.js + 那整条一期管线里。
    后端复刻一份等于让那张表有第二个副本，两边迟早漂。所以后端只负责**接住结论**。

    返回 (列表, 错误响应)。**列表为 None 表示这次请求不是第二轮**（请求体里没有
    dropped 这个键），与「第二轮但什么都没丢」（空列表）是两件不同的事：
    前者跳过 check/revise 两步，后者要落一条 check 如实记下「检查过了，没东西丢」。
    """
    if 'dropped' not in body:
        return None, None

    raw = body['dropped']
    if not isinstance(raw, list):
        return None, _bad('dropped 必须是数组（收到 %s）' % type(raw).__name__)

    items = []
    for item in raw[:DROPPED_MAX]:
        if not isinstance(item, dict):
            continue          # 形状不对的条目直接跳过，不为了它整轮报错
        tag = str(item.get('tag') or '').strip()[:32]
        preview = str(item.get('preview') or '').strip()[:200]
        if not tag and not preview:
            continue
        items.append({'tag': tag or 'unknown', 'preview': preview})
    return items, None


# ------------------------------------------------------------------ 三个接口

def _save(body):
    """POST /agent/save  {docId?, title, contentMd, origin, runId?}
       → {docId, version:{id, seq, createdAt}}

    runId（P7）只有一种情况会带：第一次保存，且正文是 AI 润色的结果。
    它把 versions 与 agent_runs 挂上，回答「这一版是哪次润色产出的」。
    """
    draft, err = _draft(body)
    if err:
        return err

    origin = body.get('origin')
    if origin is None:
        origin = 'manual'
    if origin not in ORIGINS:
        return _bad('origin 只能是 %s 之一' % '、'.join(ORIGINS))

    run_id, err = _opt_int(body, 'runId')
    if err:
        return err

    try:
        result = store.save_version(
            draft['docId'], draft['title'], draft['contentMd'], origin, run_id)
    except ValueError as err2:
        return _bad(str(err2))
    return 200, result


def _versions(query):
    """GET /agent/versions?docId=12
       → {doc:{id,title,currentVersionId}, versions:[{id,seq,origin,chars,createdAt}]}

    不带 docId（或 docId=0）时回一个空壳而不是报错——
    那正是 src/agent-client.js 用来判断「本机服务在不在」的探针。
    """
    raw = query.get('docId', [None])[0]
    doc_id, err = _int_param(raw)
    if err:
        return err
    if doc_id is None or doc_id <= 0:
        return 200, {'doc': None, 'versions': []}
    return 200, store.list_versions(doc_id)


def _version(query):
    """GET /agent/version?id=7 → {id, seq, contentMd, origin, createdAt}"""
    raw = query.get('id', [None])[0]
    version_id, err = _int_param(raw)
    if err:
        return err
    if version_id is None or version_id <= 0:
        return _bad('缺参数 id（要取哪一版）')
    data = store.get_version(version_id)
    if data is None:
        return 404, {'ok': False, 'error': '版本 %r 不存在' % version_id}
    return 200, data


# 一次最多回多少条 run。它挡的是「有人把 limit 写成 100000」这种把整张表拉出来的
# 请求，而排查时真正会看的就是最近几十次，超过的部分翻页也用不上。
RUN_LIMIT_MAX = 200


def _runs(query):
    """GET /agent/runs?docId=12&limit=20 → {runs:[{...,stepCount}]}

    这个只读接口是 agent_steps 的「出口」：§7 说它是调试 agentic 的唯一手段，
    但表建起来而没有入口的话，调试时还是得开 sqlite3 敲 SQL——
    那等于没有这个手段。

    docId 不传（或 0）＝ 不过滤，看全部；这是排查时最常用的看法。
    """
    raw = query.get('docId', [None])[0]
    doc_id, err = _int_param(raw)
    if err:
        return err
    if doc_id is not None and doc_id <= 0:
        doc_id = None

    raw_limit = query.get('limit', [None])[0]
    limit, err = _int_param(raw_limit)
    if err:
        return err
    if limit is None or limit <= 0:
        limit = 20
    limit = min(limit, RUN_LIMIT_MAX)

    return 200, {'runs': store.list_runs(doc_id, limit)}


def _run_detail(query):
    """GET /agent/runs/<id> → {run:{...}, steps:[...]}；找不到回 404。

    steps 只在这里带回来（列表不带）：这就是 store.list_runs 里说的分工——
    列表要的是「有哪几次、各跑了什么样」，详情要的是「那一次到底哪一步坏了」。
    """
    raw = query.get('id', [None])[0]
    run_id, err = _int_param(raw)
    if err:
        return err
    if run_id is None or run_id <= 0:
        return _bad('run id 必须是正整数：%r' % raw)
    data = store.get_run(run_id)
    if data is None:
        return 404, {'ok': False, 'error': 'run %r 不存在' % run_id}
    return 200, {'run': data, 'steps': store.list_steps(run_id)}


def _token_budget():
    """整条 run 的 token 预算。config.json 里给了合法的正整数就用它，否则用默认值。

    做成可配置是为了 §14.5 那条验收：把 polishMaxTokens 调小（例如 100），
    就能在真机上观察「预算用尽时优雅停下」——写死一个 24000 等于这条护栏
    永远跑不到，验收时无从证明它存在。
    """
    raw = llm.config().get('polishMaxTokens')
    if isinstance(raw, bool) or not isinstance(raw, int) or raw <= 0:
        return POLISH_MAX_TOKENS
    return raw


def _chain_started(run_info):
    """整条链的单调时钟起点，供 _pump 判总时长。

    一条 run 跨两次 HTTP 请求，`time.monotonic()` 在两次请求之间没有共同基准，
    所以改成把 run 的 created_at 换算成一个 monotonic 上的「已经起跑了多久」：
        started = now_mono - (now_wall - created_wall)
    换算的是「过去多久」而不是「哪个时刻」，因此两次请求之间隔了多久都不影响。
    解析不出来（列被外部改坏）就退化成「从现在开始算」——真发生了只是这一条 run
    的上限从宽，不会更糟。
    """
    created = (run_info or {}).get('createdAt')
    try:
        wall = datetime.strptime(created, '%Y-%m-%dT%H:%M:%S').timestamp()
    except (TypeError, ValueError):
        return time.monotonic()
    return time.monotonic() - max(0.0, time.time() - wall)


def _spent_tokens(run_id):
    """这条 run 到目前为止累计花掉的 token（输入 + 输出）。

    它是**整条链**的用量：第一轮结束时就已由 finish_run 累加进去了，
    所以第二轮开跑前读它一次，就知道预算还剩多少。
    """
    info = store.get_run(run_id) or {}
    return (info.get('tokensIn') or 0) + (info.get('tokensOut') or 0)


def _stop_note(chain_started, step_started, run_id):
    """该不该把这一轮停下；该停时返回给用户的一句话，不停返回 None。

    三种停法，按「越明确越先判」排：
      1. 显式取消（/agent/cancel）；
      2. 单步超时；
      3. 整条链超时。
    三种都**不报错**——流正常收尾、把已经生成的部分交回去，末尾附上这句说明。
    这正是 §14.5 要的「时长/预算用尽时优雅停下，而不是报错或转圈」。
    """
    if CANCEL_REQUESTED.get(run_id):
        return ('已按你的请求停下。下面是**已经生成的部分**，'
                '后面的段落还没处理完——可以接着手动改，或再点一次「重新润色」。')
    if time.monotonic() - step_started > STEP_MAX_SECONDS:
        return ('这一步超过 %d 秒还没跑完，先停在这里。下面是**已经生成的部分**，'
                '后面的段落还没处理完——可以接着手动改，或再点一次「重新润色」。'
                % STEP_MAX_SECONDS)
    if time.monotonic() - chain_started > POLISH_MAX_SECONDS:
        return ('这一次润色（含兼容性修订）累计超过 %d 秒，先停在这里。'
                '下面是**已经生成的部分**，后面的段落还没处理完——'
                '可以接着手动改，或再点一次「重新润色」。' % POLISH_MAX_SECONDS)
    return None


def _pump(messages, kind, chain_started, step_started, parts, usage, run_id):
    """跑一轮上游流式调用：delta 转给客户端，正文攒进 parts、用量攒进 usage。

    返回 (status, error, note)。抽出来是因为第一轮（polish）与第二轮（revise）
    在「怎么读流、怎么判超时、怎么攒用量」上完全是同一件事，只有 messages 与
    kind 不同；两份各写一遍，两边迟早分叉。

    两次计时（chain_started / step_started）都在这里判，见 _stop_note：
    单步与整条链是两条独立的护栏，任一条到点都停。

    parts / usage 用「传进来的容器原地更新」而不是返回值：一个几十 KB 的正文
    没有理由在每轮之间再复制一遍。
    """
    status = 'done'
    error = None
    note = None
    for item in llm.stream(messages):
        note = _stop_note(chain_started, step_started, run_id)
        if note:
            status = 'canceled'
            break
        if 'delta' in item:
            parts.append(item['delta'])
            yield {'step': kind, 'delta': item['delta']}
        elif 'usage' in item:
            usage.update(item['usage'] or {})
    return status, error, note


def _polish_stream(draft, run_id, start_idx=0, dropped=None):
    """一条 run 的流式主循环。生成器：yield 事件字典，serve.py 负责写成 SSE 帧。

    两种入口，正好对应 PLAN-II.md §9 的「一条链、两段」：

      dropped is None → 第一轮：只跑 polish（idx = start_idx）。
      dropped 是列表   → 第二轮：先落一条 check（idx = start_idx，零 token，
                        产物是兼容性报告），再在 dropped 非空时跑 revise
                        （idx = start_idx + 1）。这是**同一条 run** 的第二段——
                        B3 的「断点续跑」要的就是这个编号。

    为什么第二轮要跟着 runId 回来、而不是另开一条 run：§9 那套步骤编号
    （…check、revise）本来就是同一条链上的第几步；拆成两条 run 之后，
    「这一次润色到底做了什么、花在哪」就得跨两条记录拼，排查时最容易漏掉一半。

    它是唯一知道「这一轮怎么收尾」的地方，所以四件事全放在同一个 finally 里：
    落 run 的终态、写当前步骤的终态、释放全局锁、决定成品能不能用。
    （B1 的教训：start_step 也必须开在这层 try 里面——它写库失败时若绕过
    finally，全局锁就漏放了，之后每次润色都会拿到 409，直到重启服务。）
    """
    # 整条链的起点从 run 的 created_at 换算（见 _chain_started）：这样第二轮
    # 会带上第一轮已经用掉的时间，「每轮各自算 180 秒」那条漏洞就不存在了。
    chain_started = _chain_started(store.get_run(run_id))
    step_started = time.monotonic()
    step_id = None          # 当前开着的、还在流式的步骤（check 是即开即收的，不在此列）
    parts = []
    usage = {}
    status = 'done'
    error = None
    note = None
    finished = False
    text = ''
    revised = False

    try:
        if dropped is None:
            # 单轮润色也落一步（kind='polish'，idx=0）。
            # 为什么一步也要记：agent_steps 是「调试 agentic 的唯一手段」（§7），
            # 而它得有数据才谈得上用——第二轮的两步就挂在同一条链上，
            # 「第二轮到底跑没跑、跑了多久」全靠这张表回答。
            step_id = store.start_step(
                run_id, start_idx, 'polish',
                json.dumps({'title': draft['title'], 'chars': len(draft['contentMd'])},
                           ensure_ascii=False))

            status, error, note = yield from _pump(
                prompts.messages(draft['title'], draft['contentMd']),
                'polish', chain_started, step_started, parts, usage, run_id)

            text = prompts.clean_output(''.join(parts))
            if status == 'done' and not prompts.looks_like_markdown(text):
                # PLAN-II.md 14.2：剥完不像文章就报错，不静默当成正文。
                # 这里也**不把半成品交给前端**——把一段「抱歉，我无法…」塞进编辑区，
                # 比让用户看到一句明确的失败更糟。
                status = 'failed'
                error = ('上游返回的内容剥掉包装后不像一篇 Markdown 文章，已丢弃，'
                         '没有写进编辑区。多半是模型拒答或被上游截断了，可以直接重试。')
                text = ''
        else:
            # check：前端已经跑完整条一期管线，这里只把它的结论记下来。
            # 它是零 token、零耗时的，产物是**兼容性报告**——中间产物，
            # 所以写 output_text；而 revise 的产物是正文，一律 NULL
            # （见 store.py 文件头那条贯穿全库的规则）。
            report = prompts.compat_report(dropped)
            check_id = store.start_step(
                run_id, start_idx, 'check',
                json.dumps({'dropped': len(dropped), 'items': dropped,
                            'revisePrompt': prompts.revise_prompt_hash()},
                           ensure_ascii=False))
            store.finish_step(check_id, 'done', output_text=report, latency_ms=0,
                              tokens_in=0, tokens_out=0)

            if not dropped:
                # 报告为空：前端一般认为不该发这个请求（§9：多出来的往返只在
                # dropped 非空时才有），但真发了也不算错——如实记一条 check，
                # 原样交回去并说清为什么没改。
                text = draft['contentMd']
                note = '检查通过：没有发现会被公众号整块丢掉的写法，这一轮不需要修订。'
            elif _spent_tokens(run_id) >= _token_budget():
                # 预算已经用尽：这一轮**不发请求**，优雅收尾（§14.5）。
                # 为什么检查点在这里、而不是流跑到一半时：上游的 usage 只在最后
                # 一块里回来，流跑到一半根本不知道花了多少。所以预算唯一能检查的
                # 时刻就是「一轮开跑之前」——此时这一轮的输入（上一轮的稿子）已经
                # 在手里了，原样交回去即可，编辑区一个字节都不动。
                text = draft['contentMd']
                note = ('这一次润色累计已用 %d token，达到上限 %d，这一轮不再修订，'
                        '编辑区保留上一轮的稿子。想接着改可以在 agent/config.json 里'
                        '把 polishMaxTokens 调大后重启 serve.cmd 再试。'
                        % (_spent_tokens(run_id), _token_budget()))
            else:
                step_started = time.monotonic()
                step_id = store.start_step(
                    run_id, start_idx + 1, 'revise',
                    json.dumps({'title': draft['title'],
                                'chars': len(draft['contentMd']),
                                'dropped': len(dropped)}, ensure_ascii=False))

                status, error, note = yield from _pump(
                    prompts.messages_revise(draft['title'], draft['contentMd'], report),
                    'revise', chain_started, step_started, parts, usage, run_id)

                text = prompts.clean_output(''.join(parts))
                if status == 'done' and not prompts.looks_like_markdown(text):
                    status = 'failed'
                    error = ('修订那一轮返回的内容剥掉包装后不像一篇 Markdown 文章，'
                             '已丢弃，编辑区里还是上一轮的稿子。可以直接重试。')
                    text = ''
                elif status == 'done':
                    # 有东西交回去才算修订成功。一个字都没吐出来时 revised 为
                    # False——那时把空文本交出去只会把编辑区清空，不如让用户手里
                    # 留着上一轮那份完整的稿子。
                    revised = bool(text)
                else:
                    # 取消 / 单步超时 / 整条链超时：这一轮只是「改掉几处」，
                    # 半截的修订稿不如上一轮那份完整的稿子。所以编辑区保持不动
                    # （revised=False、text 回退成进来的原文），只把话说明白。
                    revised = False
                    text = draft['contentMd']
                    note = note or '这一轮修订没有跑完，编辑区里保留的是上一轮的稿子。'
        finished = True
    except llm.LLMError as err:
        status = 'failed'
        error = str(err)
        text = ''
        revised = False
        finished = True
    finally:
        # 走到这里可能是：正常收尾、超时 break、上游报错、或者用户关页
        # （生成器被 close() → GeneratorExit 在这里穿过）。
        if not finished:
            status = 'canceled'
            error = '页面关闭或已取消'
            text = ''
            revised = False
        # 收尾原因写进库里：失败用 error，被停（取消/单步超时/整条链超时）用 note。
        # 两者都要落，否则 /agent/runs/<id> 只看到一个光秃秃的 canceled，
        # 排查时分不清是超时、预算用尽还是用户点了取消。note 只可能是一句人话，
        # 长度可控，放 error 列（TEXT）合适。
        stop_note = error or (note if status == 'canceled' else None)
        # run 的 token 是**跨轮累加**的（第二轮会再调一次这里），见 store.finish_run。
        store.finish_run(
            run_id, status,
            tokens_in=usage.get('prompt_tokens'),
            tokens_out=usage.get('completion_tokens'),
            error=stop_note)
        if step_id is not None:
            # output_text 传空（默认 None → NULL）：这一步产出的是正文，
            # 而正文只有 /agent/save 一条落库路径（见 store.py 文件头）。
            store.finish_step(
                step_id, status,
                tokens_in=usage.get('prompt_tokens'),
                tokens_out=usage.get('completion_tokens'),
                latency_ms=int((time.monotonic() - step_started) * 1000),
                error=stop_note)
        try:
            RUN_LOCK.release()
        except RuntimeError:
            # 理论上不会发生（只在 polish() 里 acquire 一次）。真发生了也不该
            # 让它盖掉上面真正的错误，所以吞掉并继续。
            pass
        # 收尾时清掉取消标记。用 pop 而不是置 False：这条 run 已经结束了，
        # 留着标记只会在字典里越积越多（见 CANCEL_REQUESTED 的说明）。
        CANCEL_REQUESTED.pop(run_id, None)

    kind = 'polish' if dropped is None else 'revise'
    if status == 'failed':
        yield {'step': kind, 'done': True, 'ok': False, 'runId': run_id, 'error': error}
        return

    payload = {
        'step': kind, 'done': True, 'ok': True, 'runId': run_id,
        'text': text,
        'chars': len(text),
        'truncated': status == 'canceled',
        'note': note,
        'tokensIn': usage.get('prompt_tokens'),
        'tokensOut': usage.get('completion_tokens')
    }
    if dropped is not None:
        # revised 决定前端要不要拿这份 text 覆盖编辑区：第二轮有可能
        # 只是「检查了一下，什么都没改」（revised=false、text 与进来时一样）。
        payload['revised'] = revised
        payload['droppedCount'] = len(dropped)
    yield payload


def _polish(body):
    """POST /agent/polish  {docId?, title, contentMd, runId?, dropped?}
       → 200 {'stream': <生成器>, 'runId': n}，由 serve.py 写成 text/event-stream。

    请求体两种形状（PLAN-II.md §8.2 与 §9）：
      · 不带 runId/dropped  → 第一轮润色，开一条新 run；
      · 带 runId 与 dropped → 第二轮续跑，接在同一条 run 上。

    校验失败 / 没配 Key / 已有 run 在跑 → 返回普通 JSON 错误，一个字节的流都还没写。
    这是有意的：只要开始写流，HTTP 状态码就已经发出去了，那时再也无法用 4xx 表达失败。
    """
    draft, err = _draft(body)
    if err:
        return err

    dropped, err = _dropped(body)
    if err:
        return err

    if not llm.key_configured():
        return 503, {'ok': False,
                     'error': '后端没有配置 DeepSeek API Key，润色不可用。'
                              '在 agent/config.json 里填 apiKey 后重启 serve.cmd 即可；'
                              '不配置也不影响手动编辑与转格式。'}

    if not RUN_LOCK.acquire(blocking=False):
        return 409, {'ok': False,
                     'error': '已经有一次润色在跑了。等它结束，或先点「取消」。'}

    if dropped is None and body.get('runId') is None:
        # ---- 第一轮：开一条新 run
        try:
            base_version = store.latest_version_id(draft['docId'])
            run_id = store.start_run(
                draft['docId'], base_version, llm.model(), prompts.prompt_hash())
        except Exception as err2:
            RUN_LOCK.release()
            return 500, {'ok': False, 'error': '开不了这次润色：%s' % err2}
        CANCEL_REQUESTED[run_id] = False   # 新 run，取消标记从「没取消」开始
        return 200, {'stream': _polish_stream(draft, run_id), 'runId': run_id}

    # ---- 第二轮：接在已有 run 上。两个字段缺一不可，
    #      少了哪一个都会把「续到哪条链、为什么续」搞糊。
    run_id, err = _opt_int(body, 'runId')
    if err:
        RUN_LOCK.release()
        return err
    if run_id is None:
        RUN_LOCK.release()
        return _bad('带了 dropped 就必须带 runId（第二轮要接在哪条 run 上）')
    if dropped is None:
        RUN_LOCK.release()
        return _bad('带了 runId 就必须带 dropped（它是第二轮唯一的判据）')

    info = store.get_run(run_id)
    if info is None:
        RUN_LOCK.release()
        return 404, {'ok': False, 'error': 'run %r 不存在' % run_id}
    if info['status'] == 'running':
        # 第一轮的流还没收尾就在续跑：那不是「第二轮」，是同一轮重复发起。
        RUN_LOCK.release()
        return 409, {'ok': False, 'error': '这一次润色还在跑，等它结束再往下走。'}
    if any(step.get('kind') == 'revise' for step in store.list_steps(run_id)):
        # 「最多修订 1 轮」（§10）。第二轮之后再有人拿同一条 run 续跑，
        # 说明前端那套「round < 2」的判断出了问题。这里直接拒掉，
        # 而不是让它再花一次 token 去改一遍。
        RUN_LOCK.release()
        return 409, {'ok': False,
                     'error': '这一次润色已经修订过一轮了（上限 %d 轮），不再重复修订。'
                              % MAX_REVISE_ROUNDS}

    # 用 setdefault：万一「取消」在两条请求之间的空档里到达（那时流已经收尾、
    # 标记被 pop 掉了），这次续跑要能看见它，而不是用一个 False 把它盖掉。
    CANCEL_REQUESTED.setdefault(run_id, False)
    start_idx = store.max_step_idx(run_id) + 1
    return 200, {'stream': _polish_stream(draft, run_id, start_idx, dropped), 'runId': run_id}


def _cancel(body):
    """POST /agent/cancel  {runId} → {ok, runId, status[, alreadyFinished]}

    B3 把「断连」换成一次显式请求（PLAN-II.md §8.3）。两条路都存在：
      · 断连：前端 abort / 关页，serve.py 察觉后把生成器 close()；
      · 本接口：置一个标记，正在读流的主循环下一帧就自己停下。
    两者落到**同一段收尾代码**（_polish_stream 的 finally），所以行为一致——
    这是刻意的，不能因为多了一条路就多出一处「取消但没释放锁」的角落。

    它**不等**流真的收尾就返回：收尾要等上游把当前那一块吐完（通常不到一秒），
    在这里同步等会把 HTTP 请求挂住。前端拿到的 status 是「请求这一刻」的状态。
    """
    run_id, err = _opt_int(body, 'runId')
    if err:
        return err
    if run_id is None:
        return _bad('缺参数 runId（要取消哪一次润色）')

    info = store.get_run(run_id)
    if info is None:
        return 404, {'ok': False, 'error': 'run %r 不存在' % run_id}

    if info['status'] != 'running':
        # 已经收尾过了。这不是错误——前端很可能与收尾擦肩而过（它发出取消时
        # 流刚跑完）。回它的终态，让前端按终态收场，而不是弹一个「取消失败」。
        return 200, {'ok': True, 'runId': run_id, 'status': info['status'],
                     'alreadyFinished': True}

    CANCEL_REQUESTED[run_id] = True
    return 200, {'ok': True, 'runId': run_id, 'status': 'running'}


# ------------------------------------------------------------------ 分发

def route(method, path, query, body):
    """
    返回 (status, payload)；路径不归这里管时返回 None，由 serve.py 落回它自己的规则。
    query 是 urlsplit 之后 parse_qs 的结果（值是列表）。
    body 只有 POST 才有，且一定是 dict 或 None。

    payload 里带 'stream' 键时，serve.py 会切成 SSE 模式而不是回 JSON——
    这是「这个接口不回 JSON」唯一需要 serve.py 知道的事。
    """
    if path == '/agent/save' and method == 'POST':
        return _save(body)
    if path == '/agent/versions' and method == 'GET':
        return _versions(query)
    if path == '/agent/version' and method == 'GET':
        return _version(query)
    if path == '/agent/polish' and method == 'POST':
        return _polish(body)
    if path == '/agent/cancel' and method == 'POST':
        return _cancel(body)
    if path == '/agent/runs' and method == 'GET':
        return _runs(query)
    # /agent/runs/<id>：这里把 <id> 从路径里切出来再交给同一个处理器去校验，
    # 而不是自己写一套解析——它和 ?id= 走的是同一段代码，也就不会出现
    # 「查询串形式校验得住、路径形式绕过校验」这类只在其中一条路上发生的漏洞。
    if path.startswith('/agent/runs/') and method == 'GET':
        return _run_detail({'id': [path[len('/agent/runs/'):]]})
    return None
