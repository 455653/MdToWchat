# 超长代码行样本

## 单行 200 字符以上

下面这一行故意不加任何换行，长度超过 200 个字符，用来验证代码块在窄屏下的处理方式：

```js
const COMPATIBILITY_PAYLOAD = ['section','p','h1','h2','h3','h4','h5','h6','blockquote','ul','ol','li','hr','table','thead','tbody','tr','th','td','pre','figure','figcaption','div','span','strong','b','em','i','del','s','a','img','br','code','u','sub','sup'];
```

## 断不开的超长单词

```python
supercalifragilisticexpialidociousAndThenSomeMoreLettersToMakeItAbsolutelyUnbreakableInNarrowColumns = 1
```

## 没有空格的连续中文长句

```text
这一段没有任何空格也没有换行所以它必须依赖断行策略而不是断词策略来处理否则会在窄屏下直接溢出容器边界把整个页面顶宽产生横向滚动条这是最典型的公众号排版事故之一
```

## 含制表符与行尾空格的代码

```text
第一列	第二列	第三列
行尾有三个空格   
下面一行只有缩进
		两个制表符开头
```

## 单个字符的代码块

```
x
```

## 空代码块

```
```

## 语言标注不存在

```不存在的语言
console.log('高亮器不认识这个标注，应当退化成纯文本');
```
