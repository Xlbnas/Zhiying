# M7 实施状态技术文档

> 面向开发与接力 agent 的技术状态文件，不是宣传介绍。
> 每次 milestone 完成或 production 部署后必须更新本文件。

## 1. 元信息

| 项 | 值 |
|---|---|
| 文档更新时间 | 2026-07-31T19:00Z（M7.3A.3 收口完成，待部署） |
| 当前 SHA | 待 commit/push 后回填 |
| 当前分支 | `m7` |
| origin/m7 SHA | 待 push 后回填 |
| 当前 production SHA | `e62f5c2af9702538163d4f7583f456cd900ca550` |
| 上一轮确认 production SHA | `e62f5c2af9702538163d4f7583f456cd900ca550` |

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
| **M7.3A.2 Image Durability + Narration Watch + DAG Authoritative + GPU Leases** | **DONE** | `e62f5c2` | durable asset gen job、activity controller、DAG 权威化、production_gpu lease |
| **M7.3A.3 Asset Commit Fence + Strict Idempotency + Lease-loss Fail-closed** | **DONE** | （本次 commit） | request fingerprint、Fence A/B、lease lost fail-closed、构建网络 runbook |

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
- **production candidate**：`793c80fa-9229-4551-bc05-960c727afa2e`
- **deployed**：是（production 部署后 content hash 未变）

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
- **deployed**：是（production smoke：Web env 无 DEEPSEEK_API_KEY/LLM_PROVIDER）

### 4.4 Workflow DAG — Authoritative Mutation Source（M7.3A.2）

- **artifact**：`project_stages` + DAG 节点注册表
- **主要代码路径**：
  - `src/lib/workflow/dag-shared.ts`（纯图：节点注册表/依赖边/reachability/`computeNewlyReadyAfterLock`）
  - `src/lib/workflow/dag.ts`（`computeWorkflowReadiness` / `listBusyResourceClasses`）
  - `src/lib/workflow/stages.ts`（`assertRunnable` / `affectedDownstream` / `applyDownstreamStaleTx` 改为 DAG 驱动）
  - `src/lib/workflow/resource-classes.ts`
  - `src/components/workflow/shared.ts`（`nextStageAfter` 仅用于 display 顺序）
- **DAG 泳道**：
  - 视觉规划（API）：`narration_beat_map → visual_breakdown → shot_list → scenes`
  - 旁白/音频（TTS/GPU）：`narration_plan → narration_tts → narration_audio_manifest → subtitle_timing`
  - 素材：`scenes → assets`
  - 汇合：`scenes + narration_audio_manifest + subtitle_timing → timing_reconciliation → render`
- **权威化变更**：
  - `assertRunnable`：只检查 `directStageDependencies`（DAG 边），不再用数组前缀。
  - `affectedDownstream` / `applyDownstreamStaleTx`：使用 `downstreamStageNodes`（DAG reachability），并行兄弟（如视觉/音频分支）不再互相 stale。
  - `handleLocked`：不再调用 `nextStageAfter`；改为通过 `computeNewlyReadyAfterLock` 确定新 ready 节点，多个 ready 时并列显示，不自动只跳到数组中的视觉下一项。
  - `WORKFLOW_STAGES` 保留仅用于 DB enum、显示顺序、旧项目兼容。
- **GPU 互斥组**：`tts_gpu` / `render_gpu` / `local_image_gpu` 共享 production_gpu，并发上限 1。
- **deployed**：否（待本次 deployment）

### 4.5 Durable Image Generation Job（M7.3A.2）

- **artifact**：`asset_generation_jobs` 表
- **主要代码路径**：
  - `src/lib/assets/generation-jobs.ts`（job 生命周期）
  - `src/app/api/projects/[id]/assets/generate/route.ts`（enqueue-only，不直接调 provider）
  - `src/worker/asset-generation-executor.ts`（Worker claim + 执行）
  - `src/lib/assets/providers/generated/apiyi.ts`（connect timeout vs response timeout 分离）
