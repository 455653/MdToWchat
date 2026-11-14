# -*- coding: utf-8 -*-
"""
prompts.py —— 提示词，以及「兼容规则 → 模型约束」的翻译表（二期 P7）

为什么这张翻译表要放在这里（PLAN-II.md 11.2）：
  src/compat-rules.js 里的 25 条是一期给**降级器**用的。二期要让模型也看见它们：
  模型若产出一篇「漂亮但过不了微信过滤器」的 md，降级器会把文章拆得面目全非。
  而单轮润色只有一次机会——写歪了没有下一轮来救。所以这里把「微信会吃什么」
  逐条翻成一句写作约束，让模型一开始就别写出需要降级的东西。

为什么每条约束都挂着 compat-rules.js 的编号：
  两边要能互相指着走。改了一期某条规则，这里能立刻找到对应约束；
  反过来，「模型为什么不该写并排布局」也能一路查回 L04 的真机现象。

这个文件只生产字符串，不发请求、不碰磁盘、不碰 HTTP——
发请求在 llm.py，编排在 routes.py。
"""

import hashlib
import re

# 提示词版本。改一句提示词就把它 +1：agent_runs.prompt_hash 记的是内容哈希，
# 这个版本号是给人看的「第几版提示词」，翻日志时比一串十六进制好认。
PROMPT_VERSION = 'polish-1'

# 第二轮（修订）的提示词版本。它单独一套版本号而不是和上面共用一个：
# 两件事的判据不同（一个看「像不像文章」，一个看「哪里会被丢掉」），
# 效果回退时要能分辨是哪一套改了。agent_runs 只有一个 prompt_hash 列、
# 而且是开跑时就写死的（那时还不知道会不会有第二轮），所以这个版本号
# 记在 check 步骤的 input_json 里——那正是「这一轮为什么发起」的决策记录。
REVISE_VERSION = 'revise-1'


# ------------------------------------------------------------------ 兼容约束

# 只挑「会影响模型怎么写」的那些。像 L08（圆角时有时无）这类纯视觉项不必写进来——
# 模型写的是 Markdown，本来也表达不出圆角，写进去只是浪费 token 并稀释重点。
COMPAT_CONSTRAINTS = [
    ('L01/L02/L03/L24', '产物必须是「第一遍就已经是最终形态」，所以只用 Markdown 语法本身'
     '（标题、段落、列表、引用、代码块、表格）。不要写任何 HTML 标签、行内 style、class 或 id：'
     '它们会被编辑器整段剥掉，写了等于没写。'),
    ('L04/L05/L07', '不要试图做并排、分栏、左右对齐或任意定位的版式。'
     '公众号正文只支持自上而下的单列流，需要「并排」时改用表格或干脆拆成上下两段。'),
    ('L06', '不要用符号拼凑装饰（如用一串「=」或「●」画分隔线、进度条）。'
     '需要分隔就用一行 `---`。'),
    ('L09/L10/L11', '不要靠底色或阴影表达层级。需要强调时用文字本身（小标题、加粗、引用块）。'),
    ('L12', '列表嵌套最多两层。第三层开始会被压平，读起来反而更乱。'),
    ('L13', '表格最多 6 列，且不要写列宽。列数更多的信息请改写成表格上方的条目列表。'),
    ('L14/L15', '代码块里的单行不要超过 60 个字符；超长 URL 请单独成行，不要嵌在句子中间。'),
    ('L16/L17', '不要用字号或单位（rem / px）表达层级，产物里的字号由工具统一决定。'),
    ('L18', '不要写 `[文字](https://…)` 这种站外链接语法——外链在公众号里会变成不可点的纯文本，'
     '读者点不动。需要给出网址时，把完整 URL 原样写在正文里。'),
    ('L19', '不要写任何图片语法（`![]()`），也不要编造图片地址——外链图片在公众号里必然上传失败，'
     '只会给读者剩一个占位框。需要配图的位置，单独写一行 HTML 注释：`<!-- 配图建议：画什么、放哪 -->`。'),
    ('L20', '不要内联 SVG。需要图形时同样写成 `<!-- 配图建议：… -->`。'),
    ('L21', '不要用连续空行制造留白，段落之间空一行就够（多余的会被压成 0 高度）。'),
    ('L23', 'emoji 最多在小标题或关键强调处用一两个，不要拿它当图标用。'),
    ('L25', '不要设计「浅底 + 深字」这类强对比色块来区分内容，读者开暗黑模式时它会反过来变成不可读。')
]


