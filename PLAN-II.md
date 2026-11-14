# MdWeChat 二期规划：Agent 层

在现有渲染器**旁边**加两样东西：一个可选的 AI 润色环节，和一个版本仓库。
加完之后，一篇稿子的完整链路是「上传 → 决定要不要润色 → 润色 / 手动编辑定稿 → 存下这份 md → 转成公众号格式 → 复制」。

本文是规划。二期主体（P6、P7、B1、B2、B3）均已交付并验收，见 §13；仅「完整五步 agentic」一项暂缓。一期的设计见 [PLAN.md](PLAN.md)。

> **修订记录**
> **第四次（二期收口）**
> ⑫ 二期整体端到端回归通过：快路径（`http` 与 `file://` 双击）直达④且不新增 `/agent` 请求；慢路径用真实 DeepSeek 跑完「润色 → 编辑区 → 保存落库为 `seq=1`/`origin='ai_polish'` → run 反向指认 → 多版回溯」；B3 六条护栏证据复读无误。阶段表补上 P6 / P7 / B1 的「已完成」标记；
> ⑬ §11.5 / §14.1 第 3 条 / §15 关于「快路径零 `/agent` 请求」的措辞改为准确描述——选「不需要」这个动作不产生请求，页面初始化时版本面板会发一次只读探测 `GET /agent/versions`（不算在本路径上，失败也不影响功能）。
>
> **第三次（B3 护栏落地）**
> ⑧ §8.3 的 `POST /agent/cancel` 从「暂缓」改为已交付（合同见该节）；
> ⑨ §9 / §10 / §13 的三条护栏标注完成：总 token 上限、最多修订 1 轮、单步超时、断点续跑；「总时长上限」从「一次润色」推广为「整条链」（跨两次 HTTP 请求换算，见 §10）；
> ⑩ §14.5 的 B3 验收点（预算用尽优雅停下）已可人工点验；
> ⑪ §14.5 六条已人工验收通过（真实 DeepSeek + 真实服务）。验收第 4 条时抓到并修复一个真 bug：`panels/polish.js` 的「取消」按钮在整轮润色期间恒为 disabled——`render()` 早于 `state.run` 赋值，改由 `send()` 在赋完 `state.run` 后立刻重画。
>
> **第二次（B 档落地）**
> ⑤ §9 从「本期只有一步」扩成「步骤链」：单轮润色之后可以再接一轮**兼容性修订**，且只在 `dropped` 非空时才走；`check_wechat_compat` 的落地方式定为 **(b) 前端算 + 回传**，兼容规则仍只有 `src/compat-rules.js` 一份；
> ⑥ 多轮拆成 B1/B2/B3 三步写进 §13；`agent_steps` 从「暂缓」转为已建（多两列 `status` / `error`，见 §7）；
> ⑦ §8.3 从「暂缓」改为「已提供两条只读接口」，`POST /agent/cancel` 仍留到 B3。
>
> **第一次（对照初版）**
> ① 按「上传 → 询问是否润色 → 编辑定稿 → 保存 md → 下一步转格式」重写了 §1、§3、§8 及之后各节；
> ② AI 范围从「多轮 agentic」收敛为**单轮流式润色**，多轮部分移入 §9 的暂缓小节；
> ③ 「要不要润色」改由顶部分步条承载，因此多出 `src/steps.js` 与 `src/panels/polish.js` 两个文件；
> ④ 版本口径明确为「进编辑区即版本 1，点保存才 +1」，配套地把回退改成前端动作（§7、§11.1、§8.1）。

## 1. 二期要补的闭环

一期解决的是「md → 能粘进公众号的富文本」。二期在它的**前面**插一段，并给出一个「不需要 AI」的出口：

```
                        上传 .md
                           │
                           ▼
               ┌───────────────────────┐
               │ 问一次：要不要 AI 润色？ │
               └──────┬────────┬───────┘
                 不需要 │        │ 需要
                           │        ▼
                           │   AI 单轮润色（流式）
                           │        │
                           │        ▼
                           │   继续手动编辑
                           │   版本以「保存」为准，可回溯上一步
                           │        │
                           │        ▼
                           │   保存这份「公众号 .md」
                           │        │
                           └────┬───┘
                                ▼
                      点「下一步」→ 一期管线
                                │
                                ▼
                        一键复制进公众号
```

| 步骤 | 用户动作 | 工具侧要解决的事 | 分步条 |
| --- | --- | --- | --- |
| 1 | 上传草稿 `.md` | 收下原文，进编辑区 | ① 导入 |
| 2 | 回答「要不要 AI 润色」 | 选「不需要」→ **直接跳到第 6 步** | ② 润色 |
| 3 | 选「需要」，看着它流式润色 | 后端调 DeepSeek，逐段把润色后的文章 md 推回来 | ② 润色 |
| 4 | 自己再改几遍 | 版本由「保存」锚定；可回溯到上一个已保存版本 | ③ 编辑定稿 |
| 5 | 点「保存这份 md」 | 存下一份公众号 md，并落库为一版 | ③ 编辑定稿 |
| 6 | 点「下一步」 | 定稿交给**一期已有的管线**，产物照旧 | ④ 转格式 |
| 7 | 一键复制 | 一行不改，走的还是 `clipboard.js` | ④ 转格式 |

三点值得单独说明：

- **第 2 步是一条真正的分叉，不是装饰。** 选「不需要」时整条链路退化成一期：纯前端、不连后端、不落库、上传即可预览即可复制。二期不许在快路径上留下任何后端痕迹（见 11.5）。
- **第 6 步不需要任何新代码。** 定稿最终落进一期的 `applyText()`——那是 P0 就定好的「内容变了」唯一入口。
- **分步条只有四格，流程却有七步。** 四格是给人看的粒度，七步是实现粒度，映射见右列。把七步全摆上分步条，用户每次都要重新数一遍自己在哪。

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
| 界面形态 | **顶部分步条**：① 导入 → ② 润色 → ③ 编辑定稿 → ④ 转格式 | 链路有分叉，一条步骤指示让用户随时知道「我在哪、下一步是什么」；每一格仍复用一期「左编辑 + 右预览」布局，不另做页面 |
| 版本口径 | **进编辑区即版本 1，点「保存」才 +1** | 与一期「不要每次按键都 POST」同源的延伸：按键产生的是编辑，保存产生的才是版本 |
| 「回溯上一步」 | **回到上一个已保存版本；纯前端动作，不落库** | 与上一条同源——回退只是又一次编辑，要成为版本仍得点保存。详见 11.1 |
| Agent 粒度 | **P7 只做单轮流式润色**；**B2 再加一轮「兼容性修订」**，且只在 `dropped` 非空时才走；完整五步 agentic 暂缓 | 先把「上传 → 润色 → 编辑 → 保存 → 转格式」整条链路跑通并验通 SSE；多轮留到链路稳定之后，且只接「针对确定问题」的那一步（见 §9） |
| 模型 | **DeepSeek API** | 中文写作质量与价格合适；接口兼容 OpenAI 格式；国内直连 |
| pip 依赖 | **零依赖**：只有「写正文」那一轮流式，工具轮不流式 | 既保住零安装，又绕开最容易写错的「流式 tool_calls 分片拼接」 |

