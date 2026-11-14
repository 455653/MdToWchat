# -*- coding: utf-8 -*-
"""
serve.py —— 局域网真机预览服务（由 serve.cmd 双击调用）

为什么不是一句 `python -m http.server 8000`：
P3 的真机预览要做到「电脑上改一个字，手机 1 秒内看到变化」。
localStorage 是「每台设备 + 每个浏览器」各自独立的，手机浏览器读不到电脑上那份
mw.doc，所以必须有一个两台设备都能访问的中间点。http.server 只会发静态文件，
没有任何接收内容的入口，于是这里在它之上加了两个多出来的路由：

  GET  /sync[?rev=N]   手机端每 800ms 拉一次。带上 rev 且没变时只回一个
                       {rev:N, unchanged:true}，不把整篇文档重发一遍；
                       rev 变了才回 {doc, name, theme}，手机端据此重渲染。
  POST /sync           电脑端每次落盘后把 {rev, doc, name, theme} 发上来。

二期 P6 起还多了一组 /agent/*（文章版本仓库），由同目录的 agent/routes.py 处理。
本文件只做转发：把路径、查询串、JSON 体递过去，拿回 (状态码, 对象) 就写出去。
它和 /sync 一样带「不需要也能不要」的性质——agent/ 目录删掉只是这组接口消失，
预览、复制、/sync 一字不受影响（PLAN-II.md 第 2 节）。

其余路径一律按本目录下的静态文件处理，行为和 http.server 一致。
/sync 的内容只放在内存里：关掉窗口服务就结束了，磁盘上不会留下任何同步文件，
也不存在「关了窗口还在后台跑」的情况。
/agent/* 则是唯一会写磁盘的东西，落在同目录 agent/data/mw.db（SQLite）；
不点保存就不写库，删掉这个文件即清空版本历史。

为什么所有中文都在这个文件里，而不是放进 serve.cmd：
  cmd.exe 是按「字节偏移」跟踪批处理文件读到哪了的。serve.cmd 里一旦出现
  中文（多字节字符），文件里再执行 chcp 65001，cmd 就会拿新代码页去重新解释
  这个偏移，从而跳到一个错误的位置，后面的语句全部不执行。
  它的表现是「双击后黑窗口一闪就没了」——因为它根本走不到最后那个 pause。
  所以 serve.cmd 被刻意保持为「纯 ASCII + CRLF 换行」，一行中文都没有；
  而 Python 3.6+ 在 Windows 控制台本来就是直连 Unicode 输出，中文放这里没问题。
  改动 serve.cmd 时请守住这两条，别把中文注释补回去。

只看不动的两条底线：
  · 这个文件不做任何「信任输入」的假设，收到的东西先校验类型再落进内存；
  · 出错要看得见：POST 内容不合法时返回 400 与一句中文原因，而不是静默丢弃。
"""

import json
import os
import socket
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

# /agent/* 的后端。特意裹在 try 里：agent/ 被删掉时 serve.py 仍然要能起，
# 只是这组接口消失——「后端是可选的」这条约束，对 serve.py 自己也成立。
try:
    from agent import routes as agent_routes
    from agent import store as agent_store
except Exception as err:  # 只在 agent/ 缺失或损坏时触发
    agent_routes = None
    agent_store = None
    print('[提示] agent 后端未加载（%s）；/agent/* 不可用，/sync 与静态文件不受影响。' % err)

DEFAULT_PORT = 8000
# serve.py 和 index.html 在同一层目录：静态服务的根就是脚本所在目录
ROOT = os.path.dirname(os.path.abspath(__file__))

# 同步内容。rev 由电脑端（它的 mw.rev）给出，手机端靠它判断「要不要重渲染」
STORE = {'rev': 0, 'doc': '', 'name': '', 'theme': None}
LOCK = threading.Lock()

# 缓存一次本机地址：开机后网卡不会变，没必要每个请求都算一遍
LAN_CACHE = {'ip': None}


def lan_ip():
    """取本机在局域网里的 IPv4；取不到返回 127.0.0.1。

    为什么要用 UDP socket 的 connect，而不是解析 ipconfig：
    装了 VMware / VirtualBox 的机器会多出好几张虚拟网卡，ipconfig 的输出里
    192.168.56.1（VirtualBox 宿主网络）经常排在真实网卡前面。按文本顺序
    取第一张，手机就连不上——这正是「手机打不开」最常见的成因。
    这里的 connect 不真的发包：UDP 的 connect 只让系统按默认路由表挑一张网卡。
    """
    if LAN_CACHE['ip']:
        return LAN_CACHE['ip']

    for target in (('8.8.8.8', 80), ('1.1.1.1', 80), ('223.5.5.5', 80)):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.settimeout(0.5)
            sock.connect(target)
            ip = sock.getsockname()[0]
            if ip and not ip.startswith('127.'):
                LAN_CACHE['ip'] = ip
                return ip
        except OSError:
            # 没有默认路由的探测点就换下一个；三个都不行才回退
            pass
        finally:
            sock.close()

    LAN_CACHE['ip'] = '127.0.0.1'
    return LAN_CACHE['ip']


