# MdWeChat

把 Markdown 转成「能直接粘进微信公众号图文编辑器、且不会被吃掉样式」的富文本。

纯前端、零构建、离线可用：**双击 `index.html` 就能用**，不 `npm install`、不起服务、不引 CDN。

---

## 它解决什么问题

公众号编辑器的粘贴会做一轮「清洗」，任何「先做个好看的网页再全选复制」的路都走不通：

- 剥掉 `<style>`、`<link>`、`class`、`id`，只保留元素自身 `style` 属性里的内联声明；
- 过滤 `flex` / `grid` / `position` / 伪元素 / `float` 等布局能力；
- 外链图片提示「上传失败」，外链 `<a>` 退化成不可点击的纯文本；
- 空段落被压成 0 高度。

所以本工具的答案只有一句话：**样式在渲染阶段就写完、写死进每个元素的 `style` 属性，产物只含微信留得住的标签与属性。** 没有「预览一套、复制另一套」——你在预览里看到的，就是会被复制出去的那一份。

## 功能

- **Markdown 输入**：手写、粘贴、拖拽、文件选择三种通路，自动嗅探 UTF-8 / GBK 编码（中文 Windows 导出的 GBK md 不再变成「锟斤拷」）。
- **双栏对照预览**：左栏桌面宽 1080px、右栏手机宽（375 / 393 / 360 三档），两栏挂同一份产物；左侧大纲侧栏点击跳转、滚动高亮。
- **主题参数**：字号 / 行高 / 字色 / 强调色 / 两端缩进 / 段间距实时可调，写进 CSS 变量并同步固化进产物。
- **一键复制到公众号**：复制前先「体检」，把预计会丢的样式（外链图、占位图）列出来、知情确认后再写剪贴板；另提供「复制源码」「打开纯净页」两条退路。
- **多媒体内嵌（P5）**：图片、MathJax 公式、Mermaid 图表全部在本机栅格化成 PNG 的 `data: URI` 再进产物，不依赖网络、不依赖会被剥掉的标签。
- **手机真机预览**：`serve.cmd` 起一个局域网服务，手机扫码看到「发出去之后读者看到的那一份」，电脑改字手机 800ms 内同步。
- **兼容规则表**：把「手机上丢样式」沉淀成可复核的规则，核心资产。

## 快速开始

### 日常使用

1. 双击 `index.html`（或拖进浏览器），直接在 `file://` 下运行。
2. 在左侧写 Markdown，或把 `.md` 文件拖到窗口任意位置，或点右上角「打开 md」。
3. 右侧预览即是固化后的产物；调好参数后点 **「复制到公众号」**（或 `Ctrl+Enter`），去公众号编辑器 `Ctrl+V`。
4. 快捷键：`Ctrl+Enter` 复制、`Ctrl+S` 存回本地 `.md`、`Esc` 关闭弹窗。

### 手机真机预览

1. 电脑与手机连同一 WiFi。
2. 双击 `serve.cmd`（需要本机装有 Python 3，且 `python` 在 PATH 里）。
3. 回到 `index.html` 点「手机预览」，用手机扫二维码打开 `?mode=preview` 的只读页。

> 服务端内容只放在内存里，关掉窗口即结束，不留后台进程；二维码完全本机生成，内网地址不会发给任何在线服务。

## 工作原理

渲染是一条固定顺序的流水线（`src/pipeline.js`）：

```
parse（markdown-it）
  → 多媒体摘取（识别 mermaid 围栏与公式）
  → 布局降级（列表 → section 序列，表格 → 百分比列宽）
  → 多媒体内嵌（图片 / 公式 / 图表 → PNG data: URI）
  → 挂 375px 舞台（离线、不可见、但照常布局）
  → 固化（inline-styles.js：把计算样式写死进每个元素的 style）
  → 归一（sanitize.js：白名单清洗 + 补地基 section）
  → 输出
```

三个文件各司其职，缺一不可：

| 文件 | 职责 |
| --- | --- |
| `src/whitelist.js` | 标签 / 属性 / 固化属性的白名单，以及「不可降级标签」与「降级映射」 |
| `src/inline-styles.js` | 固化器：把浏览器算出来的样式写进内联 `style`，越权属性被 `INLINE_PROPS` 拦下 |
| `src/sanitize.js` | 归一器：按白名单清洗标签与属性，删空段落，补最外层主题地基 |