## 4. 形态边界：三份形态，只持久化中间那份

| 形态 | 谁产生 | 存哪 |
| --- | --- | --- |
| 草稿 md | 用户 | 只作为「版本 1 的内容来源」，不单独建模 |
| **文章 md**（AI 润色 + 人工编辑） | AI / 用户 | **SQLite，版本化**——二期唯一要持久化的东西 |
| 产物 HTML | 一期 `pipeline.build()` | **不存**，见 11.3 |

第 5 步「保存这份 md」落下的就是第二行那份**文章 md**：一份存到本地磁盘（浏览器下载），一份（后端在时）落进 `versions` 表。

## 5. 架构总览

```
┌──────────────────────────────┐        ┌────────────────────────────┐
│ 浏览器（file:// 或 局域网）      │        │ serve.py（一个 Python 进程） │
│                              │        │                            │
│ index.html                   │  HTTP  │  /sync        ← 一期已有    │
│  src/steps.js        ← 分步条 │───────►│  /agent/*     ← 二期新增    │
│  src/panels/polish.js ← 润色  │        │                            │
│  src/panels/history.js ← 版本 │        │  agent/store.py → SQLite   │
│  src/agent-client.js          │        │  agent/llm.py   → DeepSeek │
│                              │        │                            │
│ 一期管线（pipeline/media/…）   │        │                            │
│  ↑ 定稿从第 6 步灌进来，一行不改 │        │                            │
└──────────────────────────────┘        └────────────────────────────┘
```

三个约定：

- **真源分工写死。** `localStorage.mw.doc` 是**编辑态**真源，`versions` 表是**历史态**真源。只有显式动作（点「保存」）才同步，**不要每次按键都 POST**——那会把版本历史刷成一堆碎片。
- **缺后端不报错。** 前端复用 `src/sync.js` 的 `findBase()`；探测不到服务时按一期 `noteFail()` 的态度处理：一次会话提示一次，随后静默维持现状。
- **分步条是唯一的状态机。** 「现在第几步」「能不能前进」只由 `src/steps.js` 回答，各面板不许自己判断。否则会出现「版本面板以为在第 3 步、分步条以为在第 2 步」这种错位——它不报错，只让用户一脸问号。

## 6. 目录与文件

```
agent/
  __init__.py        空
  store.py           SQLite 连接、schema、四张表的 CRUD（B1 起）。唯一碰 SQL 的文件
  routes.py          /agent/* 的处理函数（收 dict → 返回 dict，不下业务判断）
  llm.py             DeepSeek 客户端：urllib + 手写 SSE 解析（P7）
  prompts.py         提示词 + compat-rules 的翻译表（P7）
  data/mw.db         SQLite 文件（加进 .gitignore）
```

| 文件 | 阶段 | 状态 |
| --- | --- | --- |
| `src/steps.js` | P6 | 新建。分步条状态机，以及第 2 步「要不要润色」的询问 |
| `src/panels/history.js` | P6 | 新建。版本列表、保存、回溯上一步 |
| `src/agent-client.js` | P6 | 新建。后端探测与调用（沿用 `sync.js` 的 findBase 思路） |
| `agent/store.py`、`agent/routes.py`、`agent/__init__.py` | P6 | 新建 |
| `serve.py` | P6 | 改约 20 行：把 `/agent/` 前缀转发给 `routes.py`，`/sync` 逻辑不动 |
| `index.html` | P6 | 改约 8 行：分步条挂载点 + 两个面板 + 两个 `<script>`（都排在 app.js 之前） |
| `PLAN.md` | P6 | 追加第 2 节那两条约束改写 |
| `src/panels/polish.js` | P7 | 新建。润色进度与流式输出 |
| `agent/llm.py`、`agent/prompts.py` | P7 | 新建 |
| `agent/store.py`、`agent/routes.py` | B1 | 改：加 `agent_steps` 表与 `GET /agent/runs`、`GET /agent/runs/<id>`；单轮润色落一步 `kind='polish'` |
| `agent/runner.py`、`agent/tools.py` | 暂缓 | 原计划的五步循环与工具集。B 档走的是「前端算 + 回传」（见 §9），这两块暂时不必建 |

## 7. 数据模型

```sql
documents (
  id                 INTEGER PRIMARY KEY,
  title              TEXT NOT NULL,
  current_version_id INTEGER,          -- 最近一次保存的那一版
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
)

versions (
  id         INTEGER PRIMARY KEY,
  doc_id     INTEGER NOT NULL REFERENCES documents(id),
  seq        INTEGER NOT NULL,          -- 同一文档内递增，从 1 开始
  content_md TEXT NOT NULL,
  origin     TEXT NOT NULL,             -- import | ai_polish | manual | rollback
  run_id     INTEGER,                   -- 本版由哪次润色产出（P7 起用）
  parent_id  INTEGER,                   -- 派生链：编辑链、回退链
  created_at TEXT NOT NULL,
  UNIQUE (doc_id, seq)
)

agent_runs (                            -- P7 起用：一条 = 一次润色
  id, doc_id, base_version_id, result_version_id,
  status TEXT,                          -- running | done | failed | canceled
  model TEXT, prompt_hash TEXT,         -- 提示词也要版本化
  tokens_in INTEGER, tokens_out INTEGER,
  error TEXT, created_at TEXT, finished_at TEXT
)

agent_steps (                           -- B1 起用：一条 = 多轮里的一步
  id, run_id, idx, kind TEXT,           -- polish | analyze | outline | draft | check | revise
  status TEXT,                          -- running | done | failed | canceled
  input_json TEXT, output_text TEXT, tool_calls_json TEXT,
  tokens_in INTEGER, tokens_out INTEGER, latency_ms INTEGER,
  error TEXT, created_at TEXT,
  UNIQUE (run_id, idx)
)
```

