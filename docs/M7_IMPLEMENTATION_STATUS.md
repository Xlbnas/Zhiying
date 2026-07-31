# M7 实施状态技术文档

> 面向开发与接力 agent 的技术状态文件，不是宣传介绍。
> 每次 milestone 完成或 production 部署后必须更新本文件。

## 1. 元信息

| 项 | 值 |
|---|---|
| 文档更新时间 | 2026-07-31T05:45Z（以当前 VM 时间为准，部署后需刷新） |
| 当前 SHA | `09ae38aab6e46f77b37bd98ad3e1eed46100d7a7` |
| 当前分支 | `m7` |
| origin/m7 SHA | `077f3d4c9de4881684433545d17ec228062eea4f` |
| 当前 production SHA | **待本次部署后确认并回填** |
| 上一轮确认 production SHA | `077f3d4c9de4881684433545d17ec228062eea4f` |

## 2. Production 拓扑

- **开发机**：`agentvm` / `/home/agentvm/projects/ZhiYing`
- **生产宿主机**：飞牛 `Xlbnas-Shelter`（`VoicelessXlbnas@192.168.31.56 -p 2264`）
- **生产部署根目录**：`/vol1/1000/docker/zhiying`
- **生产备份根目录**：`/vol1/1000/backups/zhiying/`
- **生产 DB**：`/vol1/1000/docker/zhiying/data/zhiying.db`
- **GPU**：NVIDIA RTX 2080 Ti 22GB
- **端口**：`3210`（local + LAN）
- **Git 策略**：
  - 开发、代码测试、commit、push 在 `agentvm` 完成。
  - Production Docker 部署在飞牛宿主机完成。
  - 宿主机使用独立 Git clone，通过 remote `github` fetch 精确 SHA。
  - 不得因为 VM 没有 Docker 而跳过 production 部署。
- **Secret 边界**：
  - `DEEPSEEK_API_KEY` / `LLM_PROVIDER` 只注入 `zhiying-worker`。
  - `APIYI_API_KEY` 只注入 `zhiying-web`。
  - Web route 不直接调用 LLM provider；Worker 持有凭据执行 `buildNarrativeBeats` / `buildVisualIntentPlan`。

## 3. 已完成里程碑

| Milestone | 状态 | 关键 commit | 备注 |
|---|---|---|---|
| M7.0 Editorial Pipeline Redesign | DONE | `9bd1abc` | 审计报告 `docs/M7_0_EDITORIAL_PIPELINE_REDESIGN_REPORT.md` |
| M7.1 Typed Narration Compiler v2 | DONE | `f6a38d5` | `c16513b` 实现，compiler v2，exact source |
| M7.1.1 Activation Gate | DONE | `8b778fb` | immutable snapshot 才能激活 pipeline |
| M7.2 Narrative Beats | DONE | `bd57dad` | exact-source beat candidates |
| M7.2.1 Generation Single-flight | DONE | `d915d58` | `generation_runs` / `generation_attempts` 通用化 |
| DSL hotfix | DONE | `d915d58` | 防止 typed narration DSL 进入 M6 TTS |
| M7.3A Visual Intent | DONE | `196a49e` | provenance matrix / displayText / evidenceIds |
| M7.3A.1 Worker LLM Dispatch + DAG/Resource Parallelism | DONE | `196a49e`, `311dd36`, `e961ea8`, `7d64713`, `6627f65`, `31a3efb`, `493c2e6`, `3916b3c`, `b200120`, `56a1f50`, `09ae38a` | Visual Intent 契约、Worker dispatch、DAG、超时修复、UI、自动刷新、文档 |

## 4. 当前已实现功能详情

### 4.1 Visual Intent Plan Candidate

- **artifact kind**：`visual_intent_plan`
- **schema version**：`visual-intent-plan@1.0`
- **compiler version**：`1.1`
- **prompt version**：`visual-intent-plan@1.1`
- **主要代码路径**：
  - `src/lib/visual-intent/schema.ts`
  - `src/lib/visual-intent/validate.ts`
  - `src/lib/visual-intent/plan.ts`
  - `src/lib/visual-intent/generate.ts`
  - `src/app/api/projects/[id]/visual-intents/route.ts`
- **旧 candidate ID**：`793c80fa-9229-4551-bc05-960c727afa2e`（只读 revalidate，不得删除/覆盖/修改）
- **production candidate**：待 dry-run / production 验证后回填
- **deployed**：待 production 部署后确认

