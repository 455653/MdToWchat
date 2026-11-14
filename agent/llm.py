# -*- coding: utf-8 -*-
"""
llm.py —— DeepSeek 客户端（二期 P7）

零依赖：只用标准库 urllib 发请求，SSE 自己解析（PLAN-II.md §3）。
为什么不用 requests / openai 包：项目立身之本是「双击即用、零安装」，
为了一个流式调用去破坏它不划算。手写量确实多几十行，但都是能看懂的几十行。

API Key 从哪来（两处，按优先级）：
  1. 环境变量 DEEPSEEK_API_KEY；
  2. agent/config.json 里的 apiKey 字段。
为什么不是「写死在某个 py 文件里」：见 PLAN-II.md 15「不做前端直连模型」——
Key 只能在服务端。config.json 进了 .gitignore，仓库里不留 Key。

两个必须照做的细节（PLAN-II.md §12）：

  1. **分片边界。** 模型按 token 吐，一个 SSE 事件的 JSON 可能在任意字节处被切开，
     多字节中文尤其容易切在半个字上。所以这里做两件事：
       · 用增量解码器（incremental decoder）解 UTF-8，而不是每块单独 decode——后者
         会在半个汉字上抛 UnicodeDecodeError，或者更糟：解出一串乱码；
       · 按 '\n' 切行，但跨块的半行留在 buffer 里等下一块，绝不「切完就丢」。
     选错的表现就是「偶发出现乱码字」，而且是几十次里偶发一次，最难查。

  2. **HTTP 超时是「每次 socket 读」的超时，不是「整个请求」的超时。**
     流式响应下这个区别正好合用：只要上游还在吐字，就不算超时；
     真的卡住了才会抛。总时长上限不在这里管，在 routes.py（它才知道怎么把
     已经流出来的部分交还给用户）。
"""

import codecs
import json
import os
import urllib.error
import urllib.request

# DeepSeek 的 OpenAI 兼容端点。国内直连，不需要代理。
API_URL = 'https://api.deepseek.com/chat/completions'

# 配置文件名固定，且与 store.py 的 data/ 同一层（agent/）。
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')

# 默认模型与输出上限。8192 是 deepseek-chat 的输出上限：
# 一篇 3000 字的公众号文章大约 4500 token，留出余量才不会写到一半被截断。
DEFAULT_MODEL = 'deepseek-chat'
MAX_TOKENS = 8192

# 单次 socket 读的超时。模型偶尔会「想」几秒才吐第一个字，60s 足够宽松，
# 又能在真的断网时及时抛出来，而不是让用户看着转圈。
READ_TIMEOUT = 60

# 温度：改写任务不需要发挥，1.0 是官方对通用对话的推荐值。
TEMPERATURE = 1.0


class LLMError(Exception):
    """上游调用失败。message 是给用户看的中文，不含堆栈。"""


# ------------------------------------------------------------------ 配置

_config_cache = None


def config():
    """读 agent/config.json。读不到 / 坏了都返回空 dict——它只是可选配置，不是必需文件。"""
    global _config_cache
    if _config_cache is not None:
        return _config_cache
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as fp:
            data = json.load(fp)
        _config_cache = data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        _config_cache = {}
    return _config_cache


def api_key():
    """环境变量优先，其次 config.json。都没有返回空串。"""
    from_env = (os.environ.get('DEEPSEEK_API_KEY') or '').strip()
    if from_env:
        return from_env
    return str(config().get('apiKey') or '').strip()


def key_source():
    """Key 是从哪来的。启动提示要如实说，否则用户改了 config.json 却没生效会一直找不着原因。"""
    if (os.environ.get('DEEPSEEK_API_KEY') or '').strip():
        return '环境变量 DEEPSEEK_API_KEY'
    if str(config().get('apiKey') or '').strip():
        return CONFIG_PATH
    return None


def key_configured():
    return bool(api_key())


def model():
    return str(config().get('model') or '').strip() or DEFAULT_MODEL


# ------------------------------------------------------------------ SSE 解析

def _sse_events(buffer, chunk_text):
    """把新到的文本追加进 buffer，切出完整的 SSE 事件，返回 (事件列表, 剩余 buffer)。

    SSE 的帧分隔是空行（\n\n）。切的时候必须留着最后一段不完整的——
    那就是 PLAN-II.md §12 第 2 条说的「缓存半截 buffer」。
    """
    buffer += chunk_text
    events = []
    while True:
        # 兼容 \r\n：模型和中间层都可能用 CRLF 结尾
        head = buffer.find('\n\n')
        crlf = buffer.find('\r\n\r\n')
        if crlf >= 0 and (head < 0 or crlf < head):
            block, buffer = buffer[:crlf], buffer[crlf + 4:]
        elif head >= 0:
            block, buffer = buffer[:head], buffer[head + 2:]
        else:
            break

        data_lines = []
        for line in block.split('\n'):
            line = line.rstrip('\r')
            if not line or line.startswith(':'):
                continue          # 空行与注释（有些中间层会插 `: ping` 保活）
            if line.startswith('data:'):
                data_lines.append(line[5:].lstrip())
        if data_lines:
            events.append('\n'.join(data_lines))
    return events, buffer