`agent_steps` 比初版多两列：`status` 与 `error`。初版只能表达「这一步跑过」，加这两列才能表达「这一步跑到一半失败了」——而多轮里最常见的坏情况恰恰是「第 3 步坏了，前 2 步是好的」。`UNIQUE(run_id, idx)` 里那个 `idx` 兼作**步骤顺序**和**断点**：要接着跑时取 `max(idx)` 就知道从第几步续。

### 版本口径

这一节是本次修订新增的，实现时必须照它来，否则会做成「每改一个字就多一版」。

- 编辑区里始终有一个「当前版本号」。内容首次进编辑区时是 **1**。
- **只有点「保存」才写库。** 库里还没有这个文档 → 写 `seq=1`；已有 → `seq = max+1`。
- **只改不点保存，什么都不写，版本号也不动。** 这就是「不按保存始终为版本 1」。
- 第一次保存时，正文来自上传原文则 `origin='import'`，来自 AI 润色结果则 `origin='ai_polish'`；之后的保存一律 `manual`。
- `rollback` 这个枚举值**本期不产生**——回退是前端动作（见 11.1），要留下痕迹仍走 `/agent/save`。留着它只是为了将来若要「回退即成一版」不用改表。

三个非显然的点：

- **`agent_steps` 是调试 agentic 的唯一手段。** 没有它，Agent 跑歪了只能盯着最终文章猜。B1 已经把它建起来，并且让**单轮润色也落一步**——表得有数据才谈得上用，而真正的多轮（B2/B3）直接在它上面接着长。
- **`agent_steps` 里不许顺手存正文。** 它的 `output_text` 只放中间产物（分析、大纲、兼容性报告）；`polish` / `draft` / `revise` 这三类「产出就是正文」的步骤，`output_text` 一律为 NULL。否则「没点保存就没有这一版」就成了空话——用户会在库里找到一份他从没认可过的稿子。**正文只有一条落库路径：`/agent/save`。**
- **`prompt_hash` 必须存。** 调一次提示词效果可能全变；不记 hash，质量回退时无法归因。
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

```json
// GET /agent/versions 里每条只回元数据，正文按需单取
{ "id": 12, "seq": 3, "origin": "manual", "chars": 1840, "createdAt": "2026-11-13T10:22:31" }
```

`/agent/save` 的 `docId` 可空：首次保存时后端自建 document（`seq=1`）。**这正是「第一次点保存才有版本 1」的落点**——上传本身不发任何请求。

**不规划 `POST /agent/rollback`。** 回退在编辑区完成，要留下痕迹仍走 `/agent/save`。留一个「回退即写库」的接口，等于留一条绕过保存按钮偷偷写库的路，与 §7 的版本口径直接打架。

**列表刻意不回正文**：几十条版本、每条几 KB，回全量会把响应撑大十倍。这与 `src/sync.js` 里「rev 没变就只回一个 `unchanged`」是同一思路——该省的地方省。

### 8.2 P7：润色（流式）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/agent/polish` | 请求体 `{docId?, title, contentMd, runId?, dropped?}`；响应 `text/event-stream`。逐段推 `{step, delta}`，最后推一帧 `{step, done:true, ok, runId, text, chars, truncated, note}`（失败时是 `{done:true, ok:false, error}`） |

**两种请求形状（B2 起）。** 不带 `runId` / `dropped` ＝ 第一轮润色，开一条新 run；带齐这两个 ＝ 第二轮续跑，接在**同一条 run** 上（§9）。第二轮的末帧多两个字段：`revised`（这一轮到底改了没有）与 `droppedCount`，`step` 取 `'revise'`。一轮请求里能出现的只有 `{step:'polish'}` 或 `{step:'revise'}`（`check` 是零 token 的本地判定，不产生 delta）。三种错配一律在**开始写流之前**回普通 JSON：`dropped` 不是数组、或只带其中一个字段 → 400；`runId` 指向的 run 不存在 → 404；那条 run 还在 `running` → 409。

用 `fetch` + `ReadableStream` 手动解析 SSE，**不用 `EventSource`**——后者不支持 POST，而润色请求体可能很大。

三条实现约定：

