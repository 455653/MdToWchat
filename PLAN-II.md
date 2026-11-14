# MdWeChat 二期规划：Agent 层

在现有渲染器**旁边**加一个本机服务，做两件事：AI 把草稿润色成公众号文章、以及文章的版本回溯。

本文只是规划，**尚未动手**。一期的设计见 [PLAN.md](PLAN.md)。

## 1. 二期要补的闭环

一期解决的是「md → 能粘进公众号的富文本」。二期补上它的前半段：

| 步骤 | 用户动作 | 工具侧要解决的事 |
| --- | --- | --- |
| 1 | 提交草稿 `.md` | 收下原文，作为 `seq=1` 留底 |
| 2 | 让 AI 润色成公众号文章 | 多轮 agentic：分析 → 大纲 → 分段写 → 自检 → 修订 |
| 3 | 自己再改几遍 | 每次改动存一版，可回溯上两版 |
| 4 | 确认终稿 | 把终稿交给**一期已有的管线**，产物照旧 |
| 5 | 一键复制 | 一行不改，走的还是 `clipboard.js` |

第 5 步是一期已经做完的东西。**二期的价值全部在第 1–4 步，且第 4 步不需要任何新代码**——终稿最终落进 `applyText()`，那是一期就定好的「内容变了」唯一入口。

## 2. 与一期的关系：两条约束改写

一期有六条硬约束（见 PLAN.md 第 3 节），其中第 1 条（纯前端、双击即用）与第 3 条（禁止用 `fetch` 读本地文件）会被二期触碰。

**不偷偷破，改为明文两条：**

> **渲染器永远纯前端。** `index.html` 及其 `src/` 不因二期引入任何对后端的依赖：后端不在时功能一字不减、照样双击即用。Agent 能力是可选增强。
>
> **后端不许成为必需。** `serve.cmd` 没开时，所有 `/agent/*` 入口降级为一句提示，不阻塞编辑、预览、复制中的任何一项。

这两条不是「放宽」，是**把二期范围划清楚**。一期第 3 条本来就已经为局域网同步开过一个口子（`src/sync.js` → `serve.py` 的 `/sync`），二期是接在同一个口子上，不是新开一个。

**二期不动一期的任何交付物：** `vendor/`、`pipeline.js`、`media.js`、`inline-styles.js`、`sanitize.js`、`whitelist.js`、`compat-rules.js`、`fixtures/`、`test/assert.html` 一个字符都不改。

## 3. 已定决策

| 议题 | 决定 | 理由摘要 |
| --- | --- | --- |
| 后端放在哪 | **长在 `serve.py` 旁边**（同一进程加 `/agent/*`） | 一次双击全都有；与 `/sync` 共用 CORS、端口、启动提示 |
| 版本历史存哪 | **SQLite** | 标准库自带、零安装、单文件；单用户单机场景够用 |
| Agent 粒度 | **多轮 agentic**（分析 → 大纲 → 分段 → 自检 → 修订） | 质量上限最高，且能把「微信兼容自检」做成一个环节 |
| 模型 | **DeepSeek API** | 中文写作质量与价格合适；接口兼容 OpenAI 格式；国内直连 |
| pip 依赖 | **零依赖**：只有「写正文」那一轮流式，工具轮不流式 | 既保住零安装，又绕开最容易写错的「流式 tool_calls 分片拼接」 |

## 4. 形态边界：三份形态，只持久化中间那份

| 形态 | 谁产生 | 存哪 |
| --- | --- | --- |
| 草稿 md | 用户 | 只作为 `seq=1` 留底，不单独建模 |
| **文章 md**（AI 润色 + 人工编辑） | AI / 用户 | **SQLite，版本化**——二期唯一要持久化的东西 |
| 产物 HTML | 一期 `pipeline.build()` | **不存**，见 11.3 |

## 5. 架构总览

```
┌──────────────────────────────┐        ┌────────────────────────────┐
│ 浏览器（file:// 或 局域网）      │        │ serve.py（一个 Python 进程） │
│                              │        │                            │
│ index.html                   │  HTTP  │  /sync        ← 一期已有    │
│  src/panels/history.js  ─────┼───────►│  /agent/*     ← 二期新增    │
│  src/agent-client.js         │        │                            │
│                              │        │  agent/store.py → SQLite   │
│ 一期管线（pipeline/media/…）   │        │  agent/llm.py   → DeepSeek │
│  ↑ 终稿从版本面板灌进来，一行不改 │        │  agent/runner.py（多轮循环）│
└──────────────────────────────┘        └────────────────────────────┘
```

