---
name: zhiying-ui-design
description: 知影 · AI 知识视频工坊的产品 UI 设计规范。当编写、修改或审查知影的页面、组件、布局、交互、样式、动画、项目页、工作流页、Scene Editor、Jobs 页面时必须使用。
type: prompt
whenToUse: 当任务涉及知影项目的任何前端界面、UI、UX、布局、视觉样式、交互动效或页面设计时
disableModelInvocation: false
---

# 知影 UI 设计规范

知影不是普通后台管理系统。

它是一个：

「知识创作者的视频工作台 / Creative Workstation」

功能性与效率优先，但"工具型产品"不等于"没有设计"。

## 一、核心气质

整体应该呈现：

- 专业
- 安静
- 克制
- 精密
- 有创作工具的感觉
- 有一定编辑部 / 影像工作室气质
- 长时间使用不疲劳

避免：

- 企业 OA 后台风
- Vue Admin 风
- 普通 SaaS Dashboard 模板感
- 大面积紫蓝 AI 渐变
- 满屏发光
- Cyberpunk HUD
- 所有内容都做成相同圆角 Card
- 为设计而设计的复杂动画
- 每个按钮都使用渐变
- 过度玻璃拟态

## 二、功能与设计的关系

优先级：

1. 信息层级
2. 操作效率
3. 状态清晰
4. 视觉一致
5. 美感
6. 装饰

但这不意味着界面应该朴素到像内部管理后台。

每一个核心页面都应该至少存在一个清晰的视觉记忆点。

例如：

- 工作流页面：阶段 Stepper 是视觉主线
- Scene Editor：时间 / Scene / Player 形成工作台结构
- 项目首页：项目状态与视频缩略图形成编辑部感
- Jobs：渲染进度具有明确的时间与状态视觉
- Sources：资料来源具有"研究档案库"感

## 三、布局

优先使用：

- 清晰的栅格
- 有意识的留白
- 层次不同的工作区域
- 固定的工作台结构
- 合理的高信息密度

不要把每一个信息块都包装成独立 Card。

允许：

- 无边框区域
- 极细分割线
- Surface 层级
- 大小不同的模块
- 左右主从布局
- 顶部阶段导航

## 四、视觉系统

建立统一 Design Tokens：

- background
- surface
- elevated-surface
- border
- text-primary
- text-secondary
- text-muted
- accent
- success
- warning
- danger
- research
- archive

颜色必须使用语义 Token，不要在组件中散落硬编码颜色。

Accent 应克制使用。

一个页面不应出现大量互相竞争的强调色。

## 五、字体和文字

中文界面优先保证：

- 中文清晰
- 数字清晰
- 长时间阅读舒适

建立：

- Display
- Heading
- Body
- Caption
- Mono / Numeric

层级。

不要所有文字都只有 font-size: 14px。

时间码、Token、Scene ID、Render ID 等技术信息可使用等宽字体或等宽数字。

## 六、动效

动效必须表达状态变化，而不是装饰。

推荐：

- 120–220ms 微交互
- 页面区域渐入
- 状态切换
- Stepper 进度
- Scene selection
- 渲染进度
- Panel 展开

避免：

- 到处弹跳
- 大幅度 spring
- 无意义 hover 位移
- 长时间渐变动画
- 页面进入时所有元素逐个飞入

支持 prefers-reduced-motion。

## 七、工作流页面

工作流是知影的核心产品能力。

12 个阶段不能只是普通 Tab。

应该让用户一眼理解：

已完成
当前阶段
未开始
stale
locked
failed / warning

阶段之间应有明确视觉连接。

Stage Gate 应成为产品视觉语言的一部分。

## 八、Scene Editor

Scene Editor 应有真正的视频工作台感觉。

核心布局：

Scene / Timeline 信息
+
编辑区域
+
Remotion Player

必须保证：

Player 是视觉中心之一。

Scene 列表信息密度可以高，但需要清晰：

- Scene ID
- 类型
- 时长
- Template
- 状态

被选中的 Scene 必须有明确状态，但不要大面积高饱和背景。

## 九、状态设计

系统存在大量状态：

- generated
- edited
- locked
- stale
- queued
- running
- succeeded
- failed
- cancelled

必须统一状态系统。

不能不同页面自己设计一套颜色和 Badge。

## 十、AI 的视觉表现

不要把 AI 做成：

- 魔法星星
- 紫色渐变机器人
- 发光 Brain
- Sparkles Everywhere

AI 在知影中只是生产能力。

视觉重点应该放在：

内容
工作流
证据
场景
视频

而不是"AI"三个字。

## 十一、设计执行流程

在实现重要页面以前：

1. 明确该页面最重要的一个任务。
2. 明确信息层级。
3. 确定该页面的视觉焦点。
4. 再开始写组件。

完成以后必须检查：

- 第一眼是否知道该做什么？
- 是否像真正的创作工具？
- 是否又退化成普通后台？
- 是否存在过度设计？
- 是否有明确视觉层级？
- 1366px / 1440px / 1920px 是否正常？
- 深色与浅色层级是否清楚？
- 长时间使用是否舒适？

## 十二、与其他 Skills 配合

本 Skill 定义"知影应该是什么样"。

如存在以下 Skill，应同时参考：

- frontend-design：提高视觉质量，但不得覆盖本 Skill 的产品气质约束
- web-design-guidelines：检查 UX、无障碍和 Web 规范
- react-best-practices：保证实现性能

出现冲突时：

知影产品约束
>
可用性
>
视觉创意
>
纯装饰
