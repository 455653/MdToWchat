# -*- coding: utf-8 -*-
"""
store.py —— 版本仓库的持久化层（二期 P6）

为什么是 SQLite 而不是 MySQL：见 PLAN-II.md 11.6。核心只有一句——
需求是「单机、单用户、几百行文本的版本历史」，SQLite 是标准库自带，
不引入任何安装门槛，与项目「零安装」的调性一致。

这个文件是全项目唯一写 SQL 的地方。routes.py 负责校验形状，这里负责落盘；
HTTP 头、JSON 序列化这些一概不碰。这样分开的意义是：真到了要换存储的那天，
重写这一个文件就够了。

三个必须照做的细节（PLAN-II.md §7「SQLite 的四个坑」）：
  1. journal_mode=WAL —— 否则「读」会阻塞「写」。手机端 800ms 一次轮询预览时，
     保存会偶发卡住，且是间歇性的，最难查。
  2. foreign_keys=ON —— SQLite **默认关闭**外键约束，不开等于没写 REFERENCES。
  3. 写操作串行化 —— SQLite 只允许一个写者。ThreadingHTTPServer 是每请求一个线程，
     不串行会得到偶发的 "database is locked"。
   第四个坑（不要跨线程复用连接）用「每个操作开一条独立连接」绕开：
   连接是廉价的，连接池在这个量级上只会多出一处出错的地方。

两个刻意不做的动作（PLAN-II.md §7 与 11.1）：
  · 不为「只留两版」物理删除历史。那会在用户第四次回溯时报一个莫名其妙的
    「版本不存在」；想省空间应该是软删 + 定期清理。
  · 不产生 origin='rollback'。回退是前端动作，要留下痕迹仍走一次 save，
    那时它的 origin 就是 manual。

一条贯穿全库的规则（agent_steps 落地时补上）：
  **正文只有一条落库路径——/agent/save。**
  agent_runs / agent_steps 是**过程**记录，一开跑就写、不受保存按钮约束；
  但它们也不许顺手把正文存下来，否则「没点保存就没有这一版」就成了空话
  （用户会在库里找到一份他从没认可过的稿子）。所以 agent_steps.output_text
  只放中间产物（分析、大纲、兼容性报告），'polish' / 'draft' / 'revise' 这类
  「产出就是正文」的步骤，output_text 一律为 NULL。
"""

import os
import sqlite3
import threading
from datetime import datetime

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
DB_PATH = os.path.join(DATA_DIR, 'mw.db')

# 全局写锁。见文件头第 3 条：这是「偶发 database is locked」的唯一解。
WRITE_LOCK = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
  id                 INTEGER PRIMARY KEY,
  title              TEXT NOT NULL,
  current_version_id INTEGER,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
  id         INTEGER PRIMARY KEY,
  doc_id     INTEGER NOT NULL REFERENCES documents(id),
  seq        INTEGER NOT NULL,
  content_md TEXT NOT NULL,
  origin     TEXT NOT NULL,
  run_id     INTEGER,
  parent_id  INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (doc_id, seq)
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id                INTEGER PRIMARY KEY,
  doc_id            INTEGER REFERENCES documents(id),
  base_version_id   INTEGER,
  result_version_id INTEGER,
  status            TEXT NOT NULL,
  model             TEXT,
  prompt_hash       TEXT,
  tokens_in         INTEGER,
  tokens_out        INTEGER,
  error             TEXT,
  created_at        TEXT NOT NULL,
  finished_at       TEXT
);