两个关键约定：

- **真源分工写死。** `localStorage.mw.doc` 是**编辑态**真源，`versions` 表是**历史态**真源。只有显式动作（点「润色」或「存入历史」）才同步，**不要每次按键都 POST**——那会把版本历史刷成一堆碎片。
- **缺后端不报错。** 前端复用 `src/sync.js` 的 `findBase()`；探测不到服务时按一期 `noteFail()` 的态度处理：一次会话提示一次，随后静默维持现状。

## 6. 目录与文件

```
agent/
  __init__.py        空
  store.py           SQLite 连接、schema、四张表 CRUD。唯一碰 SQL 的文件
  routes.py          /agent/* 的处理函数（收 dict → 返回 dict，不下业务判断）
  llm.py             DeepSeek 客户端：urllib + 手写 SSE 解析（P7）
  runner.py          多轮循环状态机。唯一有「过程」的文件（P8）
  tools.py           工具实现，核心是 check_wechat_compat（P8）
  prompts.py         提示词 + compat-rules 的翻译表（P7）
  data/mw.db         SQLite 文件（加进 .gitignore）
```

| 文件 | 阶段 | 状态 |
| --- | --- | --- |
| `agent/store.py`、`agent/routes.py`、`agent/__init__.py` | P6 | 新建 |
| `src/panels/history.js`、`src/agent-client.js` | P6 | 新建 |
| `serve.py` | P6 | 改约 20 行：把 `/agent/` 前缀转发给 `routes.py`，`/sync` 逻辑不动 |
| `index.html` | P6 | 改约 3 行：面板挂载点 + 一个 `<script>` |
| `PLAN.md` | P6 | 追加第 2 节那两条约束改写 |
| `agent/llm.py`、`agent/prompts.py` | P7 | 新建 |
| `agent/runner.py`、`agent/tools.py` | P8 | 新建 |

## 7. 数据模型

```sql
documents (
  id                 INTEGER PRIMARY KEY,
  title              TEXT NOT NULL,
  current_version_id INTEGER,          -- 指向当前版本
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
)

versions (
  id         INTEGER PRIMARY KEY,
  doc_id     INTEGER NOT NULL REFERENCES documents(id),
  seq        INTEGER NOT NULL,          -- 同一文档内递增，从 1 开始
  content_md TEXT NOT NULL,
  origin     TEXT NOT NULL,             -- import | ai_polish | manual | rollback
  run_id     INTEGER,                   -- 本版由哪次 agent 运行产出（P7 起用）
  parent_id  INTEGER,                   -- 派生链：编辑链、回退链
  created_at TEXT NOT NULL,
  UNIQUE (doc_id, seq)
)

agent_runs (                            -- P7 起用
  id, doc_id, base_version_id, result_version_id,
  status TEXT,                          -- running | done | failed | canceled
  model TEXT, prompt_hash TEXT,         -- 提示词也要版本化
  tokens_in INTEGER, tokens_out INTEGER,
  error TEXT, created_at TEXT, finished_at TEXT
)

agent_steps (                           -- P8 起用
  id, run_id, idx, kind TEXT,           -- analyze | outline | draft | check | revise
  input_json TEXT, output_text TEXT, tool_calls_json TEXT,
  tokens_in INTEGER, tokens_out INTEGER, latency_ms INTEGER, created_at TEXT
)
```

三个非显然的点：

- **`agent_steps` 是调试 agentic 的唯一手段。** 没有它，Agent 跑歪了只能盯着最终文章猜。有了它才能一眼看出「第 3 步大纲就偏了，后面全跟着偏」。
- **`prompt_hash` 必须存。** 一次运行要调十几次模型，改一次提示词效果全变；不记 hash，质量回退时无法归因。
- **`UNIQUE(doc_id, seq)` 是最后一道保险。** 连点两次「保存」时靠它兜住撞号，而不是靠前端防抖。

### SQLite 的四个坑