- **设计**：
  - Web route 验证 + enqueue（202）；客户端用 `requestId`（crypto.randomUUID()）确保双击只产生一个 job。
  - requestId UI 生命周期（`src/components/workflow/asset-request-id.ts`）：同一「生成」点击生命周期内复用同一 requestId；任务到达终态（succeeded/failed/indeterminate）后 release，显式「重新生成」才创建新 requestId。
  - Worker 原子 claim job → 调 APIYi → 持久化 provider request ID / usage → 写入 candidate → terminal finalize。
- **超时语义**：
  - `APIYI_CONNECT_TIMEOUT_MS`（undici `Agent.connectTimeout`）：仅 TCP/TLS connect。
  - `APIYI_RESPONSE_TIMEOUT_MS`（AbortController 整体 deadline）：默认 300s，覆盖整个同步 generateContent（headers 等待 + 模型生成 + body 读取，中途不 reset）。
  - 删除了没有执行路径的 `PROVIDER_POLL_TIMEOUT` 语义。
  - 超时后 job → indeterminate，billing_status=unknown，相同 requestId 不自动再调。
- **错误码**：`PROVIDER_CONNECT_TIMEOUT` / `PROVIDER_RESPONSE_TIMEOUT` / `IMAGE_DECODE_FAILED` / `PROVIDER_TERMINAL_FAILURE` / `PROVIDER_RESULT_INDETERMINATE`。仅存在真实对应阶段时记录。
- **billing**：区分 `confirmed_zero` / `confirmed_charged` / `unknown_billing`。不得把"没有 usage event"解释为 ¥0。
- **S001-R01**：保留全部旧状态和 metadata，不删除、不覆盖。`billing_status=unknown`，`failure_phase` 标注 inferred。不自动真实重试。
- **deployed**：否（待本次 deployment）

### 4.6 Narration Activity Controller（M7.3A.2）

- **方式**：单一 `useActivityController` Hook（`src/components/workflow/use-activity-controller.ts`），纯逻辑在 `activity-controller-logic.ts`，框架无关可单测。
- **行为**：
  - `notifyMutation()` 被 NarrationPanel 的任何 mutation（generate/cancel/build）调用后，立即刷新 activity 并启动 watch。
  - 停止条件：至少成功刷新一次，连续两次返回无 running/queued 任务，且 audio/subtitle 已进入稳定终态。
  - hidden 页面轮询降至 15s；恢复 visible 立即刷新并恢复 2s。
  - 网络失败退避：2s → 4s → 8s → 最大 15s；成功后恢复 2s。
  - unmount 时清理 timer，禁止旧闭包持续请求。
- **主要代码路径**：
  - `src/components/workflow/activity-controller-logic.ts`
  - `src/components/workflow/use-activity-controller.ts`
  - `src/components/workflow/WorkflowWorkspace.tsx`
  - `src/components/workflow/NarrationPanel.tsx`
  - `src/app/api/projects/[id]/activity/route.ts`
- **与 /stages 轮询的关系**：Activity response 已包含 stages；当 activity controller 启用后，WorkflowWorkspace 不再并行每 2s 请求 `/stages`；只保留一次初始 `/stages` fetch 或使用 `activity.stages`。
- **测试**：`scripts/test-narration-activity-watch.ts`（22 PASS）覆盖初始无任务→mutation 启动 watch→running→succeeded→终态停止→hidden 降频→错误退避→不重复请求。
- **deployed**：否（待本次 deployment）

### 4.8 M7.3A.3 Asset Generation Commit Fence（本轮）

- **Strict request idempotency**：`asset_generation_jobs.request_fingerprint`（sha256 over
  projectId/sceneId/requirementId/normalizedPrompt/provider/model/resourceClass/
  sourceScenesVersionId/sourceRequirementHash）。相同 requestId + 相同 fingerprint →
  reused；不同 → `REQUEST_ID_CONFLICT`（HTTP 409，列差异字段，零 provider call，
  不修改旧 job）。历史无 fingerprint 行按字段级兼容判定并确定性回填。
