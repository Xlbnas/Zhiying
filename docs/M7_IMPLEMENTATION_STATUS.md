# M7 实施状态技术文档

> 面向开发与接力 agent 的技术状态文件，不是宣传介绍。
> 每次 milestone 完成或 production 部署后必须更新本文件。

## 1. 元信息

| 项 | 值 |
|---|---|
| 字段 | 值 |
|---|---|
| statusUpdatedAt | 2026-08-03T14:00Z（M7.3B FROZEN；**TTS-A FROZEN**；**TTS-B FROZEN（独立 Review PASS）**；**TTS-C.0.R4 architecture closure completed，pending independent Review PASS；TTS-C runtime implementation not started；TTS-C.1A not started**） |
| reviewedCodeSHA | `e3bd60a879cb279c6bd19b1c2d5013073b7155d3`（M7.3B final code/runtime；M7.3B deployment evidence docs HEAD 为 `044ac23e2524d53f41d223c37d16619425b21182`；M7.3A frozen code 为 `aa3f814…`） |
| productionRuntimeSHA | `86f7f52b2f81d20d352de6d3189792c25e6cfe29`（TTS-B.R3 部署后容器镜像实际代码 SHA） |
| productionHostCheckoutSHA | `86f7f52b2f81d20d352de6d3189792c25e6cfe29`（宿主机 checkout；可因 docs/ops commit 高于 runtime） |
| 当前分支 | `m7` |
| 实时 origin/m7 HEAD | 以 `git rev-parse origin/m7` 为准（不硬编码为「永远当前」） |

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
  - `DEEPSEEK_API_KEY` / `LLM_PROVIDER`：仅注入 `zhiying-worker`（Web 不持有）。
  - `APIYI_API_KEY`：当前 compose 注入 `zhiying-web` 与 `zhiying-worker`。
    Web 仅用于 provider capability/health 检查与 enqueue（不执行生成）；Worker 执行真实 APIYi provider 调用。
  - indextts2-adapter 不持有上述 secret。
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
| **M7.3A.3 Asset Commit Fence + Strict Idempotency + Lease-loss Fail-closed** | **DONE** | `7a0aeb7`/`ba90d98`/`67c6dba`/`07b39dc`（runtime `07b39dc`，docs `09c5b64`/`4bf4be6`） | request fingerprint、Fence A/B、lease lost fail-closed、构建网络 runbook |
| **M7.3A.3.1 Atomic Candidate Commit + Server-side Bind Gate** | **DONE** | `df99384`/`32bc8b3`/`2131c6a`/`d7bc9e1`/`9dc3c6a`（runtime `9dc3c6a`，docs `2cd2b92`/`e337b61`，ops `6709882`） | 原子 commit、服务端 stale 绑定门禁、精确 source loader、完整请求快照、render bundle lease |
| **M7.3A.3.2 Atomic Candidate Binding + Monotonic Image Billing + Render Heartbeat Cleanup** | **DONE** | `528f5c9`/`a8056b4`/`b243233`/`6ddf720`/`8eb23d0`（runtime `8eb23d0`） | 原子绑定、三态 provenance、billing 单调、provider result 审计、heartbeat dispose、SHA 元数据模型 |
| **M7.3A.3.3 Legacy Binding Safety + Charged Provider Result Audit + Render Bundle Exit Classification** | **FROZEN** | `e40de12`/`80f8d11`/`ead3a23`/`c0b6f8a` + R1 `695dc02` + R2 `f7d786f` + R3 `aa3f814`（runtime `aa3f814`） | legacy 目标可验证门禁、provider 返回即 charged、usage 证据只追加、bundle 实时状态退出、首次写入 metadata 危险键过滤；**独立 Review PASS（final code/runtime `aa3f814…`，deployment evidence docs `36ff32e…`）** |
| **M7.3B Visual Sequences / Shots Contract + DAG Foundation** | **FROZEN（独立 Review PASS）** | `96ddcc8`/`c7cbba0`/`468d0c1`/`85e826c` + R1 `a71f0fe` + R2 `e3bd60a`（final code/runtime `e3bd60a879cb279c6bd19b1c2d5013073b7155d3`，deployment evidence docs HEAD `044ac23e2524d53f41d223c37d16619425b21182`） | visual-sequences@1.0 / shots@1.0 契约、exact-source provenance、确定性语义校验、candidate generation（Worker LLM dispatch + commit-time source fence）、dispatch 幂等/canonical timeline/usable-candidate DAG；冻结语义见 §7 |
| **TTS-A Immutable Custom Voice Library Foundation** | **FROZEN（独立 Review PASS）** | final code/runtime `1460efd12c9f4bbb3fa4188757deeff3c8566c99`；deployment evidence docs `2fc7ffb460dc36cd44fdcb3c5b98e9e09e9e392f` | voice-profile@1.0 / voice-profile-revision@1.0、immutable revision（DB trigger ABORT）、安全音频摄取（canonical WAV 48k/mono/pcm_s16le）、exact validator（单一真相源）、bounded multipart streaming（@fastify/busboy 3.2.0）、损坏 revision 不得 reused（409 revision_unusable）、staging/intermediate symlink 防护、**R2：staging ownership 单一持有者 + best-effort cleanup + multipart I/O fail containment**、Voice Library API + `/settings/voices` 最小 UI；设计文档 `docs/TTS_A_VOICE_LIBRARY_DESIGN.md`；**未绑定项目、未生成 TTS、TTS-B/C not started** |

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
- **deployed**：是（e62f5c2）

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
- **deployed**：是（e62f5c2）

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
- **deployed**：是（e62f5c2）

### 4.7 Durable GPU Resource Lease（M7.3A.2）

- **artifact**：`resource_group_leases` 表（`UNIQUE(resource_group)`）
- **主要代码路径**：
  - `src/lib/resources/leases.ts`（claim / heartbeat / release / recovery）
  - `src/lib/scheduler.ts`（`claimNextAnyJob` 在 claim GPU 任务前先原子取得 lease）
  - `src/lib/workflow/dag.ts`（`listBusyResourceClasses` 以 lease 为准，兼容旧数据无 lease 过渡）
  - `src/worker/job-runner.ts`（finally 释放 lease）
  - `src/worker/tts-executor.ts` / `src/worker/asset-generation-executor.ts`（只消费 lease-lost 信号，不执行 normal release）
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
- **测试**：`scripts/test-workflow-resource-leases.ts`（63 PASS）覆盖双 Worker 互斥、heartbeat、过期回收、LLM+TTS 并行、GPU 组内互斥、长时间任务心跳续约（L7/L8）、lease lost fail-closed（L9）、render bundle 阶段 lease 保活（L10）。
- **deployed**：是（e62f5c2）

### 4.8 M7.3A.3 Asset Generation Commit Fence

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
- **deployed**：是（e62f5c2）

### 4.9 M7.3A.3.1 Atomic Candidate Commit + Server-side Bind Gate

- **服务端 stale 绑定门禁**（`src/lib/assets/bind.ts`）：带 `provenance_json` 的候选必须
  relevance=current + sourceScenesVersionId=active version + sourceRequirementHash=当前
  hash + 生成 job 存在且 result_asset_id/result_relevance/project/scene/requirement 全部
  匹配，否则 409（CANDIDATE_STALE / CANDIDATE_SOURCE_STALE）；历史无 provenance 资产
  兼容（legacyProvenance=true），不批量伪造。
- **原子 commit**（`src/lib/assets/commit.ts` `commitGeneratedAssetResultTx`）：Fence B
  判定 + asset 落库 + job 终态 + resolution state 清除在同一 BEGIN IMMEDIATE；判定读取
  事务内最新 active source（无 TOCTOU）；事务失败删除本轮新文件、不动历史 asset。
- **精确 source loader**（`loadActiveScenesSource`）：project_stages.active_version JOIN
  project_versions 精确读取，fail-closed（缺失 → 拒绝，不 latest fallback）；用于
  enqueue / Fence A / Fence B / bind gate / resolver。
- **完整请求快照**：`asset_generation_jobs.image_size/aspect_ratio/provider_config_version`
  enqueue 冻结；fingerprint 含 imageSize/aspectRatio/resourceGroup；Worker 从 job 快照
  调用 provider（禁止 env 重新推导）；provider.name !== job.provider → CONFIG_ERROR
  零调用；usage 也取快照。
- **Render lease 覆盖 bundle 阶段**：heartbeat 在 claim 后、ensureBundleLazy 前启动，
  覆盖 bundle+render 全程；bundle 期间 lost → 不进入 renderMedia。
  **技术债**：CPU bundle 阶段仍持有 production_gpu（未来可拆 cpu_compile → render_gpu
  两阶段以便 bundle 与 TTS 并行；该优化未实现，不得声称已完成）。
- **构建网络硬化**：脚本幂等（自有容器 running 时二次 start 直接通过）、socat 仅绑
  loopback、check 验证 listener+TLS(SNI)、代理 host 可配置。
- **deployed**：是（8eb23d0）

### 4.10 M7.3A.3.3 Final Safety Closure

- **legacy 目标可验证门禁**（bind.ts）：active scenes source 读取前置（所有 candidate 含 legacy）；
  legacy（provenance_json IS NULL）必须满足 scene_id 非空且匹配、requirement_json 合法且
  requirementId 匹配、active scenes 中 exact requirement 存在，否则 409
  LEGACY_CANDIDATE_TARGET_UNVERIFIABLE。strict 分支行为不变。bind 失败整体 rollback
  （旧 active binding / license / resolution state 均不动）。
- **provider 返回即 charged**：generate 返回非空 candidates 后立即锁定
  providerOutcome=confirmed_charged + returnedImageCount/actualModel/actualProvider/
  providerRequestId（函数级 hoist，catch 使用真实值，禁止重声明）；result validation
  （candidate.provider 等）失败 → PROVIDER_INVALID_RESPONSE：job failed、billing 保持
  charged、不保存 current asset、不自动重试。
- **usage 证据只追加**（finalizeImageGenerationUsage）：incoming undefined/null 时保留
  prior（providerRequestId/generationId/usageMetadata/actualModel/requestedModel/
  providerConfigVersion/assetId/imageCount/failurePhase）；charged 后既有 cost 非 null
  永远保留、cost null 保持 null（pricingUnavailable=true），不得被 imageCount=0 重算成 0。
- **render bundle 退出分类**（`src/lib/render/bundle-classify.ts` classifyBundleExit + controlExitKind）：
  优先级 lease lost > shutdown(requeue) > cancel(cancelled) > bundle_error；R2 改为
  `runBundlePhase(getState)` 实时读取 + bundle 后 fence（`controlExitKind` 全 false 才
  proceed）+ `runWithCleanup` 单 owner finally dispose heartbeat（`src/worker/index.ts`）。
- **deployed**：是（695dc02 R1 → f7d786f R2）

### 4.11 M7.3B Visual Sequences / Shots Contract + DAG Foundation

