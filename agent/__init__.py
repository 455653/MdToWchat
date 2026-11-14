# -*- coding: utf-8 -*-
"""
agent —— MdWeChat 二期的版本仓库与（P7 起的）AI 润色后端。

为什么它长在 serve.py 旁边而不是另起一个服务：
一次双击 serve.cmd 就什么都有了，且与 /sync 共用端口、CORS 和启动提示。
具体分工见 PLAN-II.md 第 5 节。

本包只被 serve.py 引用；index.html 那边的 src/ 一行都不依赖它——
后端不在时功能一字不减（PLAN-II.md 第 2 节与 11.5）。
"""