- **Fence A（provider 前）**：active scenes version + exact requirement hash 与 job
  冻结快照一致；不一致 → SOURCE_STALE（confirmed_zero，provider calls=0）。
- **Fence B（provider 返回后）**：source 漂移或 production_gpu lease 丢失 → 结果仍
  append-only 保存为 historical asset（`assets.provenance_json`：source version/hash/
  jobId/requestId/relevance/staleReason），job succeeded + `result_relevance=stale`，
  不清除当前 requirement 的失败/readiness 状态，不自动重试，不自动重新计费调用。
- **resolver**：`buildProjectResolution` 改用 `listLatestAssetGenerationJobsByRequirement`
  （复合 key `scene_id:requirement_id`）；generated candidate 须 source 匹配
  （sceneId + requirementId + sourceScenesVersionId + sourceRequirementHash），
  stale 候选进入 `staleGeneratedCandidates`（UI 审计展示）；新增
  `latestGenerationAttempt` 技术详情。
- **lease-loss fail-closed**：统一 `createResourceLeaseHeartbeat`（`src/lib/resources/
  lease-heartbeat.ts`）供 TTS / Render / local image 共用。heartbeat 返回 false →
  lost：TTS abort synthesize + requeue（本地 GPU 无计费）；render abort + 不提交
  final success（RESOURCE_LEASE_LOST）；local image 结果按 stale historical 保留。
  Executor 不再执行 normal lease release（scheduler 唯一 claim，job-runner finally
  唯一 release）。
- **构建网络固化**：`scripts/production-build-network.sh`（start/check/stop）+ 
  `docs/PRODUCTION_BUILD_NETWORK.md` + 根目录 `AGENTS.md`。宿主机 Docker build 用
  `--network=host` + `--add-host remotion.media:127.0.0.1` + nginx:alpine+socat
  CONNECT 隧道（经 127.0.0.1:7890 代理）+ `APT_MIRROR`/`NPM_REGISTRY` 镜像源。
- **deployed**：否（待本次 deployment）

### 4.8 M7.3A.3 Asset Generation Commit Fence（本轮）

- **Strict request idempotency**：`asset_generation_jobs.request_fingerprint`（sha256 over
  projectId/sceneId/requirementId/normalizedPrompt/provider/model/resourceClass/
  sourceScenesVersionId/sourceRequirementHash）。相同 requestId + 相同 fingerprint →
  reused；不同 → `REQUEST_ID_CONFLICT`（HTTP 409，列差异字段，零 provider call，
  不修改旧 job）。历史无 fingerprint 行按字段级兼容判定并确定性回填。
- **Fence A（provider 前）**：active scenes version + exact requirement hash 与 job
  冻结快照一致；不一致 → SOURCE_STALE（confirmed_zero，provider calls=0）。
- **Fence B（provider 返回后）**：source 漂移或 production_gpu lease 丢失 → 结果仍
  append-only 保存为 historical asset（`assets.provenance_json`：source version/hash/
  jobId/requestId/relevance/staleReason），job succeeded + `result_relevance=stale`，
  不清除当前 requirement 的失败/readiness 状态，不自动重试，不自动重新计费调用。
- **resolver**：`buildProjectResolution` 改用 `listLatestAssetGenerationJobsByRequirement`
  （复合 key `scene_id:requirement_id`）；generated candidate 须 source 匹配
  （sceneId + requirementId + sourceScenesVersionId + sourceRequirementHash），
  stale 候选进入 `staleGeneratedCandidates`（UI 审计展示）；新增
  `latestGenerationAttempt` 技术详情。