def lan_url(port):
    """手机要打开的地址。必须带 ?mode=preview：只读页没有工具栏，是唯一适合全选复制的页面。"""
    return 'http://%s:%d/?mode=preview' % (lan_ip(), port)


class Handler(SimpleHTTPRequestHandler):
    # 默认是 HTTP/1.0，每次请求都要新建 TCP 连接；手机端 800ms 轮询一次，
    # 走 1.1 的长连接能明显减少连接开销。
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, **kwargs):
        kwargs['directory'] = ROOT
        super().__init__(*args, **kwargs)

    # ------------------------------------------------------------------ 工具

    def end_headers(self):
        # 允许跨源读响应：电脑端可能是 file:// 打开的（Origin: null），
        # 它要往 127.0.0.1:8000 推内容、读回局域网地址，没有这个头会被浏览器拦掉。
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        # 轮询内容绝对不能缓存：缓存一次就永远看不到新内容
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def snapshot(self, include_body):
        with LOCK:
            data = {
                'rev': STORE['rev'],
                'unchanged': not include_body,
                'lan': lan_url(self.server.server_port)
            }
            if include_body:
                data['doc'] = STORE['doc']
                data['name'] = STORE['name']
                data['theme'] = STORE['theme']
            return data

    def dispatch_agent(self, method, parts, body=None):
        """把 /agent/* 交给 agent/routes.py。返回 True 表示已经写过响应。

        route() 对「路径不在它表里」回 None——这时本方法回 False，
        调用方落回自己的规则（GET 走静态文件、POST 回 404），
        这样 /agent/ 下多一个没实现的路径不会被当成静态文件去 404 得莫名其妙。

        payload 里带 'stream' 键（只有 /agent/polish 成功时如此）就走 SSE。
        这是 routes.py 与 HTTP 层之间唯一的一条特殊约定：它说明「这个接口不回 JSON」。
        """
        if agent_routes is None:
            return False
        got = agent_routes.route(method, parts.path, parse_qs(parts.query), body)
        if got is None:
            return False
        status, payload = got
        if isinstance(payload, dict) and payload.get('stream') is not None:
            self.stream_events(payload['stream'], status)
        else:
            self.send_json(payload, status)
        return True

    def stream_events(self, events, status=200):
        """把一串事件写成 text/event-stream（PLAN-II.md §8.2）。

        为什么不用 chunked 编码（PLAN-II.md §12 第 1 条）：
          本处理器是 HTTP/1.1。上面有 end_headers() 会给每个响应加几个头，
          但它不加 Content-Length 也不加 Transfer-Encoding——那种情况下
          客户端会一直等下去（它不知道正文到哪儿算完）。两条出路里选了
          「Connection: close」：连接关闭本身就是结束信号，一行都不用自己算分块。
          代价是每次润色一条新连接，而润色本来就不是高频操作。

        为什么每条都要 flush：
          wfile 在 Python 3 里是无缓冲的，但 flush 是「不依赖那个实现细节」的写法——
          这一段的全部意义就是「逐段可见」，被任何一层缓冲攒住都会退化成最后一次性出现。
        """
        self.close_connection = True
        self.send_response(status)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Connection', 'close')
        # 万一将来被套在 nginx 之类后面，这一行让它也别攒着
        self.send_header('X-Accel-Buffering', 'no')
        self.end_headers()

        try:
            for event in events:
                frame = 'data: ' + json.dumps(event, ensure_ascii=False) + '\n\n'
                self.wfile.write(frame.encode('utf-8'))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            # 用户关页或点了「取消」：连接已经没了，这里只需安静退出。
            # 真正要紧的收尾（把 run 标成 canceled、释放全局锁）在生成器的
            # finally 里，下面这句 close() 就是去触发它。
            pass
        finally:
            close = getattr(events, 'close', None)
            if close is not None:
                close()

    # ------------------------------------------------------------------ 路由

    def do_OPTIONS(self):
        # 简单请求（text/plain）本来不触发预检，但浏览器对「file:// → 本机地址」
        # 这类私有网络请求会先发预检，回一个 204 让整条路都通。
        self.send_response(204)
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.end_headers()

    def do_GET(self):
        parts = urlsplit(self.path)
        # /agent/* 先试；不在它的表里再落回 /sync 与静态文件
        if parts.path.startswith('/agent/') and self.dispatch_agent('GET', parts):
            return
        if parts.path != '/sync':
            return super().do_GET()

        want = parse_qs(parts.query).get('rev', [None])[0]
        # 只有「编号能对上」才算没变。手机端第一次来（不带 rev）必然拿到全文。
        unchanged = want is not None and want.lstrip('-').isdigit() and int(want) == STORE['rev']
        self.send_json(self.snapshot(include_body=not unchanged))

    def do_POST(self):
        parts = urlsplit(self.path)
        is_agent = parts.path.startswith('/agent/')
        if not is_agent and parts.path != '/sync':
            self.send_json({'ok': False, 'error': '只有 /sync 与 /agent/* 接受 POST'}, 404)
            return

        raw_length = self.headers.get('Content-Length')
        try:
            length = int(raw_length or 0)
        except ValueError:
            self.send_json({'ok': False, 'error': 'Content-Length 不是数字：%r' % raw_length}, 400)
            return

        raw = self.rfile.read(length) if length > 0 else b''
        try:
            data = json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, ValueError) as err:
            self.send_json({'ok': False, 'error': '内容不是合法 JSON：%s' % err}, 400)
            return
        if not isinstance(data, dict):
            self.send_json({'ok': False, 'error': '内容必须是 JSON 对象'}, 400)
            return

        if is_agent:
            # 体已经拆成 dict 了；/agent/ 下没登记的路径才回 404
            if not self.dispatch_agent('POST', parts, data):
                self.send_json({'ok': False, 'error': '未知的 /agent 接口：%s' % parts.path}, 404)
            return

        with LOCK:
            if isinstance(data.get('rev'), int):
                STORE['rev'] = data['rev']
            if isinstance(data.get('doc'), str):
                STORE['doc'] = data['doc']
            if isinstance(data.get('name'), str):
                STORE['name'] = data['name']
            if isinstance(data.get('theme'), dict):
                STORE['theme'] = data['theme']

        self.send_json({'ok': True, 'rev': STORE['rev'], 'lan': lan_url(self.server.server_port)})

    # ------------------------------------------------------------------ 日志

    def log_message(self, fmt, *args):
        # /sync 每 800ms 来一次，打出来会把控制台刷满，真正有用的启动信息反而被顶走。
        if '/sync' in (fmt % args):
            return
        super().log_message(fmt, *args)