- **artifact kinds**：`visual_sequence_plan`（schemaVersion `visual-sequences@1.0`）/ `shot_plan`（schemaVersion `shots@1.0`）——kind 与冻结 snapshot ruleset（`m7-pipeline-snapshot.ts` `RULESET_V1_EXPECTED_KIND`）预声明一致；compilerVersion `1.0`；promptVersion `visual-sequences@1.0` / `shots@1.0`。
- **契约**：Sequence 只含 `sequenceId(Q001…)/chapter/beatIds/visualIntentIds`（视觉语义一律经 visualIntentId 引用，禁止复制 intent/strategy/authenticity/objective/subject/displayText/evidenceIds）；Shot 只含 `shotId(H001…)/sequenceId/chapter/unitIds/visualIntentId/transitionFromPrevious`——unitIds 是语义切片锚点，不是最终时间。
- **exact-source provenance**：Sequence source 记录 beats+intent+transitive narration/script 的精确 artifact ID + `sha256:` content hash（双源链必须完全一致，`SOURCE_CHAIN_MISMATCH` fail-closed）；Shots source 记录 sequences+beats+intent+narration/script 全链，且必须与 Sequence artifact 自身记录的 source 完全一致（`SHOT_SOURCE_MISMATCH`）。禁止 latest/current 猜来源。
- **确定性语义校验**：Sequence 18 条规则 / Shot 23 条规则，稳定机器码（`SEQUENCE_BEAT_COVERAGE_GAP`…`SHOT_TRANSITION_INVALID` 等）；`VISUAL_UNRESOLVED` 允许保留（非阻断 `SEQUENCE_NEEDS_REVIEW`/`SHOT_NEEDS_REVIEW` → classify `needs_review`），validator 零改写（禁止自动转 MG）。
- **candidate generation（Worker LLM dispatch）**：复用 `generation_runs/generation_attempts/generation_dispatch_jobs`（stage `m7_visual_sequences`/`m7_shots`）+ `llm_api` resourceClass；LLM proposal 只输出 `{sequences}`/`{shots}` body，wrapper/source/generation 由服务端确定性构造；`MAX_REPAIRS=2` attempt journal；**commit-time source fence**（落库事务内重读全部 source 行核对 hash，漂移 → `SOURCE_STALE` 终态、零 artifact 行）；sequences 的 dispatch `source_artifact_id` 为 `${beatsId}|${intentId}` 复合键。
- **M7 candidate DAG（`src/lib/m7-dag/`）**：`narration_plan_v2`/`narrative_beats`/`visual_intent_plan` → `visual_sequences` → `shots`；无反向边、无环（测试断言）；节点状态 `not_generated / generation_running / generation_failed / ready / needs_review / blocked`（优先级 running > ready > needs_review > generation_failed > blocked > not_generated）；candidate 分类状态 `current_candidate / stale_source / invalid_source / needs_review`（`current_candidate` 仅表示相对 exact source 未漂移，不代表 project current/active/locked）；与 M6 `WORKFLOW_NODES` 完全无关。
- **API**：`GET/POST /api/projects/[id]/visual-sequences`（POST body `{narrativeBeatsArtifactId, visualIntentPlanArtifactId, requestId}`）、`GET /api/projects/[id]/visual-sequences/[artifactId]`、`GET/POST /api/projects/[id]/shots`（POST body `{visualSequencesArtifactId, requestId}`）、`GET /api/projects/[id]/shots/[artifactId]`——202 queued/running、200 reused、409 terminal/conflict；Web 只 enqueue（零 secret），Worker 执行。
- **deployed**：是（6f109d0，2026-08-02；见 §15 本轮部署证据）。

### 4.12 M7.3B.R1 Review Closure（Dispatch Idempotency + Canonical Timeline）

独立 Review 判定 M7.3B FAIL，修复 5 项 blocker（本小节为修复记录；M7.3B 后续在 §4.13 修复后 Review PASS 冻结）：

1. **queued dispatch source conflict（P0，`src/lib/llm-generation/dispatch.ts`）**：`enqueueGenerationDispatch` 此前只在 generation_run 存在时比较 source；worker 未 claim 前只有 queued dispatch 时，同 requestId 不同 source 被错误返回 queued/running 而非 409。修复：单 BEGIN IMMEDIATE 内，对最终重读到的 dispatch row 在按 status 返回**之前**强制 `source_artifact_id` 一致性检查（queued/running/succeeded/failed/cancelled 一律适用）→ `RequestIdConflictError`。保持：same-source 幂等（同一 dispatchId）、run-level conflict、不新增 dispatch、不修改原 source、不调用 provider。
2. **Visual Sequence 全局 beat 顺序（P0，`visual-sequences/validate.ts`）**：新增 `SEQUENCE_BEAT_ORDER_MISMATCH`——`sequences.flatMap(beatIds)` 必须与 beats 顺序**逐项相同**（时间线顺序，不得排序比较）；与 gap/overlap/duplicate/within-sequence non-contiguous 并存（多 issue 允许）。
3. **Shot 全局 sequence/unit 顺序（P0，`shots/validate.ts`）**：新增 `SHOT_SEQUENCE_ORDER_MISMATCH`（shots 首次出现去重后的 sequence 顺序必须与 exact Visual Sequence artifact 逐项相同）与 `SHOT_UNIT_ORDER_MISMATCH`（`shots.flatMap(unitIds)` 必须与 canonical 时间线 sequences→beats→units 逐项相同）；删除无效的 `seenSeqOrder` 死变量。
4. **DAG usable-candidate 语义（P1，`m7-dag/readiness.ts`）**：dependency 缺失判定从"节点状态 ∈ {blocked, not_generated}"改为**usableCandidateCount**——eligible/current → usable；needs_review：visual_intent_plan 可用于 visual_sequences 与 shots（unresolved 在两层均非阻断）、visual_sequences 可用于 shots、narration_plan_v2 needs_review 不可用；stale/invalid → 不可用。上游 running/failed 且无可用 candidate → 下游 blocked；上游有旧合法 candidate 同时 regenerate running → 下游不被误判 blocked。
5. **reference ID schema（P1，`visual-sequences/schema.ts`、`shots/schema.ts`）**：`beatIds` 精确 `^B\d{3}$`、`visualIntentIds`/`visualIntentId` 精确 `^V\d{3}$`、`unitIds` 精确 `^N\d{3}$`（保留 Q/H 已有约束）；malformed reference 在 schema 层拒绝，exact-but-missing 合法格式 ID 仍由 semantic validator 报 NOT_FOUND。

### 4.13 M7.3B.R2 Review Closure（Dispatch Running-State + DAG Proof）

独立 Review 判定 M7.3B 仍 FAIL，修复 3 项（本小节为修复记录；修复后独立 Review PASS，M7.3B FROZEN）：

1. **dispatch-only running 状态（P1，`llm-generation/dispatch.ts` + 4 条 route）**：scheduler 已 claim dispatch（status=running）但 generation_run 尚未创建时，同 requestId+同 source 再 POST 此前错误返回 `status='queued'`。修复：`EnqueueDispatchResult` 的 queued variant 原样携带 `dispatchStatus: 'queued' | 'running'`，四条 route（narrative-beats / visual-intents / visual-sequences / shots）统一透出 `status: result.dispatchStatus`——不再硬编码 queued。不制造虚假 runId/retryAfterMs，不新建 run/dispatch，不调用 provider。
2. **run/dispatch 双持久 source fail-closed（P1，`llm-generation/dispatch.ts`）**：单 BEGIN IMMEDIATE 内统一读取 generation_run 与 generation_dispatch_jobs，在任何 status 返回之前执行三组一致性检查：input vs run、input vs dispatch、run vs dispatch（两者同时存在时）——任一组不一致 throw `SourceInvariantConflictError`（继承 `RequestIdConflictError` 保持 409 映射；错误明确标识发生冲突的持久 source，并 fail-closed；不选择任一 source 继续）。不修改/不删除/不覆盖任一持久 source，不重新生成，不调用 provider。正常同 source 行为保持：queued→queued、dispatch-only running→running、run running→running、succeeded→reused、failed/indeterminate→terminal。
3. **DAG 测试 fixture 隔离（P1，`m7-dag/readiness.ts` + `test-m73b-dag.ts`）**：导出纯判定 `isCandidateUsableForDownstream(sourceNode, candidateStatus, downstreamNode)`（含下游相关性检查：downstream 必须是 sourceNode 的真实 DAG 下游）；G1-G4 fixture 重构为"每条只缺目标 dependency"（G1/G2 前置 eligible beats、G3/G4 前置 plan+beats+intent 可用；G4 独立新项目，不再被 G3 queued dispatch 污染；blocker detail 精确断言只含目标 dependency）；G5 精确断言 old valid candidate 仍 usable + shots 保持 ready；G8 truth table 用纯函数锁定 9 项判定（含 narration needs_review 不可用、不相关 downstream false）。

## 5. 当前正在进行的工作

- **M7.3A 正式 FROZEN（独立 Review PASS）**：final code/runtime = `aa3f8145825f5a33542f54e90e661e0cccf3e692`；deployment evidence docs = `36ff32e3301f51bf054efbee029fc1e6115ad3f5`；independent Review = PASS。冻结语义见 §7。
- **M7.3B 正式 FROZEN（独立 Review PASS）**：final code/runtime = `e3bd60a879cb279c6bd19b1c2d5013073b7155d3`；deployment evidence docs HEAD = `044ac23e2524d53f41d223c37d16619425b21182`（§15.3）；independent Review = PASS。冻结语义见 §7「M7.3B 冻结语义」。
- **TTS-A 正式 FROZEN（独立 Review PASS）**：final code/runtime = `1460efd12c9f4bbb3fa4188757deeff3c8566c99`；deployment evidence docs = `2fc7ffb460dc36cd44fdcb3c5b98e9e09e9e392f`。冻结语义见 §7「TTS-A 冻结语义」；非阻断 hardening note 见 §7 末。
- **TTS-B 正式 FROZEN（独立 Review PASS）**：final code/runtime = `86f7f52b2f81d20d352de6d3189792c25e6cfe29`；deployment evidence docs = `eac6f2d67ed0c2c6723c9d77e9b4400e251cd6f1`；GitHub Actions 独立证据：run `30801164259` / job `M7 Quality Gate` / head SHA `86f7f52…` / completed / success / 27 suites / artifact `8850888730`（digest `sha256:0b7f7386…`）。冻结语义见 §7「TTS-B 冻结语义」。TTS-B 演变：R1（candidate 传播/DAG 双依赖/commit fence/UUID/archived replay/source 自洽）→ R2（commit-time Narration candidate fence、concurrent existing2 usable 裁决、graph 故障注入、GitHub CI）→ R3（**transaction-atomic Narration fence**：权威判断移入 final BEGIN IMMEDIATE、E20 竞态测试 + mutation 验证、CI pipefail 失败退出码传播）。
- **TTS-C.0.R4 architecture closure completed（pending independent Review PASS；runtime implementation not started；TTS-C.1A not started；只读审计，零代码/零部署）**：关闭独立 Review FAIL 发现——① **reclaimable validation**（`tts_synthesis_claims`/`voice_materialization_jobs` 的 validating 阶段带 `validation_owner_token/validation_lease_expires_at/validation_attempt/candidate_artifact_id/candidate_artifact_metadata_hash/validation_started_at`，所有权字段各阶段显式；lease 过期 → BEGIN IMMEDIATE CAS 接管 + attempt+1 + 重跑 exact validator，不调用 provider，不永久阻塞）；② **validating 阶段取消语义**（Phase 3 同事务重读全部 subscriber；active=0 → claim cancelled + 清 owner/lease + 不建 job + 释放 unique；最后 subscriber 在 validating_reuse 取消 → 直接取消 claim；generation_pending/running 才置 job cancel_requested；零 subscriber 不产生 provider job；测试矩阵）；③ **materialization 真正 single-flight**（`voice_materialization_jobs` 增 `validating_existing` unschedulable 状态 + partial unique `uq_voice_materialization_jobs_active`（validating_existing/queued/running/indeterminate），Scheduler 只领 `queued`，不依赖 projection UNIQUE 单独承担；envelope 增 `project_id` + `UNIQUE(project_id, request_id)`，Assignment 属同 project；single-flight 算法 + stale validating CAS）；④ **materialization fan-out/durability**（文件 durable 后单事务：重读 job owner/lease + exact Voice Revision + 全部 subscriber + identity/Assignment/project 自洽（mismatch → 回滚 + REQUEST_STATE_INCONSISTENT）→ projection=file_ready_unpublished → job=succeeded → 全部未取消 request=succeeded + materialization_id；目标路径固定 voice-root-relative）；⑤ **legacy single-source mapping cutover**（5 态：unmapped/mapping_pending/mapped_verified → 用 legacy entry；mapped_active → 用 TTS-A projection（legacy 行仅 provenance）；retired → 不输出；**每 canonical key 恰好一个 source**（修复 R3 双来源冲突）；等价性验证 6 项；atomic cutover：publish → activeRegistrySha256==candidate → mapped_active + published_usable；LKG → legacy remains emitted + registry_pending）；⑥ **artifact fan-in provenance**（`sentence_audio_artifacts` 删单数 request_id → `claim_id/job_id/successful_attempt_id` NOT NULL + `originating_request_id` 仅审计；artifact 不声称只属一个 request；成功 artifact 必须有 exact successful attempt）；⑦ **完整状态机与 trigger**（tts_audio_requests 含 `waiting → succeeded` reuse 路径；claim 状态机 `validating_reuse → succeeded/cancelled/generation_pending/failed` 等；全部非法倒退 trigger ABORT）；⑧ **schema 真实 contract**（设计文档 §2 每表可执行级约束：REFERENCES+ON DELETE/CHECK/partial unique/immutable-field trigger/invalid-transition trigger/DELETE trigger/NULL 语义/authoritative reader/API redaction/legacy compat，不以注释代替；保持 9 表）；⑨ **并行开发矩阵**（1A∥1C 并行、1B 骨架并行、publisher 等 1A PASS、C.2 等三者齐备、C.3→C.5 runtime 串行；单一 integrator 拥有 m7、不推阶段 branch、每 exact SHA 单独 gate/Review/deploy、禁止合并未 Review lane）；⑩ **OSS 矩阵 AGPL/NC 措辞统一**（"可能产生相应 license 义务或商业合规风险；知影决定不引入；不构成法律意见"，无绝对化表述）。四份文档全部更新；TTS-B/A 冻结语义未动。
- **TTS-B.R2（历史记录）**：R1 Review FAIL 后聚焦修复——① Performance commit-time Narration candidate fence；② Assignment concurrent existing2 复用同一 authoritative helper；③ graph detector 单一真相源 + 故障注入；④ GitHub Actions 独立 CI（run 30796556192 success @ 34ee6c3）。其修复在 R3 中被强化（fence 移入事务内）。
- **Production legacy 审计（只报告，不修改）**：generated assets 19；provenance NULL 19（全为历史 legacy）；NULL + requirement_json 缺失/损坏 1；active legacy bindings 17；active bindings 指向当前 active scenes 中缺失的 requirement 10（分布于 2 个项目，均为历史绑定；未删除/重绑）。
- 下一步：TTS-C.1A（voice materialization durable requests/files/DB projection）→ TTS-C.1B（global registry publisher + adapter hot reload）→ TTS-C.1C（capability snapshot/compiler）→ TTS-C.2（request envelope + durable job + attempt journal + immutable sentence audio artifact + fingerprints）→ TTS-C.3（preview/override/variant/A-B/selection）→ TTS-C.4（selection manifest + immutable master audio + ffprobe）→ TTS-C.5（subtitle timing v2/reconciliation/stale graph/review UI）→ timing-reconciliation@2.0 → storyboard → animatic → final render。