- **lease-loss fail-closed**：统一 `createResourceLeaseHeartbeat`（`src/lib/resources/
  lease-heartbeat.ts`）供 TTS / Render / local image 共用。heartbeat 返回 false →
  lost：TTS abort synthesize + requeue（本地 GPU 无计费）；render abort + 不提交
  final success（RESOURCE_LEASE_LOST）；local image 结果按 stale historical 保留。
  Executor 不再执行 normal lease release（scheduler 唯一 claim，job-runner finally
  唯一 release）。
- **构建网络固化**：`scripts/production-build-network.sh`（start/check/stop）+ 
  `docs/PRODUCTION_BUILD_NETWORK.md` + 根目录 `AGENTS.md`。宿主机 Docker build 用
  `--network=host` + `--add-host remotion.media:127.0.0.1` + nginx:alpine+socat
  CONNECT 隧道（经 127.0.0.1:7890 代理）+ `APT_MIRROR`/`NPM_REGISTRY` 镜像源。
- **deployed**：否（待本次 deployment）

### 4.7 Durable GPU Resource Lease（M7.3A.2）

- **artifact**：`resource_group_leases` 表（`UNIQUE(resource_group)`）
- **主要代码路径**：
  - `src/lib/resources/leases.ts`（claim / heartbeat / release / recovery）
  - `src/lib/scheduler.ts`（`claimNextAnyJob` 在 claim GPU 任务前先原子取得 lease）
  - `src/lib/workflow/dag.ts`（`listBusyResourceClasses` 以 lease 为准，兼容旧数据无 lease 过渡）
  - `src/worker/job-runner.ts`（finally 释放 lease）
  - `src/worker/tts-executor.ts`（内部 finally 释放 lease）
- **设计**：
  - `claimResourceLease` 使用 `INSERT … ON CONFLICT(resource_group) DO UPDATE WHERE …` 实现原子 UPSERT。
  - `lease_expires_at` 过期才允许覆盖；同 worker+job 重入允许。
  - 任务期间周期性 heartbeat：TTS executor 在现有 5s 定时器内同时续约 resource lease（job 级 heartbeat 保留）；asset executor 在 `provider.generate` 执行期间每 2s 续约 lease+job。
  - 租约时长 `ZHIYING_RESOURCE_LEASE_MS`（默认 10min）、asset 心跳间隔 `ZHIYING_ASSET_HEARTBEAT_MS`（默认 2s）可经 env 覆盖（测试用短 TTL 实证长时间任务续约）。
  - 任何终态（succeeded/failed/cancelled/requeued/shutdown）均释放 lease。
  - `recoverStaleTtsJobs` 回收 zombie running 时同时释放 lease。
  - `llm_api` / `remote_image_api` 不需要 production_gpu lease；可与 TTS 并行。
- **resource readiness 修正**：
  - `gpuOccupied` 由有效 lease 或兼容旧数据的 running GPU job 推导。
  - queued ≠ 占用资源；只有 running/leased 才算占用。
  - UI `waiting_resource` 表示依赖满足但 lease 不可得。
- **测试**：`scripts/test-workflow-resource-leases.ts`（48 PASS）覆盖双 Worker 互斥、heartbeat、过期回收、LLM+TTS 并行、GPU 组内互斥、**长时间任务（>lease TTL）期间 heartbeat 续约实证（L7/L8）**。
- **deployed**：否（待本次 deployment）

## 5. 当前正在进行的工作

- M7.3A.3 收口完成（代码+测试+文档），全量验证绿。
- 待完成：production 备份、部署、verification（本次执行）。
- 下一步：M7.3B（明确不在本次范围）。

## 6. 尚未完成 TODO

- [ ] Production 部署（本次 M7.3A.2 待执行）
- [ ] M7.3B — Visual Sequences / Shots（明确禁止在本次执行）
- [ ] M7.4 — Timing Reconciliation v2
- [ ] M7.5 — Asset Bindings 迁移
- [ ] M7.6 — M7 Pipeline Snapshot
- [ ] M7.7 — Storyboard
- [ ] M7.8 — Animatic
- [ ] M7.9 — Editorial Gate / Final Render