1. `PRAGMA journal_mode=WAL`——否则「读」会阻塞「写」，手机端 800ms 轮询预览时保存会偶发卡住。
2. `PRAGMA foreign_keys=ON`——SQLite **默认关闭外键约束**，不开等于没写 `REFERENCES`。
3. **写操作必须串行化**（一个全局锁）。SQLite 只允许一个写者，`ThreadingHTTPServer` 下不串行会得到 `database is locked`，且是偶发的，最难查。
4. 每个请求用独立连接（或 `check_same_thread=False` + 自建锁），不要把连接跨线程复用。

## 8. 接口契约

### 8.1 P6：版本仓库（不含 AI）

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| POST | `/agent/save` | `{docId?, title, contentMd, origin}` | `{docId, version:{id, seq, createdAt}}` |
| GET | `/agent/versions?docId=` | — | `{doc:{id,title,currentVersionId}, versions:[…]}` |
| GET | `/agent/version?id=` | — | `{id, seq, contentMd, origin, createdAt}` |
| POST | `/agent/rollback` | `{versionId}` | `{docId, version:{id, seq, origin:'rollback'}}` |

```json
// GET /agent/versions 里每条只回元数据，正文按需单取
{ "id": 12, "seq": 3, "origin": "rollback", "chars": 1840, "createdAt": "2026-11-13T10:22:31" }
```

`/agent/save` 的 `docId` 可空：首次保存时后端自建 document（`seq=1`，`origin='import'`）。

**列表刻意不回正文**：几十条版本、每条几 KB，回全量会把响应撑大十倍。这与 `src/sync.js` 里「rev 没变就只回一个 `unchanged`」是同一思路——该省的地方省。

### 8.2 P7：润色（流式）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/agent/polish` | 请求体同 `save`，响应 `text/event-stream`，逐段推 `{step, delta}`，结束推 `{runId, versionId}` |

用 `fetch` + `ReadableStream` 手动解析 SSE，**不用 `EventSource`**——后者不支持 POST，而润色请求体可能很大。

### 8.3 P8：运行管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/agent/runs?docId=` | 运行历史（含 `agent_steps` 摘要） |
| POST | `/agent/cancel` | `{runId}`，runner 在每步之间检查 `status` |

## 9. Agent 循环与工具集

```
1 analyze   读原稿 → 题材 / 目标读者 / 必须保留的骨架
2 outline   产出公众号结构大纲          ──┐
3 draft     按大纲逐段生成（可并行）      ├─ 这三步不流式
4 check     调 check_wechat_compat(md)  ──┘
5 revise    只重写有问题的段落           ← 只有这一步流式
```

工具只有三个，**刻意不加联网搜索**（见 11.7）：

| 工具 | 作用 | Token 成本 |
| --- | --- | --- |
| `check_wechat_compat(md)` | 本地跑 `pipeline.build()`，返回 `dropped` / 占位图数 / 表格列数 | **零** |
| `save_draft(md)` | 落库为中间版本 | 零 |
| `get_reference_version(seq)` | 读历史版本 | 零 |

## 10. 工程护栏

- **预算上限**：最多修订 2 轮、总 token 上限、总时长上限。超限就停下，把当前最好的一版交给用户并说明「还差什么」。绝不能无限循环。
- **可中断**：每步之间检查 `status`，`cancel` 后干净收尾，不留下 `running` 状态的僵尸 run。
- **同时只允许一个 run**：`ThreadingHTTPServer` 每请求一个线程，跑几分钟会占线程；并发还会让 SQLite 写锁打架、被上游限流。用全局标志拦住，冲突时回 409。
- **中途失败不从头再来**：每步都落 `agent_steps`，断网或额度用尽后能接着跑。

## 11. 关键决策

### 11.1 为什么回退是「新增一版」而不是「移动指针」

回退到旧版时，不 `UPDATE current_version_id` 指回去，而是拿旧内容生成 `seq+1` 的新行（`origin='rollback'`）。三个后果：

1. 历史 append-only，永不被改写——**回退这个动作本身还能再回退**。连按两次「上一版」，能回到回退前的状态。
2. `UNIQUE(doc_id, seq)` 让并发写不会撞号。
3. 「上两版」就是 `ORDER BY seq DESC LIMIT 3` 取后两条，是纯查询，不需要任何清理逻辑。

配套的一条：**不要为了「只留两版」去物理删除**。那会在用户第四次回溯时报一个莫名其妙的「版本不存在」。想省空间就软删 + 定期清理（保留每篇最近 N 版 + 所有 `origin='ai_polish'` 的节点）。