## 6. 尚未完成 TODO

- [x] Production 部署（M7.3A.2 e62f5c2 / M7.3A.3 07b39dc 已完成）
- [x] M7.3B — Visual Sequences / Shots（**FROZEN**，独立 Review PASS，final code/runtime `e3bd60a…`）
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
- **M7.3A.3.3 冻结决策（独立 Review PASS 后正式生效）**：
  - legacy generated candidate 仅在 intended target 可验证（scene_id 非空且匹配、requirement_json 合法且 requirementId 匹配、active scenes 中 exact requirement 存在）时允许新绑定；否则 409 LEGACY_CANDIDATE_TARGET_UNVERIFIABLE（fail-closed）。
  - provider 返回非空图片结果即视为 confirmed_charged（无论后续 result validation / 本地持久化是否失败）；PROVIDER_INVALID_RESPONSE 时 job failed 但 billing 保持 charged，不保存 current asset，不自动重试。
  - billing evidence 单调，只能升级不能降级；usage metadata 只追加不丢失已知证据（providerRequestId/generationId/actualModel/requestedModel/imageCount 等）；charged 且 cost 未知保持 null（pricingUnavailable=true），不得伪造成 0。
  - render bundle 退出按优先级分类：lease lost > shutdown(requeue) > cancel(cancelled) > bundle_error。
- **M7.3A 冻结语义（正式生效，后续里程碑不得顺带重构；改动需显式评审）**：
  1. Visual Intent 是视觉语义唯一所有者（intent/strategy/authenticity/objective/subject/continuationOfVisualIntentId/displayText/evidenceIds）；
  2. legacy binding exact-target gate（LEGACY_CANDIDATE_TARGET_UNVERIFIABLE fail-closed）；
  3. charged provider result audit（provider 返回即 charged，结果校验失败 billing 保持）；
  4. billing evidence monotonic（只升级不降级，charged+cost 未知保持 null）；
  5. live bundle exit state（lease lost > shutdown > cancel > bundle_error，实时读取 + 后置 fence）；
  6. heartbeat single-owner cleanup（scheduler 唯一 claim，runner finally 唯一 release，executor 不 normal release）；
  7. usage metadata sanitization（危险键过滤 + 只追加，首次写入/prior 非 plain 均过滤）；
  8. 后续阶段不得顺带重构以上语义。
- **M7.3B 冻结边界（本轮生效，后续里程碑不得顺带重构）**：
  1. Beat 只引用 Narration Plan V2 unit；Beat 不得新增 sequenceId/shotId、不得拥有最终时间区间、不得包含视觉语义；
  2. Visual Intent 是视觉语义唯一所有者（intent/strategy/authenticity/objective/subject/continuationOfVisualIntentId/displayText/evidenceIds）；Visual Intent 不得新增 Sequence/Shot 字段；
  3. Sequence/Shot 只能保存 visualIntentId 引用，禁止复制任何 Visual Intent 内容；
  4. Sequence/Shot 都是 immutable candidate（kind `visual_sequence_plan`/`shot_plan`）；不 current/active/locked，不建 M7 snapshot，不切换项目到 m7；
  5. Sequence/Shot 不含任何最终 timing（startMs/endMs/durationMs/frames）、素材/模板/渲染字段、语音/表演字段（voice/delivery/pace/energy/emotion）；
  6. TTS 兼容边界：Voice Profile / Narration Performance Plan 变化只 stale 下游 timing artifact，不 stale Sequence/Shot；Narration Plan unit 身份或正文改变必须经 Beats/Visual Intent source drift 传播 stale；最终时间线只在 TTS-C 与 narration master 确认后生成；
  7. `VISUAL_UNRESOLVED` 允许保留（candidate 分类 `needs_review`），禁止自动改写为 MG。
- **M7.3B 冻结语义（正式生效，independent Review = PASS；后续 TTS、timing、asset、render 阶段不得顺带重构；改动需显式评审）**：
  1. artifact kind：`visual_sequence_plan` / `shot_plan`；
  2. schema：`visual-sequences@1.0` / `shots@1.0`；
  3. Sequence/Shot 都是 immutable candidate：不 current、不 active、不 locked、不隐式 latest、不创建 snapshot；
  4. Visual Intent 是视觉语义唯一所有者；Sequence/Shot 只保存 `visualIntentId` 引用；
  5. Sequence/Shot 禁止：最终 timing、asset/layout/render 字段、voice/performance 字段、Visual Intent 内容副本；
  6. exact-source provenance + commit-time source fence；
  7. canonical timeline：Sequence beat 顺序逐项一致；Shot sequence/unit 顺序逐项一致；validator 不自动排序；
  8. durable idempotency：queued/running dispatch source immutable；同 requestId 不同 source 409；dispatch-only running 原样返回 running；run/dispatch source 矛盾 fail-closed（错误明确标识发生冲突的持久 source，不选择任一 source 继续）；
  9. DAG usable-candidate：current/eligible 可用；Visual Intent `needs_review` 可用于 Sequence/Shot；Visual Sequence `needs_review` 可用于 Shot；Narration Plan `needs_review` 不可用于 downstream；stale/invalid 不可用；
  10. 后续 TTS、timing、asset、render 阶段不得顺带重构以上语义。
- **TTS-A 冻结语义（正式生效，independent Review = PASS；final code/runtime `1460efd12c9f4bbb3fa4188757deeff3c8566c99`；deployment evidence docs `2fc7ffb460dc36cd44fdcb3c5b98e9e09e9e392f`；后续 TTS-B/TTS-C 不得顺带重构；改动需显式评审）**：
  1. Voice Profile 是稳定身份（服务端 UUID；provider 仅 `indextts2`）；
  2. Voice Profile Revision append-only；revision_number 在 BEGIN IMMEDIATE 内 MAX+1；
  3. Revision UPDATE/DELETE 由 DB trigger ABORT 禁止（数据库层不可变）；
  4. 业务必须使用 exact profileId + revisionId 双 ID 引用；
  5. 禁止隐式 latest/current/default revision（无 getLatest 业务接口；UI 建议仅命名 `suggestedLatestForDisplay`）；
  6. archived Profile 的历史 exact revision 仍可读（historical exact read）；
  7. archived Profile 禁止新增 revision（409 profile_archived）；
  8. canonical reference 冻结：WAV / pcm_s16le / mono / 48000Hz（canonical 生成参数全部服务端固定，上传内容不影响 ffmpeg 参数）；
  9. exact validator（`validateVoiceProfileRevisionExact`）是单一真相源：getVoiceProfileRevisionExact / readRevisionAudio / resolveVoiceRevisionForFutureTts / requestId reused 检查全部复用；
  10. exact validator 校验：Profile/Revision schema、provider、adapter_compatibility_key 精确、metadata strict schema（仅 canonicalizationVersion/adapterCompatibilityKey/ingestedAt）且与行一致、codec/sample_rate/channels/duration 冻结范围、hash 字段格式、`canonical_audio_path` 精确等于 `voice-library/<pid>/<rid>/reference.wav`、lexical resolve 不越界、root realpath、中间目录 realpath 不越界、final 非 symlink 且 regular file、文件 SHA256 与 DB 完全一致；
  11. bounded multipart：25MB 单文件、30MB 总 body、严格字段白名单（requestId/audio/transcript/language）、流式解析（@fastify/busboy 3.2.0），Content-Length 预检 + 流式实测双保险；
  12. staging ownership：parser → core 单次转移；route 不持有 staging；core 从函数入口持有；
  13. durability：final rename/fsync（final 文件/revisionDir/profileDir/root/staging 源目录）全部先于 SQLite commit；commit 后不再执行关键 fsync；
  14. cleanup 是 best-effort（`cleanupStagingBestEffort`）：不覆盖业务错误；commit 后失败不推翻 201/200；
  15. same requestId + same fingerprint：exact validator usable=true 才允许 200 reused；否则 409 revision_unusable；
  16. damaged revision（文件缺失/hash 漂移/中间 symlink/metadata/provider/adapter/codec/sr/ch/duration 不符）→ 409 revision_unusable（fail-closed，绝不返回 200）；
  17. API 不返回绝对或相对 canonical path（序列化出口不含 canonical_audio_path/metadata_json；响应不含 dataDir）；
  18. TTS-A 未绑定项目、未调用 adapter、未生成 TTS（voice_profiles/revisions 在 production 仍 0/0）；
  19. 后续 TTS-B/TTS-C 不得顺带重构以上语义。
  - **非阻断 hardening note（本 docs-only commit 不改代码）**：core（`ingestVoiceProfileRevisionFromStaged`）的直接内部调用者若未来绕过 route，应确保 DB 初始化也位于 staging ownership scope 内（即 `getDb()` 调用也应纳入 try/finally 或由调用方先行初始化）。此项不是 TTS-A blocker，不在本次冻结 commit 修改代码。