## 7. 已冻结架构决策

- Visual Intent 永远是 candidate，不 current/selected/active/locked，不触发下游。
- Narrative Beats 永远是 candidate，不进入 active pipeline。
- 旧 Visual Intent candidate `793c80fa-9229-4551-bc05-960c727afa2e` 只读 revalidate，不修改。
- Worker secret boundary：Web 不持有 `DEEPSEEK_API_KEY` / `LLM_PROVIDER`。
- GPU 互斥组 `tts_gpu` / `render_gpu` / `local_image_gpu` 并发上限 1；跨 Worker 通过 durable DB lease 强制。
- APIYi 是同步 generateContent（非异步 task+poll）；`PROVIDER_POLL_TIMEOUT` 不做真实 poll path。
- 图片生成：Web 只 enqueue（202），Worker claim + 执行；requestId 确保幂等。
- 本地 timeout 后不自动重新计费调用；`billing_status` 区分 confirmed/unknown。
- 不切换任何项目到 m7；`projects` 仍为 m6；snapshot pointer 仍为 NULL；无 M7 pipeline snapshot。

## 8. 已知事故和修复

| 事故 | 修复 | 关键 commit |
|---|---|---|
| DSL 进入 M6 TTS | 增加 DSL gate，typed narration 不进入 M6 TTS | `d915d58` |
| generation 双计费风险 | `generation_runs` (project_id, stage, request_id) 唯一 + BEGIN IMMEDIATE claim | `d915d58`, `5321f57` |
| candidate/active 混淆 | 明确 candidate 与 active pipeline 分离 | `a657fbd` |
| Worker secret boundary | Web 不调用 provider，Worker 持有凭据 | `311dd36` |
| AI image timeout 误判 | 30s AbortController 覆盖整个同步生成；TCP connect timeout 与 response deadline 分离 | `31a3efb`, M7.3A.2 |
| APIYi connect timeout 覆盖同步生成 | undici Agent.connectTimeout + 独立 response deadline | M7.3A.2 |
| 图片生成无幂等 | `asset_generation_jobs` (project_id, scene_id, requirement_id, request_id) UNIQUE | M7.3A.2 |
| Narration activity 轮询启动竟态 | `useActivityController` + `notifyMutation` 立即启动 watch | M7.3A.2 |
| DAG 未成为状态机真相 | `assertRunnable`/`affectedDownstream`/`handleLocked` 改为 DAG 驱动 | M7.3A.2 |
| GPU 互斥仅单进程内存 | `resource_group_leases` + scheduler lease claim 原子化 | M7.3A.2 |
| 长时间 GPU 任务 lease 过期被抢占 | TTS/asset executor 执行期间周期性 heartbeat resource lease（TTS 并入 5s 定时器；asset 生成期间 2s 心跳）；`ZHIYING_RESOURCE_LEASE_MS`/`ZHIYING_ASSET_HEARTBEAT_MS` 可覆盖 | 本次收尾 commit |
| 图片生成终态后 UI 复用旧 requestId 无法重试 | 新增 `asset-request-id.ts` 生命周期模块；`VisualAssetsPanel` 终态（succeeded/failed/indeterminate）release requestId | M7.3A.2 收尾 |
| 同 requestId 被不同逻辑请求复用 | `request_fingerprint`（9 字段 sha256）+ REQUEST_ID_CONFLICT(409)；历史行字段级兼容 + 确定性回填 | M7.3A.3 |
| resolver 用旧 job 覆盖新 job | `buildProjectResolution` 改用复合 key latest helper | M7.3A.3 |
| 生成期间 scenes 漂移的 candidate 冒充当前 | Fence B：结果保存为 stale historical（provenance_json + result_relevance=stale），resolver 过滤 | M7.3A.3 |
| lease 丢失后任务仍提交成功 | `createResourceLeaseHeartbeat` 统一心跳；TTS/render abort fail-closed，image 结果降级 stale historical | M7.3A.3 |
| executor 与 runner 双重 lease 释放 | executor 移除 normal release；runner finally 唯一释放；直接调用 executor 的测试模拟 runner 生命周期 | M7.3A.3 |
| NAS 构建 remotion 下载挂起 | 构建网络 runbook：CONNECT 隧道 + `--network=host` + `--add-host` + 镜像源（`docs/PRODUCTION_BUILD_NETWORK.md`） | M7.3A.3 |

