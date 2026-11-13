# 链接与裸 URL 样本

## 普通行内链接

这是一个 [普通链接](https://example.com/path) 后面跟着正文。

## 带标题的链接

[带 title 的链接](https://example.com/path "鼠标悬停时显示这句话")

## 裸 URL

https://example.com/bare/url/that/is/not/wrapped/in/angle/brackets

## 尖括号包裹的自动链接

<https://example.com/autolink>

<mailto:someone@example.com>

## 裸邮箱

someone@example.com 这种写法是否被识别成链接，各渲染器行为不一致，必须固定下来。

## 带查询串与锚点的长链接

[带查询串的长链接](https://example.com/search?q=markdown+to+wechat&page=2&sort=recent#section-3)

## 中文域名与 IDN

[中文域名链接](https://例子.测试/路径?参数=值)

## 链接套链接（非法写法）

[外层链接](https://example.com/outer [内层链接](https://example.com/inner))

## 链接里含下划线与星号

[snake_case_and_ast*erisk*](https://example.com/a_b_c_d_e_f_g)

## 引用式链接

这是一个 [引用式链接][ref-id]，下面是它的定义。

[ref-id]: https://example.com/reference

## 相对路径与锚点

[相对路径](./another.md) 与 [页内锚点](#链接与裸-url-样本) 在公众号里都没有意义，属于必须提醒用户的场景。

## 图片链接与链接图片混排

[![链接图片](https://example.com/link-img.png)](https://example.com/target)

## 超长裸 URL

https://example.com/very/long/path/segment/one/two/three/four/five/six/seven/eight/nine/ten/eleven/twelve?with=query&and=parameters&that=are&also=long&including=tokens&and=signatures&expires=1735689600

## 协议不安全的链接

[http 链接](http://example.com/insecure) 与 [协议相对链接](//example.com/protocol-relative)