- **TTS-B 冻结语义（正式生效，independent Review = PASS；final code/runtime `86f7f52b2f81d20d352de6d3189792c25e6cfe29`；deployment evidence docs `eac6f2d67ed0c2c6723c9d77e9b4400e251cd6f1`；GitHub Actions run `30801164259` success / 27 suites / artifact `8850888730`；后续 TTS-C 不得顺带重构；改动需显式评审）**：
  - **Assignment**：
    1. Project Voice Assignment 是 immutable candidate artifact（schemaVersion `project-voice-assignment@1.0`，compilerVersion `1.0`）；不 current/active/locked/default，不更新 projects 指针，不创建 snapshot；
    2. exact `voiceProfileId + voiceProfileRevisionId` 双 ID 引用；禁止 latest/current/default 隐式解析；
    3. requestId envelope-first（`voice_assignment_requests` 表）优先裁决；
    4. 同 requestId + 同 exact source + 既有 artifact/source/voice 均 usable → 200 reused（不新增 artifact/envelope）；
    5. 同 requestId 不同 exact source → 409 REQUEST_ID_CONFLICT；
    6. archived Profile 允许 historical same-request replay（200 reused）；archived Profile 禁止新 requestId 创建新 Assignment（409 PROFILE_ARCHIVED）；
    7. 新建时 Profile 必须 active；initial exact validator + final exact validator 双道；
    8. BEGIN IMMEDIATE 内重读 request envelope 仍不存在 + Profile active + Revision exact 归属该 Profile + schema/provider/hash/adapter 与最终 descriptor 完全一致；
    9. concurrent existing2 路径必须走统一 authoritative adjudication helper（artifact 存在 + schema 可解析 + source 自洽 + exact voice usable → reused；artifact 缺失/契约非法 → REQUEST_STATE_INCONSISTENT；source/voice 不可用 → ASSIGNMENT_UNUSABLE）；不在事务内直接声称 reused；
    10. artifact/source/voice 不可用一律 fail-closed；不创建第二个 artifact；不修改旧 envelope 指针；不 fallback latest revision；
    11. Assignment source self-consistency 逐项校验（projectId / voiceProfileId / voiceProfileRevisionId / revisionSchemaVersion / provider / canonicalAudioSha256 / adapterCompatibilityKey），任一不一致 → ASSIGNMENT_SOURCE_MISMATCH → invalid_source；
    12. malformed UUID → 422 invalid_request；well-formed missing UUID → 404 PROFILE_NOT_FOUND / REVISION_NOT_FOUND；
    13. 新 revision 上传不 stale 旧 exact Assignment；archive 不 stale 历史 exact Assignment。
  - **Performance Plan**：
    14. 显式 exact Narration Plan artifact ID + 显式 exact Project Voice Assignment artifact ID；不解析 current/latest；
    15. candidate artifact 不代表 selected/active；classify 状态机 current_candidate / stale_source / invalid_source；
    16. Narration、Assignment、Voice descriptor 三层 source self-consistency 逐项校验（narrationPlanArtifactId/Hash/schemaVersion/compilerVersion/scriptV2VersionId/scriptV2Version/scriptV2ContentHash + assignmentArtifactId/Hash/voiceProfileId/voiceProfileRevisionId/canonicalAudioSha256/adapterCompatibilityKey/provider），任一不一致 → PERFORMANCE_SOURCE_MISMATCH → invalid_source；
    17. 复用 generation_runs（`UNIQUE(project_id, stage, request_id)` durable single-flight）+ generation_attempts attempt journal + generation_dispatch_jobs 双持久状态 fail-closed；stage `m7_narration_performance_plan`；
    18. Web 不直接调用 LLM：POST 只 precheck + enqueue（202）；Worker claim 后执行；
    19. succeeded result replay 必须重新 `classifyNarrationPerformancePlan`，仅 current_candidate 返回 200 reused；stale/invalid → 409 RESULT_ARTIFACT_STALE / RESULT_ARTIFACT_INVALID（不新建 artifact、不重调 provider）；
    20. locked Script V2 drift（不改旧 plan artifact content_json）→ Narration candidate stale → Performance stale_source（NARRATION_PLAN_STALE）；needs_review → NARRATION_PLAN_NOT_ELIGIBLE_NEEDS_REVIEW；
    21. 事务外检查只是 early rejection / optimization，不是最终 fence；
    22. final BEGIN IMMEDIATE 事务内、INSERT 前重新读取 exact Narration Plan + 重新执行 `classifyNarrationPlanV2Candidate`；只有 `eligible_candidate` 可提交；其余状态（needs_review/stale/invalid/missing）→ SOURCE_STALE 抛错 → 整事务回滚；
    23. Performance artifact INSERT 与 generation run succeeded（`completeGenerationRunSuccess`，owner_token + status='running' 守卫）同事务原子；Assignment 行 hash 在事务内重读；
    24. exact voice 文件校验（异步文件 SHA，`validateVoiceProfileRevisionExact`）在事务外执行；TTS-C dispatch 前还必须再次校验；
    25. stale/invalid source 不重建、不重调 provider；repair 上限 2，attempt 达上限 terminal failed。
  - **DAG**：`narration_plan_v2 → narration_performance_plan` 与 `project_voice_assignment → narration_performance_plan` 双依赖；无反向边、无 cycle；Narration Plan 仅 `eligible_candidate` usable（needs_review/stale/invalid/missing/script_not_locked 均不可用）；Assignment 仅 `current_candidate` usable；blocked detail 精确列出缺失依赖（narration_plan_v2 / project_voice_assignment）；不 stale Narrative Beats / Visual Intent / Sequence / Shot。
  - **范围边界**：TTS-B 不负责 adapter `/voices` materialization、adapter registry publish、provider capability compile、TTS input fingerprint、sentence preview、sentence audio generation、incremental regeneration、narration audio manifest、master concatenation、ffprobe duration、subtitle timing、timing reconciliation、storyboard/animatic stale——以上属于 TTS-C 及后续阶段。


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

- **M7.3B FROZEN（独立 Review PASS）**。冻结语义见 §7；后续阶段不得顺带重构。
- **TTS-A 已批准启动**（Immutable Custom Voice Library Foundation）。TTS-A 自身边界：
  - **只做** Voice Profile / immutable Voice Profile Revision 声音库基础设施（schema + 安全摄取 + exact reader + API + 最小 `/settings/voices` UI）。
  - **不要** 实现 TTS-B（Voice Selection / Project Voice Assignment）/ TTS-C（增量合成）/ Narration Performance Plan；不做 pace/energy/emotion/delivery 规划。
  - **不要** 在 production 上传参考音频、创建 Voice Profile、调用真实 IndexTTS2 adapter、生成正式 TTS；不重新合成 Freud TTS；不生成 narration master；不做 subtitle timing；不创建 `timing-reconciliation@2.0`。
  - **不要** 改写历史 tts_jobs 行、重算 fingerprint、改变旧 job dedupe / manifest 选择 / TTS worker provider / adapter 请求；不自动把现有 env-based voice 映射到新库；不自动读取 latest revision。
  - **不要** 把声音绑定到项目；不设置 global default；不提供业务自动调用的 getLatestVoiceRevision。
  - **不要** 创建 M7 pipeline snapshot；**不要** 切换任何项目到 m7。
  - **不要** 自动重新生成污染项目 TTS；**不要** 循环重试 S001-R01 图片生成。
  - **不要** 回写/修改 "narrative-beats@1.0" 与 "visual-intent-plan@1.0"（Beat 不得新增 sequenceId/shotId；Visual Intent 不得新增 Sequence/Shot 字段；Sequence/Shot 不得复制 Visual Intent 内容）。
  - 修改 Worker secret boundary 前必须经过 review。
  - 删除或覆盖旧 candidate `793c80fa-9229-4551-bc05-960c727afa2e` 是禁止的。

## 11. 测试套件清单

### 11.1 必跑脚本（agentvm）

- `pnpm typecheck`
- `pnpm build`
- `scripts/test-m73b-visual-sequences.ts`（M7.3B 新增）
- `scripts/test-m73b-shots.ts`（M7.3B 新增）
- `scripts/test-m73b-generation.ts`（M7.3B 新增）
- `scripts/test-m73b-dag.ts`（M7.3B 新增）
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
- `scripts/test-tts-a-voice-library-schema.ts`（TTS-A 新增；R1 后 34 PASS）
- `scripts/test-tts-a-voice-library-ingest.ts`（TTS-A 新增；R1 后 25 PASS）
- `scripts/test-tts-a-voice-library-api.ts`（TTS-A 新增；R1 扩展 R 段「损坏 revision 不得 reused」后 78 PASS，KNOWN-ISSUE=0——415 不再泄漏 staging 路径，K1 自动转 PASS）
- `scripts/test-tts-a-voice-library-files.ts`（TTS-A 新增；R1 扩展 E9-E17 symlink 防护后 23 PASS）
- `scripts/test-tts-a-durability.ts`（TTS-A.R1 新增，30 PASS）：D1 file-op 顺序日志（rename→fsync final→fsync revisionDir→fsync profileDir→fsync root→fsync staging→commit→201）/ D2 rename 后 commit 前 fsync 失败（ingest_failed、row=0、orphan、exact null、不误判 duplicate）/ D3 INSERT 失败与 final 覆盖保护（row=0、sentinel 不被覆盖）/ D4 commit 后无 durability-critical 操作 / D5 crash model 文档措辞断言（**镜像内运行需只读挂载 docs/：D5 读设计文档**）
- `scripts/test-tts-a-multipart.ts`（TTS-A.R1 新增，31 PASS）：M1 Content-Length 预检 413（不读 body）/ M2 chunked 流式计数 413 提前中止 / M3 伪造 Content-Length / M4 单文件 >25MB 413 file_too_large / M5-M7 严格字段（双 audio、unknown、重复字段 422）/ M8 合法 multipart 201 + 无完整 Buffer 证据 / M9 parser 错误与断连（无 DB 行、staging 清理）
- `scripts/test-tts-a-staging-failures.ts`（TTS-A.R2 新增，39 PASS）：S1 open failure（500 ingest_failed、无残留、ffprobe=0）/ S2 mid-stream write failure（500 JSON、source 未全消费、fd close once）/ S3 fsync failure / S4 close failure（cleanup 仍执行、close 一次）/ S5 parser cleanup failure（原错误不被覆盖）/ S6 core early validation（wrapper + staged core 双路径：错误码稳定、cleanup 被调用、cleanup 失败不覆盖）/ S7 post-commit cleanup failure（仍 201/200、usable、无第二行）/ S8 route ownership（源码 + 运行时）
- `scripts/test-tts-b-voice-assignment.ts`（TTS-B 新增，37 PASS）：A schema（unknown/forbidden/provider/hash/malformed 拒绝）/ B exact source（active+usable→candidate、missing/cross/archived、file missing、hash drift、metadata/provider/adapter mismatch、新 revision 不 stale、无 latest fallback）/ C idempotency（同 requestId 复用、异 revision 409、并发恰好一个、跨项目、无指针）
- `scripts/test-tts-b-performance-schema.ts`（TTS-B 新增，31 PASS）：D performance schema/语义（exact coverage、silence excluded、gap、duplicate、order mismatch、non-speech、enum/emotion union、forbidden spokenText/subtitleText/sourceText、timing/audio/job/path、unknown field）
- `scripts/test-tts-b-performance-generation.ts`（TTS-B 新增，29 PASS）：E generation（reuse、409、并发 single-flight、repair attemptCount=2、attempt 上限 failed、narration drift→SOURCE_STALE 零 artifact、voice unusable→VOICE_SOURCE_INVALID、无 TTS job、buildPerformanceInputIdentity 确定性）+ **E19（生成期间 lock Script V2 B，outer check 前 drift）+ E20（outer check 通过后、BEGIN IMMEDIATE 前 lock Script V2 B——setPerformanceBeforeCommitTransactionForTest hook 真实 generateVersion+lockStage，事务内重新 classify=stale → SOURCE_STALE、run failed、零 artifact、provider 恰好一次、无 TTS job；TTS-B.R3 新增，并已做 mutation 验证：禁用事务内 fence 时 E20c FAIL）**
- `scripts/test-tts-b-dag.ts`（TTS-B 新增，9 PASS）：F DAG（无 assignment→blocked、usable→not_generated、drift→stale、新 revision/archive 不 stale、损坏 invalidates、Sequence/Shot 不变、无 cycle/反向边）
- `scripts/test-tts-b-api.ts`（TTS-B 新增，21 PASS）：H API（assignment POST 201/200/409/404、strict 422、performance POST 202 enqueue/200 reused/409、cross-project 404、GET exact、无路径泄漏）+ G TTS boundary（tts_jobs=0、Web 不调 LLM、无 manifest、无激活）
- `scripts/test-llm-dispatch.ts`
- `scripts/test-workflow-stages.ts`
- `scripts/test-m6310-usage.ts`

### 11.2 M7.3A.2/M7.3A.3 新增/扩展测试