## 9. 当前已知技术债

- APIYi 图像生成是同步 HTTP，本地 timeout 后无法真正向 provider 轮询 late result；相同 requestId 不自动再调，需新 requestId 显式 retry。
- `asset_resolution_state.metadata` 为新增列，老数据无 failure phase，resolver 会从 `project_usage_events` 兜底回填。
- S001-R01 旧事故 `billing_status=unknown`、`failure_phase=inferred`，不删除不重试。
- `ParallelLanes` 组件目前依赖项目全局 CSS class，未内联样式。
- `nextStageAfter` 仅用于 display 顺序，不再用于业务门控。
- agentvm 无系统 ffmpeg/ffprobe；Remotion 自带的 ffprobe 可用但 ffmpeg 不支持 raw PCM 输出，`tryFinalizeNarrationAudio` 中的 normalization 在 agentvm 测试中会失败（production Docker 镜像自带完整 ffmpeg）。

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
- `scripts/test-llm-dispatch.ts`
- `scripts/test-workflow-stages.ts`
- `scripts/test-m6310-usage.ts`

### 11.2 M7.3A.2/M7.3A.3 新增/扩展测试

- `scripts/test-asset-generation-durability.ts`（53 PASS）：幂等/超时/indeterminate/billing/append-only + T7 provenance + T8 requestId 生命周期 + **T9 mid-flight source drift（Fence B）** + **T10 lease lost 降级 stale**
- `scripts/test-workflow-dag-parallelism.ts`（15 PASS）：DAG 权威依赖/双分支 ready/并行不互 stale
- `scripts/test-workflow-resource-leases.ts`（53 PASS）：GPU 互斥/heartbeat/过期回收/LLM+TTS 并行 + L7/L8 长时间心跳 + **L9 lease lost abort/requeue**
- `scripts/test-narration-activity-watch.ts`（28 PASS）：activity 控制器 + W9 stable-stop 精确规则
- `scripts/test-image-request-fingerprint.ts`（18 PASS）：strict request idempotency（reuse/409 prompt/model/version/hash/规范化/历史行兼容）
- `scripts/test-asset-resolver-candidate-e2e.ts`（25 PASS）：resolver/bind E2E（candidate_waiting→bind→ready、不串 requirement/scene、stale 过滤、latest attempt 选择）
- `scripts/test-production-build-network.sh`（7 PASS）：构建网络脚本逻辑（dry-run/端口占用拒绝/退出码，不访问付费服务）

### 11.3 本轮 agentvm 测试结果