产物的「契约」由 `test/assert.html` 里 10 条断言钉死（A1–A10）：不含 `class`、不含 `<style>`/`<link>`、不含 `flex`/`grid`/`position`、每个块级元素带内联 `font-size`、宽度不写死超过 375px、图片全部 `data:` URI、不含 `svg`/`canvas`/`iframe`……

## 目录结构

```
index.html              唯一入口（双击即用）
serve.cmd / serve.py    局域网真机预览服务（/sync 同步通道）
PLAN.md                 完整设计文档（六条硬约束、阶段划分、关键决策）
vendor/                 离线第三方库（UMD，随仓库走，不引 CDN）
src/
  theme.css             主题变量 + 应用外壳样式
  util.js               防抖 / 转义 / 编码嗅探 / 文件读取 / toast
  whitelist.js          白名单与降级映射
  compat-rules.js       兼容规则表（核心资产，内置 25 条 L01–L25）
  pipeline.js           渲染管线编排
  media.js              图片 / 公式 / 图表的内嵌与栅格化
  inline-styles.js      固化器
  sanitize.js           归一器
  clipboard.js          剪贴板（富文本两层降级）
  sync.js               局域网同步通道
  view.js               双栏预览 / 大纲 / 二维码
  preview-mode.js       只读预览页与纯净复制页
  app.js                引导与事件绑定（最后加载）
  panels/               主题参数 / 样式体检 / 丢失样式登记 三个面板
fixtures/               12 个回归样本 md
test/assert.html        浏览器内断言台
```

脚本加载顺序固定为 `util → whitelist → compat-rules → vendor/* → pipeline → media → inline-styles → sanitize → clipboard → sync → panels/* → view → preview-mode → app`。`util.js` 必须最先、`app.js` 必须最后。

## 六条硬约束

1. 纯前端，双击 `index.html` 在 `file://` 下可运行，无构建、无 `npm install`、无本地服务器。
2. 禁止 ES Module（`file://` 下 `type="module"` 会被 CORS 拦），脚本用经典 `<script src>` 按序加载，全部挂在 `window.MW`。
3. 禁止用 `fetch` / `XMLHttpRequest` 读本地文件，md 只能来自文件选择、拖拽或 `textarea`。
4. 第三方库放 `vendor/`，必须 UMD、离线可用，禁止 CDN。
5. 不引任何框架，只用原生 DOM 与原生 CSS。
6. 除 Mermaid（约 3.2MB）与 MathJax（约 2MB）按需懒加载外，首屏 1 秒内可交互。

## 兼容规则表（核心资产）

「md 转 html」十分钟能写完，但「手机上丢掉的样式能变成一条规则、下次不再丢」需要把失败经验沉淀下来。`src/compat-rules.js` 内置 25 条已知兼容问题（L01–L25），每条带 `target / property / expected / strategy / status / fixture / lastVerified` 字段。

`status` 只允许四态，初始一律 `suspect`：`suspect`（见过现象但未真机复核）→ `verified`（真机复核有效）→ `failed`（复核发现策略无效）→ `obsolete`（微信已修好）。这张表的全部价值就在于「哪条真跑过、哪条还没有」分得清，所以**禁止为了看起来完成度高把 `suspect` 改成 `verified`**。

用户在手机上发现丢样式，可以在「登记」面板落成一条用户规则（存 `localStorage['mw.rules']`），规则回灌进渲染管线，越用越好用。

## 测试

打开 `test/assert.html`，一次多选 `fixtures/` 下的全部 12 个 md 文件。断言按阶段启用：阶段编号大于当前阶段（P5）的断言以灰色显示、不计分。12 个样本覆盖标题、列表、八列表格、超长代码、大图、嵌套引用、提示块、公式、Mermaid、CJK/emoji、链接等回归场景。

## 依赖（vendor）

| 库 | 版本 | 用途 |
| --- | --- | --- |
| markdown-it | 14.1.0 | Markdown 解析 |
| markdown-it-footnote | 4.0.0 | 脚注 |
| markdown-it-task-lists | 2.1.1 | 任务列表 |
| highlight.js | 11.11.1（common） | 代码高亮 |
| qrcodejs | master | 手机预览二维码 |
| MathJax（tex-svg） | 3.2.2 | 公式（懒加载） |
| Mermaid | 10.9.1 | 图表（懒加载） |

来源、版本与体积核对方式见 `vendor/README.md`。

## 更多细节

设计动机、阶段划分、关键决策（375px 舞台、0.2% 编码阈值、兼容规则字段约定、断言体系）都写在 [`PLAN.md`](PLAN.md)，推荐先读它再读源码。