def main():
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        raw = sys.argv[1].strip()
        if raw.isdigit():
            port = int(raw)
        else:
            # 端口参数写错就明说，而不是默默用 8000 起一个和预期不符的服务
            print('[提示] 端口参数 %r 不是数字，改用默认端口 %d' % (raw, port))

    ip = lan_ip()
    mobile = lan_url(port)

    # 版本仓库：建表是幂等的，起服务时顺手做一次；失败只影响 /agent/*，
    # 预览与 /sync 照常——「后端可选」不因为一个建表失败就整体打不开。
    store_ready = False
    if agent_routes is not None:
        try:
            agent_routes.init()
            store_ready = True
        except Exception as err:
            print('  [注意] 版本仓库初始化失败：%s' % err)
            print('         文章版本功能不可用；预览与 /sync 不受影响。')

    print('')
    print('  MdWeChat 局域网预览已启动')
    print('  本机访问   : http://localhost:%d/' % port)
    print('  手机预览   : %s' % mobile)
    if store_ready:
        print('  版本仓库   : %s' % agent_store.DB_PATH)
    elif agent_routes is None:
        print('  版本仓库   : 未启用（agent/ 未加载）')

    # AI 润色是不是能用，这里要如实说，而且要说清 Key 是从哪读到的。
    # 理由：改过 agent/config.json 却没生效时，用户唯一能自己排查的线索就是这一行——
    # 只写「已启用」，他会以为新 Key 已经生效，然后拿着 401 一路找错方向。
    if agent_routes is not None:
        try:
            from agent import llm as agent_llm
            source = agent_llm.key_source()
            if source:
                print('  AI 润色    : 已启用（模型 %s，Key 来自 %s）'
                      % (agent_llm.model(), source))
            else:
                print('  AI 润色    : 未配置 API Key（在 agent/config.json 里填 apiKey，'
                      '重启本服务生效；不配也能手动编辑与转格式）')
        except Exception as err:
            print('  AI 润色    : 未启用（%s）' % err)

    if ip == '127.0.0.1':
        print('  [注意] 没有取到局域网地址，只能在电脑本机看。')
        print('         请确认已连上 WiFi 或网线，并关掉会拦截网络的代理软件。')
    else:
        print('  手机和电脑要连同一个 WiFi，用手机相机或微信扫二维码即可打开。')
    print('')
    print('  按 Ctrl+C 停止服务；直接关掉本窗口也会停止，不会留下后台进程。')
    print('')

    server = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    # 0.0.0.0 才允许局域网内的设备访问；只绑 127.0.0.1 手机连不上
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('')
        print('  服务已停止。')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