| 脚本 | PASS | FAIL | 备注 |
|---|---|---|---|
| `test-asset-generation-durability.ts` | 53 | 0 | M7.3A.2/3（含 T7-T10） |
| `test-workflow-dag-parallelism.ts` | 15 | 0 | M7.3A.2 新增 |
| `test-workflow-resource-leases.ts` | 53 | 0 | M7.3A.2/3（含 L7-L9） |
| `test-narration-activity-watch.ts` | 28 | 0 | M7.3A.2（含 W9） |
| `test-image-request-fingerprint.ts` | 18 | 0 | M7.3A.3 新增 |
| `test-asset-resolver-candidate-e2e.ts` | 25 | 0 | M7.3A.3 新增 |
| `test-production-build-network.sh` | 7 | 0 | M7.3A.3 新增（脚本逻辑） |
| `test-m73a-visual-intent.ts` | 184 | 0 | 含旧 candidate revalidate |
| `test-m72-narrative-beats.ts` | 125 | 0 | 含 generation run |
| `test-m721-generation-singleflight.ts` | 99 | 0 | 幂等/并发/terminal |
| `test-m6-dsl-gates.ts` | 40 | 0 | DSL gate |
| `test-m711-activation.ts` | 58 | 0 | snapshot gate |
| `test-m71-compiler.ts` | 79 | 0 | typed narration v2 |
| `test-m71-schema.ts` | 29 | 0 | plan schema |
| `test-m71-subtitle.ts` | 15 | 0 | subtitle cue |
| `test-m71-tts.ts` | 25 | 0 | fingerprint/payload |
| `test-m71-db.ts` | 46 | 0 | DB 集成 |
| `test-m6313-narration.ts` | 39 | 0 | narration sanitation |
| `test-m3a-narration-plan.ts` | 50 | 0 | plan build/stale |
| `test-m3b-tts.ts` | 99 | 0 | 完整 ffmpeg（/tmp 静态 GPL 构建）下全绿；normalization 不再失败 |
| `test-m3c-subtitle-timing.ts` | 82 | 0 | 同上环境限制消除 |
| `test-llm-dispatch.ts` | 57 | 0 | Worker dispatch |
| `test-workflow-stages.ts` | 56 | 0 | 工作流状态机/DAG 兼容 |
| `test-m6310-usage.ts` | 54 | 0 | usage 统计 |
| `pnpm typecheck` | ✅ | - | `tsc --noEmit` 通过 |
| `pnpm build` | ✅ | - | Next.js 15 生产构建通过 |

> agentvm 无系统 ffmpeg；使用 Remotion 自带的 ffprobe 可用，但自带的 ffmpeg 不支持 `-f s16le` raw PCM 输出格式，`tryFinalizeNarrationAudio` 中的 normalization step 在 agentvm 测试中会失败。production Docker 镜像自带完整 ffmpeg，不影响 production。

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
   - asset generation jobs
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
7. **migration**：单 web 先行，验证 tables/columns/indexes（`asset_generation_jobs`、`resource_group_leases`），验证幂等，验证旧 artifact hash，再全量 up。
8. **全量 up**：`docker compose -f docker-compose.production.yml -f docker-compose.production.gpu.yml --env-file .env.production up -d`

## 13. 不得删除的历史 artifacts

- `793c80fa-9229-4551-bc05-960c727afa2e`（Visual Intent candidate）
- 所有 `narrative_beats` candidate artifacts
- 所有 `narration_plan_v2` candidate artifacts
- 污染项目 TTS 历史音频（audit-only，不得重用）
- `project_usage_events` 全量记录
- `generation_runs` / `generation_attempts` 全量记录

## 14. 最近一轮 Review 阻断项

M7.3A.2 Review 全部阻断项已修复（第二轮 hardening）。接续复核（独立验证）与补齐：