### 4.2 Narrative Beats Candidate

- **artifact kind**：`narrative_beats`
- **schema version**：`narrative-beats@1.0`
- **compiler version**：`1.0`
- **主要代码路径**：
  - `src/lib/narrative-beats/schema.ts`
  - `src/lib/narrative-beats/validate.ts`
  - `src/lib/narrative-beats/plan.ts`
  - `src/lib/narrative-beats/generate.ts`
  - `src/app/api/projects/[id]/narrative-beats/route.ts`
- **deployed**：是（M7.2.1）

### 4.3 Worker-side LLM Dispatch

- **artifact**：`generation_dispatch_jobs` + `generation_runs` + `generation_attempts`
- **主要代码路径**：
  - `src/lib/llm-generation/dispatch.ts`
  - `src/lib/llm-generation/runs.ts`
  - `src/worker/dispatch-executor.ts`
  - `src/worker/index.ts`
  - `src/worker/job-runner.ts`
- **边界**：Web route 只做 validation/enqueue/query/poll；Worker 原子 claim 后执行 `buildNarrativeBeats` / `buildVisualIntentPlan`。
- **deployed**：待 production 部署后确认

### 4.4 Workflow DAG / 资源感知并行

- **artifact**：`project_stages` + DAG 节点注册表（内存）
- **主要代码路径**：
  - `src/lib/workflow/dag-shared.ts`（纯图）
  - `src/lib/workflow/dag.ts`（`computeWorkflowReadiness`）
  - `src/lib/workflow/resource-classes.ts`
  - `src/lib/scheduler.ts`
  - `src/worker/job-runner.ts`
  - `src/app/api/projects/[id]/activity/route.ts`
  - `src/components/workflow/ParallelLanes.tsx`
  - `src/components/workflow/WorkflowWorkspace.tsx`
- **DAG 泳道**：
  - 视觉规划（API）：`narration_beat_map → visual_breakdown → shot_list → scenes`
  - 旁白/音频（TTS/GPU）：`narration_plan → narration_tts → narration_audio_manifest → subtitle_timing`
  - 素材：`scenes → assets`
  - 汇合：`scenes + narration_audio_manifest + subtitle_timing → timing_reconciliation → render`
- **GPU 互斥组**：`tts_gpu` / `render_gpu` / `local_image_gpu` 共享 production_gpu，并发上限 1。
- **deployed**：待 production 部署后确认

### 4.5 AI 图像生成超时修复

- **主要代码路径**：
  - `src/lib/assets/providers/generated/apiyi.ts`
  - `src/app/api/projects/[id]/assets/generate/route.ts`
  - `src/lib/usage-events.ts`
  - `src/lib/assets/model.ts`
  - `src/lib/assets/resolver.ts`
  - `src/components/workflow/VisualAssetsPanel.tsx`
- **错误码**：`PROVIDER_CONNECT_TIMEOUT` / `PROVIDER_RESPONSE_TIMEOUT` / `PROVIDER_POLL_TIMEOUT` / `IMAGE_DOWNLOAD_TIMEOUT` / `IMAGE_DECODE_FAILED` / `PROVIDER_TERMINAL_FAILURE`
- **幂等**：`project_usage_events.id = attemptId`，provider 调用前写入 `in_flight`，终态 `finalize`；超时后不自动重试。
- **deployed**：待 production 部署后确认

### 4.6 NarrationPanel 自动刷新

- **方式**：WorkflowWorkspace 顶层 `/api/projects/[id]/activity` 2s 轮询；NarrationPanel 订阅 `activity.audioOverview` / `activity.subtitleReadiness`。
- **主要代码路径**：
  - `src/app/api/projects/[id]/activity/route.ts`
  - `src/components/workflow/WorkflowWorkspace.tsx`
  - `src/components/workflow/NarrationPanel.tsx`
  - `src/components/workflow/shared.ts`
- **deployed**：待 production 部署后确认

## 5. 当前正在进行的工作

- 本次接力已完成 M7.3A.1 全部代码实现、本地 typecheck/build 与必跑测试套件。
- 待完成：push 到 origin/m7、production 备份与部署、production smoke verification。

## 6. 尚未完成 TODO