- **流结束时只回 `runId`，正文不落库。** run 是**过程**记录（`agent_runs`，一开跑就写），而「落成一版」要等用户点「保存这份 md」（§7）。所以这一帧里**没有** `versionId`——那个 id 在用户保存之前根本不存在。用户若从头到尾没点保存，这一轮润色只会留下一条 `agent_runs`，`versions` 里一条都不会多。等用户真点了保存，`/agent/save` 带回的 `runId` 才把两件事接上。
- **最后一帧带清洗过的完整 `text`。** 中间的 delta 是上游原文，剥 ``` 围栏与开场白那一步在后端做（`prompts.clean_output`），前端不重写它。前端只要「以最后一帧为准」，就不存在「前端拼出来的正文和服务端认为的正文不一致」这类只在长文上偶现的问题。
- **流开始之后的失败不走 HTTP 状态码。** 只要开始写流，状态码就已经发出去了，再也改不了。所以「流还没开始」的三种失败回普通 JSON——校验失败 400、没配 Key 503、已有 run 在跑 409；流开始之后的失败用 `{done:true, ok:false, error}` 表达，前端两种情况按同一套代码处理。

### 8.3 运行管理

B1 起提供两条**只读**接口。它们是 `agent_steps` 的出口——§7 说这张表是调试 agentic 的唯一手段，而一张没有接口的表等于没有这个手段（调试时还是得开 `sqlite3` 敲 SQL）。

| 方法 | 路径 | 响应 |
| --- | --- | --- |
| GET | `/agent/runs?docId=&limit=` | `{runs:[{id, docId, baseVersionId, resultVersionId, status, model, promptHash, tokensIn, tokensOut, error, createdAt, finishedAt, stepCount}]}`，最新在前；`docId` 不传或 0 ＝ 不过滤，`limit` 缺省 20、上限 200 |
| GET | `/agent/runs/<id>` | `{run:{…同上但没有 stepCount…}, steps:[{idx, kind, status, inputJson, outputText, toolCallsJson, tokensIn, tokensOut, latencyMs, error, createdAt}]}`；该 run 不存在 → 404 |
| POST | `/agent/cancel` | 请求 `{runId}`；响应 `{ok, runId, status[, alreadyFinished]}` |

两条只读接口刻意的分工：

- **列表不带 `steps`。** 与 `versions` 列表不带正文是同一思路（§8.1）：一次多轮 run 的 steps 可能有几十 KB，被它撑大之后，「我刚刚那次润色怎么了」这个最常用的查询反而变慢。
- **详情里的 `outputText` 对 `polish` 恒为 `null`。** 见 §7：正文只有 `/agent/save` 一条落库路径。

**`POST /agent/cancel`（B3 交付）。** 这是一个写标记的接口：`routes.CANCEL_REQUESTED[runId] = True`（模块级 dict，单条读写是原子的），流主循环每帧查一次，命中就优雅收尾——和「断连」落到同一段 `finally`：run 与当前 step 一并落 `canceled`，已经流出来的部分照样交给用户。三条边界：缺 `runId` 或类型不对 → 400；`runId` 不存在 → 404；run 已经收尾（`status != 'running'`）→ 200 且带 `alreadyFinished: true`（不是错误——「我要它停」的结果就是「它停了」）。

它和「断连」是**并行而非替代**的两条路：abort 在「请求还没发出去」时也有效，但那时前端还不知道 `runId`（第一轮的 runId 要等末帧才回来）；`/agent/cancel` 需要 `runId`，但对「已经跨过第一轮、正在跑第二轮」的 run 更稳。前端两条路都留着（`MW.agent.polish()` 返回的 `cancel` 走 abort，`MW.agent.cancel(runId)` 走显式请求），点一次「取消」两个都发。

## 9. 步骤链

P7 交付的是最短的链，只有一步：

```
polish   读原稿 → 按公众号体裁重写一遍 → 流式返回全文
```

没有工具调用，没有多轮循环，没有中间态。**这是刻意的**：一次成形已经能覆盖「把技术草稿改成公众号文章」这个主场景，而它的实现里没有一段是难调的。

B2 在这条链后面再接一段，而且**只在第一段真有问题时才走**：

```
4 check    前端跑一遍 pipeline.build()，把 dropped 回传     ← 零 token
5 revise   只重写有问题的段落                              ← 流式
```

（沿用下面那套五步的名字，为的是同一个 `kind` 只有一种含义。）判据是 `dropped`——被降级器丢掉的节点——非空。

**B2 交付后实测的修正：`dropped` 在当前管线里恒为空，第二轮是一条保险丝，不是常规路径。** 拿真实管线跑了六类输入（原始 HTML、任务列表、mermaid、公式、脚注表格、语法错的 mermaid），`dropped` 全是空的。两个根因：解析器配的是 `html:false`（原始 HTML 被转义成纯文本，不会成为节点，更不会被删），mermaid 与公式都被栅格化成了 `<img>`（不残留 `<svg>`），任务列表的 `<input>` 也早被 `degradeTaskCheckboxes` 换成文字。这和 `sanitize.js` 自己的说法是一致的：那份 `DROP_TAGS` 是**防御性**的——防的是「某天某个 markdown-it 插件升级，产物里多出了新形态的节点」，不是日常会发生的事。所以「多数文章只跑一次往返」要更强地读成「**正常文章一次往返都不多跑**」，第二轮只在管线真的丢了东西时才会亮。验收这条链路的办法见 §14.4。

这两步也各落一条 `agent_steps`，而它们正好示范了 `output_text` 的分界：`check` 的产物是**兼容性报告**（中间产物，写 `output_text`），`revise` 的产物是**正文**（写 NULL，正文只走 `/agent/save`）。

**为什么 `check` 不是一次工具调用（(b) 前端算 + 回传）：** 原写法 `check_wechat_compat(md)` 得在 Python 侧跑 `pipeline.build()`，而管线在浏览器里。复刻一份 25 条规则等于让 `src/compat-rules.js` 有第二个副本，两边迟早漂——那张表是项目里独有、别处拿不到的资产（11.2）。所以改成**前端算、把 `dropped` 回传**：兼容规则仍只有一份，后端也不多一行 Python 侧管线代码。代价是多一次（且只在 `dropped` 非空时才有的）往返；换来的是 11.5「后端不许成为必需」没被破坏——算 `dropped` 的能力本来就在前端。

### B 档的三步

- **B1（已完成）** `agent_steps` 表 + run 读接口（§8.3）+ 单轮润色落一步。
- **B2（已完成）** `dropped` 回传通道；服务端据它决定要不要发起第二轮；第二轮 `revise` 仍流式。`check` / `revise` 各落一条 `agent_steps`，`finish_run` 的 token 改成跨轮累加，新增 `store.max_step_idx`（B3 断点续跑要靠它）。**触发率≈0，理由见上一节。**
- **B3（已完成）** 预算上限（最多修订 1 轮、总 token 上限）、单步超时、`POST /agent/cancel`，以及「中途失败不从头再来」（靠 `agent_steps.idx` 断点续跑）。落地情况见 §10。

### 暂缓：完整五步 agentic

原规划的五步循环整段保留在这里，等链路稳定后再开：

```
1 analyze   读原稿 → 题材 / 目标读者 / 必须保留的骨架
2 outline   产出公众号结构大纲          ──┐
3 draft     按大纲逐段生成（可并行）      ├─ 这三步不流式
4 check     调 check_wechat_compat(md)  ──┘
5 revise    只重写有问题的段落           ← 只有这一步流式
```

前三个（`analyze` / `outline` / `draft`）B 档不做：它们把「一次请求」拆成三次，多数文章换不来可感知的质量提升，却实打实地把成本与「跑歪的面」一起放大。B 档只接 `check` / `revise`——它们针对的是一个**确定**的问题（降级器确实会丢东西），而不是「也许还能写得更好」。

工具届时只有三个，**刻意不加联网搜索**（见 11.7）：

| 工具 | 作用 | Token 成本 |
| --- | --- | --- |
| `check_wechat_compat(md)` | 本地跑 `pipeline.build()`，返回 `dropped` / 占位图数 / 表格列数 | **零** |
| `save_draft(md)` | 落库为中间版本 | 零 |
| `get_reference_version(seq)` | 读历史版本 | 零 |

## 10. 工程护栏

本期（P7 + B1）只有单轮，护栏也只需三条：

- **可中断。** 用户关页或点取消后，run 要干净收尾，不留 `running` 状态的僵尸记录。
- **同时只允许一个 run。** `ThreadingHTTPServer` 每请求一个线程，跑几分钟会占线程；并发还会让 SQLite 写锁打架、被上游限流。用全局标志拦住，冲突时回 409。
- **总时长上限。** 超时就停，把**已经流出来的部分**交给用户并说明「还差什么」。绝不能出现「转圈转到天荒地老」。

B3 已补上后两条，并把第一条从「一次润色」推广成「整条链」：

- **总时长上限（`POLISH_MAX_SECONDS = 180`，管整条链）。** 难点是这条链**跨两次 HTTP 请求**，两次请求里的 `time.monotonic()` 没有共同基准。解法是拿 run 的 `created_at`（本地时间 ISO）换算成「这条 run 已经起跑了多久」，只比较**时长**、不比较**时刻**，所以两次请求之间隔多久都不影响结果；`created_at` 解析失败时退化为「从现在开始算」，宁可少算也不会误杀。第二轮开跑前还专门检查一次，否则第二轮能把第一轮那条护栏整个绕过去。
- **单步超时（`STEP_MAX_SECONDS = 120`）。** 证据落 `agent_steps.latency_ms`。检查点在流主循环每帧开头——上游是一块块回来的，只有逐帧看才停得下来。
- **总 token 上限（`POLISH_MAX_TOKENS = 24000`，可被 `agent/config.json` 的 `polishMaxTokens` 覆盖）。** 预算的检查点只能在「一轮开跑前」：上游的 usage 只在流的最后一块回来，流跑到一半时根本不知道已经花了多少。所以第二轮开跑前读一次 `_spent_tokens(run_id)`（第一轮的用量已由 `finish_run` 跨轮累加进去了）。用尽时不报错、不转圈，而是**优雅停下**——编辑区保留上一轮的完整稿子，只把原因说清楚。把 `polishMaxTokens` 调到很小，就能手工看到这一幕（§14.5）。
- **最多修订 1 轮（`MAX_REVISE_ROUNDS = 1`）。** 判据是 `store.list_steps` 里有没有 `kind='revise'`——已经有一轮修订的 run 再续跑直接回 409。这条拦住的是「前端把同一个 run 反复续跑」这种把 token 当柴烧的打法。
- **中途失败不从头再来。** 每一步都落 `agent_steps`；续跑时步骤序号由 `store.max_step_idx(run_id) + 1` 接上，而不是从 0 重来——所以重跑只会补上缺的那一步，前面跑过的不会重算、不会重复计费。

这五块的证据全部落在 `agent_steps`（`status` / `error` / `latency_ms` / `idx`），所以「那次润色为什么停在这里」永远有一条 SQL 能查出来，不必靠盯最终文章猜。

## 11. 关键决策

### 11.1 为什么「回溯上一步」是前端动作，而回退之后保存才成一版

把**回退**和**记录**拆开：回退只改编辑区内容（把上一个已保存版本的正文拉回来替换），要留下痕迹仍得点保存。

三个后果：

1. 用户只需要记一条规则：**保存按钮是唯一会写库的动作**。不用去分辨「这个动作算不算一版」。
2. 历史仍然 append-only：回退 + 保存 = 新增一版（内容是旧的，`seq` 是新的）。所以**「回退这个动作本身还能再回退」依然成立**——连按两次「回溯上一步」，能回到回退前的状态。
3. 「上两版」就是 `ORDER BY seq DESC LIMIT 3` 取后两条，是纯查询，不需要任何清理逻辑。

配套一条：**不要为了「只留两版」物理删除**。那会在用户第四次回溯时报一个莫名其妙的「版本不存在」。想省空间就软删 + 定期清理（保留每篇最近 N 版 + 所有 `origin='ai_polish'` 的节点）。

边界情况：一条都还没保存过时，「回溯上一步」回到**进入编辑区时的初始内容**，此时它的语义是「撤销这一轮编辑」。这份 baseline 只活在前端，不进库；按钮在「内容 == 上一保存版 / baseline」时禁用，而不是点了没反应。

### 11.2 为什么要把 compat-rules 内化进提示词

`src/compat-rules.js` 那张规则表一期是**给降级器用的**。二期应该同时**给模型看**：表格列数上限、禁 flex/grid/position、禁三层以上嵌套引用、外链一律失效、SVG/WebP 不支持。

如果模型产出「漂亮但过不了」的 md，降级器会把文章拆得面目全非。要的是**一开始就别写出需要降级的东西**。这张表是项目里独有、别处拿不到的资产。

单轮润色比多轮更需要这一条：只有一次机会，写歪了没有下一轮来救。

### 11.3 为什么只持久化 md，不持久化产物 HTML

产物 HTML 由 md + 主题**确定性算出**，存它等于存冗余；且它的体积比 md 大一个量级（内联样式 + 图片 data URI 全在里面）。真要复现某一版的产物，用那一版 md 重跑一次 `pipeline.build()` 即可，成本是毫秒级。

反过来说，这也意味着**版本表里只有纯文本**——这正是 SQLite 能胜任的原因。

### 11.4 为什么工具轮不流式

本期没有工具轮，这条验收推迟；但它届时依然成立，所以先写在这里。

「流式 + tool calling」要求按 index 拼接分片的 `arguments` JSON，是整套实现里最容易写错、最难调的一段（出错表现是「偶尔工具参数是半截 JSON」）。而工具轮用户看不见也不需要看见。

所以只让**写正文那一轮流式**：工具调用于是永远拿到完整的 JSON 响应。手写量从约两百行降到几十行，零依赖保住了，且没有牺牲任何用户可见的体验。

### 11.5 为什么后端不许成为必需

一期的立身之本是「双击即用、离线、数据不出本机」。如果二期让 `index.html` 变得必须连着后端才能用，等于用「润色」这个新功能毁掉「渲染」这个老价值。

所以后端是**可选增强**：探测不到就降级，编辑、预览、复制照常。这条不只是体验问题，它是二期的验收项之一（见 14.1 第 9 条）。

第 2 步选「不需要」的那条快路径，是这条约束最硬的一次检验：**选「不需要」这个动作从头到尾不产生一个 `/agent/*` 请求**。另有一个容易误判的点：页面初始化时版本面板会发一次只读探测 `GET /agent/versions`（用于显示「已连接 / 未连接」），它不随快路径增减，且失败也不影响任何功能——它是可用性显示，不是依赖。

### 11.6 为什么选 SQLite 而不是 MySQL

需求要的是「回溯上两版」，本质是**单机、单用户、几百行文本**的版本历史。SQLite 完全够用，且是标准库自带——**不引入任何安装门槛**，与项目「零安装」的调性一致。

MySQL 的优势（多用户、并发写、远端访问）在这个场景里都用不到，而代价是：要装一个数据库服务、要 pip 装驱动、双击 `serve.cmd` 不再能自洽。**注意：即使选了 MySQL，驱动也是 pip 依赖**，那时「零依赖」这条就已经破了——这笔账要一起算。

被否决的第三条路「SQLite 起步 + 留好切换层」也放弃了：在没有第二个实现的情况下，抽象层是纯开销。等真要换时，`store.py` 单文件重写即可，代价可控。

### 11.7 为什么不给 Agent 联网搜索工具

公众号文章的润色不需要外部事实——它需要的是「把已有的内容重新组织得更好读」。加搜索只会引入两类坏结果：幻觉（把搜到的不相关内容缝进来）与延迟（多几轮网络往返）。

单轮润色更没有这个位置：一次请求里既让它检索又让它重写，只会两头都不好。

真正该给 Agent 的工具是 `check_wechat_compat`——它不查外面，它查**自己家管线的兼容性**，零 token 成本且完全确定。

### 11.8 为什么提示词要禁止模型编造图片链接

一期里图片只能靠用户手动「映射本地图片」进来（外链在 `file://` 下读不到像素，只能落占位图）。模型随手写 `![](https://…)` 就必然变成占位图，还得用户回头一张张映射。

所以提示词里要明确：**不要自行编造图片链接；需要配图处写 `<!-- 配图建议：… -->`**。

### 11.9 为什么「要不要润色」只在开头问一次，不做成常驻开关

常驻开关会诱导用户在两种模式间反复横跳，而润色的价值恰恰在「一遍成形」。更重要的是：**分步条要立得住，前提是每一步只问一个问题。** 第 2 步已经回答过的事，不该在第 3 步再问一遍。

代价是用户中途改主意时得退回第 2 步——这个代价由分步条的「后退」承担，比常驻开关便宜。

## 12. 已知陷阱（动手前先验的两件事）

1. **SSE 与 `protocol_version = 'HTTP/1.1'`。** `serve.py` 目前是 HTTP/1.1；HTTP/1.1 下不写 `Content-Length` 又不写 `Transfer-Encoding: chunked`，客户端会一直等下去。这条路由要么手动写 chunked，要么加 `Connection: close` 让连接关闭充当结束信号。**P7 第一步就要验通。**
2. **DeepSeek 的 SSE 分片边界。** 模型按 token 吐，一个 `data:` 事件可能在任意字节处被切断（多字节中文尤其容易切在半字上）。解析器必须缓存半截 buffer，**不能按行 `split` 完就丢**。选错的表现是「偶发出现乱码字」。

其余把握较大的坑：`serve.cmd` 必须保持「纯 ASCII + CRLF」（原因见 `serve.py` 文件头注释）；`send_json` 已带 `charset=utf-8`，中文与 emoji 链路无需另做。

> 原第 2 条「哪个模型支持 function calling」随多轮 agentic 一起暂缓，届时再实测，不要依赖转述。

## 13. 阶段划分

| 阶段 | 目标 | 关键交付 |
| --- | --- | --- |
| **P6** | 分步条外壳 + 版本仓库 | `src/steps.js`（分步条、「要不要润色」询问、选「不需要」的快路径）、`serve.py` 加 `/agent/*`、SQLite 三张表、版本 CRUD、`src/panels/history.js`（保存与回溯上一步）、「保存这份 md」下载。**零 AI**。**已完成** |
| **P7** | DeepSeek 接入 + 流式 + 单轮润色 | `agent/llm.py`、`agent/prompts.py`、`/agent/polish`、`src/panels/polish.js`、润色结果**保存后**落库为一版（`origin='ai_polish'`）。**做到这里整条链路就可用**。**已完成** |
| **B1** | 多轮的「地基」与出口 | `agent_steps` 表（含 `status`/`error`）、`store.start_step/finish_step/list_runs/list_steps`、`GET /agent/runs?docId=&limit=`、`GET /agent/runs/<id>`；单轮润色落一步 `kind='polish'`。**这一步不改变任何用户可见行为**，它只是让「多轮」有可调的证据。**已完成** |
| **B2** | 第二步：兼容性修订 | 前端把 `pipeline.build()` 的 `dropped` 回传；服务端据它决定是否发起第二轮；第二轮 `revise` 流式；`check` / `revise` 各落一条 `agent_steps`。**已完成**（2026-11-14）——`dropped` 实测恒为空，第二轮按「保险丝」交付，见 §9 |
| **B3** | 护栏补齐 | 最多修订 1 轮、总 token 上限、整条链的单步超时、`POST /agent/cancel`、靠 `agent_steps.idx` 的断点续跑。**已完成**（2026-11-14）——见 §10；验收点见 §14.5 |
| 暂缓 | 完整五步 agentic + 工具集 | `agent/runner.py`、`agent/tools.py`、`analyze`/`outline`/`draft`。见 §9 |

> 表里的 P6/P7 是**二期内部编号**，与一期的 P0–P7 没有对应关系——一期已经做完，这里只是为了排顺序。（初版把「P8」也列为阶段，本次随多轮 agentic 一起移入暂缓。）

**P6 刻意不含 AI**，这样能把「版本回溯」与「模型质量」两个问题分开验收——AI 出问题时能确定底层是对的。这也是把 §1 第 2 步的分叉放在 P6 的原因：**先证明「不需要 AI 也能走完全程」，再去接 AI**。

P6 还有一个隐性收益：版本仓库在 P7 会立刻变成润色结果的落地场所（`agent_runs.result_version_id` 指向的就是 P6 建好的 `versions` 表）。**先做 P6 不是绕路，是铺路。**

## 14. 验收标准

### 14.1 P6（十一条，均可手工点验）

1. 双击 `serve.cmd` → 顶部出现分步条，停在「① 导入」。
2. 上传一份 `.md` → 问「要不要 AI 润色」。
3. 选「**不需要**」→ 直接跳到「④ 转格式」，预览与复制一字不减，选这个动作**不产生任何新的 `/agent` 请求**（验证 11.5）。注意排除法：页面初始化时版本面板会发一条只读探测 `GET /agent/versions`，那一条不算在本路径上。
4. 选「需要」→ 进「② 润色」；P6 阶段此处提示「润色未接入」，允许手动编辑继续。
5. 在编辑区改几个字，**不点保存** → 版本号仍是 1，`GET /agent/versions` 返回空（验证 §7 版本口径）。
6. 点一次「保存」→ 库里出现 `seq=1`；再改再存 → `seq=2`。
7. 点「回溯上一步」→ 编辑区回到 `seq=1` 的正文，**版本号不变、库里仍是 2 条**（验证 11.1）。
8. 回溯之后点保存 → 库里出现 `seq=3` 且正文等于 `seq=1`——**验证「回退这个动作本身还能再回退」**。
9. **关掉 `serve.cmd`，直接双击 `index.html`** → 分步条仍在，「不需要」这条路照常走完；「需要」时提示一句并允许手动编辑——**验证「后端不许成为必需」**（11.5）。
10. 关窗口再启动 → 数据还在（验证真落盘，不是 `serve.py` 里 `STORE` 那种内存态）。
11. 点「保存这份 md」→ 下载的 .md 用记事本打开中文不乱码；正文含中文 / emoji / 多空行 / 行尾空格时，存回来逐字节一致。

### 14.2 P7

1. **关停 `serve.cmd`（或直接双击 `index.html`）** → 第 2 步选「需要」后，润色区给出一句「没连上本机的润色服务」并允许重试；**界面不卡**，手动编辑、「进入定稿」照常走完（验证 11.5）。
2. **流式输出逐段可见**（润色区里的内容一段段长出来，不是等半天一次性出现）；中途点「取消」或直接关页 → `agent_runs` 里那一条 status 是 `canceled`，没有 `running` 的僵尸记录（验证 §10 的两条护栏）。
3. **润色完成后库里什么都没有**——没点保存就没有版本。点「保存这份 md」→ `versions` 出现 `seq=1`、`origin='ai_polish'`、`run_id` 指向那一次润色，且 `agent_runs.result_version_id` 反过来指向这一版（验证 §7 的版本口径与「点保存才落库」）。
4. 上游返回的 ` ```markdown ` 包裹与「好的，以下是…」前言被剥掉；剥完不像 md 时报错（`ok:false`），**不静默写库、也不写进编辑区**（验证 §8.2）。
5. 润色后的 md 过一遍 `pipeline.build()`，`dropped` 为空或仅有预期项（在控制台跑一遍即可，验证 11.2）。
6. **连续润色同一篇两次**，中文与 emoji 不出现乱码字（验证 §12 第 2 条的分片处理）。

### 14.3 B1（六条）

B1 刻意**不改任何用户可见行为**——页面、按钮、文案与 P7 验收时逐字一致。所以这一段的验收全在「能不能看到证据」上：用浏览器地址栏或 `curl` 打那几个只读接口即可。

1. 跑一次润色（第 2 步选「需要」）→ `GET /agent/runs` 出现一条，`status='done'`、`stepCount=1`。**同一时刻 `GET /agent/versions` 仍是空的**（没点保存就没有版本，§7 的口径没被这一步破坏）。
2. `GET /agent/runs/<id>` → 里那一步是 `kind='polish'`、`idx=0`、`status='done'`，`tokensIn` / `tokensOut` / `latencyMs` 都有值，而 **`outputText` 是 `null`**——正文没有被顺手存进过程表（§7）。
3. 点「保存这份 md」后，再读同一条 run → `resultVersionId` 与 `docId` 已经反过来指上：这一版是哪次润色产出的，能倒查。
4. 润色中途点「取消」或直接关页 → 那条 run 与它的 step **都落 `canceled`**（没有 `running` 的僵尸记录）；紧接着再点一次润色不会拿到 409（全局锁已释放）。
5. 边界：`GET /agent/runs/999` → 404；`GET /agent/runs/abc` → 400；不带 `docId` 能看到全部，带 `docId=N` 只剩那一篇；`limit` 再大也不会超过 200 条。
6. 关掉 `serve.cmd` → 这几个接口连不上即可，分步条、编辑、预览、复制一字不受影响（11.5 未被这一步动到）。

### 14.4 B2（六条）

B2 同样**不改用户可见行为**：正常文章的流程、文案与 B1 时逐字一致。难度在于第二轮的判据（`dropped`）在真实文章里恒为空（§9 有实测），所以第 3–6 条改用**控制台直接构造请求**来验——验的是「通道通不通」，不是「用户点得到点不到」。所有命令都在跑着 `serve.cmd` 的那个页面（`http://localhost:8000/`）的控制台里执行，同源，不用写全地址。

0. **先把 `serve.cmd` 关掉重开。** B2 改了后端（`agent/routes.py` / `prompts.py` / `store.py`），而 Python 不热加载——跑着的老进程仍然是 B1 的代码。它的表现最迷惑人：第二轮请求**不报错**，只是被静默当成第一轮（新开一条 run、末帧 `step:'polish'`、`revised` 字段干脆不出现）。验收时若第 3 条结果不对，先回来看这一条。

1. 跑一次普通润色（第 2 步选「需要」）→ 结果与 B1 时**没有任何区别**：面板照常出稿，编辑区照常可改。`GET /agent/runs?limit=1` 那条 `status='done'`、`stepCount=1`；**DevTools 的 Network 里 `/agent/polish` 只有一次请求**（验证「`dropped` 为空时一次往返都不多发」）。
2. `GET /agent/runs/<id>` → 仍只有一步 `kind='polish'`、`idx=0`、`outputText=null`。**记下这时的 `tokensIn` / `tokensOut`**，第 4 条要用。
3. 在控制台构造一次第二轮（模拟前端回传了几处会被丢掉的写法）：

   ```js
   fetch('/agent/runs?limit=1').then(r => r.json()).then(j => console.log(j.runs[0].id))
   // 把上面打出来的数字填进下面的 runId，然后执行：
   MW.agent.polish({
     title: '手工验第二轮',
     contentMd: MW.app.text(),
     runId: /* 上面那条 id */,
     dropped: [{ tag: 'svg', preview: '<svg width="10"></svg>' }]
   }, e => { if (e.delta) console.log('delta', e.delta.length); })
     .promise.then(r => console.log('末帧', r.done));
   ```

   末帧应当是 `step:'revise'`、`revised:true`、`droppedCount:1`；再读同一条 run → **三步**：`idx=1 kind='check'`（`outputText` 是一段中文兼容性报告、`tokensIn/Out` 都是 0）、`idx=2 kind='revise'`（`outputText` 是 `null`）。这正是 §7 的分界：中间产物落 `output_text`，正文不落。
4. 对比第 2 条记下的数字：那条 run 现在的 `tokensIn` / `tokensOut` **= 第一轮 + 第二轮**（不是被第二轮覆盖掉）。这是 B2 改 `finish_run` 为累加的唯一目的——一条 run 跨两次 HTTP 请求，用量应当是各轮之和。
5. 再构造一次**什么都没丢**的第二轮：把上面那段里的 `dropped` 换成 `[]` → 末帧 `revised:false`、`text` 原样等于传进去的正文、`note` 里说明检查通过；`/agent/runs/<id>` 只多出一条 `check`，**没有 `revise`**，且**没有产生第二次上游调用**（`tokensIn` 不再增加，面板上也不会有新的 delta）。
6. 边界，全部必须**在开始写流之前**回普通 JSON：

   | 构造 | 期望 |
   | --- | --- |
   | 带 `dropped` 不带 `runId` | 400 |
   | 带 `runId` 不带 `dropped` | 400 |
   | `dropped` 传字符串（如 `"x"`） | 400 |
   | `runId` 指向不存在的 run | 404 |

   另外：对一条**还在跑**的 run 再发一次 → 409。以上每次失败之后，紧接着再点一次「开始润色」不能拿到 409（说明失败路径上全局锁也放掉了）。

### 14.5 B3（六条，均可手工点验）

B3 的护栏没有新增用户可见的功能，只有「坏了会很难看」的兜底，所以验收方式以**构造边界、看它怎么收场**为主。全部可以在浏览器控制台里做（`MW` 挂在 window 上）。

1. **预算用尽时优雅停下（本节的主验收点）。** 把 `agent/config.json` 的 `polishMaxTokens` 改成一个小值（例如 `100`），重启 `serve.cmd`，正常跑一次润色。预期：第一轮照常流式输出并灌进编辑区；**不报错、不转圈**；润色区出现一句「这一次润色累计已用 N token，达到上限 100，这一轮不再修订，编辑区保留上一轮的稿子」。
2. **一条 run 最多修订 1 轮。** 在控制台里对同一个 `runId` 连续发两次带 `dropped` 的续跑请求，第二次应当收到 `409` 与「已经修订过一轮了」。看 `GET /agent/runs/<id>` 的 `steps`：`revise` 只应出现一次。
3. **单步超时留下证据。** 每次润色的 `GET /agent/runs/<id>` 里，`polish` 步骤的 `latencyMs` 应当是一个合理的毫秒数（不是 `null`）。超时停下时，run 与 step 都应为 `canceled`，且 `error` 字段写明是「超过 N 秒」。
4. **点「取消」能干净收尾。** 润色中途点「取消」。预期：流当场停下，编辑区保留已经生成的部分，润色区说明「已按你的请求停下」；随后 `GET /agent/runs?limit=1` 里那条 run 的 `status` 是 `canceled`，**不留 `running` 僵尸**。网络面板里除了原本那条 `POST /agent/polish` 中断之外，还应看到一条 `POST /agent/cancel` 返回 `200`。
5. **取消是幂等的。** 对一条已经收尾的 run 再发一次 `/agent/cancel`，应返回 `200` 且带 `alreadyFinished: true`，而不是报错。对不存在的 `runId` → `404`，缺 `runId` → `400`。
6. **断点续跑不重来。** `GET /agent/runs/<id>` 的 `steps` 里，`idx` 从 `0` 起连续递增（`polish=0 → check=1 → revise=2`），且 `check` 的 `tokensIn`/`tokensOut` 都是 `0`。这证明「续跑」是在原 run 上往后接，而不是从第 0 步重算。

完整五步 agentic 的验收（五步都落 `agent_steps`、`check_wechat_compat` 的结果确实驱动下一轮修订）随该阶段一并暂缓。

## 15. 明确不做

- **不做多用户 / 登录 / 权限。** 单机个人工具，加账号体系只会拖慢一切。
- **不做云端部署。** 数据留在本机是这个工具的卖点，上云等于把它换成另一个产品。
- **不在渲染器里加任何后端依赖。** 见第 2 节。
- **不做「不点保存也自动记版本」。** 见 §7 与 11.1。
- **不在快路径上引入任何后端调用。** 见 §1 第 2 步与 11.5——选「不需要」这条路径不产生 `/agent` 请求（页面初始化那次只读探测不算，且失败也不影响功能）。
- **不存产物 HTML。** 见 11.3。
- **不给 Agent 联网搜索。** 见 11.7。
- **不做前端直连模型。** API Key 只能放后端——`file://` 页面里的 Key 等于公开，任何打开这个 html 的人都能看到。
- **不为了「只留两版」物理删除历史。** 见 11.1。

## 16. 待定问题

- **失败 run 的清理策略。** `status='failed'` 的 run 保留多久。B1 之后这张表还多了 `agent_steps`，「保留最近 N 次」的清理要以 run 为单位连步骤一起删。
- ~~提示词的具体文本~~ → **已定**：P7 用真实输出实测过一遍（含 8 列表格、外链、图片、emoji、代码块的草稿），模型逐条照约束处理，**没有需要补的规则**，`PROMPT_VERSION` 停留在 `polish-1`。
- ~~`seq=1` 是否要留底~~ → **已定**：不留。上传不发请求，第一次点保存才是 `seq=1`。
- ~~分段生成的粒度~~ → 随多轮 agentic 暂缓。单轮不存在这个问题：一次生成整篇。