| 阻断项 | 复核结论 | 处理 |
|---|---|---|
| P0: APIYi → local_image_gpu 错误分类 | ✅ 已解决（route 按 provider 决定 resourceClass） | 无改动 |
| P0: asset executor double-claim lease | ✅ 已解决（scheduler 唯一 claim，executor 不自行 claim） | 无改动 |
| P0: generated candidate requirement 缺失 | ⚠️ 代码已冻结 requirement_json+hash，但无测试 | **补 T7 实证**（hash 一致性 / asset.requirement_json 与快照全等 / exact 字段） |
| P0: response deadline per-phase 重置 | ✅ 已解决（单一 AbortController 覆盖到 body 读完，T6b 实证不 reset） | 无改动 |
| P1: long job lease TTL 不足 | ❌ 原实现不完整：TTS 从不 heartbeat resource lease；asset 只在 generate 后 heartbeat 一次 | **修复**：TTS 5s 定时器内续约 lease；asset 生成期间 2s 心跳；`ZHIYING_RESOURCE_LEASE_MS`/`ZHIYING_ASSET_HEARTBEAT_MS` 可覆盖；**补 L7/L8 实证**（>TTL 期间 lease 存活、竞争者被挡、结束后释放） |
| P1: latest job selection 错误 | ✅ 已解决（Map 去重） | 无改动 |
| P1: activity controller 停止条件不完整 | ⚠️ 代码正确（emptyStreak>=2 + terminal 含 stale/not_ready），测试未钉死规则 | **补 W9 实证**（streak=1 不停止 / running 重置 / 连续两次才停） |
| P1: activity API asset gen resourceClass 硬编码 | ✅ 已解决（从 job.resource_class 列读取） | 无改动 |
| 测试更新 | ⚠️ 服务端幂等已覆盖，UI requestId 生命周期有 bug（终态后不复用新 id，无法重试） | **修复**：`asset-request-id.ts` + VisualAssetsPanel 终态 release；**补 T8 实证** |

## 15. 本轮 Production Smoke 关键证据

已部署：`e62f5c2af9702538163d4f7583f456cd900ca550`（M7.3A.2 收尾），备份 `m73a2-20260731T140940Z`（DB SHA `256dcfe6…c2b980`，integrity=ok）。

| 检查项 | 结果 | 证据 |
|---|---|---|
| 本地/LAN 3210 API/UI 200 | ✅ | `127.0.0.1:3210/api/projects`=200；`192.168.31.56:3210` API/UI 均 200 |
| Web 不持有 LLM secret | ✅ | web env 仅 `APIYI_API_KEY=`；`DEEPSEEK_API_KEY`/`LLM_PROVIDER` 仅存在于 worker |
| Worker LLM/APIYi 配置健康 | ✅ | worker env 含 DEEPSEEK/LLM_PROVIDER/APIYI；启动日志正常 |
| RTX 2080 Ti / ffprobe / NVENC 正常 | ✅ | worker 内 `RTX 2080 Ti 14261MiB`、ffprobe 5.1.9、`libnvidia-encode.so.1` 存在；日志 `GPU mode: hardware(angle-egl), NVENC: enabled` |
| 容器 healthy | ✅ | zhiying-web / zhiying-worker / indextts2-adapter 均 `e62f5c2` + healthy |
| projects 仍为 m6 / snapshot 指针 NULL | ✅ | 全项目 `pipeline_version=m6`、`m7_pipeline_snapshot_id` 空 |
| Freud artifact hash 不变 | ✅ | narration_plan_v2 `01ff6fbd…` 与 narrative_beats `e226cadd…` 规范化 sha256 与备份全等 |
| S001-R01 旧事故保留 | ✅ | S014-R01 generation_failed(apiyi) 保留；S001 历史 generated assets×2；40 条 bindings 保留；旧 candidate `793c80fa…` 规范化内容与备份全等（备份 JSON dump 转义差异导致 raw hash 不同，语义相等） |
| 无意外付费请求 | ✅ | 17:15 后 `project_usage_events`=0；llm/generation 状态为历史存量；`asset_generation_jobs`=0 行、`resource_group_leases`=0 行 |
| logs 无 migration/SQLite/dispatch/lease 错误 | ✅ | web/worker 日志无相关 error（仅 Node SQLite experimental warning） |
| migration 单 web 先行验证 | ✅ | 新表/索引/5 个 additive 列/UNIQUE 约束就位；幂等重启 healthy；`BACKUP_COMPLETED_AT`(14:11:45Z) < `CHECKOUT_STARTED_AT`(14:12:11Z) |
| 新镜像 mock 测试 | ✅ | 容器内 11 套件全绿（scripts 以宿主同 SHA 挂载，runner 镜像不含 scripts/） |