CREATE TABLE IF NOT EXISTS agent_steps (
  id              INTEGER PRIMARY KEY,
  run_id          INTEGER NOT NULL REFERENCES agent_runs(id),
  idx             INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL,
  input_json      TEXT,
  output_text     TEXT,
  tool_calls_json TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  latency_ms      INTEGER,
  error           TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (run_id, idx)
);
"""


def now_text():
    """时间戳统一用本地时间的 ISO 形式，和响应里给前端的格式一致。"""
    return datetime.now().strftime('%Y-%m-%dT%H:%M:%S')


def connect():
    """每个操作一条独立连接。见文件头「第四个坑」。"""
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    return conn


def init():
    """建表。serve.py 启动时调一次；语句都带 IF NOT EXISTS，重复调用无害。"""
    with WRITE_LOCK:
        conn = connect()
        try:
            conn.executescript(SCHEMA)
            conn.commit()
        finally:
            conn.close()


def save_version(doc_id, title, content_md, origin, run_id=None):
    """
    落一版。返回 {docId, version:{id, seq, createdAt}}。

    doc_id 为 None 就是「这台库里还没有这篇文档」——首次保存，
    此刻才第一次建 document 并写 seq=1。这正是「上传本身不发请求、
    第一次点保存才有版本 1」的落点（PLAN-II.md §8.1）。

    连点两次「保存」时靠 UNIQUE(doc_id, seq) 兜住撞号，而不是靠前端防抖（§7）。
    写锁已经把并发收成串行，所以这里读 max(seq) 再 +1 是安全的。

    run_id（P7）：这一版正文来自哪次润色。只有「第一次保存且正文是 AI 润色结果」
    才会带上它——润色本身不写库（版本口径见 PLAN-II.md §7 与 11.1），
    所以 run 与 version 的关联只能在保存这一刻补上（result_version_id）。
    """
    stamp = now_text()
    with WRITE_LOCK:
        conn = connect()
        try:
            cur = conn.cursor()

            if doc_id is None:
                cur.execute(
                    'INSERT INTO documents (title, current_version_id, created_at, updated_at)'
                    ' VALUES (?, NULL, ?, ?)',
                    (title, stamp, stamp))
                doc_id = cur.lastrowid
            else:
                exists = cur.execute(
                    'SELECT id FROM documents WHERE id = ?', (doc_id,)).fetchone()
                if exists is None:
                    raise ValueError('文档 %r 不存在' % doc_id)

            top = cur.execute(
                'SELECT COALESCE(MAX(seq), 0) AS m FROM versions WHERE doc_id = ?',
                (doc_id,)).fetchone()
            seq = int(top['m']) + 1

            parent = cur.execute(
                'SELECT id FROM versions WHERE doc_id = ? ORDER BY seq DESC LIMIT 1',
                (doc_id,)).fetchone()
            parent_id = parent['id'] if parent else None

            cur.execute(
                'INSERT INTO versions'
                ' (doc_id, seq, content_md, origin, run_id, parent_id, created_at)'
                ' VALUES (?, ?, ?, ?, ?, ?, ?)',
                (doc_id, seq, content_md, origin, run_id, parent_id, stamp))
            version_id = cur.lastrowid

            cur.execute(
                'UPDATE documents SET current_version_id = ?, updated_at = ?, title = ?'
                ' WHERE id = ?',
                (version_id, stamp, title, doc_id))

            if run_id is not None:
                # COALESCE：润色发生在第一次保存之前时，run 的 doc_id 还是空的
                # （那时还没有文档），在这一刻补上。
                cur.execute(
                    'UPDATE agent_runs SET result_version_id = ?,'
                    ' doc_id = COALESCE(doc_id, ?) WHERE id = ?',
                    (version_id, doc_id, run_id))

            conn.commit()

            return {
                'docId': doc_id,
                'version': {'id': version_id, 'seq': seq, 'createdAt': stamp}
            }
        finally:
            conn.close()


def list_versions(doc_id):
    """
    列表只回元数据，正文按需单取（PLAN-II.md §8.1）。
    几十条版本乘每条几 KB，回全量会把响应撑大十倍——
    与 src/sync.js 里「rev 没变就只回一个 unchanged」是同一思路。
    """
    conn = connect()
    try:
        doc = conn.execute(
            'SELECT id, title, current_version_id FROM documents WHERE id = ?',
            (doc_id,)).fetchone()
        if doc is None:
            return {'doc': None, 'versions': []}

        rows = conn.execute(
            'SELECT id, seq, origin, length(content_md) AS chars, created_at'
            ' FROM versions WHERE doc_id = ? ORDER BY seq ASC',
            (doc_id,)).fetchall()

        return {
            'doc': {
                'id': doc['id'],
                'title': doc['title'],
                'currentVersionId': doc['current_version_id']
            },
            'versions': [{
                'id': r['id'],
                'seq': r['seq'],
                'origin': r['origin'],
                'chars': r['chars'],
                'createdAt': r['created_at']
            } for r in rows]
        }
    finally:
        conn.close()


def get_version(version_id):
    """单取一版正文。找不到返回 None，由 routes 翻成 404。"""
    conn = connect()
    try:
        row = conn.execute(
            'SELECT id, seq, content_md, origin, created_at FROM versions WHERE id = ?',
            (version_id,)).fetchone()
        if row is None:
            return None
        return {
            'id': row['id'],
            'seq': row['seq'],
            'contentMd': row['content_md'],
            'origin': row['origin'],
            'createdAt': row['created_at']
        }
    finally:
        conn.close()


def latest_version_id(doc_id):
    """这篇文档最近一版的 id，没有则 None。润色时记进 agent_runs.base_version_id——
    有了它，才能回答「这一版是在哪一版的基础上润出来的」。"""
    if doc_id is None:
        return None
    conn = connect()
    try:
        row = conn.execute(
            'SELECT id FROM versions WHERE doc_id = ? ORDER BY seq DESC LIMIT 1',
            (doc_id,)).fetchone()
        return row['id'] if row else None
    finally:
        conn.close()


# ------------------------------------------------------------------ 润色 run

def start_run(doc_id, base_version_id, model_name, prompt_hash):
    """开一条润色记录，返回 run_id。

    与 versions 的关键区别：run 是**过程**记录，落库时机不受「保存」约束——
    它记的是「跑过一次润色、跑成什么样」，不是用户认可的正文版本。
    所以它一开跑就写，结束时更新状态（PLAN-II.md §7）。
    """
    with WRITE_LOCK:
        conn = connect()
        try:
            cur = conn.execute(
                'INSERT INTO agent_runs'
                ' (doc_id, base_version_id, status, model, prompt_hash, created_at)'
                ' VALUES (?, ?, ?, ?, ?, ?)',
                (doc_id, base_version_id, 'running', model_name, prompt_hash, now_text()))
            conn.commit()
            return cur.lastrowid
        finally:
            conn.close()


def finish_run(run_id, status, tokens_in=None, tokens_out=None, error=None):
    """收尾一条 run。status 取 running / done / failed / canceled（PLAN-II.md §7）。

    刻意只更新状态与用量，不动 result_version_id——那个要等用户点「保存」
    才由 save_version 补上。见文件头「版本口径」。

    **token 是累加而不是覆盖**（B2 起）：一条 run 会跨两次 HTTP 请求
    （第一轮 polish、第二轮 check+revise，中间隔着前端算 dropped 的那一下），
    每轮结束各调一次这里，所以 run 的用量应当是各轮之和。
    `CASE WHEN ? IS NULL` 把「这一轮没有拿到 usage」与「真的用了 0 个 token」
    分开：前者保持原值不动，后者照常累加。这样单轮路径的行为与 P7 完全一致
    （NULL + 有值 = 有值；NULL + NULL = NULL），B1 的那几条断言不受影响。
    """
    with WRITE_LOCK:
        conn = connect()
        try:
            conn.execute(
                'UPDATE agent_runs SET status = ?,'
                ' tokens_in = CASE WHEN ? IS NULL THEN tokens_in'
                '                 ELSE COALESCE(tokens_in, 0) + ? END,'
                ' tokens_out = CASE WHEN ? IS NULL THEN tokens_out'
                '                  ELSE COALESCE(tokens_out, 0) + ? END,'
                ' error = ?, finished_at = ? WHERE id = ?',
                (status, tokens_in, tokens_in, tokens_out, tokens_out,
                 error, now_text(), run_id))
            conn.commit()
        finally:
            conn.close()


def _run_fields(row):
    """agent_runs 的一行 → 响应对象（camelCase）。

    列表和详情共用这一份：同一条 run 在两个接口里字段拼法不同的话，
    前端就得为「同一个东西」写两套取值逻辑，而这类分叉通常要等到线上才被发现。
    """
    return {
        'id': row['id'],
        'docId': row['doc_id'],
        'baseVersionId': row['base_version_id'],
        'resultVersionId': row['result_version_id'],
        'status': row['status'],
        'model': row['model'],
        'promptHash': row['prompt_hash'],
        'tokensIn': row['tokens_in'],
        'tokensOut': row['tokens_out'],
        'error': row['error'],
        'createdAt': row['created_at'],
        'finishedAt': row['finished_at']
    }


def get_run(run_id):
    """读一条 run。给排查用（「这一版是哪次润色产出的」「那次为什么失败」）。
    找不到返回 None，由 routes 翻成 404。"""
    conn = connect()
    try:
        row = conn.execute('SELECT * FROM agent_runs WHERE id = ?', (run_id,)).fetchone()
        return _run_fields(row) if row else None
    finally:
        conn.close()


# ------------------------------------------------------------------ 多轮步骤

def start_step(run_id, idx, kind, input_json=None):
    """开一步，返回 step_id。

    §7 说「agent_steps 是调试 agentic 的唯一手段」——没有它，跑歪了只能盯着
    最终文章猜是哪一步坏的。所以它和 run 一样是**过程**记录：一开跑就写，
    收尾时更新状态。

    idx 从 0 开始，同一 run 内唯一（UNIQUE(run_id, idx)）：它同时是「步骤顺序」
    和「断点在哪」——要接着跑时，取 max(idx) 就知道从第几步续。
    """
    with WRITE_LOCK:
        conn = connect()
        try:
            cur = conn.execute(
                'INSERT INTO agent_steps (run_id, idx, kind, status, input_json, created_at)'
                ' VALUES (?, ?, ?, ?, ?, ?)',
                (run_id, idx, kind, 'running', input_json, now_text()))
            conn.commit()
            return cur.lastrowid
        finally:
            conn.close()


def finish_step(step_id, status, output_text=None, tool_calls_json=None,
                tokens_in=None, tokens_out=None, latency_ms=None, error=None):
    """收尾一步。status 取 running / done / failed / canceled。

    **output_text 只放中间产物，绝不放正文**（见文件头「正文只有一条落库路径」）。
    所以 'polish' 与将来的 'draft'/'revise' 这三类「产出就是正文」的步骤，
    output_text 一律为 NULL，只留 tokens 与耗时。
    """
    with WRITE_LOCK:
        conn = connect()
        try:
            conn.execute(
                'UPDATE agent_steps SET status = ?, output_text = ?, tool_calls_json = ?,'
                ' tokens_in = ?, tokens_out = ?, latency_ms = ?, error = ? WHERE id = ?',
                (status, output_text, tool_calls_json, tokens_in, tokens_out,
                 latency_ms, error, step_id))
            conn.commit()
        finally:
            conn.close()


def max_step_idx(run_id):
    """这条 run 已经写到最后一步的 idx；一步都没有时返回 -1。

    B2 的第二轮要靠它接上编号（polish=0 → check=1 → revise=2），
    B3 的「断点续跑」也要靠它（取它 +1 就知道从第几步接着跑）。
    写一条 SQL 而不是「查 len(list_steps())」：后者要把所有步骤的正文
    都读出来数个数，而这里只关心编号。
    """
    conn = connect()
    try:
        row = conn.execute(
            'SELECT COALESCE(MAX(idx), -1) AS m FROM agent_steps WHERE run_id = ?',
            (run_id,)).fetchone()
        return int(row['m'])
    finally:
        conn.close()


def list_runs(doc_id=None, limit=20):
    """run 列表，最新的在前。

    只回元数据、不回 steps（与 versions 列表「不回正文」同一思路）：
    一次多轮 run 的 steps 可能有几十 KB，列表接口被它撑大之后，
    「我刚刚那次润色怎么了」这个最常用的查询反而变慢。
    """
    conn = connect()
    try:
        sql = ('SELECT id, doc_id, base_version_id, result_version_id, status, model,'
               ' prompt_hash, tokens_in, tokens_out, error, created_at, finished_at'
               ' FROM agent_runs')
        args = []
        if doc_id is not None:
            sql += ' WHERE doc_id = ?'
            args.append(doc_id)
        sql += ' ORDER BY id DESC LIMIT ?'
        args.append(limit)
        rows = conn.execute(sql, args).fetchall()

        counts = dict(conn.execute(
            'SELECT run_id, COUNT(*) FROM agent_steps GROUP BY run_id').fetchall())

        runs = []
        for r in rows:
            item = _run_fields(r)
            item['stepCount'] = counts.get(r['id'], 0)
            runs.append(item)
        return runs
    finally:
        conn.close()


def list_steps(run_id):
    """一条 run 的全部步骤，按 idx 升序。"""
    conn = connect()
    try:
        rows = conn.execute(
            'SELECT idx, kind, status, input_json, output_text, tool_calls_json,'
            ' tokens_in, tokens_out, latency_ms, error, created_at'
            ' FROM agent_steps WHERE run_id = ? ORDER BY idx ASC',
            (run_id,)).fetchall()
        return [{
            'idx': r['idx'],
            'kind': r['kind'],
            'status': r['status'],
            'inputJson': r['input_json'],
            'outputText': r['output_text'],
            'toolCallsJson': r['tool_calls_json'],
            'tokensIn': r['tokens_in'],
            'tokensOut': r['tokens_out'],
            'latencyMs': r['latency_ms'],
            'error': r['error'],
            'createdAt': r['created_at']
        } for r in rows]
    finally:
        conn.close()