# ------------------------------------------------------------------ 系统提示词

_WRITING_RULES = [
    '**忠实优先。** 原文里的事实、数据、结论、专有名词、代码片段一个都不能改、不能丢。'
    '你是在重写和重排，不是在替作者创作。原文没有的数据、案例、引用一律不许补。',
    '**一段只说一件事，一段不超过 5 行。** 手机屏幕上超过 5 行的段落会变成一堵墙，'
    '把它拆成两段，或提炼成小标题。',
    '**长句拆短句。** 中文里一句话超过 40 个字就拆开。去掉「值得一提的是」'
    '「综上所述」这类没有信息量的连接词。',
    '**保留作者的语气。** 原文是口语就保持口语，是技术说明就保持技术说明，'
    '不要把两者都改成同一种「公众号腔」。',
    '**术语与代码原样保留。** 英文术语、函数名、命令、报错信息不要翻译、不要改写大小写。',
    '**标题要具体。** 大标题给出这篇文章到底讲了什么，不要用「浅谈」「那些事」这类空壳标题。',
    '**结构清晰。** 用 2 到 5 个二级标题（`##`）把正文分段；小标题用陈述句，不要只写一个名词。'
]


def system_prompt():
    """系统提示词。每一段的存在理由都写在上面两个常量里，这里只做拼装。"""
    lines = [
        '你是一位资深的微信公众号编辑。你的工作是把作者交来的 Markdown 草稿，'
        '改写成一篇可以直接发布到微信公众号的文章。',
        '',
        '## 输出格式（最重要，先看这条）',
        '只输出改写后的 Markdown 正文本身。',
        '- 不要写任何开场白、结束语或解释（例如「好的，以下是改写后的文章」）；',
        '- 不要用 ``` 代码围栏把整篇文章包起来；',
        '- 除了文章正文，一个字都不要多写。',
        '',
        '## 写作要求',
    ]
    lines += ['- ' + item for item in _WRITING_RULES]
    lines += [
        '',
        '## 排版硬约束（违反会导致文章在公众号里被拆散）',
        '下面每一条都对应一个真实的、已经在真机上观察到的排版事故。'
        '请把它们当作不可协商的规则，而不是风格建议。',
    ]
    lines += ['- （%s）%s' % (rid, text) for rid, text in COMPAT_CONSTRAINTS]
    return '\n'.join(lines)


def user_prompt(title, content_md):
    """用户消息。标题作为提示给模型，正文是草稿原文。"""
    name = (title or '').strip() or '未命名'
    return '\n'.join([
        '文件名：%s' % name,
        '',
        '以下是作者交来的草稿原文。请按上面的要求改写成公众号文章：',
        '',
        '----- 草稿开始 -----',
        content_md,
        '----- 草稿结束 -----'
    ])


def messages(title, content_md):
    """发给模型的完整消息数组（OpenAI 兼容格式）。"""
    return [
        {'role': 'system', 'content': system_prompt()},
        {'role': 'user', 'content': user_prompt(title, content_md)}
    ]


def prompt_hash():
    """提示词内容哈希，写进 agent_runs.prompt_hash（PLAN-II.md §7）。

    存它的理由只有一个：调一次提示词效果可能全变，不记 hash，
    质量回退时无法归因到「是哪一版提示词写出来的」。
    这里只哈希系统提示词——user 部分是用户自己的稿子，哈希它会每篇都不同，没有归因价值。
    """
    digest = hashlib.sha256(system_prompt().encode('utf-8')).hexdigest()
    return '%s-%s' % (PROMPT_VERSION, digest[:12])


# ------------------------------------------------------------------ 第二轮：check 与 revise（B2）

# sanitize 会整块删掉的标签（src/whitelist.js 的 DROP_TAGS）翻成人话。
# 为什么要翻：报告是给作者看的，「svg ×2」他未必知道自己写过 SVG，
# 而「内联 SVG 图形 ×2」能让他立刻回想起「哦，我画了个流程图」。
# 这份表只影响措辞，判据始终是前端回传的 tag 本身（那才是唯一的真相）。
_DROPPED_NAMES = {
    'script': 'script 脚本',
    'style': 'style 样式表',
    'link': 'link 外链资源',
    'meta': 'meta 元信息',
    'base': 'base 基准地址',
    'noscript': 'noscript 兜底块',
    'iframe': 'iframe 内嵌框',
    'object': 'object 嵌入对象',
    'embed': 'embed 嵌入内容',
    'video': 'video 视频标签',
    'audio': 'audio 音频标签',
    'canvas': 'canvas 画布',
    'svg': '内联 SVG 图形',
    'form': 'form 表单',
    'input': 'input 表单控件',
    'select': 'select 下拉框',
    'textarea': 'textarea 多行输入框',
    'button': 'button 按钮'
}