- [ ] M7.3B — Visual Sequences / Shots（明确禁止在本次执行）
- [ ] M7.4 — Timing Reconciliation v2 / 不创建 `timing-reconciliation@2.0`
- [ ] M7.5 — Asset Bindings 迁移
- [ ] M7.6 — M7 Pipeline Snapshot（明确禁止在本次执行）
- [ ] M7.7 — Storyboard
- [ ] M7.8 — Animatic
- [ ] M7.9 — Editorial Gate / Final Render
- [ ] 本次 production 部署后的 SHA 回填与 smoke 证据回填

## 7. 已冻结架构决策

- Visual Intent 永远是 candidate，不 current/selected/active/locked，不触发下游。
- Narrative Beats 永远是 candidate，不进入 active pipeline。
- 旧 Visual Intent candidate `793c80fa-9229-4551-bc05-960c727afa2e` 只读 revalidate，不修改。
- Worker secret boundary：Web 不持有 `DEEPSEEK_API_KEY` / `LLM_PROVIDER`。
- GPU 互斥组 `tts_gpu` / `render_gpu` / `local_image_gpu` 并发上限 1。
- `project_usage_events.id` 作为 image generation attemptId，DB 级幂等。
- 本地 timeout 后不自动重新计费调用；显式 retry 需新 attemptId。
- 不切换任何项目到 m7；`projects` 仍为 m6；snapshot pointer 仍为 NULL；无 M7 pipeline snapshot。

## 8. 已知事故和修复

| 事故 | 修复 | 关键 commit |
|---|---|---|
| DSL 进入 M6 TTS | 增加 DSL gate，typed narration 不进入 M6 TTS | `d915d58` |
| generation 双计费风险 | `generation_runs` (project_id, stage, request_id) 唯一 + BEGIN IMMEDIATE claim | `d915d58`, `5321f57` |
| candidate/active 混淆 | 明确 candidate 与 active pipeline 分离 | `a657fbd` |
| Worker secret boundary | Web 不调用 provider，Worker 持有凭据 | `311dd36` |
| AI image timeout 阶段不明 | 细分 timeout phase + in_flight usage event + attempt/provider id 持久化 | `31a3efb` |

## 9. 当前已知技术债

- `ParallelLanes` 组件目前依赖项目全局 CSS class（`lane-board`, `lane-grid` 等），未内联样式；若全局无对应样式则视觉表现朴素。
- APIYi 图像生成是同步 HTTP，本地 timeout 后无法真正向 provider 轮询 late result；`reconcile` 只能返回已记录的 attempt 状态。
- `asset_resolution_state.metadata` 为新增列，老数据无 failure phase，resolver 会从 `project_usage_events` 兜底回填。
- `WorkflowWorkspace` 同时保留 `/stages` 轮询与 `/activity` 轮询，存在少量重复请求；未来可统一为 `/activity` 驱动。

## 10. 下一轮 agent 的安全边界

- **不要** 启动 M7.3B / 生成 Visual Sequences / 生成 Shots。
- **不要** 创建 `timing-reconciliation@2.0`。
- **不要** 迁移 asset bindings。
- **不要** 创建 M7 pipeline snapshot。
- **不要** 切换任何项目到 m7。
- **不要** 生成 Storyboard / Animatic / Editorial Gate / Final Render。
- **不要** 自动重新生成污染项目 TTS。
- **不要** 循环重试 S001-R01 图片生成。
- 修改 Worker secret boundary 前必须经过 review。
- 删除或覆盖旧 candidate `793c80fa-9229-4551-bc05-960c727afa2e` 是禁止的。

## 11. 测试套件清单

### 11.1 必跑脚本（agentvm）

- `pnpm typecheck`
- `pnpm build`
- `scripts/test-m73a-visual-intent.ts`
- `scripts/test-m72-narrative-beats.ts`
- `scripts/test-m721-generation-singleflight.ts`
- `scripts/test-m6-dsl-gates.ts`
- `scripts/test-m711-activation.ts`
- `scripts/test-m71-compiler.ts`
- `scripts/test-m71-schema.ts`
- `scripts/test-m71-subtitle.ts`
- `scripts/test-m71-tts.ts`
- `scripts/test-m71-db.ts`
- `scripts/test-m6313-narration.ts`
- `scripts/test-m3a-narration-plan.ts`
- `scripts/test-m3b-tts.ts`
- `scripts/test-m3c-subtitle-timing.ts`
- `scripts/test-workflow-dag-parallelism.ts`（若存在）

### 11.2 本次新增/扩展测试