### 11.2 为什么要把 compat-rules 内化进提示词

`src/compat-rules.js` 那张规则表一期是**给降级器用的**。二期应该同时**给模型看**：表格列数上限、禁 flex/grid/position、禁三层以上嵌套引用、外链一律失效、SVG/WebP 不支持。

如果模型产出「漂亮但过不了」的 md，降级器会把文章拆得面目全非。要的是**一开始就别写出需要降级的东西**。这张表是项目里独有、别处拿不到的资产。

### 11.3 为什么只持久化 md，不持久化产物 HTML

产物 HTML 由 md + 主题**确定性算出**，存它等于存冗余；且它的体积比 md 大一个量级（内联样式 + 图片 data URI 全在里面）。真要复现某一版的产物，用那一版 md 重跑一次 `pipeline.build()` 即可，成本是毫秒级。

反过来说，这也意味着**版本表里只有纯文本**——这正是 SQLite 能胜任的原因。

### 11.4 为什么工具轮不流式

「流式 + tool calling」要求按 index 拼接分片的 `arguments` JSON，是整套实现里最容易写错、最难调的一段（出错表现是「偶尔工具参数是半截 JSON」）。而工具轮用户看不见也不需要看见。

所以只让**写正文那一轮流式**：工具调用于是永远拿到完整的 JSON 响应。手写量从约两百行降到几十行，零依赖保住了，且没有牺牲任何用户可见的体验。

### 11.5 为什么后端不许成为必需

一期的立身之本是「双击即用、离线、数据不出本机」。如果二期让 `index.html` 变得必须连着后端才能用，等于用「润色」这个新功能毁掉「渲染」这个老价值。

所以后端是**可选增强**：探测不到就降级，编辑、预览、复制照常。这条不只是体验问题，它是二期的验收项之一（见 14.1 第 5 条）。

### 11.6 为什么选 SQLite 而不是 MySQL

需求要的是「回溯上两版」，本质是**单机、单用户、几百行文本**的版本历史。SQLite 完全够用，且是标准库自带——**不引入任何安装门槛**，与项目「零安装」的调性一致。

MySQL 的优势（多用户、并发写、远端访问）在这个场景里都用不到，而代价是：要装一个数据库服务、要 pip 装驱动、双击 `serve.cmd` 不再能自洽。**注意：即使选了 MySQL，驱动也是 pip 依赖**，那时「零依赖」这条就已经破了——这笔账要一起算。

被否决的第三条路「SQLite 起步 + 留好切换层」也放弃了：在没有第二个实现的情况下，抽象层是纯开销。等真要换时，`store.py` 单文件重写即可，代价可控。

### 11.7 为什么不给 Agent 联网搜索工具

公众号文章的润色不需要外部事实——它需要的是「把已有的内容重新组织得更好读」。加搜索只会引入两类坏结果：幻觉（把搜到的不相关内容缝进来）与延迟（多几轮网络往返）。

真正该给 Agent 的工具是 `check_wechat_compat`——它不查外面，它查**自己家管线的兼容性**，零 token 成本且完全确定。

### 11.8 为什么提示词要禁止模型编造图片链接

一期里图片只能靠用户手动「映射本地图片」进来（外链在 `file://` 下读不到像素，只能落占位图）。模型随手写 `![](https://…)` 就必然变成占位图，还得用户回头一张张映射。

所以提示词里要明确：**不要自行编造图片链接；需要配图处写 `<!-- 配图建议：… -->`**。

## 12. 已知陷阱（动手前先验的两件事）

1. **SSE 与 `protocol_version = 'HTTP/1.1'`。** `serve.py` 目前是 HTTP/1.1；HTTP/1.1 下不写 `Content-Length` 又不写 `Transfer-Encoding: chunked`，客户端会一直等下去。这条路由要么手动写 chunked，要么加 `Connection: close` 让连接关闭充当结束信号。**P7 第一步就要验通。**
2. **DeepSeek 哪个模型支持 function calling。** `deepseek-chat` 与 `deepseek-reasoner` 在 tools 上的支持程度不同。这条不要依赖转述——**P8 第一步用官方文档 + 一个最小请求实测**。选错了的现象是「工具调了但没反应」。

