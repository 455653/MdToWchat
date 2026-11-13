# vendor

离线第三方库目录。P1 起装入首屏要用的四个库，P3 追加二维码库，P5 追加公式与图表两个大库（懒加载）。

## 已放入（P1）

首屏用的四个库，都是 UMD 版本、随仓库一起走，不引 CDN。

| 库 | 版本 | 文件 | 体积 | 来源 |
| --- | --- | --- | --- | --- |
| markdown-it | 14.1.0 | `markdown-it.min.js` | 约 121 KB | `https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js` |
| markdown-it-footnote | 4.0.0 | `markdown-it-footnote.min.js` | 约 5.5 KB | `https://cdn.jsdelivr.net/npm/markdown-it-footnote@4.0.0/dist/markdown-it-footnote.min.js` |
| markdown-it-task-lists | 2.1.1（文件头横幅写 2.1.0，上游如此） | `markdown-it-task-lists.min.js` | 约 2.6 KB | `https://cdn.jsdelivr.net/npm/markdown-it-task-lists@2.1.1/dist/markdown-it-task-lists.min.js` |
| highlight.js | 11.11.1（common 构建，只含常用语言） | `highlight.min.js` | 约 125 KB | `https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/highlight.min.js` |

来源与版本的核对方式：按上表 URL 各重新拉一份，与目录里的文件逐字节比对 SHA256，
四个文件全部一致才写进这张表。记这一笔是为了拦住「表里的版本比目录里的文件新」这种静默腐烂。

为什么 highlight.js 用 common 构建而不是 full：
full 版把 190 多种语言全带上，体积是 common 的三倍多，而硬约束 6 要求首屏 1 秒内可交互。
common 覆盖了 JavaScript / Python / Bash / SQL / JSON / HTML / CSS，正是 P1 要求支持的那几种。

## 已放入（P3）

| 库 | 版本 | 文件 | 体积 | 来源 |
| --- | --- | --- | --- | --- |
| qrcodejs (davidshimjs) | master（仓库未打 tag） | `qrcode.min.js` | 约 20 KB | `https://github.com/davidshimjs/qrcodejs` 的 `qrcode.min.js` |

SHA256：`C541EF06327885A8415BCA8DF6071E14189B4855336DEF4F36DB54BDE8484F36`

它给「手机预览」按钮生成局域网地址的二维码。为什么必须用本地库：
硬约束 4 禁引 CDN，而且把内网地址发到任何在线二维码服务，都等于把
「这台机器在内网里的位置」交给第三方——地址里就带着 IP 和端口。

为什么它是静态引入而不是懒加载：只有约 20 KB，而按钮随时可能被点，
动态注入多出一次竞态（点得比注入快就画不出码）；它不参与渲染，不影响首屏。

两个使用上的坑，写在这里免得下次重踩：
1. 构造时容器不能是 `display:none`——库内部要量容器尺寸，隐藏状态下量到 0，
   画出来是一块空白。所以 `src/view.js` 里是先揭开遮罩、再 `new QRCode()`。
2. 它是全局 `QRCode` 构造函数，纠错级别常量在 `QRCode.CorrectLevel` 上。

## 已放入（P5）

公式与图表两个大库。它们的体积决定了自己只能被懒加载。

| 库 | 版本 | 文件 | 体积 | 来源 |
| --- | --- | --- | --- | --- |
| MathJax（tex-svg 单文件构建） | 3.2.2 | `mathjax-tex-svg.js` | 2,108,580 B（约 2.01 MB） | `https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js` |
| Mermaid | 10.9.1 | `mermaid.min.js` | 3,335,717 B（约 3.18 MB） | `https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js` |

两个体积都是在目录里实测出来的（`Length` 字段），不是估算。

为什么这两个不进首屏：加起来约 5.2 MB，与硬约束 6「首屏 1 秒内可交互」直接冲突。
它们由 `src/media.js` 在真正解析出公式 / 图表时才用 `document.createElement('script')`
注入，注入完成后 resolve，所以调用方可以 `await` 到「库已就绪」。
识别时机在 `src/pipeline.js` 的多媒体摘取那一步——此刻 mermaid 还是
`<pre><code class="language-mermaid">`，认得出；等代码块被套上容器就认不出了。

选 tex-svg 单文件构建而不是 tex-chtml：chtml 走的是网页字体 + 大量 CSS，
产物在微信里会被剥掉样式；而 svg 构建把每份公式画成一个自包含的 SVG，
本地再栅格化成 PNG 就是最终形态，中间不依赖任何外部字体文件。

两个使用上的坑，写在这里免得下次重踩（详见 `src/media.js`）：
1. MathJax 必须设 `svg.fontCache: 'local'`。默认的 `'global'` 把字形放进文档级的隐藏
   `<svg>`，公式用 `<use xlink:href="#MJX-…">` 去引用；而「把单个 SVG 序列化成 data: URI
   再当图片画进 canvas」这条路上，指向另一份文档的 `<use>` 不会被解析，画出来是空白。
2. Mermaid 必须设 `flowchart.htmlLabels:false` 与 `useMaxWidth:false`。默认的
   `htmlLabels:true` 会把节点文字包进 `<foreignObject>`，而 SVG 被当图片渲染时
   `<foreignObject>` 不渲染——结果是「只有线框，没有字」。

## 三条硬性要求

1. **UMD 版本。** 硬约束 2 禁止 ES Module，`file://` 下 `type="module"` 会被 CORS 拦掉。
   库必须以「挂到全局变量」的方式提供接口。
2. **离线可用。** 硬约束 4 禁止引 CDN：断网、内网、企业代理环境下都要能跑，
   而且 CDN 会让「双击 index.html」这条最基本的路径依赖网络。
3. **按需懒加载。** 硬约束 6 要求首屏 1 秒内可交互，大库必须在真正用到时才注入。

## 文件缺失时的表现

`file://` 下的 `<script src>` 加载失败是静默失败：不报错、不进控制台，
只会让后面的代码拿到 `undefined`，然后抛出与真实原因毫无关系的
「Cannot read properties of undefined (reading 'parse')」。

所以 `src/pipeline.js` 在渲染前会对四个首屏库做一次存在性检查，
缺哪个就在预览区点名写出「缺少 vendor/xxx.js（库名）」，
而不是让整页挂在一条看不懂的报错上。