# 报告里最多列几条样例。它同时进提示词与 agent_steps.output_text：
# 一篇被塞了几十个 <input> 的稿子不该把这两处一起撑大，而看到前几条
# 已经足够知道「坏在哪」——数量始终是全的，只是样例截断。
_REPORT_SAMPLE_MAX = 5


def compat_report(dropped):
    """把前端回传的 dropped 列表写成一段中文报告。

    这是 check 步骤的**产物**（写 agent_steps.output_text），也是 revise 提示词的
    依据。一处生成两处用：报告说「丢了什么」与模型被告知「要修什么」必须完全一致，
    分成两份的话迟早会出现「报告说 3 处、模型只看到 2 处」这种对不上的账。

    dropped 里每项形如 {'tag': 'svg', 'preview': '<svg …>'}（src/sanitize.js 的 dropSubtree）。
    """
    items = [item for item in (dropped or []) if isinstance(item, dict)]
    if not items:
        return ''

    counts = {}
    for item in items:
        tag = str(item.get('tag') or '未知').lower()
        counts[tag] = counts.get(tag, 0) + 1

    listed = '、'.join(
        '%s ×%d' % (_DROPPED_NAMES.get(tag, tag), counts[tag])
        for tag in sorted(counts, key=lambda t: (-counts[t], t)))

    lines = ['产物里有 %d 处写法会被公众号整块丢掉：%s。' % (len(items), listed)]

    samples = [str(item.get('preview') or '').strip() for item in items]
    samples = [s for s in samples if s][:_REPORT_SAMPLE_MAX]
    if samples:
        lines.append('原文样例：' + ' | '.join(samples))
    return '\n'.join(lines)


def revise_prompt_hash():
    """修订提示词的内容哈希，写进 check 步骤的 input_json（见 REVISE_VERSION 的说明）。"""
    digest = hashlib.sha256(revise_system_prompt().encode('utf-8')).hexdigest()
    return '%s-%s' % (REVISE_VERSION, digest[:12])


def revise_system_prompt():
    """第二轮的提示词。

    与第一轮最大的区别是**改动范围**：第一轮可以整体重排，这一轮不行——
    用户已经在编辑区里看过第一轮的成品了，第二轮若顺手把别的段落也重写一遍，
    等于把一份已经认可的稿子又换了个样。所以这里把话说死：只动被丢弃的那几处。

    输出仍然是**整篇文章**而不是「补丁」：让模型返回「哪几段换成什么」，
    再在前端做拼接，是一类只在长文、只在某段被切在中间时才会现形的 bug 的温床。
    整篇重发的代价是这一轮多花些输出 token，而它只在真的丢了东西时才跑
    （多数文章的 dropped 是空的，根本走不到这里）。
    """
    lines = [
        '你是一位资深的微信公众号编辑。上一轮已经把作者的草稿改写成公众号文章，',
        '但检查发现其中有几处写法在粘贴进公众号编辑器时会被**整段丢掉**。',
        '',
        '## 这一轮只做一件事：把会被丢掉的地方改掉',
        '- 被丢弃的内容，指的是下面「会被丢掉的内容」里列出的那些写法。',
        '- 只改这些地方：把 SVG 图形、表单控件、内嵌框之类换成纯 Markdown 能表达的东西，'
        '删得掉的直接删掉，需要保留的信息改写成文字或表格。',
        '- **其余内容一个字都不要动。** 段落顺序、标题、用词、标点全部保持上一轮的样子，'
        '不要顺手润色、不要调整结构。用户已经看过上一轮的稿子。',
        '',
        '## 输出格式',
        '输出改写后的**完整 Markdown 正文**（不是差异、不是片段）。',
        '- 不要写任何开场白、结束语或解释；',
        '- 不要用 ``` 代码围栏把整篇文章包起来。',
        '',
        '## 排版硬约束（改的时候同样要守）',
    ]
    lines += ['- （%s）%s' % (rid, text) for rid, text in COMPAT_CONSTRAINTS]
    return '\n'.join(lines)