- `scripts/test-m73b-visual-sequences.ts`（92 PASS，M7.3B.R1 更新）：sequences schema（含 reference ID 精确限制）/ 语义校验全矩阵 / **canonical beat order（SEQUENCE_BEAT_ORDER_MISMATCH：reversed blocks、三块交换、classify invalid_source、generation repair attemptCount=2 零自动排序）** / classify / 双源 chain precheck / 向后兼容
- `scripts/test-m73b-shots.ts`（96 PASS，M7.3B.R1 更新）：shots schema（含 reference ID 精确限制）/ 语义校验全矩阵 / **canonical sequence/unit order（SHOT_SEQUENCE_ORDER_MISMATCH + SHOT_UNIT_ORDER_MISMATCH：block 前置、shot block 交换、classify invalid_source、generation repair attemptCount=2）** / classify / precheck / 向后兼容
- `scripts/test-m73b-generation.ts`（114 PASS，M7.3B.R2 更新）：Web enqueue-only / Worker Mock 执行 / 幂等复用 / 409 冲突 / 并发 single-flight / repair attemptCount / 3 次失败终态 / source drift（before dispatch / during generation / before commit，commit-time fence 零 artifact）/ **queued dispatch source conflict（sequences+shots：409、dispatch count=1、原 source 未覆盖、runs=0、provider calls=0；同 source 重复同 dispatchId；并发不同 source 恰好一胜一 409；generic enqueue 与 visual-intents route 既有 stage 回归）** / **dispatch-only running window（真实 scheduler claim：claim 后 dispatch=running、generation_run=0，同 source POST → 202 running 同 dispatchId、count=1、source 不变、provider calls=0、artifact 不变；不同 source → 409 且原 dispatch 仍 running；sequences/shots/visual-intents 三 route 一致；被 claim 的 dispatch 用 Mock provider 正确收尾）** / **run/dispatch 双持久 source 矛盾 fail-closed（run succeeded/failed/running + dispatch 异 source：input 任一匹配均 409，两行 source/status 完全不变，错误明确标识发生冲突的持久 source 并 fail-closed；dispatch cancelled 无 run → 同 source terminal / 异 source 409；一致 source 的 succeeded/failed/running 正常短路）** / production override 禁用
- `scripts/test-m73b-dag.ts`（71 PASS，M7.3B.R2 更新）：图结构（无环/无反向边）/ 节点状态机（not_generated→running→ready/blocked/needs_review）/ TTS 并行边界 / Voice/Performance 概念源零影响 / narration 漂移传播 / **usable-candidate 语义（fixture 隔离：G1/G2 前置 eligible beats、G3/G4 前置全链可用、G4 独立项目不被 G3 信封污染、blocker detail 精确只含目标 dependency；旧合法 candidate + regenerate running 时 currentCandidateCount≥1 且 shots 保持 ready；intent/sequences needs_review 可用；narration needs_review 不可用）** / **usable truth table（isCandidateUsableForDownstream 纯函数 9 项：narration eligible→usable、narration needs_review→false、intent needs_review→sequences/shots、sequences needs_review→shots、stale/invalid→false、不相关 downstream→false）** / 无 m7 激活

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

已部署：`07b39dc2c3c7ebd10635a4d91d80a800495318f4`（M7.3A.3），备份 `m73a2-20260801T021504Z`（DB SHA `833df854…b13f6`，integrity=ok，SHA256SUMS 全过），时间戳证明 `BACKUP_COMPLETED_AT`(02:17:12Z) < `CHECKOUT_STARTED_AT`(02:17:33Z)。

| 检查项 | 结果 | 证据 |
|---|---|---|
| 三容器 healthy | ✅ | zhiying-web / zhiying-worker / indextts2-adapter 均 `zhiying:07b39dc` + healthy |
| local/LAN 3210 API/UI 200 | ✅ | 127.0.0.1 与 192.168.31.56 的 /api/projects 与 / 均 200 |
| Web 无 LLM secret | ✅ | web env 无 DEEPSEEK_API_KEY/LLM_PROVIDER；worker 持有全部凭据 |
| Worker provider 健康 | ✅ | worker 启动日志正常（GPU/NVENC 配置行） |
| RTX 2080 Ti / NVENC / ffprobe | ✅ | nvidia-smi=RTX 2080 Ti；ffprobe 5.1.9；libnvidia-encode.so.1 存在；`GPU mode: hardware(angle-egl), NVENC: enabled` |
| projects 仍 m6 / snapshot NULL | ✅ | 全项目 pipeline_version=m6、m7_pipeline_snapshot_id 空 |
| 无 M7 snapshot | ✅ | m7_pipeline_snapshot_id 全空 |
| Freud artifacts hash 不变 | ✅ | narration_plan_v2/narrative_beats 规范化 sha256 与备份全等 |
| 污染项目仍 blocked / S001、S014 保留 | ✅ | S001 generated assets=2 保留；S001-R01、S014-R01 generation_failed 证据在 |
| usage/cost 无意外增长 | ✅ | 部署时间点后 project_usage_events=0；asset_generation_jobs=0 行 |
| logs 无 migration/SQLite/lease/provider 错误 | ✅ | web/worker 日志无相关 error（仅 Node SQLite experimental warning） |
| migration 单 web 先行 | ✅ | `request_fingerprint`/`result_relevance`（asset_generation_jobs）+ `provenance_json`（assets）就位；幂等重启 healthy；旧 candidate `793c80fa…` 保留 |
| 新镜像测试 | ✅ | 容器内 15 套件全绿（image code SHA = mounted scripts SHA = 07b39dc）；M3-B 99/0、M3-C 82/0 |
| 部署后临时 DB + Mock provider 验证（不调用真实 APIYi） | ✅ | fingerprint 18、resolver-e2e 25、durability 53、leases 53（覆盖：fingerprint conflict / latest selection / candidate_waiting / exact bind / mid-flight drift / lease loss abort / remote+tts 并行 / local+tts 互斥） |
| 构建网络 runbook 实测 | ✅ | `production-build-network.sh start/check/stop` 一次通过；本次 browser 层缓存命中未触发下载；隧道清理完成 |

### 15.1 M7.3B 部署证据（6f109d0，2026-08-02）

- **部署链**：code SHA `6f109d01fca62e200be88a8369eadd37d35b981d` = production runtime SHA = host checkout SHA = origin/m7 HEAD（docs evidence commit 后 origin/m7 会高于 runtime——以现场 `git rev-parse` 为准）。
- **pre-deployment backup**：`/vol1/1000/backups/zhiying/m73b-20260802T041205Z`（DB SHA `0d74155e…` 与 R3 一致=部署前零写入；integrity=ok；SHA256SUMS 全过；`BACKUP_COMPLETED_AT=04:14:25Z` 先于 checkout）。
- **构建网络 runbook**：`production-build-network.sh start/check` 一次通过 → `docker build --network=host --add-host remotion.media:127.0.0.1 --build-arg APT_MIRROR --build-arg NPM_REGISTRY -t zhiying:6f109d0…`（BUILD_EXIT=0，trap 保证 stop）→ 443 无 listener、tunnel 容器 0 残留。
- **镜像内测试**（`NODE_ENV=development`，scripts 只读挂载，image code SHA = mounted scripts SHA = 6f109d0）：M7.3B 4 套件 71/73/47/37 全绿 + 权威 8 套件（m73a 184、m72 125、m721 99、m711 58、dag-parallelism 15、resource-leases 87、m3b-tts 99、m3c 82）全绿。
- **up 验证**：三容器 healthy @`zhiying:6f109d0…`；local/LAN 3210 root 200、/api/projects 200；worker 日志无 migration/SQLite/lease/provider error；resource leases 0；web env 无 DEEPSEEK_API_KEY/LLM_PROVIDER。
- **Production 数据不变量（部署前后只读对比，20 项全过）**：projects 全 m6；snapshot pointer 全 NULL；M7 snapshot 0；Freud narration_plan_v2/narrative_beats/visual_intent artifact ID 序列 hash 与备份全等；`793c80fa…` content hash 与备份全等（`784703a4…`）；污染项目（`31d45df7…`）S001-R01 证据行与备份 diff=空；tts_jobs 351=351、asset_generation_jobs 0=0、asset_bindings 40=40、assets 40=40、usage-events 610=610、render_jobs 14=14；`visual_sequence_plan`/`shot_plan`/`timing_reconciliation_v2` artifact 全 0；`m7_visual_sequences`/`m7_shots` generation runs 0；resource leases 0。
- **本轮未执行**：不对 Freud 或任何 production 项目调 visual-sequences/shots POST；不创建 production Sequence/Shot candidate；不调用真实 LLM/APIYi；不创建 M7 snapshot；不切换项目到 m7（M7.3B 行为全部经临时 DB + Mock provider 验证）。

### 15.2 M7.3B.R1 部署证据（a71f0fe，2026-08-02）

- **部署链**：code SHA `a71f0fed1028da0f2a47305d22df120d8165f714` = production runtime SHA = host checkout SHA = origin/m7 HEAD（docs evidence commit 后 origin/m7 会高于 runtime——以现场 `git rev-parse` 为准）。
- **pre-deployment backup**：`/vol1/1000/backups/zhiying/m73b-r1-20260802T055201Z`（DB SHA `0d74155e…` 与 R3/6f109d0 一致=部署前零写入；integrity=ok；**SHA256SUMS 44 文件全 OK、0 FAILED**——BACKUP_COMPLETED_AT 先于 manifest 生成；`BACKUP_COMPLETED_AT=05:53:51Z` 先于 checkout）。
- **构建网络 runbook**：`production-build-network.sh start/check` 一次通过 → `docker build --network=host --add-host remotion.media:127.0.0.1 --build-arg APT_MIRROR --build-arg NPM_REGISTRY -t zhiying:a71f0fe…`（BUILD_EXIT=0，trap 保证 stop）→ 443 无 listener、tunnel 容器 0 残留。
- **镜像内测试**（`NODE_ENV=development`，scripts 只读挂载，image code SHA = mounted scripts SHA = a71f0fe）：M7.3B.R1 4 套件 92/96/76/53 全绿 + 权威 9 套件（m73a 184、m72 125、m721 99、m711 58、dag-parallelism 15、resource-leases 87、durability 53、m3b-tts 99、m3c 82）全绿。
- **up 验证**：三容器 healthy @`zhiying:a71f0fe…`；local/LAN 3210 root 200、/api/projects 200；worker 日志无 migration/SQLite/dispatch/lease/provider error；resource leases 0；web env 无 DEEPSEEK_API_KEY/LLM_PROVIDER。
- **Production 数据不变量（部署前后只读对比，21 项全过）**：projects 全 m6（3 个）；snapshot pointer 全 NULL；M7 snapshot 0；Freud narration_plan_v2/narrative_beats/visual_intent artifact ID 序列 hash 与备份全等（`1449aefb…`）；`793c80fa…` content hash 与备份全等（`784703a4…`）；`visual_sequence_plan`/`shot_plan`/`timing_reconciliation_v2` artifact 全 0；`m7_visual_sequences`/`m7_shots` generation runs 0；generation_dispatch_jobs 0=0；llm_usage 69=69；asset_generation_jobs 0=0；tts_jobs 351=351；assets/bindings 40/40=40/40；render_jobs 14=14；usage-events 610=610；resource leases 0；无项目切换 m7。
- **状态**：**M7.3B.R1 deployed；M7.3B pending independent Review PASS；TTS-A not started**。
- **本轮未执行**：不对 Freud 或任何 production 项目调 visual-sequences/shots POST；不创建 production Sequence/Shot candidate；不调用真实 LLM/APIYi；不创建 M7 snapshot；不切换项目到 m7；不实现 timing-reconciliation@2.0；不迁移 bindings（M7.3B.R1 行为全部经临时 DB + Mock provider 验证）。

### 15.3 M7.3B.R2 部署证据（e3bd60a，2026-08-02）

