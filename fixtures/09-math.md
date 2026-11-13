# 公式样本

## 行内公式

勾股定理写作 $a^2 + b^2 = c^2$，这是最简单的行内公式。

质能方程 $E = mc^2$ 夹在一句中文里，两侧的中文与公式之间不留空格，这是中文排版里最容易出问题的边界。

## 独立公式块

$$
\int_{0}^{\infty} e^{-x^{2}} \, dx = \frac{\sqrt{\pi}}{2}
$$

## 超长公式

$$
\begin{aligned}
\mathbb{E}[\hat{\theta}_{n}] - \theta &= \frac{1}{n}\sum_{i=1}^{n}\left(\frac{\partial^{2}}{\partial\theta^{2}}\log p(x_{i} \mid \theta)\right)^{-1}\frac{\partial}{\partial\theta}\log p(x_{i} \mid \theta) + O\left(n^{-3/2}\right) \\
&= \frac{\sigma^{2}}{n}\cdot\frac{\mu^{2}+2\mu\sigma+\sigma^{2}}{(\mu+\sigma)^{3}} + o\left(n^{-1}\right)
\end{aligned}
$$

## 其它定界符写法

反斜杠圆括号：\( \alpha + \beta = \gamma \)

反斜杠方括号：

\[
\sum_{k=1}^{n} k = \frac{n(n+1)}{2}
\]

## 公式里含下划线与星号

$ \text{a\_b} \cdot \text{c*d} = \text{a\_b*c*d} $

## 美元符号被误判为空公式

价格是 $100 和 $200，这里没有成对出现，按理不该被当成公式。

## 代码块里的公式

```
上面的 $x^2$ 在代码块里必须原样显示，不能被当成公式排版。
```