其余把握较大的坑：`serve.cmd` 必须保持「纯 ASCII + CRLF」（原因见 `serve.py` 文件头注释）；`send_json` 已带 `charset=utf-8`，中文与 emoji 链路无需另做。

## 13. 阶段划分

| 阶段 | 目标 | 关键交付 |
| --- | --- | --- |
| **P6** | 版本仓库 + 历史面板 | `serve.py` 加 `/agent/*`、SQLite 四张表、版本 CRUD、可回溯上两版。**零 AI** |
| **P7** | DeepSeek 接入 + 流式 + 单轮润色 | 提交草稿 → 得到文章 md → 落库为一版。此时已是可用产品 |
| **P8** | 五步 agentic + 三工具 + 预算与中断 | 质量上限；体检结果回灌修订 |

**P6 刻意不含 AI**，这样能把「版本回溯」与「模型质量」两个问题分开验收——AI 出问题时能确定底层是对的。

P6 还有一个隐性收益：版本仓库在 P7/P8 会立刻变成 Agent 的落地场所（`agent_runs.result_version_id` 指向的就是 P6 建好的 `versions` 表）。**先做 P6 不是绕路，是铺路。**

## 14. 验收标准

### 14.1 P6（八条，均可手工点验）

1. 双击 `serve.cmd` → 版本面板出现（路由通了）。
2. 存一版 → 改几个字 → 再存 → 列表 2 条，`seq` 为 1、2。
3. 点「回退到第 1 版」→ 列表变 3 条，第 3 版 `origin=rollback` 且正文等于第 1 版。
4. 再点「回退到第 2 版」→ 第 4 版正文等于第 2 版——**验证「回退这个动作本身还能再回退」**（11.1）。
5. **关掉 `serve.cmd`，直接双击 `index.html`** → 面板提示一句，编辑 / 预览 / 复制一字不减——**验证「后端不许成为必需」**（11.5）。
6. 关窗口再启动 → 数据还在（验证真落盘，不是 `serve.py` 里 `STORE` 那种内存态）。
7. 连点两次「保存」→ `seq` 不撞号。
8. 正文含中文 / emoji / 多空行 / 行尾空格 → 存回来逐字节一致。

### 14.2 P7

- 关停 `serve.cmd` 时 `/agent/polish` 如期降级，不卡界面。
- 流式输出逐段可见，中途关页不留僵尸 run。
- 产出 md 落库为一版，且 `run_id` 可追溯。
- 上游返回的 ` ```markdown ` 包裹与「好的，以下是…」前言被剥掉；剥完不像 md 时报错，**不静默写库**。

### 14.3 P8

- 五步循环的每一步都落 `agent_steps`，能从表里还原「为什么写成这样」。
- 触及预算上限时优雅停止并说明，不无限循环。
- `check_wechat_compat` 返回的 `dropped` / 占位图数确实驱动了下一轮修订（对比 `agent_steps` 的输入输出可见）。
- Agent 产出的 md 过一遍 `pipeline.build()`，`dropped` 为空或仅有预期项。

## 15. 明确不做

- **不做多用户 / 登录 / 权限。** 单机个人工具，加账号体系只会拖慢一切。
- **不做云端部署。** 数据留在本机是这个工具的卖点，上云等于把它换成另一个产品。
- **不在渲染器里加任何后端依赖。** 见第 2 节。
- **不存产物 HTML。** 见 11.3。
- **不给 Agent 联网搜索。** 见 11.7。
- **不做前端直连模型。** API Key 只能放后端——`file://` 页面里的 Key 等于公开，任何打开这个 html 的人都能看到。
- **不为了「只留两版」物理删除历史。** 见 11.1。

## 16. 待定问题

- **提示词的具体文本。** 需要把 `compat-rules.js` 的规则逐条翻译成约束，且要实测哪几条对模型有效——这是 P7 的主要工作量，也是最能拉开质量差距的地方。
- **分段生成的粒度。** 按大纲小节切，还是按目标字数切？取决于实测中模型对长上下文的保持程度。
- **`seq=1` 是否要留底。** 目前规划是留。若草稿较长而用户从不回溯到它，可以考虑不留以节省空间（不影响正确性，纯取舍）。
- **失败 run 的清理策略。** `status='failed'` 的 run 与它的 `agent_steps` 保留多久。