- **部署链**：code SHA `e3bd60a879cb279c6bd19b1c2d5013073b7155d3` = production runtime SHA = host checkout SHA = origin/m7 HEAD（docs evidence commit 后 origin/m7 会高于 runtime——以现场 `git rev-parse` 为准）。
- **pre-deployment backup**：`/vol1/1000/backups/zhiying/m73b-r2-20260802T091124Z`（DB SHA `0d74155e…` 与历轮一致=部署前零写入；integrity=ok；**SHA256SUMS 44 文件全 OK、0 FAILED**；`BACKUP_COMPLETED_AT=09:13:12Z` 先于 checkout）。
- **构建网络 runbook**：`production-build-network.sh start/check` 一次通过 → `docker build --network=host --add-host remotion.media:127.0.0.1 --build-arg APT_MIRROR --build-arg NPM_REGISTRY -t zhiying:e3bd60a…`（BUILD_EXIT=0，trap 保证 stop）→ 443 无 listener、tunnel 容器 0 残留。
- **镜像内测试**（`NODE_ENV=development`，scripts 只读挂载，image code SHA = mounted scripts SHA = e3bd60a）：M7.3B.R2 4 套件 92/96/114/71 全绿 + 权威 9 套件（m73a 184、m72 125、m721 99、m711 58、dag-parallelism 15、resource-leases 87、durability 53、m3b-tts 99、m3c 82）全绿。
- **up 验证**：三容器 healthy @`zhiying:e3bd60a…`；local/LAN 3210 root 200、/api/projects 200；worker 日志无 migration/SQLite/dispatch/lease/provider error；resource leases 0；web env 无 DEEPSEEK_API_KEY/LLM_PROVIDER。
- **Production 数据不变量（部署前后只读对比，21 项全过）**：projects 全 m6（3 个）；snapshot pointer 全 NULL；M7 snapshot 0；Freud 三 artifact ID 序列 hash 与备份全等（`1449aefb…`）；`793c80fa…` content hash 与备份全等（`784703a4…`）；`visual_sequence_plan`/`shot_plan`/`timing_reconciliation_v2` artifact 全 0；`m7_visual_sequences`/`m7_shots` generation runs 0；generation_dispatch_jobs 0=0；llm_usage 69=69；usage-events 610=610；asset_generation_jobs 0=0；tts_jobs 351=351；assets/bindings 40/40=40/40；render_jobs 14=14；resource leases 0；无项目切换 m7。
- **状态**：**M7.3B.R2 deployed；M7.3B pending independent Review PASS；TTS-A not started**。
- **本轮未执行**：不对 Freud 或任何 production 项目调 generation POST；不创建 production Sequence/Shot candidate；不调用真实 LLM/APIYi；不创建 M7 snapshot；不切换项目到 m7；不实现 timing-reconciliation@2.0；不迁移 bindings（M7.3B.R2 行为全部经临时 DB + Mock provider 验证）。

### 15.4 TTS-A 部署证据（fed3e3d，2026-08-02）

- **部署链**：code SHA `fed3e3d19b4c1a0ef80e1b2822ff4e5ab8aaf798` = production runtime SHA = host checkout SHA = origin/m7 HEAD（本 docs evidence commit 后 origin/m7 会高于 runtime——以现场 `git rev-parse` 为准）。
- **pre-deployment backup**：`/vol1/1000/backups/zhiying/tts-a-20260802T113748Z`（DB SHA `0d74155e…` 与历轮一致=部署前零写入；integrity=ok；**SHA256SUMS 32 文件全 OK、0 FAILED**；`BACKUP_COMPLETED_AT=2026-08-02T11:37:55Z` 先于 checkout；含 tts_jobs 全表 dump、schema.sql、migration-state、Freud artifact dump、data audio 文件清单+hashes、compose×2、`.env.production`）。
- **构建网络 runbook**：`production-build-network.sh start/check` 通过 → `docker build --network=host --add-host remotion.media:127.0.0.1 --build-arg APT_MIRROR --build-arg NPM_REGISTRY -t zhiying:fed3e3d…`（BUILD_EXIT=0，trap 保证 stop）→ 443 无 listener、tunnel 容器 0 残留；image digest `4d65a84d…`（与 192118c 相同——src 未变，仅测试脚本修订）。
- **镜像内测试**（`NODE_ENV=development`，scripts 只读挂载，image code SHA = mounted scripts SHA = fed3e3d）：**TTS-A 4 套件 34/25/35/14 全绿** + frozen 11 套件全绿（m73b 92/96/114/71、m73a 184、billing 68、bind-atomicity 45、resource-leases 87 含 render bundle L10、m71-tts 25、m3b-tts 99、m3c 82）。
- **migration 演练**（production DB 副本，应用标准入口 `getDb()`）：voice_profiles / voice_profile_revisions / 2 个 ABORT trigger 就位，初始行数 0/0；重跑幂等；**351 条 tts_jobs 全量 sha256 演练前后完全一致**（`02cfde74…`）；integrity_check=ok。未手工 sqlite3 ALTER production。
- **up 验证**：三容器 healthy @`zhiying:fed3e3d…`（`ZHIYING_RELEASE_TAG=fed3e3d…`）；local 3210 与 LAN root 200、/api/projects 200、/settings/voices 200、/api/voice-profiles 200（`{"profiles":[]}`）；worker/web 日志无 migration/SQLite/dispatch/lease/provider error；web env 无 DEEPSEEK_API_KEY/LLM_PROVIDER；host worktree clean。
- **Production 数据不变量（部署前后只读对比，24 项全过）**：projects 全 m6（3 个）；`m7_pipeline_snapshot_id` 全 NULL（3/3）；M7 snapshot 0；Freud narration_plan_v2/narrative_beats/visual_intent 全行 sha 与备份全等（`59d84eff…`/`727031a4…`/`078a882d…`）；旧 candidate `793c80fa…` 全行 sha 全等；`visual_sequence_plan`/`shot_plan`/`timing_reconciliation_v2` 全 0；`m7_visual_sequences`/`m7_shots` generation runs 0；artifacts 全表 sha 全等（`1bf0f861…`，覆盖 narration_audio_manifest 与 subtitle_timing）；tts_jobs 351=351 且全量 sha `02cfde74…` 与备份全等；llm_usage 69=69；project_usage_events 610=610；asset_generation_jobs 0=0；assets/bindings sha 全等；render_jobs 14=14；resource leases 0；**voice_profiles=0、voice_profile_revisions=0**；`/vol1/1000/docker/zhiying/data/voice-library` 不存在（未创建任何 production 声音数据）；无项目切换 m7；无真实 LLM/APIYi/IndexTTS2 调用。
- **状态**：**M7.3B FROZEN；TTS-A deployed；TTS-A pending independent Review PASS；TTS-B not started；TTS-C not started**。
- **本轮未执行**：不在 production 上传参考音频；不创建 production Voice Profile；不调用真实 IndexTTS2 adapter；不生成正式 TTS；不重新合成 Freud TTS；不绑定项目声音；不开始 TTS-B/C；不生成 narration master；不做 subtitle timing；不创建 timing-reconciliation@2.0；不创建 M7 snapshot；不切换任何项目到 m7；不改写历史 tts_jobs；不把 env-based voice 导入新库。
- **证据边界**：OPS-AUDIT-BRIDGE 不可用（仓库无此设施）；以上 production 证据来自 Agent 现场命令，**不是** independently verified。

### 15.5 TTS-A.R1 部署证据（dca8dc4，2026-08-03）

- **部署链**：code SHA `dca8dc463596fdf1c0bb1a1a9be14d3bdbabe1c9` = production runtime SHA = host checkout SHA = origin/m7 HEAD（本 docs evidence commit 后 origin/m7 会高于 runtime——以现场 `git rev-parse` 为准）。
- **pre-deployment backup**：`/vol1/1000/backups/zhiying/tts-a-r1-20260803T035559Z`（DB SHA `3b92bec5…`；integrity=ok；**SHA256SUMS 全 OK、0 FAILED**；`BACKUP_COMPLETED_AT` 先于 checkout；含 zhiying.db online backup、schema.sql、migration-state、tts_jobs 全表 dump+hash、voice_profiles/voice_profile_revisions（0/0）、voice-library-dir（NOT_EXIST）、narration/manifest/subtitle 按 kind 拆分 dump、llm/usage、assets/bindings、render、leases、compose×2、`.env.production`（内容不进报告）、previous-sha（fed3e3d）、invariants baseline、data audio 文件清单）。
- **构建网络 runbook**：`production-build-network.sh start/check` 通过 → `docker build --network=host --add-host remotion.media:127.0.0.1 --build-arg APT_MIRROR=mirrors.aliyun.com --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t zhiying:dca8dc4…`（**BUILD_EXIT=0**，trap 保证 stop）→ 构建后 tunnel `STOPPED`、443 无 listener、tunnel 容器 0 残留；image digest `d6d9f56c…`；host worktree clean。新增依赖 `@fastify/busboy@3.2.0`（package.json 精确 pin + lockfile 精确提交）。
- **镜像内测试**（`NODE_ENV=development`，scripts 只读挂载，image code SHA = mounted scripts SHA = dca8dc4；durability 套件额外只读挂载 docs——D5 断言读设计文档）：**TTS-A 6 套件 34/25/78/23/30/31 全绿**（api KNOWN-ISSUE=0——415 不再泄漏 staging 路径，K1 自动转 PASS）+ frozen 11 套件全绿（m73b 92/96/114/71、m73a 184、billing 68、bind-atomicity 45、resource-leases 87、m71-tts 25、m3b-tts 99、m3c 82）。agentvm 同 17 套件全绿；m3f/m4b adapter 套件在 agentvm 环境阻塞（依赖 Python venv，adapter 走 Docker；不在既有门禁清单）。
- **migration 演练**（production DB 副本，应用标准入口 `getDb()`）：voice_profiles / voice_profile_revisions / 2 个 ABORT trigger 就位，初始行数 0/0；重跑幂等；**351 条 tts_jobs 全量 sha256 演练前后完全一致**（`92c67ac2…`，与备份基线同方法 hash 一致）；integrity_check=ok。未手工 sqlite3 ALTER production。
- **up 验证**：三容器 healthy @`zhiying:dca8dc4…`/`zhiying-indextts2-adapter:dca8dc4…`（adapter 代码未变，沿用原 digest 重新 tag；`ZHIYING_RELEASE_TAG=dca8dc4…`）；local 3210 与 LAN root 200、/api/projects 200、/settings/voices 200、/api/voice-profiles 200（`{"profiles":[]}`）；worker/web 日志无 migration/SQLite/lease/provider error（仅标准 node:sqlite ExperimentalWarning）；resource leases 0；443/tunnel 0；host worktree clean。
- **Production 数据不变量（部署前后只读对比，24 项全过）**：projects 全 m6/rigorous（3 个）；`m7_pipeline_snapshot_id` 全 NULL；M7 snapshot 表 0；Freud narration_plan_v2/narrative_beats/visual_intent 全行 sha 与备份全等（`99e33ccf…`/`d3414755…`/`42fc4989…`）；`visual_sequence_plan`/`shot_plan`/`timing_reconciliation_v2` 全 0；narration_audio_manifest/subtitle_timing sha 与备份全等（`5e720665…`/`6afe7f06…`）；tts_jobs 351=351 且全量 sha `92c67ac2…` 与备份全等；llm_usage 69=69；project_usage_events 610=610；asset_generation_jobs 0=0；assets/bindings 40=40；render_jobs 14=14；resource leases 0；**voice_profiles=0、voice_profile_revisions=0**；`/vol1/1000/docker/zhiying/data/voice-library` 不存在（未创建任何 production 声音数据）；无项目切换 m7（pipeline_version 全 m6）；无真实 LLM/APIYi/IndexTTS2 调用。
- **状态**：**M7.3B FROZEN；TTS-A.R1 deployed；TTS-A pending independent Review PASS；TTS-B not started；TTS-C not started**。
- **本轮未执行**：不在 production 上传参考音频；不创建 production Voice Profile；不调用真实 IndexTTS2 adapter（不生成 TTS）；不重新合成 Freud TTS；不绑定项目声音；不开始 TTS-B/C；不生成 narration master；不做 subtitle timing；不创建 timing-reconciliation@2.0；不创建 M7 snapshot；不切换任何项目到 m7；不改写历史 tts_jobs；不把 env-based voice 导入新库。
- **证据边界**：OPS-AUDIT-BRIDGE 不可用（仓库无此设施）；以上 production 证据来自 Agent 现场命令，**不是** independently verified。

### 15.6 TTS-A.R2 部署证据（1460efd，2026-08-03）