- `scripts/test-llm-dispatch.ts`（Worker-side LLM dispatch）
- resource scheduler 覆盖在 `test-llm-dispatch.ts` / `test-m3b-tts.ts` 中
- image generation timeout/reconcile 覆盖在 `test-m73a-visual-intent.ts` 与组件单元测试中
- per-requirement prompt UI 与 NarrationPanel auto-refresh 通过 `pnpm build` 与手动 UI 检查

### 11.3 本轮 agentvm 测试结果

| 脚本 | PASS | FAIL | 备注 |
|---|---|---|---|
| `test-m73a-visual-intent.ts` | 184 | 0 | 含 Worker dispatch / usage / 旧 candidate revalidate |
| `test-m72-narrative-beats.ts` | 125 | 0 | 含 generation run / single-flight |
| `test-m721-generation-singleflight.ts` | 99 | 0 | 幂等 / 并发 / terminal requestId |
| `test-m6-dsl-gates.ts` | 40 | 0 | DSL 进入 M6 TTS 防护 |
| `test-m711-activation.ts` | 58 | 0 | snapshot gate / 事务原子 |
| `test-m71-compiler.ts` | 79 | 0 | typed narration v2 |
| `test-m71-schema.ts` | 29 | 0 | plan schema / superRefine |
| `test-m71-subtitle.ts` | 15 | 0 | subtitle cue 编译 |
| `test-m71-tts.ts` | 25 | 0 | fingerprint / payload |
| `test-m71-db.ts` | 46 | 0 | DB 集成 / migration |
| `test-m6313-narration.ts` | 39 | 0 | narration sanitation |
| `test-m3a-narration-plan.ts` | 50 | 0 | plan build / stale |
| `test-m3b-tts.ts` | 99 | 0 | TTS 管线 / worker / finalize |
| `test-m3c-subtitle-timing.ts` | 82 | 0 | timing / timeline mismatch |
| `test-llm-dispatch.ts` | 57 | 0 | Worker dispatch / Web boundary |
| `test-workflow-stages.ts` | 56 | 0 | 工作流状态机 / DAG 兼容 |
| `pnpm typecheck` | ✅ | - | `tsc --noEmit` 通过 |
| `pnpm build` | ✅ | - | Next.js 15 生产构建通过 |

> agentvm 无系统 ffprobe，测试时使用项目本地 `.tools/static-ffmpeg/ffprobe`（静态构建）；production Docker 镜像自带 ffprobe。

## 12. Production 部署和备份规范

1. **备份先行**（在 checkout/build/up 之前）：
   - SQLite `.backup`
   - `integrity_check=ok`
   - DB SHA-256
   - `SHA256SUMS` 全部通过
   - compose×2
   - `.env.production`
   - previous exact SHA
   - image/container IDs
   - stage pointers
   - pipeline/snapshot pointers
   - generation runs/attempts/dispatch jobs
   - resource leases
   - Freud M7 artifact JSON+hash
   - 污染项目证据
   - S001/S001-R01 image generation job/attempt/provider evidence
   - TTS jobs/audio manifest/subtitle 状态
   - llm/image/TTS usage 和 cost
   - render assets archive
2. **时间戳证明**：`BACKUP_COMPLETED_AT < CHECKOUT_STARTED_AT`。
3. **备份目录**：`/vol1/1000/backups/zhiying/`。
4. **checkout**： detached HEAD，验证 `git rev-parse HEAD` = target SHA。
5. **构建**：`docker compose -f docker-compose.production.yml -f docker-compose.production.gpu.yml --env-file .env.production build`
6. **新镜像测试**：`NODE_ENV=test` 跑全部 Mock provider tests。
7. **migration**：单 web 先行，验证 tables/columns/indexes，验证幂等，验证旧 artifact hash，再全量 up。
8. **全量 up**：`docker compose -f docker-compose.production.yml -f docker-compose.production.gpu.yml --env-file .env.production up -d`

## 13. 不得删除的历史 artifacts

- `793c80fa-9229-4551-bc05-960c727afa2e`（Visual Intent candidate）
- 所有 `narrative_beats` candidate artifacts
- 所有 `narration_plan_v2` candidate artifacts
- 污染项目 TTS 历史音频（audit-only，不得重用）
- `project_usage_events` 全量记录
- `generation_runs` / `generation_attempts` 全量记录

## 14. 最近一轮 Review 阻断项

- 无（K3 提交已全部本地 typecheck 通过；本次接力已补齐测试并修复 `ttsJobResultSchema` 对 `providerVersion`/`providerCommit` 的 optional 处理）。