def _extract(payload_text):
    """一条 SSE 的 data 载荷 → (delta 文本, usage 或 None, 是否结束)。"""
    if payload_text.strip() == '[DONE]':
        return '', None, True
    try:
        data = json.loads(payload_text)
    except ValueError:
        # 上游偶尔会插一些非 JSON 的行。跳过它比让整轮润色失败合理。
        return '', None, False

    usage = data.get('usage') if isinstance(data, dict) else None
    choices = (data or {}).get('choices') or []
    if not choices:
        return '', usage, False

    delta = choices[0].get('delta') or {}
    content = delta.get('content')
    text = content if isinstance(content, str) else ''
    return text, usage, False


def stream(messages, max_tokens=MAX_TOKENS, temperature=TEMPERATURE):
    """调用 DeepSeek 并逐段吐出正文。

    生成器，yield 两种字典：
      {'delta': '一段文字'}
      {'usage': {'prompt_tokens': n, 'completion_tokens': n}}   ← 只在最后出现

    失败一律抛 LLMError（带中文原因），调用方负责把它变成给用户看的一句话。
    """
    key = api_key()
    if not key:
        raise LLMError('没有配置 DeepSeek API Key。请在 agent/config.json 里填 apiKey，'
                       '或设置环境变量 DEEPSEEK_API_KEY。')

    payload = json.dumps({
        'model': model(),
        'messages': messages,
        'stream': True,
        # 让上游在最后一块里带上 token 用量，好写进 agent_runs（PLAN-II.md §7）。
        # 老版本网关不认这个字段时会直接忽略，属于安全降级。
        'stream_options': {'include_usage': True},
        'max_tokens': max_tokens,
        'temperature': temperature
    }).encode('utf-8')

    request = urllib.request.Request(
        API_URL,
        data=payload,
        method='POST',
        headers={
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': 'Bearer ' + key
        })

    try:
        response = urllib.request.urlopen(request, timeout=READ_TIMEOUT)
    except urllib.error.HTTPError as err:
        raise LLMError(_http_error_text(err))
    except urllib.error.URLError as err:
        raise LLMError('连不上 DeepSeek（%s）。请检查网络与代理设置。' % (err.reason,))
    except OSError as err:
        raise LLMError('请求 DeepSeek 失败：%s' % err)

    # 增量解码器：见文件头的第 1 条。errors='replace' 是有意的——
    # 万一上游真的吐了非法字节，宁可让那一个字变成替换符，也不该让整轮润色炸掉。
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    buffer = ''

    try:
        while True:
            try:
                chunk = response.read(2048)
            except OSError as err:
                raise LLMError('读取 DeepSeek 响应中断：%s' % err)
            if not chunk:
                break

            events, buffer = _sse_events(buffer, decoder.decode(chunk))
            for raw in events:
                text, usage, done = _extract(raw)
                if text:
                    yield {'delta': text}
                if usage:
                    yield {'usage': usage}
                if done:
                    return
    finally:
        response.close()


def _http_error_text(err):
    """把上游的 HTTP 错误翻成一句用户能看懂的话。

    401 是最常见的（Key 错/过期），单独说清楚——否则用户会以为是自己网络的问题。
    """
    body = ''
    try:
        body = err.read().decode('utf-8', 'replace')
    except Exception:
        pass

    detail = ''
    try:
        parsed = json.loads(body)
        if isinstance(parsed, dict):
            inner = parsed.get('error')
            if isinstance(inner, dict):
                detail = str(inner.get('message') or '')
            elif isinstance(inner, str):
                detail = inner
            detail = detail or str(parsed.get('message') or '')
    except ValueError:
        detail = body[:200].strip()

    if err.code == 401:
        head = 'DeepSeek 拒绝了这次的 API Key（401）。请确认 agent/config.json 里的 apiKey 是有效且未过期的。'
    elif err.code == 402:
        head = 'DeepSeek 账户余额不足（402）。'
    elif err.code == 429:
        head = 'DeepSeek 限流了（429），稍等一会儿再试。'
    elif err.code >= 500:
        head = 'DeepSeek 服务端出错（%d），通常是暂时的。' % err.code
    else:
        head = 'DeepSeek 返回了 %d。' % err.code

    return head + ('详情：' + detail if detail else '')