- **部署链**：code SHA `1460efd12c9f4bbb3fa4188757deeff3c8566c99` = production runtime SHA = host checkout SHA = origin/m7 HEAD（本 docs evidence commit 后 origin/m7 会高于 runtime——以现场 `git rev-parse` 为准）。
- **pre-deployment backup**：`/vol1/1000/backups/zhiying/tts-a-r2-20260803T044549Z`（DB SHA `3b92bec5…` 与 R1 全等=期间零写入；integrity=ok；**SHA256SUMS 全 OK、0 FAILED**；`BACKUP_COMPLETED_AT` 先于 checkout；含 zhiying.db online backup、schema.sql、migration-state、tts_jobs 全表 dump+hash、voice_profiles/voice_profile_revisions（0/0）、voice-library-dir（NOT_EXIST）、narration/manifest/subtitle 按 kind 拆分、llm/usage、assets/bindings、render、leases、compose×2、`.env.production`（内容不进报告）、previous-sha（dca8dc4）、invariants baseline、data audio 文件清单）。
- **构建网络 runbook**：`production-build-network.sh start/check` 通过 → `docker build --network=host --add-host remotion.media:127.0.0.1 --build-arg APT_MIRROR=mirrors.aliyun.com --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t zhiying:1460efd…`（**BUILD_EXIT=0**，trap 保证 stop）→ 构建后 tunnel `STOPPED`、443 无 listener、tunnel 容器 0 残留；image digest `af3eef24…`；host worktree clean。
- **镜像内测试**（`NODE_ENV=development`，scripts 与 docs 只读挂载，image code SHA = mounted scripts SHA = 1460efd）：**TTS-A 7 套件 34/25/78/23/30/31/39 全绿**（api KNOWN-ISSUE=0；S 套件为真实故障注入：S1 open / S2 mid-stream write / S3 fsync / S4 close / S5 cleanup / S6 core early validation / S7 post-commit cleanup failure / S8 route ownership）+ frozen 11 套件全绿（m73b 92/96/114/71、m73a 184、billing 68、bind-atomicity 45、resource-leases 87、m71-tts 25、m3b-tts 99、m3c 82）。agentvm 同 18 套件全绿。
- **migration 演练**（production DB 副本，应用标准入口 `getDb()`）：voice_profiles / voice_profile_revisions / 2 个 ABORT trigger 就位，初始行数 0/0；重跑幂等；**351 条 tts_jobs 全量 sha256 演练前后完全一致**（`92c67ac2…`，与备份基线同方法 hash 一致）；integrity_check=ok。未手工 sqlite3 ALTER production。
- **up 验证**：三容器 healthy @`zhiying:1460efd…`/`zhiying-indextts2-adapter:1460efd…`（adapter 代码未变，沿用原 digest 重新 tag；`ZHIYING_RELEASE_TAG=1460efd…`）；local/LAN root 200、/api/projects 200、/settings/voices 200、/api/voice-profiles 200（`{"profiles":[]}`）；worker/web 日志无 migration/SQLite/lease/provider error；resource leases 0；443/tunnel 0；host worktree clean。
- **Production 数据不变量（部署前后只读对比，24 项全过）**：projects 全 m6/rigorous（3 个）；`m7_pipeline_snapshot_id` 全 NULL；M7 snapshot 表 0；Freud narration_plan_v2/narrative_beats/visual_intent 全行 sha 与备份全等（`99e33ccf…`/`d3414755…`/`42fc4989…`）；`visual_sequence_plan`/`shot_plan`/`timing_reconciliation_v2` 全 0；narration_audio_manifest/subtitle_timing sha 与备份全等（`5e720665…`/`6afe7f06…`）；tts_jobs 351=351 且全量 sha `92c67ac2…` 与备份全等；llm_usage 69=69；project_usage_events 610=610；asset_generation_jobs 0=0；assets/bindings 40=40；render_jobs 14=14；resource leases 0；**voice_profiles=0、voice_profile_revisions=0**；`/vol1/1000/docker/zhiying/data/voice-library` 不存在（未创建任何 production 声音数据）；无项目切换 m7（pipeline_version 全 m6）；无真实 LLM/APIYi/IndexTTS2 调用。
- **状态**：**M7.3B FROZEN；TTS-A.R2 deployed；TTS-A pending independent Review PASS；TTS-B not started；TTS-C not started**。
- **本轮未执行**：不在 production 上传参考音频；不创建 production Voice Profile；不调用真实 IndexTTS2 adapter（不生成 TTS）；不重新合成 Freud TTS；不绑定项目声音；不开始 TTS-B/C；不生成 narration master；不做 subtitle timing；不创建 timing-reconciliation@2.0；不创建 M7 snapshot；不切换任何项目到 m7；不改写历史 tts_jobs；不把 env-based voice 导入新库。
- **证据边界**：OPS-AUDIT-BRIDGE 不可用（仓库无此设施）；以上 production 证据来自 Agent 现场命令，**不是** independently verified。

### 15.7 TTS-B 部署证据（0b70e81，2026-08-03）

- **部署链**：code SHA `0b70e8117277a76e776b6f22494a48142aa460e9` = production runtime SHA = host checkout SHA = origin/m7 HEAD（本 docs evidence commit 后 origin/m7 会高于 runtime——以现场 `git rev-parse` 为准）。
- **pre-deployment backup**：`/vol1/1000/backups/zhiying/tts-b-20260803T054625Z`（DB SHA `3b92bec5…` 与 R2 全等=期间零写入；integrity=ok；**SHA256SUMS 全 OK、0 FAILED**；含 zhiying.db online backup、schema.sql、migration-state、tts_jobs 全表 dump+hash、voice tables、voice-library-dir、narration/manifest/subtitle、llm/usage、assets/bindings、render、leases、compose×2、`.env.production`（内容不进报告）、previous-sha（1460efd）、invariants baseline）。
- **构建网络 runbook**：`production-build-network.sh start/check` 通过 → `docker build --network=host --add-host remotion.media:127.0.0.1 --build-arg APT_MIRROR --build-arg NPM_REGISTRY -t zhiying:0b70e81…`（**BUILD_EXIT=0**，trap 保证 stop）→ tunnel `STOPPED`、443 无 listener、worktree clean；image digest `74a62c4e…`。
- **镜像内测试**（`NODE_ENV=development`，scripts+docs 只读挂载，image SHA = mounted SHA = 0b70e81）：**23 套件全绿**——TTS-A 7（34/25/78/23/30/31/39）、**TTS-B 5（37/31/15/9/21）**、frozen 11（m73b 92/96/114/71、m73a、billing 68、bind 45、leases 87、m71-tts 25、m3b-tts 99、m3c 82）。agentvm 同 23 套全绿。
- **migration 演练**（production DB 副本，`getDb()`）：新增 `voice_assignment_requests` 表（TTS-B request envelope）就位且 0 行；voice_profiles/revisions 0/0；2 个 ABORT trigger 就位；重跑幂等；**351 条 tts_jobs hash `92c67ac2` 不变**；integrity ok。未手工 sqlite3 ALTER production。
- **up 验证**：三容器 healthy @`zhiying:0b70e81…`/`zhiying-indextts2-adapter:0b70e81…`（adapter 代码未变，沿用原 digest 重新 tag；`ZHIYING_RELEASE_TAG=0b70e81…`）；local root 200、/api/projects 200、/settings/voices 200、/api/voice-profiles 200（`{"profiles":[]}`）、**TTS-B 路由挂载（/api/projects/no-such/voice-assignments 与 …/narration-performance-plans 均 404=route 存在且 project 检查生效）**；worker/web 日志无 startup/SQLite/lease/provider error；resource leases 0；443/tunnel 0；host worktree clean。
- **Production 数据不变量（部署前后只读对比，28 项全过）**：projects 全 m6/rigorous（3）；snapshot pointer 全 NULL；M7 snapshot 0；Freud narration_plan_v2/narrative_beats/visual_intent hash 与备份全等；visual_sequence_plan/shot_plan/timing_reconciliation_v2 全 0；**project_voice_assignment artifact=0、narration_performance_plan artifact=0**；**TTS-B generation runs=0、dispatch jobs=0**；tts_jobs 351=351 且 hash `92c67ac2` 全等；voice_profiles=0、voice_profile_revisions=0；`data/voice-library` 不存在；narration_audio_manifest/subtitle_timing hash 全等；llm_usage 69=69；usage_events 610=610；asset_generation_jobs 0=0；assets/bindings 40=40；render_jobs 14=14；leases=0；无项目切换 m7；无真实 LLM/APIYi/IndexTTS2 调用。
- **状态**：**M7.3B FROZEN；TTS-A FROZEN；TTS-B deployed；TTS-B pending independent Review PASS；TTS-C not started**。
- **本轮未执行**：不在 production 创建 Voice Profile/Assignment/Performance candidate；不调用真实 IndexTTS2 adapter；不生成 TTS；不 enqueue tts_jobs；不生成 narration master；不做 subtitle timing；不创建 timing-reconciliation@2.0；不创建 M7 snapshot；不切换任何项目到 m7；不改写历史 tts_jobs；不 materialize adapter `/voices`；不发布 adapter registry。
- **证据边界**：OPS-AUDIT-BRIDGE 不可用（仓库无此设施）；以上 production 证据来自 Agent 现场命令，**不是** independently verified。

### 15.8 TTS-B.R1 部署证据（d24b176，2026-08-03）

- **部署链**：code SHA `d24b17644f2f22f864392a272d7d7ea7b493892c` = production runtime SHA = host checkout SHA = origin/m7 HEAD（本 docs evidence commit 后 origin/m7 会高于 runtime——以现场 `git rev-parse` 为准）。
- **pre-deployment backup**：`/vol1/1000/backups/zhiying/tts-b-r1-20260803T065943Z`（DB SHA `4d3c577e…`；integrity=ok；**SHA256SUMS 全 OK、0 FAILED**；含 zhiying.db online backup、schema.sql、migration-state、voice_assignment_requests、voice tables、tts_jobs 全表 dump+hash、narration/manifest/subtitle、llm/usage、assets/bindings、render、leases、compose×2、`.env.production`（内容不进报告）、previous-sha（0b70e81）、invariants baseline）。
- **构建网络 runbook**：`production-build-network.sh start/check` 通过 → `docker build --network=host --add-host remotion.media:127.0.0.1 --build-arg APT_MIRROR --build-arg NPM_REGISTRY -t zhiying:d24b176…`（**BUILD_EXIT=0**，trap 保证 stop）→ tunnel `STOPPED`、443 无 listener、worktree clean；image digest `124cc0a6…`。
- **镜像内测试**（`NODE_ENV=development`，scripts+docs 只读挂载，image SHA = mounted SHA = d24b176）：**23 套件全绿**——TTS-A 7（34/25/78/23/30/31/39）、**TTS-B 5（55/31/22/20/29，TTS-B.R1 新增 ID schema/commit fence/archived replay/source 自洽/locked Script drift/succeeded 重放）**、frozen 11（m73b 92/96/114/71、m73a、billing 68、bind 45、leases 87、m71-tts 25、m3b-tts 99、m3c 82）。agentvm 同 23 套全绿。
- **migration 演练**（production DB 副本，`getDb()`）：无 schema 变更——voice_assignment_requests schema 不变且 0 行；voice tables 0/0；重跑幂等；**351 条 tts_jobs hash `92c67ac2` 不变**；integrity ok。未手工 sqlite3 ALTER production。
- **up 验证**：三容器 healthy @`zhiying:d24b176…`/`zhiying-indextts2-adapter:d24b176…`（adapter 代码未变，沿用原 digest 重新 tag；`ZHIYING_RELEASE_TAG=d24b176…`）；local root//api/projects//settings/voices//api/voice-profiles 200（`{"profiles":[]}`）；**TTS-B GET routes 404（route 挂载 + project 检查生效）**；worker/web 日志无 startup/SQLite/lease/provider error；resource leases 0；443/tunnel 0；host worktree clean。
- **Production 数据不变量（部署前后只读对比，29 项全过）**：projects 全 m6（3）；snapshot 全 NULL/0；Freud narration/beats/intent hash 全等；m7b kinds 全 0；project_voice_assignment artifact=0、narration_performance_plan artifact=0、voice_assignment_requests=0、TTS-B runs=0、dispatch=0；**tts_jobs total=351、hash `92c67ac2` 全等、本轮新增 TTS job=0**；voice_profiles/revisions 0/0；voice-library 不存在；narration_audio_manifest/subtitle_timing hash 全等；timing_reconciliation_v2=0；llm_usage 69=69；usage_events 610=610；assets/bindings 40=40；render 14=14；leases=0；无项目切换 m7；无真实 LLM/APIYi/IndexTTS2 调用。
- **状态**：**M7.3B FROZEN；TTS-A FROZEN；TTS-B.R1 deployed；TTS-B pending independent Review PASS；TTS-C not started**。
- **本轮未执行**：不在 production 创建 Voice Profile/Assignment/Performance candidate；不 POST Assignment/Performance；不调用真实 IndexTTS2 adapter；不 enqueue TTS job（新增=0）；不生成 narration master；不做 subtitle timing；不创建 timing-reconciliation@2.0；不创建 M7 snapshot；不切换任何项目到 m7；不改写历史 tts_jobs；不 materialize adapter `/voices`；不发布 adapter registry。
- **证据边界**：OPS-AUDIT-BRIDGE 不可用（仓库无此设施）；以上 production 证据来自 Agent 现场命令，**不是** independently verified。

