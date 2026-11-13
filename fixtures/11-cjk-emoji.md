# 中英混排与表情样本

## 中英混排的边界

在中文与English之间不加空格会让视觉上挤在一起，而加上空格之后 In English 与中文之间就有了呼吸感。排版工具不需要替作者决定这件事，但必须保证自己的样式不会让这种差别变得更糟。

## 英文长句与不换行

The quick brown fox jumps over the lazy dog. This sentence is deliberately written without any line break in the source file so that the renderer has to decide where to wrap it based on the available width rather than on the author's line breaks.

## 超长英文单词

Pneumonoultramicroscopicsilicovolcanoconiosis 这种长度的单词在窄屏下必须被强制断开，否则会把容器顶宽。

## 表情符号

基础表情：😀 😂 🎉 🚀 ✅ ❌ ⚠️

组合型表情（由多个码点拼成，长度统计最容易算错）：👨‍👩‍👧‍👦 👩🏽‍💻 🏳️‍🌈 👍🏻

肤色与性别修饰：👋🏿 🧑‍🎓 🤦‍♂️ 🤷🏻‍♀️

## 表情出现在标题里

### 🚀 标题里的表情

## 表情出现在列表里

- ✅ 已完成
- ❌ 已失败
- ⚠️ 需要注意
- 🎉 全部通过

## 表情与中文紧贴

发布啦🎉这次真的发布啦🚀没有任何空格

## 全角标点

这是全角逗号，这是全角句号。这是全角分号；这是全角冒号：这是全角问号？这是全角感叹号！

## 中日韩混排

日本語のテキストと한국어 텍스트と中文文本混在同一行，看看断行策略对三种语言的差异。

## 竖排标点与省略号

破折号——与省略号……以及间隔号·都要能正确显示。

## 零宽字符与不可见字符

这一行里有一个零宽空格（U+200B），它不可见但会影响断行：​这里。

## 组合音标

Café résumé naïve Zürich Ångström — 带变音符号的拉丁字母不应被拆开。

## 超长中英混合无空格串

这是一个超长的中英混合字符串abc123def456ghi789jkl012mno345pqr678stu901vwx234yz这串字符中间没有任何空格所以断行策略必须能处理这种最糟的情况否则页面会被顶宽