def revise_user_prompt(title, content_md, report):
    """第二轮的用户消息：报告在前，正文在后。

    报告放前面而不是塞在末尾：它是这一轮唯一的行动依据，
    放在文章后面容易被长正文淹没。
    """
    name = (title or '').strip() or '未命名'
    return '\n'.join([
        '文件名：%s' % name,
        '',
        '## 会被丢掉的内容',
        report or '（没有检测到会被丢掉的内容。）',
        '',
        '## 上一轮的稿子',
        '',
        '----- 草稿开始 -----',
        content_md,
        '----- 草稿结束 -----'
    ])


def messages_revise(title, content_md, report):
    """发给模型的第二轮消息（OpenAI 兼容格式）。"""
    return [
        {'role': 'system', 'content': revise_system_prompt()},
        {'role': 'user', 'content': revise_user_prompt(title, content_md, report)}
    ]


# ------------------------------------------------------------------ 输出清洗

# 整篇被 ``` 围栏包起来。模型很爱这么干，尽管提示词已经说了不要。
_FENCE_RE = re.compile(r'^\s*```[a-zA-Z0-9_+-]*[ \t]*\r?\n(.*?)\r?\n?```\s*$', re.S)

# 「好的，以下是…」这类前言。只匹配「一句客套话 + 冒号/句号结尾」，
# 而且只在它出现在最前面时才删——正文里出现同样的字眼不能碰。
_PREAMBLE_RE = re.compile(
    r'^\s*(好的|好，|当然|没问题|收到|明白)[，,。！!]?[^\n]{0,40}?(如下|以下是|这是|为你|已)[^\n]{0,40}?[：:。]\s*\n+'
)
_PREAMBLE_LINE_RE = re.compile(
    r'^\s*(以下是|这是|下面是)[^\n]{0,60}?(文章|版本|改写|润色)[^\n]{0,20}?[：:。]\s*\n+'
)

# 模型不肯干活时的典型话术。剥完如果长这样，说明这一轮根本没产出文章。
_REFUSAL_RE = re.compile(
    r'^\s*(抱歉|对不起|很遗憾|我无法|我不能|作为一个?AI|作为人工智能)'
)


def clean_output(text):
    """剥掉代码围栏与开场白。只做「去掉包装」，不做任何内容改写。

    为什么必须剥（PLAN-II.md 14.2）：模型的这些包装不是文章的一部分。
    若原样塞进编辑区，用户看到的第一行会是一句「好的，以下是改写后的文章」，
    而那一行还会被一起转成公众号格式发出去。
    """
    if not isinstance(text, str):
        return ''
    out = text.strip()

    # 围栏可能剥掉一层后还剩一层（模型偶尔套两层），所以循环到不再变化
    for _ in range(3):
        stripped = _FENCE_RE.sub(r'\1', out).strip()
        if stripped == out:
            break
        out = stripped

    for _ in range(3):
        stripped = _PREAMBLE_RE.sub('', out, count=1)
        stripped = _PREAMBLE_LINE_RE.sub('', stripped, count=1)
        stripped = stripped.strip()
        if stripped == out:
            break
        out = stripped

    return out.strip()


def looks_like_markdown(text):
    """剥完的文本像不像一篇文章（PLAN-II.md 14.2：不像就报错，不静默写库）。

    判定刻意宽松——这里的任务是「挡住明显的失败」，不是做 Markdown 语法校验。
    真正要挡的是三种：模型拒答、模型只回了一句话、模型回了个空。
    所以只要「够长 + 有段落结构」，就算通过。
    """
    body = (text or '').strip()
    if not body:
        return False
    if _REFUSAL_RE.match(body):
        return False

    # 去掉空白后仍有内容（防「全是空行」）
    dense = re.sub(r'\s', '', body)
    if len(dense) < 30:
        return False

    # 至少有一样 md 的结构特征：标题 / 列表 / 引用 / 表格 / 代码块 / 分段
    if re.search(r'^#{1,6}[ \t]+\S', body, re.M):
        return True
    if re.search(r'^\s*([-*+]|\d+\.)[ \t]+\S', body, re.M):
        return True
    if re.search(r'^\s*>[ \t]?\S', body, re.M):
        return True
    if '|' in body or '```' in body:
        return True
    return '\n\n' in body
