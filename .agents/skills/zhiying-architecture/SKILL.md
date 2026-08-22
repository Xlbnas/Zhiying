---
name: zhiying-architecture
description: 知影项目的架构约束与开发边界。涉及数据库、Worker、Jobs、Next.js、Remotion、Docker、Schema、项目状态或 M1-M4 实现时必须使用。
type: prompt
whenToUse: 当修改知影的系统架构、服务端、数据库、任务队列、Remotion集成、Docker、项目数据结构或开发里程碑时
disableModelInvocation: false
---

# 知影架构约束

## 当前有效架构依据

`视频生成器_架构设计文档.md` v0.2.1 因文件不可取得、且不在当前仓库或 Git history 中，已不再作为当前架构 Source of Truth。

迁移期间按以下优先级判断：

1. 当前实际源码与 tests；
2. 当前 Feiniu production 现场事实；
3. `docs/skill_migration/04_CONTRACT_FREEZE.md`；
4. `docs/skill_migration/03_ARCHITECTURE_REVIEW.md`；
5. 其他与上述事实一致的当前项目文档。

历史文档对该文件的引用只保留为历史记录，不得据此重建已不可验证的架构结论。若发生冲突，以当前源码与已验证生产事实为准。

不得因为"更现代""更企业级"而自行替换已经确定的架构。

以下既有基线仅在与当前源码、production facts 和迁移 contract 一致时适用：

- Next.js App Router（package.json 精确锁定版本 + 提交 lockfile，禁用 latest）
- SQLite + better-sqlite3
- WAL / busy_timeout=5000 / foreign_keys=ON / synchronous=NORMAL
- SQLite 文件必须在本机文件系统，禁止 SMB/NFS
- 单 Scheduler：统一轮询 llm_jobs + render_jobs，任何时刻只运行一个任务
- Jobs 必须支持原子 claim（BEGIN IMMEDIATE 条件更新）/ heartbeat / stale recovery / retry / cancel
- web + worker 两 service，同一 Docker 镜像
- 不引入 Redis
- 不引入 PostgreSQL
- Remotion Player / Renderer 使用同一 Composition 与 Props Schema（同构原则）
- Renderer 使用 @remotion/bundler + @remotion/renderer（bundle 按 templateVersion 缓存），CLI 仅作调试
- Scene JSON 使用 schemaVersion
- Visual Template 使用 templateVersion
- 每次 AI regenerate / 人工编辑自动创建 project_versions；每次正式 Render 创建含 templateVersion 的不可变快照
- /app/data 是唯一持久状态
- Secrets 不以明文进入 settings 表（环境变量 + 页面掩码显示）
- 所有 remotion / @remotion/* 包使用完全一致的精确版本

## M1 特别约束

M1 不接：

- LLM
- DeepSeek
- TTS
- Research
- Evidence
- Sources

M1 只完成：

FullCutScenes.json
→ Import
→ SQLite
→ Scene Editor（只读查看 + Player 预览）
→ Render Job
→ Worker（单调度器）
→ renderMedia
→ Jobs（实时进度）
→ MP4 Download

不得因为"顺便"而提前实现 M2-M4。

## M1 验收标准（8 条）

- M1-01 能导入现有 FullCutScenes.json 并创建项目
- M1-02 85 个 Scene 数据无损（ID、顺序、时间、模板一致，round-trip 导出校验）
- M1-03 浏览器 Player 能完整播放项目
- M1-04 Player 与 Renderer 在 3–5 个固定 frame 上视觉一致
- M1-05 导出后 Job 状态完整流转 queued → running → succeeded
- M1-06 人工杀 Worker 后 heartbeat 超时 → stale recovery → retry 生效
- M1-07 完整 MP4 正常输出
- M1-08 Jobs 页可下载视频，重启 Web 后历史任务仍在

## 实现前

遇到架构问题，先检查当前源码、tests、已验证 production facts，以及本仓库的迁移 contract/review 文档。已有事实遵守；不存在结论时提出最小变更方案，不自行扩大系统复杂度。