### 15.9 TTS-B.R2 部署证据（34ee6c3，2026-08-03）

- **部署链**：code SHA `34ee6c3c83339c375bd0fb43c248397b8e044021` = production runtime SHA = host checkout SHA = origin/m7 HEAD（本 docs evidence commit 后 origin/m7 会高于 runtime——以现场 `git rev-parse` 为准）。
- **GitHub Actions 独立 CI**：workflow `.github/workflows/m7-quality-gate.yml`（job `M7 Quality Gate`，ubuntu-24.04，Node 22 + pnpm 11.9.0，apt ffmpeg/ffprobe），统一权威入口 `scripts/run-m7-quality-gate.sh`（agentvm / 镜像内 / CI 共用）。push m7 自动运行；exact code SHA `34ee6c3…` 的 run `30796556192` = **completed / success**（`QUALITY_GATE_RESULT=PASS`，26 suites：git-diff-check + typecheck + build + TTS-B 5 + TTS-A frozen 7 + frozen/existing 11）；artifact `m7-quality-gate-34ee6c3…` 已上传（含日志，无 secret/生产数据）。
- **pre-deployment backup**：`/vol1/1000/backups/zhiying/tts-b-r2-20260803T074900Z`（DB SHA `4d3c577e…` 与 R1 全等=期间零写入；integrity=ok；**SHA256SUMS 全 OK、0 FAILED**；含 zhiying.db online backup、schema、migration-state、voice_assignment_requests、voice tables、tts_jobs 全表 dump+hash、narration/manifest/subtitle、llm/usage、assets/bindings、render、leases、compose×2、`.env.production`（内容不进报告）、previous-sha（d24b176）、invariants baseline）。
- **Exact-SHA 构建**：runbook start/check → `docker build --network=host --add-host remotion.media:127.0.0.1 --build-arg APT_MIRROR --build-arg NPM_REGISTRY -t zhiying:34ee6c3…`（**BUILD_EXIT=0**，trap 保证 stop）→ tunnel `STOPPED`、443 无 listener、worktree clean；image digest `a258fd9a…`（本轮 code 仅 shell runner 变化，src/.next 未变，digest 与 810ebc3/0b40c1f 相同）。
- **镜像内门禁**（`NODE_ENV=development`，scripts+docs 只读挂载，image SHA = mounted SHA = 34ee6c3；同一 `run-m7-quality-gate.sh`）：**26 suites 全 PASS**（git 步骤在无 .git 环境跳过并记录；build 步骤 env -u NODE_ENV 规避 next build 在 NODE_ENV=development 下的 prerender 异常）。
- **migration 演练**（production DB 副本，`getDb()`）：无 schema 变更——voice_assignment_requests schema 不变且 0 行；voice tables 0/0；重跑幂等；**351 条 tts_jobs hash `92c67ac2` 不变**；integrity ok。未手工 sqlite3 ALTER production。
- **up 验证**：三容器 healthy @`zhiying:34ee6c3…`/`zhiying-indextts2-adapter:34ee6c3…`（adapter 代码未变，沿用原 digest 重新 tag；`ZHIYING_RELEASE_TAG=34ee6c3…`）；local root//api/projects//settings/voices//api/voice-profiles 200（`{"profiles":[]}`）；**TTS-B GET routes 404（route 挂载）**；worker/web 日志无 startup/SQLite/lease/provider error；resource leases 0；443/tunnel 0；host worktree clean。
- **Production 数据不变量（部署前后只读对比，29 项全过）**：projects 全 m6（3）；snapshot 全 NULL/0；Freud narration/beats/intent hash 全等；m7b kinds 全 0；project_voice_assignment=0、narration_performance_plan=0、voice_assignment_requests=0、TTS-B runs=0、dispatch=0；**tts_jobs total=351、hash `92c67ac2` 全等、本轮新增 TTS job=0**；voice_profiles/revisions 0/0；voice-library 不存在；narration_audio_manifest/subtitle_timing hash 全等；timing_reconciliation_v2=0；llm_usage 69=69；usage_events 610=610；assets/bindings 40=40；render 14=14；leases=0；无项目切换 m7；无真实 LLM/APIYi/IndexTTS2 调用。
- **状态**：**M7.3B FROZEN；TTS-A FROZEN；TTS-B.R2 deployed；TTS-B pending independent Review PASS；TTS-B not frozen；TTS-C not started**。
- **本轮未执行**：不在 production 创建 Voice Profile/Assignment/Performance candidate；不 POST Assignment/Performance；不调用真实 IndexTTS2 adapter；不 enqueue TTS job（新增=0）；不生成 narration master；不做 subtitle timing；不创建 timing-reconciliation@2.0；不创建 M7 snapshot；不切换任何项目到 m7；不改写历史 tts_jobs；不 materialize adapter `/voices`；不发布 adapter registry。
- **证据边界**：GitHub Actions 是 independently observable evidence（run ID/conclusion 可在 GitHub 核验）；production 证据来自 Agent 现场命令，OPS-AUDIT-BRIDGE 不可用，**不是** independently verified。

### 15.10 TTS-B.R3 部署证据（86f7f52，2026-08-03）

- **部署链**：exact code SHA `86f7f52b2f81d20d352de6d3189792c25e6cfe29` = production runtime SHA = host checkout SHA（push 的 head SHA，树内含 R3 全部代码修改：ae10c99/bed53d8/945610b）；部署证据 docs commit 后 origin/m7 会高于 runtime——以现场 `git rev-parse` 为准。
- **GitHub Actions 独立 CI**：exact code SHA `86f7f52…` 的 run `30801164259` = **completed / success**（`QUALITY_GATE_RESULT=PASS`，`QUALITY_GATE_TOTAL_SUITES=27`）；artifact `m7-quality-gate-86f7f52…`（digest `sha256:0b7f738…`，31243 B，含完整日志，无 secret/生产数据）。**CI 失败退出码传播（R3）**：gate 步骤 `set -o pipefail` + tee；`scripts/test-m7-quality-gate-exit-propagation.sh` 纳入统一 gate（suite 26→27）；summary 从 gate 输出读取 suite 数（不再硬编码）。
- **agentvm 本地 gate**（同一 `run-m7-quality-gate.sh`，PATH 含 `.tools/static-ffmpeg`）：**27 suites 全 PASS**（git-diff-check/typecheck/next-build/m7-exit-propagation/TTS-B 5/TTS-A frozen 7/frozen-existing 11）；performance-generation 29 PASS（含 **E20**：outer check 通过后、BEGIN IMMEDIATE 前真实 lock Script V2 B → 事务内重新 classify=stale → SOURCE_STALE、run failed、零 artifact、provider 恰好一次、无 TTS job；并做 **mutation 验证**：禁用事务内 fence 时 E20c FAIL，证明测试真实复现 R2 漏洞）。
- **pre-deployment backup**：`/vol1/1000/backups/zhiying/tts-b-r3-20260803T092613Z`（integrity=ok；**SHA256SUMS 0 FAILED**；36 文件；含 zhiying.db online backup、schema、migration state、voice_assignment_requests、voice tables、tts-b artifacts/runs/dispatch、**tts_jobs 全表 dump + hash `02cfde74…`（count=351）**、artifacts inventory、llm/usage、projects/stages/versions、assets/bindings、render、leases、compose×2、`.env.production` 备份（内容不进报告）、previous-sha `34ee6c3`、invariants baseline、BACKUP_COMPLETED_AT、SHA256SUMS）。
- **Exact-SHA 构建**：宿主机 checkout `86f7f52…`（worktree clean）→ runbook start/check → `docker build --network=host --add-host remotion.media:127.0.0.1 --build-arg APT_MIRROR --build-arg NPM_REGISTRY -t zhiying:86f7f52…`（**BUILD_EXIT=0**，trap 保证 stop）→ 镜像 digest `sha256:4052c71d…`；tunnel=0、443 listener=0、worktree clean。
- **镜像内门禁**（`NODE_ENV=development`，scripts+docs 只读挂载，image SHA = mounted SHA = 86f7f52；同一 `run-m7-quality-gate.sh`）：**27 suites 全 PASS**（git 步骤在无 .git 环境 SKIP 并计入；QUALITY_GATE_SHA=unknown 属预期）。
- **migration rehearsal**（production DB 副本 `/tmp/tts-b-r3-rehearsal-data` + 镜像内 `getDb()`）：getDb 幂等（同实例）；schema 关键表全部存在；voice_assignment_requests 兼容且 0 行；voice tables 0/0；TTS-B artifacts/runs/dispatch 0；**tts_jobs count=351**；integrity=ok；无 schema migration；未手工 ALTER production。
- **up 验证**：三容器 healthy @`zhiying:86f7f52…`/`zhiying-indextts2-adapter:86f7f52…`（adapter 代码未变，沿用原 digest 重新 tag；`ZHIYING_RELEASE_TAG=86f7f52…`）；local root//api/projects//settings/voices//api/voice-profiles 200；**TTS-B GET routes 404（route 挂载）**；worker/web/adapter 日志无 startup/SQLite/lease/provider error（web 仅 Node SQLite experimental warning）；resource leases 0；443/tunnel 0；host worktree clean。
- **Production 数据不变量（部署前后只读对比，全部一致）**：projects=3 全 m6；snapshot pointers=0；**artifacts 全表（含 content_json）backup DB vs production DB hash 全等**（c4b5d7d6…）；project_stages/project_versions/llm_usage/tts_jobs hash 全等；tts_jobs=351、hash `02cfde74…` 全等、**本轮新增 TTS job=0**；voice_profiles/revisions 0/0；voice_assignment_requests=0；TTS-B artifacts/runs/dispatch=0；M7.3B kinds=0；timing_reconciliation_v2=0；llm_usage 69=69；usage_events 610=610；assets/bindings 40=40；render_jobs 14=14；leases=0；voice-library 无业务文件；无项目切换 m7；无真实 LLM/APIYi/IndexTTS2 调用。
- **状态**：**M7.3B FROZEN；TTS-A FROZEN；TTS-B.R3 deployed；TTS-B pending independent Review PASS；TTS-B not frozen；TTS-C not started**。
- **本轮未执行**：不在 production 创建 Voice Profile/Assignment/Performance candidate；不 POST Assignment/Performance；不调用真实 IndexTTS2 adapter；不 enqueue TTS job（新增=0）；不生成 narration master；不做 subtitle timing；不创建 timing-reconciliation@2.0；不创建 M7 snapshot；不切换任何项目到 m7；不改写历史 tts_jobs；不 materialize adapter `/voices`；不发布 adapter registry；不开始 TTS-C。
- **证据边界**：GitHub Actions 是 independently observable evidence（run 30801164259 / conclusion success / artifact digest 可在 GitHub 核验）；production 证据来自 Agent 现场命令，OPS-AUDIT-BRIDGE 不可用，**不是** independently verified。
