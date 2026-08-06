# M7 实施状态技术文档

> 面向开发与接力 agent 的技术状态文件，不是宣传介绍。
> 每次 milestone 完成或 production 部署后必须更新本文件。

## 1. 元信息

| 项 | 值 |
|---|---|
| 字段 | 值 |
|---|---|
| statusUpdatedAt | 2026-08-06T03:33Z（M7.3B FROZEN；**TTS-A FROZEN**；**TTS-B FROZEN（独立 Review PASS）**；**TTS-C.0 = FROZEN（独立 Review PASS）**；**TTS-C.1A = FROZEN（R7 Final Proportional Review PASS + Deployment Evidence Review PASS；production runtime = `37eaac6c8c8969239cab00848f6291454615a912`；POST remains disabled）**；**TTS-C.1B.1 implemented（branch `work/tts-c1b1-adapter-contract`；pending independent Review；not merged / not deployed）；TTS-C.1B.1.R1 blocker fixed（reference 文件验证前置，pending blocker-specific Review；not merged / not deployed）**；TTS-C.1B.2 / 1B.3 / 1C planning authorized（implementation not started）；TTS-C.2 not authorized） |
| reviewedCodeSHA | `e3bd60a879cb279c6bd19b1c2d5013073b7155d3`（M7.3B final code/runtime；M7.3B deployment evidence docs HEAD 为 `044ac23e2524d53f41d223c37d16619425b21182`；M7.3A frozen code 为 `aa3f814…`） |
| productionRuntimeSHA | `37eaac6c8c8969239cab00848f6291454615a912`（TTS-C.1A.R7 部署后容器镜像实际代码 SHA；runtime code 内容来自 `17d4078…`，`37eaac6…` 仅多 complexity-policy docs；TTS-C.0 freeze 基线与 CI 证据见 §11.4） |
| productionHostCheckoutSHA | `37eaac6c8c8969239cab00848f6291454615a912`（宿主机 checkout = `ZHIYING_RELEASE_TAG`，与 R7 部署镜像代码 SHA 一致；可因 docs/ops commit 高于 runtime） |
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
- **TTS-C.0.R13 architecture revision completed（pending independent Review；runtime implementation not started；TTS-C.1A / 1B / 1C not started；production runtime unchanged `86f7f52…`；docs-only，零代码/零部署/零 migration/零 schema 变更）**：关闭独立 Review 对 R12 的 FAIL 发现——**P0-D（terminal claim evidence 可篡改）** → ⑥ 补 **claim terminal evidence seal**：新增 `trg_tsc_terminal_immutable`（succeeded/failed/cancelled 的 claim 全字段——status/result_artifact_id/owner_token/lease/validation_owner_token/validation_lease/validation_attempt/candidate_artifact_id/candidate_artifact_metadata_hash/validation_started_at/last_execution_command_id/execution_command_seq/updated_at——完全冻结；基于 OLD.status 为 terminal 才冻结，进入 terminal 的同一 state_transition/prestart_terminal/reuse finalize statement 不误伤）+ `trg_tsc_post_validation_evidence_seal`（离开 validating_reuse 后 candidate_artifact_id/candidate_artifact_metadata_hash/validation_started_at 一律 immutable；dispatch 出口同 statement 清空与 reuse finalize 保留 snapshot 均不受影响）；**attempt 语义冻结**：generated execution 双侧恒等（worker_claim 建立、execution_takeover 双侧 +1、generated terminal 保留最后 exact attempt 且任一侧不可改——CE-15 实证无 split）；prestart terminal 无 Worker attempt（job.attempt 保持初始 0，command.worker_attempt 仅作 validation fence，commit 后各自 immutable——禁止模糊写"双侧 attempt 永远恒等"）；validating_reuse 阶段既有 validation takeover/finalize/candidate 协议不受影响（CE-10/19）。R12 applied-command chain 全套（previous/head/seq、historical replay seal、五类 command、claim↔job exact JOIN、owner/attempt/head exact fencing、terminal job owner shape、DB_NOW_MS、indeterminate 非终态）**不回退**。证据口径：**150 项 mutation 实跑 FAIL=0（两引擎逐 test 一致；R13 新增 CE-01…20 共 20 项 + R12 全矩阵重跑 130 项）**；runner 入库 `docs/evidence/tts-c-r13/`（只从设计文档 §2 提取 SQL；真实 BEGIN IMMEDIATE 事务；原始输出含 git HEAD（=checked-in snapshot 生成时 base HEAD）/design SHA/SQL SHA/逐 test/总数；final HEAD 权威绑定由 CI artifact 提供）；R12 的 130 项、R11 的 110 项、R10 的 91 项、R9 的 360/23-29 不再引用；历史回归 NOT EXECUTED 清单见设计文档 §10.5，不计入 PASS。CI：`TTS-C Contract Gate` 指向 r13（临时输出 `/tmp/ttsc-r13-ci`）；sqlite3 CLI fail-closed pin 3.45.1；Python 版本记录报告；final HEAD 重新生成双引擎结果、两引擎一致、SHA 一致、FAIL>0 → failure、artifact + summary。D1-D5（R10-R13 修复/语义）保留。1A/1B/C.2 migration 实施时按 R13 contract 直接落地。
- **TTS-C.0 = FROZEN（独立 Review = PASS）**：R13 executable SQLite contract 经独立 Review
  **CONDITIONAL PASS**（无需 R14 架构修订）；本轮完成不改变 §2 的文档/evidence 标签归一化后正式冻结。
  冻结基线：**reviewed executable contract commit `ae7a93d26614326ead70790f65de5d95a57d167e`**；
  **reviewed §2 SQL SHA `c88f64ac880a0cf50519a3b5eaba724a701b93ac5acea0e9c4fbdf90dd6f50d8`**
  （归一化前后经 extract_contract 复核不变）；freeze/docs normalization commit = 本轮新 SHA。
  GitHub CI evidence：R13 contract 150/150（双引擎一致）+ runtime gate 27 suites + final checkout
  SHA + artifacts/digest（见本轮 CI 记录）。冻结语义（23 项）：exact source / no latest fallback；
  immutable Voice Revision；materialization projection 与 publication 分离；request envelope
  initializing；validating state unschedulable；database-time lease fencing；validation takeover
  fenced；active subscriber gating；durable temp→validate→rename→file fsync→dir fsync；file durable
  先于 DB success；global publication journal；legacy mapping 双路径；indeterminate evidence seal；
  execution applied-command chain；historical command replay seal；claim/job execution head exact；
  five command kinds；terminal claim/job evidence immutable；prestart attempt 与 generated attempt
  区分；final TTS fingerprint 边界；1A 不发布 registry；1A 不调用 provider；后续阶段不得顺带重构
  冻结 SQL。TTS-C runtime implementation baseline = not started。
- **TTS-C.1A = FROZEN（R7 Final Proportional Review PASS + Deployment Evidence Review PASS）**：final code/runtime = `37eaac6c8c8969239cab00848f6291454615a912`（runtime code 内容来自 `17d40787ce70c025d7daa012c04a76bc69c10a2b`，`37eaac6…` 仅多 complexity-policy docs）；deployment evidence docs = `c29801b3b313a41560e4e0547033c2a409ed244c`（`docs/evidence/tts-c-r17/deployment.md`，§15.15）。冻结语义：projection 止于 `file_ready_unpublished`；不发布 registry、不激活 adapter、不 cutover、不合成 TTS；production POST remains disabled（`TTS_C1A_MATERIALIZATION_POST_ENABLED` 未设置）；publication/activation/legacy 三表保持 0 行写入。R7 为 TTS-C.1A 防御复杂度上限（proportional-risk rubric；不启动 R8；见 `docs/TTS_C_1A_MATERIALIZATION_IMPLEMENTATION.md` §15-16）。TTS-C.1B / 1C planning authorized（implementation not started，实施计划见 `docs/TTS_C_1B_1C_EXECUTION_PLAN.md`）；TTS-C.2 not authorized。
- **TTS-C.1B.1 implemented（branch `work/tts-c1b1-adapter-contract`；pending independent Review；not merged / not deployed；production 不变）**：adapter registry reload contract（`services/indextts2-api-adapter/server.py`）——registry schema 1.0/1.1 双支持向后兼容（1.0 legacy 内部 `generation/publisherSchemaVersion=null`；1.1 要求 `registryGeneration` positive integer + `publisherSchemaVersion` 精确值 `tts-c-registry-publisher@1`，voices 沿用既有严格校验）；`RegistryState` 不可变整体替换（status/voices/loadedRegistrySha256=文件原始 bytes 单一 SHA-256/loadedRegistryGeneration/publisherSchemaVersion/schemaVersion/lastReloadError/degraded；单引用赋值 + threading.Lock，reader 快照引用）；`POST /reload`（只读 `ADAPTER_VOICE_REGISTRY_PATH` 固定路径、完整验证、一次性原子替换；失败有 LKG → 保持旧 state/旧 voices + degraded=true + lastReloadError + 非 2xx `VOICE_REGISTRY_RELOAD_FAILED`，无 LKG → ready=false + synthesize 503）；`GET /registry-status`（唯一 activation acknowledgment 观察面：ready/degraded/schemaVersion/loadedRegistrySha256/loadedRegistryGeneration/publisherSchemaVersion/speakerCount/detail/lastReloadError）；`/health` 兼容扩展 `degraded`（LKG degraded 视为 healthy + detail=最近失败码）；`/v1/synthesize` 请求/响应语义不变。测试 `scripts/test-tts-c1b1-adapter-registry.ts` 34 PASS（六场景 + R1 五项；mock upstream/临时目录，独立运行 ×2 无进程/端口泄漏）；gate suite 数 52→53。**TTS-C.1B.1.R1 blocker fixed**：`_load_registry_file()` 在给出任何 OK/ack 前对每个 voice 的 reference 文件完整验证（存在 + 普通文件 + 可读 + 实际 SHA-256 == referenceSha256，统一 `_validate_reference_file()` helper，带 (mtime_ns,size) 缓存并填充 `_sig/_actual_sha256/expected_md5`，成功 reload 后首次 synthesize 不重复读文件）；任一 reference 失败 → 本次加载非 OK（有 LKG → reload 非 2xx `VOICE_REGISTRY_RELOAD_FAILED` + degraded + lastReloadError 精确到 `REFERENCE_VOICE_MISSING`/`REFERENCE_SHA256_MISMATCH` + 旧 voice 继续 synthesize；无 LKG → ready=false + health detail 同码 + synthesize 503 同码）。错误码**复用既有 frozen 语义**（m4b T09/T10 锁定 `REFERENCE_VOICE_MISSING`/`REFERENCE_SHA256_MISMATCH`，不引入新码避免 ack/health/synthesize 错误码面漂移）；synthesize 对 `REFERENCE_*` 状态透传原码、对 `VOICE_REGISTRY_*` 保持既有 `VOICE_REGISTRY_INVALID` 聚合码。测试扩展 R01-R05（LKG+缺失、LKG+SHA 不符、冷启动缺失、冷启动 SHA 错、修复后 reload 恢复），T01-T20 全数回归 PASS；R1 场景并入既有 suite，gate suite 数不变（52→53）。**未实现**：publisher、legacy import、DB publication 写入、activation、recovery、production 拓扑变更（1B.2/1B.3/C.2 not authorized）。
- **TTS-C.0.R12（历史记录，已被 R13 修订取代；R12 独立 Review FAIL：P0-D terminal claim evidence 可篡改，由 R13 关闭）**——原 R12 条目存档：architecture revision completed（pending independent Review；runtime implementation not started；TTS-C.1A / 1B / 1C not started；production runtime unchanged `86f7f52…`；docs-only，零代码/零部署/零 migration/零 schema 变更）**：关闭独立 Review 对 R11 的 FAIL 发现——**P0-C（historical command replay）** → ⑥ 采用 **applied-command chain（execution head）**：claim/job 各增加 `last_execution_command_id` + `execution_command_seq`（双侧恒等；TTS-C 行 dispatch 后 seq=0/last=NULL；legacy 行 NULL 不受影响）；`tts_job_execution_transitions` 增加 `previous_command_id` + `command_seq`（首条 worker_claim/prestart_terminal：previous IS NULL、seq=1；后续：previous=双侧当前 head id、seq=当前 seq+1；`UNIQUE(job_id,command_seq)` + `UNIQUE(claim_id,command_seq)` 使 chain 严格单调、无重复 seq、不可回退/跳号/重复消费）；五类 `command_kind` 互斥保持，renewal/takeover/state_transition 的 owner/attempt/head 校验升级为 **claim↔job 精确配对 JOIN**（单一 EXISTS 内裁决 `claim.owner_token = job.claimed_by`、attempt 双侧相等、head 双侧相等、status 双侧 exact；R11 的两个互不关联 EXISTS 作废）；**direct mutation fence 一律绑定 NEW head**（R12 核心）：任何受保护字段变化必须同时满足 head 精确推进（`NEW.seq = OLD.seq+1`、`NEW.last = 该 seq 唯一 command e`、`e.previous_command_id IS OLD.last`、`e.from/to = OLD/NEW status`、字段值与 e 逐项一致）——**历史 command 的 id/seq 永远不等于当前 head 的 NEW 值（seq 必须 OLD+1），历史行不能授权任何直接 UPDATE**；新增 `trg_tsc_head_command` / `trg_tjs_head_command`（head 不可回退/跳号/单侧推进/重复消费）+ `trg_tjs_terminal_shape`（TTS-C job terminal claimed_* 必须 NULL）；terminal 后 owner/attempt/error/head 复活一律 ABORT；`prestart_terminal` 不回退（首条 command 语义）；当前 head 行的"完整重放"= 零变化 no-op（不构成篡改），任何改值变体被 chain fence 拒绝（HR-20 实证语义冻结）。证据口径：**130 项 mutation 实跑 FAIL=0（两引擎逐 test 一致；R12 新增 HR-01…20 historical replay seal 20 项 + R11 全矩阵重跑 110 项）**；runner 入库 `docs/evidence/tts-c-r12/`（只从设计文档 §2 提取 SQL；真实 BEGIN IMMEDIATE 事务；原始输出含 git HEAD / design SHA / SQL SHA / 逐 test / 总数；checked-in snapshot 记录生成时 base HEAD，final HEAD 权威绑定由 CI artifact 提供）；R11 的 110 项被覆盖、R10 的 91 项与 R9 的 360/23-29 口径不再引用；历史回归 NOT EXECUTED 清单见设计文档 §10.5，不计入 PASS。CI：`TTS-C Contract Gate` 指向 r12；**sqlite3 CLI 版本 fail-closed pin 3.45.1**（不匹配即 failure；Python 版本记录报告、CLI 为 authoritative engine）；final HEAD 重新生成双引擎结果、两引擎一致、SHA 一致、FAIL>0 → failure、artifact + summary。D1-D3（R10/R11 修复项）保留；D4（当前 head 行重放=no-op 语义）冻结。1A/1B/C.2 migration 实施时按 R12 contract 直接落地。
- **TTS-C.0.R11（历史记录，已被 R12 修订取代；R11 独立 Review FAIL：P0-C historical command replay，由 R12 关闭）**——原 R11 条目存档：architecture revision completed（pending independent Review；runtime implementation not started；TTS-C.1A / 1B / 1C not started；production runtime unchanged `86f7f52…`；docs-only，零代码/零部署/零 migration/零 schema 变更）**：关闭独立 Review 对 R10 的 FAIL 发现——**P0-A**（owner/lease/attempt 无唯一原子入口）→ ⑥ `tts_job_execution_transitions` 扩展 `command_kind` 五态互斥：**worker_claim**（首次 ownership establishment，R10 保留）、**lease_renewal**（running/indeterminate 同态续租：双侧 owner/attempt exact + 旧 lease >= DB_NOW + 新 lease > 旧 lease 且 > DB_NOW + heartbeat 不早于旧；一条 statement 原子更新 claim lease + job heartbeat；同 attempt 可多次、requestId 幂等）、**execution_takeover**（同态接管：旧 owner 双侧 exact + 旧 lease < DB_NOW + 新 owner 不同 + attempt=旧+1 + 新 lease > DB_NOW；一条 statement 原子更新双侧 owner/attempt；替代 R10 两条 UPDATE CAS）、**prestart_terminal**（Worker claim 前终结：claim generation_pending + job queued → 双侧 failed/cancelled，无 owner、attempt=claim validation_attempt、failed 必 error_code、cancelled 必 reason/error_code）、**state_transition**（R10 保留，owner fencing 双侧 exact）；幂等 = `transition_request_id UNIQUE` + 按 kind partial unique 语义防重（renewal 同 attempt 可多次）；**per-column 直接修改 fence（P0-A 核心）**：执行期 claim `owner_token/lease_expires_at_epoch_ms/validation_attempt` 与 TTS-C job `claimed_by/claimed_at/heartbeat_at/attempt/started_at/finished_at/error_code/error_message` 任何直接 UPDATE 无精确匹配 command 行一律 ABORT——same-status owner split / attempt 伪造 / terminal owner 复活结构上不可提交；**P0-B**（queued/generation_pending→failed/cancelled 不可达）→ `prestart_terminal` command 使该边真实可达（Scheduler 静态 preflight 失败 / active subscriber=0 / 明确取消；不得用于已 running / Provider 已调用 / indeterminate resolve）；**P1-A**（runner 无真实事务）→ `Harness.tx()`：PyEngine 同一 connection BEGIN IMMEDIATE→逐条→COMMIT/ROLLBACK，CLI 同一进程脚本 `BEGIN IMMEDIATE; …; COMMIT;`（-bail，失败后新连接验证回滚）；**P1-B**（CI 未绑定 contract）→ `.github/workflows/m7-quality-gate.yml` 新增 `TTS-C Contract Gate` job（final HEAD 双引擎重新生成、两引擎一致、SHA 一致、FAIL>0 → failure、artifact + summary）。证据口径：**110 项 mutation 实跑 FAIL=0（两引擎逐 test 一致；R11 新增 JS-18…35 共 25 项 + R10 全矩阵重跑 85 项）**；runner 入库 `docs/evidence/tts-c-r11/`（只从设计文档 §2 提取 SQL；真实事务；原始输出含 git HEAD / design SHA / SQL SHA / 逐 test / 总数）；R10 的 91 项被覆盖、R9 的 360/23-29 口径作废；历史回归 NOT EXECUTED 清单见设计文档 §10.5，不计入 PASS。官方参考审计（SQLite/Temporal/BullMQ 只读对照）写入设计文档 §1.5；不引入新依赖。顺带修复 D2（indeterminate→succeeded resolve 清 job error 证据）与 D3（prestart 写 finished_at）。R10 schema 与 R9 同源，1A/1B/C.2 migration 实施时按 R11 contract 直接落地。
- **TTS-C.0.R10（历史记录，已被 R11 修订取代；R10 独立 Review FAIL：P0-A owner 唯一入口 / P0-B prestart 可达 / P1-A runner 事务 / P1-B CI 绑定，均由 R11 关闭）**——原 R10 条目存档：architecture revision completed（pending independent Review；runtime implementation not started；TTS-C.1A / 1B / 1C not started；production runtime unchanged `86f7f52…`；docs-only，零代码/零部署/零 migration/零 schema 变更）**：关闭独立 Review 对 R9 的 FAIL 发现——**P0-1**（execution transition 第一条 command 因 `generation_pending` owner NULL 与 fence 死锁永不可执行）→ ⑥ 重写为 `command_kind` 双态：**worker_claim**（首次 ownership establishment：双方无 owner + command lease > DB_NOW_MS + attempt=claim.validation_attempt，一条 statement 同步建立 claim.owner_token/lease 与 job.claimed_by/claimed_at/heartbeat_at/attempt/started_at）与 **state_transition**（running/indeterminate→终态/indeterminate，owner fencing：claim.owner_token=job.claimed_by=command.worker_owner_token + claim lease >= DB_NOW_MS + 双侧 attempt exact；→indeterminate 保留双侧 owner/lease 供 resolve fence 与 §3.6 execution takeover CAS，终态清空）；**P0-2**（`UNIQUE(job_id)`/`UNIQUE(claim_id)` 阻断全生命周期多 transition）→ 删除，改 `transition_request_id UNIQUE` 幂等 + `UNIQUE(job_id, from_job_status, to_job_status, worker_attempt)` 语义防重（同一 job `queued→running→succeeded/failed/cancelled/indeterminate→…` 多阶段 command 连续可写，完全相同 replay 唯一拒绝）；显式四状态冻结（from/to claim/job status 必须成对相等，分裂状态不可提交）；`trg_tjs_command_required`/`trg_tsc_command_required` 扩展为全部 TTS-C 状态迁移必须精确匹配（from,to）command 行；`running→succeeded` command 为 §8.2 原子成功终局事务内一条 statement，不成为独立事务；**P0-3**（`legacy_cutover_existing` 不可达）→ ④⑤ 重写：`legacy_adapter_voice_entries` 新增 `mapping_mode`（unmapped→mapped_verified 时选定并 write-once；`publish_and_cutover` 需 projection=file_ready_unpublished 且无 active-flight materialization publication 在飞——情况 3 确定性裁决，`cutover_existing` 需 projection=published_usable 且 published_by 非 NULL）；publication INSERT 时 entry 为 `mapped_verified`（解除 mapping_pending 前置死锁）；cutover_existing activation **零改写** projection publication evidence（generation/SHA/published_by 保持旧 publication）；**P1-2** → `uq_lve_active_mapped_materialization`（partial：`mapped_voice_materialization_id IS NOT NULL AND mapping_status <> 'retired'`）——一个 materialization 至多被一个**活跃** legacy entry 引用；retired 保留历史 mapped ID 但不占活跃唯一位；**P1-1** → 可复跑 runner 入库 `docs/evidence/tts-c-r10/`（只从设计文档 §2 提取 SQL，不维护手写 schema 副本；双引擎 sqlite3 3.45.1 + Python sqlite3：schema apply / foreign_key_check（空）/ integrity_check（ok）/ **91 项 mutation 实跑 FAIL=0 两引擎一致**；R9 的 360/23-29 口径作废；历史回归 NOT EXECUTED 清单见设计文档 §10.5，不计入 PASS）；R9 ①②③（database-time fencing / indeterminate entry seal / exact-attempt resolve）与 R5/R6/R7/R8 全部继承不回退；顺带修复 D1（`trg_tts_jobs_immutable` 误将 indeterminate 当终态冻结 status 出边——JS-10 实证发现并收窄为真终态 succeeded/failed/cancelled）。R10 schema 与 R9 同源，1A/1B/C.2 migration 实施时按 R10 contract 直接落地。
- **TTS-C.0.R9（历史记录，已被 R10 修订取代；R9 独立 Review FAIL）**：architecture revision（①②③ fencing/seal/resolve 经实证正确由 R10 保留；P0-1 owner 死锁、P0-2 生命周期 UNIQUE 阻断、P0-3 cutover_existing 不可达、P1-1 证据口径、P1-2 retired 唯一位均由 R10 关闭）——原 R9 条目存档：architecture closure completed（pending independent Review PASS；runtime implementation not started；TTS-C.1A not started；production runtime unchanged `86f7f52…`；docs-only，零代码/零部署/零 migration/零 schema 变更）**：关闭独立 Review 对 R8 的 FAIL 发现——① **database-time lease fencing**（所有 lease 列统一 INTEGER epoch milliseconds：tts_synthesis_claims.lease_expires_at_epoch_ms + validation_lease_expires_at_epoch_ms、voice_materialization_jobs 同、voice_registry_publications.lease_expires_at_epoch_ms；权限判断时间 = SQLite DB 当前时间 `DB_NOW_MS = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`（trigger 内 SELECT 计算）；`DB_NOW_MS <= lease_expires_at_epoch_ms` 即 owner 仍有权限；activation/dispatch/execution/renewal/takeover 全部 trigger 不再使用 caller-supplied `NEW.activated_at` / `NEW.created_at` / `NEW.observed_at`；业务 evidence 时间（file_durable_at / activation_requested_at / activated_at / failed_at / validation_started_at / updated_at）保持 ISO 8601 文本但由 `trg_*_evidence_time_*` 冻结不得晚于 `DB_NOW_ISO = strftime('%Y-%m-%dT%H:%M:%fZ','now')`）；② **indeterminate entry evidence seal**（`voice_registry_publications` BEFORE UPDATE `trg_vrp_indeterminate_seal`：进入 indeterminate 的同一次 UPDATE 不得增删 candidate/manifest/file/activation 证据；`trg_vrp_indeterminate_shape`：OLD evidence shape 必须与 OLD.status 匹配——building 全 NULL、candidate_persisted candidate/manifest 非 NULL、file_durable 三个非 NULL、activation_pending 四个全非 NULL）；③ **indeterminate exact-attempt resolution**（`voice_registry_publication_activations` `CHECK (attempt >= 1)` + `activation_mode` 双态冻结（normal_owner_finalize: owner_token NOT NULL, resolution_evidence NULL / indeterminate_reconciliation: owner_token NULL, resolution_evidence NOT NULL, resolution_evidence_hash NOT NULL）；resolve 时 attempt = publication.attempt exact + observed SHA = persisted candidate SHA + indeterminate_from_status='activation_pending'）；④ **legacy cutover reachable：subject_mode 双路径**（`voice_registry_publications` 新增 `subject_mode` 列 + 拆分 `subject_type`：`materialization_publish`（publish_and_cutover）/`legacy_cutover_publish`（publish_and_cutover，projection 在前为 file_ready_unpublished）/`legacy_cutover_existing`（cutover_existing，projection 已是 published_usable，activation 仅切 legacy → mapped_active，projection 零更新）/`registry_rebuild`（none）；一对多由 `UNIQUE(mapped_voice_materialization_id) WHERE NOT NULL` 强制，杜绝多 legacy key alias 到同一 projection）；⑤ **materialization_publish 与 legacy mapping 互斥冻结**（publication INSERT 时 materialization_publish subject 不允许被 legacy_adapter_voice_entries 以 mapping_status IN (mapped_verified, mapping_pending) 引用——`materialization_publish blocked by legacy mapping` ABORT）；⑥ **atomic claim/job execution coupling**（新增第 13 表 `tts_job_execution_transitions` append-only command：`UNIQUE(job_id)` + `UNIQUE(claim_id)`；单条 INSERT 原子同步 claim + job status/owner/lease/heartbeat/result artifact；直接 UPDATE job/claim.status 出 queued/generation_pending 一律 `state transition requires execution command` ABORT）；⑦ **voice identity compatibility freeze**（`tts_jobs.voice_profile_revision` legacy 兼容通道 TTS-C 行 INSERT + UPDATE 由 `trg_tts_jobs_revision_compat` 强制 `CAST(voice_profile_revisions.revision_number AS TEXT)=voice_profile_revision` 一致；immutable trigger 把它纳入写后冻结列）；⑧ **generation uniqueness 表述**：DB 仅保证唯一（`UNIQUE(generation)`），单调分配由应用层 BEGIN IMMEDIATE 序列化协议保证（schema 注释明确不维护 sequence，不混称）；⑨ **可执行 SQLite contract 实证**（临时目录 sqlite3 3.45.1 + Python sqlite3：schema apply / foreign_key_check（空）/ integrity_check（ok）/ happy path 51 项 / R9 新增矩阵 66 项（TF/IE/LC/JS/VI/SM/ET/GN）/ R8 65 项回归 / R7 47 项回归 / R6 137 项回归 —— 共 360 项断言，FAIL=0；临时 SQL/DB 未入仓库）。R9 schema 与 R8 同源，1A/1B/C.2 migration 实施时按 R9 contract 直接落地。
- **TTS-C.0.R8（历史记录，已被 R9 修订取代；R8 独立 Review FAIL）**：architecture closure completed（pending independent Review PASS；runtime implementation not started；TTS-C.1A not started；docs-only，零代码/零部署/零 migration/零 schema 变更）：关闭独立 Review 对 R7 的 FAIL 发现——① **retryable legacy publication link**（`legacy_adapter_voice_entries.pending_publication_id` 仅允许 T1 fill（NULL→id）与 rollback clear（id→NULL，且仅当被引用 publication 已 failed/cancelled + `subject_type=legacy_cutover` + `subject_id=该 legacy entry id`）；rollback 后允许写入新 publication.id；旧失败 publication evidence 由 `voice_registry_publications` 永久保存，legacy 行不保留已失败 pending ID；非法替换 pending ID ABORT）；② **single-source candidate evidence**（删除 lve 的 `candidate_registry_generation/candidate_registry_sha256/candidate_created_at` 三列权威重复；pending/current evidence 统一经 pending_publication_id → journal；仅保留 `candidate_source_selector='tts_a'` 与 `candidate_activated_at`）；③ **legacy projection 单一发布模型**（唯一语义：legacy_cutover publication 本身同时发布目标 projection——mapped_verified 前置 mapped materialization=`file_ready_unpublished`；T5 原子完成 publication→active + materialization→`published_usable` + legacy→`mapped_active`；`trg_vmat_publish` 同时接受 materialization_publish（subject_id=materialization.id）与 legacy_cutover（subject_id=legacy entry.id，经 mapped_voice_materialization_id 定位 projection）两种 subject）；④ **atomic publication activation command**（新增第 11 表 `voice_registry_publication_activations` append-only command：AFTER INSERT trigger 在同一 SQLite statement 内完成 owner/token/attempt/lease/observed-SHA fencing → subject 精确验证 → projection 更新 → legacy entry 更新 → publication→active，任一步 `changes()=0` 即整体 ABORT；不存在可独立提交的 publication active 状态；publication INSERT subject 验证：materialization_publish 必须 file_ready_unpublished、legacy_cutover 必须 mapped_verified 且映射 materialization file_ready_unpublished、registry_rebuild 必须 subject_id='global'）；⑤ **indeterminate evidence closure**（`indeterminate_from_status` 冻结来源；进入 indeterminate 时已有 candidate/manifest/file/activation 证据立即 write-once 且禁止事后首补（NULL→value ABORT）；indeterminate→active 只能使用已存在 candidate SHA/manifest/file evidence + 仅可填 confirmed activated_at/resolution evidence；building-before-candidate indeterminate 只能 failed/cancelled，不得 resolve active）；⑥ **exact-one claim dispatch**（新增第 12 表 `tts_claim_generation_dispatches` append-only command（UNIQUE(claim_id)）：单条 INSERT 原子完成 fenced 验证 validating_reuse owner/token/attempt/lease + active subscriber>0 + INSERT 恰好一个 queued job + claim→generation_pending + 清 validation owner/candidate；`generation_pending` 无匹配 dispatch command 的状态迁移 ABORT；不变量：validating_reuse→0 job、generation_pending→exactly 1 job、running→exactly 1 job、reuse succeeded→0 job、generated 终态→exactly 1 job）；⑦ **TTS job row-state result invariant**（INSERT + 全 UPDATE 生效：`claim_id IS NOT NULL` 时 `succeeded ⇔ result_artifact_id IS NOT NULL`、非 succeeded ⇒ result NULL；running/queued/failed 单独 SET result 全 ABORT；result artifact.job_id/claim_id 与 job 一致）；⑧ **envelope dependency closure**（`tts_audio_requests` initializing→waiting 必须 claim_id 非 NULL + exact claim identity trigger 通过（job_id 可 NULL）；`voice_materialization_requests` initializing→waiting 必须 job_id 非 NULL + exact job identity trigger 通过；无 owner/lease、无 claim/job 的 committed waiting 行结构不可提交）；⑨ **generation & payload identity seal**（`voice_registry_publications.generation UNIQUE` + BEGIN IMMEDIATE 单调分配；`tts_jobs` immutable 增 `narration_plan_artifact_id/narration_plan_version/payload_json/provider/voice_profile_id/voice_profile_revision_id`，`payload_json` 与 frozen synthesis payload fingerprint 创建时 exact 对应、创建后不可改）；⑩ **可执行 SQLite contract 实证**（设计文档 §2 提取重建临时 DB sqlite3 3.45.1：12 表 schema apply / `PRAGMA foreign_key_check`（空）/ `PRAGMA integrity_check`（ok）/ happy path 全链 / crash-retry 闭环 / legacy failed→rollback→新 publication→成功闭环 / materialization 与 legacy atomic activation / claim atomic dispatch / 全部 R8 新增矩阵 + R7/R6 mutation 回归 PASS，FAIL=0——实测计数见 §11.4）。
- **TTS-C.0.R7（历史记录，已被 R8 修订取代；R7 独立 Review FAIL）**：architecture closure completed（pending independent Review PASS；runtime implementation not started；TTS-C.1A not started；docs-only，零代码/零部署/零 migration/零 schema 变更）**：关闭独立 Review 对 R6 的 FAIL 发现——① **global registry publication journal**（新增第 10 张权威表 `voice_registry_publications`，不再以"保持 9 表"为目标：generation/subject_type/subject_id/stable+candidate registry SHA/candidate manifest（canonical 不可变，完整描述每 key 的 emitted source、source row id、reference SHA、adapter key）/manifest SHA/publisher_schema_version/status/owner/lease/attempt/file_durable_at/activation_requested_at/activated_at/failed_at/error 全列；8 态；**DB 级 global active single-flight**（`uq_voice_registry_publication_active ON ((1)) WHERE status IN (building,candidate_persisted,file_durable,activation_pending,indeterminate)`）；T1 前 global reservation，T1-T5 共用同一 global owner/token/lease/attempt）；② **projection 状态与 publication attempt 分离**（`voice_materializations` 删 registry_pending，只保留 file_ready_unpublished/published_usable/failed/indeterminate + `published_by_publication_id`；成功 T5 单事务 publication→active + projection→published_usable + legacy→mapped_active；失败/indeterminate 保留 immutable evidence，projection 通过新 publication row 重试，消除 R6 repair 不可达矛盾）；③ **global cutover 一次只处理一个 frozen subject**（subject_type=materialization_publish|legacy_cutover|registry_rebuild + subject_id 冻结；mapping_pending 必须引用 exact active publication.id（`trg_lve_publication_link`）；一个 active publication 最多一个 mapping_pending subject；adapter active SHA==candidate SHA 但 DB 未 T5 → 按 journal 完成整个 subject 的原子 reconciliation，不得凭任意 per-key row 猜测）；④ **无环 claim/job 模型**（删除 `tts_synthesis_claims.job_id`；唯一权威 = `tts_jobs.claim_id` + `uq_tts_jobs_claim UNIQUE(claim_id) WHERE claim_id IS NOT NULL`；claim 的 job = `SELECT * FROM tts_jobs WHERE claim_id=?`；validating_reuse→无 job、generation_pending/running→恰好一个 job（job INSERT 要求 claim 已 generation_pending/running + claim→running 要求 job 已存在）、reuse succeeded→无 job、一个 claim 永远不能有两个 job；不再依赖"应用在同一事务记得写第二边"）；⑤ **tts_jobs result 与 TTS-C 生命周期封存**（result_artifact_id 首次非 NULL 后不可改；succeeded 必须 result 非 NULL；非成功状态不得伪装 result；result artifact 的 job_id/claim_id 必须等于当前 job；`trg_tts_jobs_delete_tts_c` 禁删 TTS-C 行（legacy 兼容）；TTS-C job INSERT 初始状态只能 queued）；⑥ **request→claim/job subscriber identity closure**（`tts_audio_requests.unit_id` NOT NULL；INSERT+UPDATE trigger 强制 request.claim_id 的 claim 同 project/unit/final fingerprint/variant；request.job_id 非 NULL 时 job.claim_id==request.claim_id 且全字段一致；result artifact identity trigger 覆盖 INSERT 与 UPDATE OF result_artifact_id）；⑦ **envelope initializing 状态**（tar/vmr 增加 initializing：只占用 (project_id, request_id)、链接全 NULL、不计 active subscriber、Scheduler 不可见；initializing→waiting 同一事务完成 exact link；crash 前回滚不产生 committed initializing；推荐不允许长期 committed initializing）；⑧ **所有新表冻结 initial INSERT state**（8 表 BEFORE INSERT trigger：request→initializing、claim→validating_reuse、attempt→created、vmr→initializing、vmjob→validating_existing、vmat→file_ready_unpublished、lve→unmapped、vrp→building；terminal 直插全拒）；⑨ **exact voice/provider identity**（新增 `tts_jobs.voice_profile_revision_id`（exact revision ID，legacy 行 NULL 兼容）；TTS-C job 必须 profile/revision exact pair + provider==revision.provider；attempt.provider==job.provider；artifact voice/profile/provider 与 job/attempt/Voice Revision 逐项一致）；⑩ **可执行 SQLite contract 实证**（设计文档 §2 提取重建临时 DB sqlite3 3.45.1：apply / foreign_key_check（空）/ integrity_check（ok）/ happy path 全链（含 publication journal 全流程）/ crash-retry 闭环（failed publication A→新 attempt B 成功→A/B evidence 保留）/ **139 项 mutation 验证全部 PASS（R7 新增 39（RP/CJ/SL/VI/INIT）+ R6 回归 100），FAIL=0**；临时 SQL/DB 不入仓库）。R6 的 validation finalization fencing、attempt 证据不可变、provenance 闭包、cutover journal、lease fencing 由 R7 继承并强化。
- **TTS-C.0.R6（历史记录，已被 R7 修订取代）**：architecture closure completed（pending independent Review PASS；runtime implementation not started；TTS-C.1A not started；docs-only）——关闭独立 Review 对 R5 的 FAIL 发现——① **tts_jobs legacy downgrade bypass 封死**（`trg_tts_jobs_immutable` 守卫扩为 `OLD/NEW.claim_id 任一非 NULL`：claim_id 写后不可 NULL/不可换/不可凭空获得，TTS-C 行 running→queued 永远 ABORT；新增 INSERT/UPDATE validation trigger 强制 TTS-C 身份字段 NOT NULL 且 claim 同 project/unit/final fingerprint/variant，NULL 无法绕过 `uq_tts_jobs_active_synthesis`；claim↔job 双向一致性由 job 侧+claim 侧 trigger 闭环）；② **attempt 证据 phase-aware、write-once、terminal immutable**（`trg_tga_evidence` 三层：write-once + 终态全冻结 + phase window；`file_durable` 后 final path/SHA/size/codec/sr/ch/duration/response_hash/provider_request_id/usage_record_id 全部不可改，不限于 phase 转移）；③ **artifact↔attempt 字节证据全闭包**（`trg_saa_provenance` 新增 15 项逐项比较：exact/synthesis fingerprint 与 job、path/SHA/size/codec/sr/ch/duration 与 attempt、provider/model 与 attempt、canonical SHA 与 Voice Revision；内容 hash 一致性在 final success transaction 内 exact fenced reread 逐项比较）；④ **request/claim 终态链接封存**（`job_id/result_artifact_id` 首次非 NULL 后不可改 + succeeded 后 linkage 冻结 + result-link identity trigger；consumer 真相统一为 `WHERE result_artifact_id=:id`，不再经 producing claim_id 声称全量）；⑤ **materialization execution identity 完整且不可变**（`source_canonical_sha256/adapter_compatibility_key` NOT NULL + write-once + 与 exact Voice Revision 自洽；destination 路径格式冻结；request link identity trigger）；⑥ **projection activation evidence 封存**（`adapter_compatibility_key` + `published_registry_generation/sha256` write-once；file_ready_unpublished 必 NULL、registry_pending 只能首次写一次、→published_usable 必须同 generation/SHA、published_usable 全不可变）；⑦ **legacy cutover journal 不可变**（`trg_lve_cutover_evidence` 按状态转换冻结字段写入权限：T1 fill / rollback clear / T5 fill activated_at / mapped_active 全冻结；旧 owner 不得原地改 candidate evidence；cutover_attempt 不回退）；⑧ **lease-expiry fencing 全量补齐**（validation/materialization renewal 与 cutover renewal/T5 全部 `AND lease >= :now`；T2/T3/T4 外部副作用前 fenced verify/renew changes=1；过期未接管 → 旧 owner 不得 renewal/finalize/新副作用，过期 I/O 结果不得提交 DB 终局）；⑨ **可执行 SQLite contract 实证**（设计文档 §2 全部真实 SQL，临时目录 sqlite3 3.45.1：apply / foreign_key_check（空）/ integrity_check（ok）/ happy path 全链 / **115 项验证全部 PASS（111 项非法 mutation 按预期 ABORT 或 changes=0 + IS-20 consumer 查询 3 + legacy requeue 1），FAIL=0**；临时 SQL/DB 不入仓库）。R5 的 validation finalization fencing、可执行 contract、relational provenance 闭包、crash-safe cutover、状态机冻结、DAG 化由 R6 继承并强化。
- **TTS-C.0.R5（历史记录，已被 R6 修订取代）**：architecture closure completed（pending independent Review PASS；runtime implementation not started；TTS-C.1A not started；docs-only，零代码/零部署/零 migration/零 schema 变更）——关闭独立 Review 对 R4 的 FAIL 发现——① **validation finalization fencing**（`tts_synthesis_claims.validating_reuse` 与 `voice_materialization_jobs.validating_existing` 的 finalization 全部为带 `status + validation_owner_token + validation_attempt + lease >= now + candidate id/hash（IS 语义）` 条件的 fenced `UPDATE ... WHERE`，`changes=1` 必须；`changes=0` → `STALE_VALIDATION_OWNER` 整事务回滚：不改 claim/job/request/projection、不建 job、不 fan-out、不复用 artifact、不写文件；takeover CAS 与 lease renewal 同样 fenced（旧 owner 续租 changes=0）；validator/takeover/last-cancel 三方竞争由事务串行单数据库裁决，冻结结果不变量：零 subscriber→cancelled 无 job、有 subscriber+usable→reused、有 subscriber+unusable→恰好一个 queued job、stale validator 永远零副作用）；② **可执行 SQLite contract**（设计文档 §2 全部为可直接转 migration 的真实 SQL：CREATE TABLE / ADD COLUMN（FK default NULL 合法）/ CREATE UNIQUE INDEX / CREATE TRIGGER BEFORE UPDATE/DELETE/INSERT；`tts_jobs` 纯增量零 rebuild、legacy 行 WHEN 守卫隔离（legacy running→queued requeue 仍允许）；FK 补齐含 `candidate_artifact_id`、三个 source artifact、profile/revision pair trigger（composite FK 需触碰 TTS-A FROZEN 表故选 trigger）；状态依赖 CHECK 冻结各状态 NULL/NOT NULL 组合；SHA CHECK=长度 64+小写 hex；路径 CHECK 拒绝 absolute/traversal/backslash 与 reader containment 边界分离）；③ **relational provenance 闭包**（`sentence_audio_artifacts`：composite FK `(job_id, claim_id) → tts_jobs(id, claim_id)`、`(successful_attempt_id, job_id) → tts_generation_attempts(id, job_id)` + BEFORE INSERT trigger（attempt 必须 phase=succeeded、project/unit/fingerprint/variant 与 claim/job 逐项一致、narration plan exact identity、source artifact kind+project、pair mismatch ABORT）；原子成功终局 6 步顺序冻结（fenced 重读→attempt file_durable→succeeded→INSERT artifact→job→claim→requests），任一失败整事务回滚 attempt 恢复 file_durable）；④ **crash-safe cutover protocol**（stable/candidate 双 registry view 分离，消除 mapped_pending 矛盾；`legacy_adapter_voice_entries` 增 cutover 列（owner/lease/attempt/candidate generation/SHA/selector/created/activated）保持 9 表并给出不需第 10 表 journal 的论证；mapping 状态机 `unmapped→mapped_verified→mapping_pending→mapped_active`（pending 可回退 verified 安全重试）+ `retired`；T1-T5 协议 + 6 点 crash reconciliation 矩阵 + 未知 SHA fail-closed；fenced mapped_active + published_usable 同事务双 changes=1）；⑤ **完整状态机冻结**（每表 old→new 全矩阵 + 真实 trigger SQL；消除 `* → failed/indeterminate`：generation_pending 允许 failed 不允许 indeterminate；published_usable 不可逆无出边 + repair 路径（failed→file_ready_unpublished；published 文件损坏经 repair job 恢复 exact SHA 不转移状态）；attempt succeeded 终态、transport_failed/validation_failed/indeterminate 合法来源逐项列出；request reused（existing）与 succeeded（新复制）不混写）；⑥ **未来测试矩阵冻结**（VF-1…5 validation fencing / MF-1…6 materialization fencing / PC-1…7 provenance / CC-1…6 cutover crash，含前置/并发步骤/断言）；⑦ **实施计划修正**（删除 1A 重复段落只留一套权威 scope/boundary/tests/not included/deployment gate；依赖改 DAG：R5 PASS→1A∥1C、1B-prep 并行，1A PASS→1B publisher integration，1A+1B+1C PASS→C.2，C.2 PASS→C.3→C.4→C.5；继续冻结并行开发/串行 cherry-pick/每 exact SHA 独立 gate/Review/部署/禁止合并未 Review lane）。**临时 SQLite contract validation（docs-only，临时目录 sqlite3 3.45.1，临时 SQL/DB 未入仓库）**：schema apply 通过、`PRAGMA foreign_key_check` 空、`PRAGMA integrity_check` ok、happy path（synthesis 全链 + materialization 全链 + cutover 全链）全过、43 项非法 mutation 全部按预期失败（provenance 7、非法状态转移 13、不可变/DELETE 6、SHA/路径/状态依赖 CHECK 8、pair trigger 2、fencing changes=0 3、partial unique 3、正向控制 legacy requeue 1）；设计文档 §2 SQL 与验证 contract 逐字一致（72/72 可执行语句核对）。TTS-A/TTS-B/M7.3B 冻结语义未动；`docs/TTS_C_OSS_REUSE_MATRIX.md` 未修改。
- **TTS-C.0.R4（历史记录，已被 R5 修订取代）**：R4 closure 关闭的 10 项发现（reclaimable validation、validating 取消语义、materialization single-flight、fan-out/durability、legacy single-source cutover 5 态、fan-in provenance、状态机与 trigger、schema contract、并行矩阵、OSS 措辞）由 R5 继承并强化为 fenced + 可执行 contract；R4 被独立 Review 判 FAIL 的 6 项阻断（finalization 无 fencing、contract 不可执行、provenance 未闭包、cutover 非 crash-safe、状态机模糊、计划依赖链错误）由 R5 全部关闭。
- **TTS-B.R2（历史记录）**：R1 Review FAIL 后聚焦修复——① Performance commit-time Narration candidate fence；② Assignment concurrent existing2 复用同一 authoritative helper；③ graph detector 单一真相源 + 故障注入；④ GitHub Actions 独立 CI（run 30796556192 success @ 34ee6c3）。其修复在 R3 中被强化（fence 移入事务内）。
- **Production legacy 审计（只报告，不修改）**：generated assets 19；provenance NULL 19（全为历史 legacy）；NULL + requirement_json 缺失/损坏 1；active legacy bindings 17；active bindings 指向当前 active scenes 中缺失的 requirement 10（分布于 2 个项目，均为历史绑定；未删除/重绑）。
- 下一步：TTS-C.1A（voice materialization durable requests/files/DB projection，schema 按 R13 contract）→ TTS-C.1B（global registry publisher + adapter hot reload，mapping_mode/subject_mode 双路径就位）→ TTS-C.1C（capability snapshot/compiler）→ TTS-C.2（request envelope + durable job + attempt journal + immutable sentence audio artifact + fingerprints + `tts_job_execution_transitions` 五类 command（worker_claim / lease_renewal / execution_takeover / prestart_terminal / state_transition）+ per-column owner fence atomic coupling）→ TTS-C.3（preview/override/variant/A-B/selection）→ TTS-C.4（selection manifest + immutable master audio + ffprobe）→ TTS-C.5（subtitle timing v2/reconciliation/stale graph/review UI）→ timing-reconciliation@2.0 → storyboard → animatic → final render。TTS-C.1A = FROZEN（§5）；TTS-C.1B / 1C planning authorized（implementation not started，实施计划见 `docs/TTS_C_1B_1C_EXECUTION_PLAN.md`）；TTS-C.2 not authorized。

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
- `scripts/test-tts-c1a-migration.ts`（TTS-C.1A 新增，22 PASS）：clean/production-like apply、重跑幂等、FK/integrity、frozen SQL/migration identity（frozenFragmentsSha256 `c1177e3d…`/appliedSqlSha256 `0f9134bc…` 复算绑定）、tts_jobs 351-row fixture hash、6 新表 + 47 trigger + 3 index exact、publication/legacy 表存在且 0 行、C.2 表/tts_jobs TTS-C 列不存在
- `scripts/test-tts-c1a-materialization-schema.ts`（TTS-C.1A 新增，8 PASS）：vmr/vmjob/vmat 初始状态直插拒绝、source identity（sha/ack/pair/path）ABORT、publication link mismatch ABORT、waiting requires job link、CHECK 状态组合
- `scripts/test-tts-c1a-materialization-api.ts`（TTS-C.1A 新增，14 PASS）：requestId 幂等复用/异 source 409、project scope、cross-project 拒绝、malformed ID、无 latest fallback、adapterReady=false、registryPublished=false、路径 redaction
- `scripts/test-tts-c1a-materialization-worker.ts`（TTS-C.1A 新增，20 PASS）：scheduler 只 claim queued（validating_existing 不可见）、durable copy（SHA/size/regular/WAV/pcm_s16le/mono/48000/duration）、projection=file_ready_unpublished、reused 零文件写（mtime 不变）、zero subscriber claim 前取消、cancel_requested pre-claim/running 期裁决
- `scripts/test-tts-c1a-materialization-durability.ts`（TTS-C.1A 新增，9 PASS）：temp 校验失败不返回成功、失联恢复（running lease 过期→failed + requests failed→新请求恢复→成功）、final DB 失败 STALE 回滚、孤儿文件 fail-closed、cleanup 不删未引用/已引用文件、DB 引用文件被删→validator unusable
- `scripts/test-tts-c1a-materialization-concurrency.ts`（TTS-C.1A 新增，17 PASS）：fan-in 单 job、并发 create 单飞、4 request 同 projection 全 succeeded、reused 零写、unusable+subscriber→queued、zero subscriber→cancelled、stale takeover attempt+1、旧 owner STALE
- `scripts/test-tts-c1a-materialization-files.ts`（TTS-C.1A 新增，17 PASS）：missing/hash drift/archived 允许/sha 污染→ASSIGNMENT_UNUSABLE/provider 污染→schema 违约 NOT_FOUND、publication/activation 0 行、TTS jobs=0、路径形状/symlink/escape 拒绝
- `scripts/test-tts-c1a-r4-hardening.ts`（TTS-C.1A.R4 新增，55 PASS）：CAP-01…05 held capability runtime brand（plain object/prototype spoof/clone+arbitrary fd 拒绝、无公开 factory、合法通过）/ SEAL-08…11 exact destination binding（canonical source path 伪装、outside-root+forged durability、absolutePathInternal/parentRealpath 漂移）/ DIR-04…07 full ancestor seal（profile/root rename+symlink、profile 换目录、合法链通过）/ VERIFY-01…04 verify 零写（整 root 缺失下 GET/reuse/replay 不 mkdir + fs snapshot 不变、Worker writer 可创建）/ CANCEL-06…08 zero-subscriber closure（worker final/validation usable 前 subscriber=0 → cancelled，合法路径仍 succeeded/reused）；gate suite 数 49→50
- `scripts/test-tts-c1a-r5-hardening.ts`（TTS-C.1A.R5 新增，28 PASS）：CAP-06…10 immutable authority record（verify capability + 伪造 durability / 替换 public evidence / 覆写 handle / closed / durabilize 成功）/ REUSE-CAP-01…05 branded reuse capability（plain 对象 / clone 拒绝、same-size damaged file rejected、legitimate reused）/ REUSE-DIR-01…04 reuse ancestor seal（profile/root rename+symlink、profile new inode、合法链）/ RESP-01/03/04 terminal response link closure（cancelled→projection=null、reused→projection.id===request.materialization_id）/ POST-INT-01/02 POST integrity closure（verified 显示 file_ready_unpublished、damaged linked fail-closed）/ HOOK-01…03 production hook guard（NODE_ENV=production reject、test 环境仍可用）；suite 数 50→51
- `scripts/test-tts-c1a-r5-mutations.ts`（R5 reproducible mutation runner，9 项 mutation 输出 `/tmp/r5-mutation-output.txt`）：4/9 fully matched（4 项 mutation 触发目标测试 FAIL），剩 5 项 mutation 应用但无 observable effect（R5 当时已记录）
- `scripts/test-tts-c1a-r6-hardening.ts`（TTS-C.1A.R6/R7 hardening，39 PASS）：CAP-06/07 immutable authority record（verify capability + 伪造 durability、替换 public evidence、篡改 record 不影响）/ REUSE-AUTH-01..05 branded reuse capability（plain 对象 / clone 拒绝、same-size damaged file rejected、legitimate reused）/ REUSE-DIR-01..04 reuse ancestor seal（profile/root rename+symlink、profile new inode、合法链）/ REUSE-ONCE-01..05 one-shot consumption（closed 后 reuse/不同 job/attempt+1/candidate hash 漂移/合法 reused）/ FD-01..06 private fd lifecycle（issuance 非法/hook throw/transaction success/shadow close/duplicate close）/ POST-R6-01..06 real route.POST（gate/queue/verified/damaged/cancelled/persistence）/ RESP-02 真实 failed path（failMaterializationJobFenced → existing request failed 路径）/ HOOK-01..03 production hook guard（NODE_ENV=production reject、test 环境仍可用）/ **R7 新增：ONCE-R7-01 并发两次 consume（barrier + callback count=1）、FD-R7-HOOK-01 hook throw 必关闭、ISSUE-R7-01/02/03 issuance 故障注入（realpath/lstat/candidate-hash 均 held closed）**；suite 数 51→52
- `scripts/test-tts-c1a-r6-mutations.ts`（R6 mutation runner）：实测 **2/10 STRONG、1/10 PARTIAL、7/10 no expected failure**——R6 报告曾按宽松标准写 10/10，属 runner/workflow 接受 bug（no observable effect / PARTIAL 被计为 PASS），R7 已订正
- `scripts/test-tts-c1a-r6-hardening.ts`（TTS-C.1A.R6 hardening，含 R7 项，39 PASS）：CAP-06/07 / REUSE-AUTH-01..05 / REUSE-DIR-01..04 / REUSE-ONCE-01..05 / FD-01..06 / POST-R6-01..06 / RESP-02 / HOOK-01..03 / **ONCE-R7-01（并发两次 consume，callback count=1）/ FD-R7-HOOK-01（hook throw 必关闭）/ ISSUE-R7-01/02/03（issuance realpath/lstat/candidate-hash 故障均 held closed）**
- `scripts/test-tts-c1a-r7-mutations.ts`（R7 STRONG-only mutation runner，12 项 mutation 输出 `/tmp/r7-mutation-output.txt` + docs/evidence/tts-c-r17/mutation-output.txt）：MUT-R7-01..12 每项必须 diffApplied + shaMutated≠before + typecheck 通过 + child 非零退出 + 无 fatal + expected FAIL 全覆盖 + restore SHA 一致 + git diff clean；任一非 STRONG → exit 1
- `.github/workflows/tts-c-r7-mutation.yml`（TTS-C R7 Mutation Gate CI）：fail-closed——TOTAL=12 PASS=12 FAIL=0 STRONG=12、禁止 no observable effect/PARTIAL、git diff --exit-code + git status 干净
- `scripts/test-tts-c1b1-adapter-registry.ts`（TTS-C.1B.1 新增，34 PASS）：场景1 legacy 1.0 启动完全兼容（ready/detail/degraded、synthesize 200）/ 场景2 `/registry-status` 对 1.0 返回 `generation=null`、`publisherSchemaVersion=null`、sha 匹配 / 场景3 reload 合法 1.1 → sha/generation/schema/speakerCount 更新 + 新 voice 可用 / 场景4 非法 reload（坏 JSON、缺 generation、错 publisherSchemaVersion、未知 schemaVersion）→ 非 2xx + LKG 不变 + 旧 voice 可用 / 场景5 首次加载失败无 LKG → ready=false + synthesize 503 + 修复后 reload 无重启恢复 / 场景6 重复 reload 同一文件幂等零副作用 / **R1（TTS-C.1B.1.R1，reference 验证前置）**：R01 LKG+reference 缺失 → reload 非 2xx + LKG 不变 + degraded + 旧 voice 200；R02 LKG+referenceSha256 不符 → reload 非 2xx + lastReloadError 精确 `REFERENCE_SHA256_MISMATCH`；R03/R04 冷启动缺失/SHA 错 → ready=false + synthesize 503 原码透传；R05 修复文件与 SHA 后 reload → 200 ready=true degraded=false；gate suite 数 52→53；adapter venv（gitignored）bootstrap 由 `scripts/run-tts-c1b1-adapter-registry.sh` 管理（缺失时按 ci.yml 同款方式现场创建，创建失败 → suite 失败 fail-closed，输出标准 FAILED_SUITE/FAILED_COMMAND/QUALITY_GATE_RESULT=FAIL）
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

### 11.4 TTS-C.0.R13 docs-only SQLite contract 验证（runner 与原始输出入库 `docs/evidence/tts-c-r13/`；runtime 阶段纳入 gate）

可复跑 runner：只从 `docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md` §2 逐字提取全部可执行 SQL
（13 表：含第 11 表 `voice_registry_publication_activations`、第 12 表 `tts_claim_generation_dispatches`、
第 13 表 `tts_job_execution_transitions`（R12 applied-command chain）；不维护手写 schema 副本；
既有基座表按 §0 基座前提以最小 fixture 提供）→ 双引擎（sqlite3 CLI 3.45.1 + 当前 Python sqlite3）
各自重建临时 DB → `PRAGMA foreign_key_check`（空）→ `PRAGMA integrity_check`（ok）→ 对象计数
（112 triggers / 7 unique indexes + 2 表级 UNIQUE(job_id|claim_id,command_seq) / 10 ALTER ADD COLUMN）
→ **真实事务能力**（PyEngine 同一 connection BEGIN IMMEDIATE→逐条→COMMIT/ROLLBACK；CLI 同一进程
脚本 BEGIN IMMEDIATE;…;COMMIT; -bail，失败后新连接验证回滚）→ 逐测试执行：**150 项 mutation
断言全部按预期，FAIL=0，两引擎逐 test 一致**（原始输出 `results-sqlite-3.45.1.txt` /
`results-python-sqlite.txt`，含 git HEAD（=checked-in snapshot 生成时 base HEAD）、design doc
sha256、extracted §2 sql sha256、逐 test PASS/FAIL、总数；任一 FAIL 非零 exit）：

- **R13 新增矩阵 20 项（CE-01…20，claim terminal evidence seal + post-validation evidence seal）**：
  generated terminal validation_attempt 无 command 不可改（CE-01/02/03）、running/indeterminate
  attempt 仍由 exact command fence 保护（CE-04/05）、candidate/validation evidence 离开
  validating_reuse 后不可注入/改写/回填（CE-06/07/08/09）、validating_reuse 合法协议不受影响
  （CE-10）、reuse succeeded snapshot 保留但不可改（CE-11/12）、prestart terminal 全证据冻结
  （CE-13/14）、generated terminal 双侧 attempt 无 split（CE-15）、terminal head 不可回退/跳号
  （CE-16）、合法 state_transition/prestart/reuse finalize 不被误伤（CE-17/18/19）、第二侧故障
  整事务回滚（CE-20）；
- **R12 全矩阵重跑 130 项**：JS-01…35、LC-01…12、TF-01…08、IE 全组、VI 全组、regress 全组、
  HR-01…20（applied-command chain + historical replay seal 全套不回退）；
- **历史回归 NOT EXECUTED（不计入 PASS）**：R6 全族（IS/SM/DEL/PC/CHK/PAIR/UNIQ/INIT）、R7 其余
  （RP-02…10b/CJ-01…08/SL-01…08b/VI-01…04b）、R8 其余（PA-02/03/05/08、PE-01/02/04、LR-02…05b、
  EN-05b、JR-04）——runtime 阶段纳入 gate 时逐项落地。
- **R12/R11/R10/R9 口径**：R12 的 130 项被覆盖；R11 的 110 项、R10 的 91 项、R9 的 360/23-29
  不再引用。
- 每个反例的预期错误文本或 `changes=0` 已逐一断言（同表多 trigger 按创建逆序触发：terminal
  claim immutable 可先于 post-validation seal / head fence / CHECK 报 `terminal immutable`——
  均为合法拒绝，runner 用消息集合断言）。未提交临时 DB；未生成音频。checked-in results 记录
  生成时 base HEAD（`git HEAD` 字段），**final HEAD 的权威绑定由 GitHub CI artifact（final
  checkout 重新生成）提供**。

### 11.4.1 CI TTS-C Contract Gate（R13）

`.github/workflows/m7-quality-gate.yml` 的 `TTS-C Contract Gate` job 指向
`docs/evidence/tts-c-r13/`（临时输出 `/tmp/ttsc-r13-ci`、`/tmp/ttsc-r13-console.log`）：
ubuntu-24.04 + setup-python 3.12；**sqlite3 CLI 版本 fail-closed pin**——
`ACTUAL="$(sqlite3 --version | awk '{print $1}')"`、`test "$ACTUAL" = "3.45.1"`（不匹配即
workflow failure）；Python sqlite3 版本记录并报告（CLI = authoritative compatibility engine）；
`--engine all` 在 **final HEAD** 重新生成双引擎结果（不依赖 checked-in result 伪装执行）；
`verify_engines.py` 断言两引擎 test ID 与 TOTAL/PASS/FAIL/SKIP 完全一致、design/SQL SHA 与
current checkout 一致；FAIL>0 → workflow failure；结果上传 artifact
`tts-c-contract-gate-<sha>`；summary 写 contract total、两引擎 SQLite 版本、design SHA、SQL SHA。
**与原有 27 个 runtime suite 分别报告，不混称。**

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

### 15.11 TTS-C.1A 部署证据（8ab1b23，2026-08-04）

- **部署链**：exact code SHA `8ab1b235fe65d18a0362594a36ce48b9ef314e9b` = production runtime SHA = host checkout SHA（树内含 1A 六个提交：migration schema / request single-flight / durable worker / 测试 / 实施文档 + tf-08 时钟源稳定修复）；`ZHIYING_RELEASE_TAG=8ab1b23…`（.env.production 更新，内容不进报告）；部署证据 docs commit 后 origin/m7 会高于 runtime——以现场 `git rev-parse` 为准。
- **GitHub Actions 独立 CI**：exact code SHA `8ab1b23…` 的 run `30917042446` = **completed / success**——`M7 Quality Gate`（`QUALITY_GATE_TOTAL_SUITES=34`：git-diff-check + typecheck + next-build + m7-exit-propagation + TTS-B 5 + TTS-A frozen 7 + frozen/existing 11 + **TTS-C.1A 7**）+ `TTS-C Contract Gate`（150/150 双引擎 FAIL=0；Python/CLI test ID 完全一致；§2 SQL SHA `c88f64ac…` 不变；sqlite3 CLI exact 3.45.1 fail-closed pin）；artifacts：`m7-quality-gate-8ab1b23…`（id `8895561433`，33203 B，digest `sha256:849dce9d…`）+ `tts-c-contract-gate-8ab1b23…`（id `8895493113`，13390 B，digest `sha256:2af95e16…`）。
- **TTS-C.0 freeze 基线**：reviewed executable contract commit `ae7a93d…`；reviewed §2 SQL SHA `c88f64ac880a0cf50519a3b5eaba724a701b93ac5acea0e9c4fbdf90dd6f50d8`（1A 全流程复算不变）；freeze/docs normalization commit `56e11de…`（CI run `30912535593` 全绿）；TTS-C.1A runtime 未改 §2 SQL（migration 生成器 frozenFragmentsSha256 `c1177e3d…` / appliedSqlSha256 `0f9134bc…` 由测试复算绑定）。
- **pre-deployment backup**：`/vol1/1000/backups/zhiying/tts-c1a-20260804T140848Z`（integrity=ok；foreign_key_check 空；**SHA256SUMS 0 FAILED**；38 文件；含 zhiying.db online backup（WAL-safe `.backup`，SHA `354d4172…`）、schema、migration state（user_version=0、TTS-C tables=0）、23 表 CSV dump（含 tts_jobs 351 行 + hash、artifacts、llm_usage、usage_events、assets/bindings、render）、compose×2、`.env.production`（内容不进报告）、previous-sha `86f7f52`、invariants baseline（projects=3/tts_jobs=351/voice 0/leases 0）、voice-dirs inventory（voice-library/materialization/registry 均 absent）、BACKUP_COMPLETED_AT、SHA256SUMS）。
- **migration rehearsal**（production DB 副本，标准入口 `applyTtsC1aMigration`）：**24/24 PASS**——6 新表（voice_materialization_requests/jobs/voice_materializations + legacy_adapter_voice_entries/voice_registry_publications/voice_registry_publication_activations 为 1B 预建、零写入）+ 47 trigger（+2 既有 TTS-A = 49）exact + 3 index；materialization/legacy/publication/activation 表 0 行；**tts_jobs 351 行 + 全行 hash `0f53a86c…` 不变**；voice_profiles/revisions/artifacts 不变；FK 空 + integrity ok；重跑幂等（对象数不变）；无文件写。未手工 sqlite3 ALTER production。
- **Exact-SHA 构建**：宿主机 checkout `8ab1b23…`（worktree clean）→ runbook start/check → `docker build --network=host --add-host remotion.media:127.0.0.1 --build-arg APT_MIRROR --build-arg NPM_REGISTRY -t zhiying:8ab1b23…`（**BUILD_EXIT=0**，build log 0 error，trap 保证 stop）→ 镜像 ID `8d7f87b72352`（2.56GB）；tunnel `STOPPED`、443 listener=0、host worktree clean。
- **镜像内门禁**（`NODE_ENV=development`，scripts+docs 只读挂载，image SHA = mounted SHA = 8ab1b23）：**TTS-C.1A 7 suites 全 PASS（107 断言：migration 22/schema 8/api 14/worker 20/durability 9/concurrency 17/files 17）** + frozen TTS 回归 m3b-tts **99 PASS**。
- **up 验证**：三容器 healthy @`zhiying:8ab1b23…`/`zhiying-indextts2-adapter:8ab1b23…`（`ZHIYING_RELEASE_TAG=8ab1b23…`）；local root 200 / /api/projects 200；**materialization GET smoke** `GET /api/projects/<id>/voice-materializations` → `{"requests":[],"adapterReady":false}`（0 行、未发布、不冒充 adapter ready）；worker/web/adapter 日志无 startup/SQLite/migration/lease/path error（web 仅 Node SQLite experimental warning）；resource leases 0。
- **Production 数据不变量（部署前后只读对比，30 项全过）**：projects=3 全 m6、snapshot pointers=0、M7 snapshot=0；**tts_jobs=351、逐行一致（backup vs production diff 空）、本轮新增 TTS job=0**；artifacts（narration/beats/visual intent）/llm_usage/usage_events/assets/asset_bindings/render_jobs 逐行一致；voice_profiles/revisions 0/0；TTS-B Assignment/Performance artifact=0；generation_runs 不变、dispatch=0；**voice_materialization_requests/jobs/voice_materializations/legacy_adapter_voice_entries/voice_registry_publications/voice_registry_publication_activations 全 0 行**；materialization root 无业务文件；registry 未发布；adapter 未 reload（容器 healthy，active registry 未触碰）；IndexTTS2 calls=0（tts_jobs 无新增 + dispatch 0）；resource leases=0；integrity=ok + FK 空；无项目切换 m7。
- **状态**：**M7.3B FROZEN；TTS-A FROZEN；TTS-B FROZEN；TTS-C.0 FROZEN（独立 Review PASS）；TTS-C.1A deployed；TTS-C.1A pending independent Review PASS；TTS-C.1B not started；TTS-C.1C not started；TTS-C.2 not started**。
- **本轮未执行**：不在 production POST materialization（零 request/job/projection 业务行）；不 copy 任何真实 Voice Revision；不写 registry；不 reload adapter；不调用 IndexTTS2；不 enqueue TTS；不调用 LLM/APIYi；不创建 narration audio；不创建 snapshot；不切换项目 m7；不创建 timing-reconciliation@2.0；不开始 1B/1C/C.2。
- **证据边界**：GitHub Actions 是 independently observable evidence（run 30917042446 / conclusion success / 双 artifact digest 可在 GitHub 核验）；production 证据来自 Agent 现场命令，OPS-AUDIT-BRIDGE 不可用，**不是** independently verified。

### 15.12 TTS-C.1A.R1 部署证据（71d87b4，2026-08-04）

- **部署链**：exact code SHA `71d87b494d6ce08f6753990a3b8aeb9a29ad3530` = production runtime SHA = host checkout SHA（树内含 R1 六个提交：validation ownership / worker fencing / filesystem containment / mount 分离 / 测试 / 实施文档）；`ZHIYING_RELEASE_TAG=71d87b49…` + 新增 `ZHIYING_HOST_MATERIALIZATIONS_DIR`（= data/voice-materializations）；部署证据 docs commit 后 origin/m7 会高于 runtime——以现场 `git rev-parse` 为准。
- **GitHub Actions 独立 CI**：exact code SHA `71d87b49…` 的 run `30923486472` = **completed / success**——`M7 Quality Gate`（`QUALITY_GATE_TOTAL_SUITES=40`：原 27 + TTS-C.1A 7 + **R1 新增 6**（validation-ownership/worker-fencing/recovery/path-security/request-concurrency/compose-mounts））+ `TTS-C Contract Gate`（150/150 双引擎 FAIL=0，§2 SQL SHA `c88f64ac…` 不变）；artifacts：`m7-quality-gate-71d87b49…`（id `8898146361`，35029 B，digest `sha256:04b6f97b…`）+ `tts-c-contract-gate-71d87b49…`（id `8898091533`，13390 B，digest `sha256:aed817e6…`）。
- **R1 修复内容（独立 Review FAIL 关闭项）**：P0-1 validation ownership handle（`ValidationLeaseHandle`；takeover 只返回赢家 handle；finalize 只接受 handle——fenced reread WHERE id/token/attempt/DB_NOW<=lease/candidate exact；lease 有效时 subscriber 只 fan-in 不跑 validator，validator 调用恰好一次；VOWN-01..08 真实双进程 + 单进程确定性验证）；P0-2 worker execution handle（claim 返回 exact handle；final WHERE `status='running' AND owner_token=? AND attempt=? AND DB_NOW<=lease`）；heartbeat loop（interval fenced 续租；changes=0 → ownershipLost 停止副作用；关键步骤前显式 verify；shutdown 中止；timer 不泄漏）；autonomous recovery（`recoverExpiredMaterializationJobs` Worker tick 前独立运行；无 durable file→failed、file exact→完成 projection/job/request、damaged→failed、未知→indeterminate；多 Worker 单裁决；确定性 executor 错误立即 fenced failed）；commit-time exact source fence（Revision DB metadata + 每个 active request Assignment source + final evidence 逐项重读，全部输入字段参与）；P0-3 真实 no-follow（`O_RDONLY|O_NOFOLLOW` + fstat；temp `O_EXCL|O_NOFOLLOW`；逐级 lstat symlink 拒绝 + parent realpath containment + rename 前后复核）；Web/Worker mount 分离（`ZHIYING_HOST_MATERIALIZATIONS_DIR`：Web `:ro`、Worker `:rw`、adapter 无；env 缺失 fail-closed；TTS-A Web 写入不回退）；P1 envelope-first BEGIN IMMEDIATE requestId 裁决（UNIQUE race 事务内捕获不逃逸 500；RID-01..03 真实双进程）；existing request outcome 按真实状态映射（failed→failed、cancelled→cancelled、running→inflight、waiting+queued→queued、indeterminate→indeterminate、succeeded/reused→reused 唯一路径）。
- **mutation proof（5 项 fence 禁用验证均 FAIL）**：finalize ownerToken 条件移除 → validation-ownership 3 FAIL；attempt 条件移除 → 4 FAIL；validation lease 条件移除（VOWN-08 无接管过期场景）→ 2 FAIL；lstat symlink 检查移除 → path-security 2 FAIL；heartbeat gate 恒 true → worker-fencing 1 FAIL。
- **pre-deployment backup**：`/vol1/1000/backups/zhiying/tts-c1a-r1-20260804T152148Z`（integrity=ok；FK 空；**SHA256SUMS 0 FAILED**；46 文件；含 zhiying.db online backup、schema、29 表 CSV dump（含 tts_jobs 351 + hash、六张 materialization 表 0 行）、compose×2、`.env.production`（内容不进报告）、previous runtime `8ab1b23` + previous docs `e5545c6`、**materialization host dir inventory（absent）+ symlink scan（0）**、compose mount 解析、invariants baseline、BACKUP_COMPLETED_AT、SHA256SUMS）。
- **migration rehearsal**（production DB 副本，标准入口 `applyTtsC1aMigration`）：**15/15 PASS**——对象数不变（6 表/47 trigger/3 index，trigger 总数 49=47+2 既有）、重跑幂等、六表业务行 0、**tts_jobs 351 + 全行 hash `0f53a86c…` 不变**、integrity ok + FK 空；§2 SQL SHA `c88f64ac…` 不变（R1 零 schema 变更）。
- **Exact-SHA 构建**：宿主机 checkout `71d87b49…`（worktree clean）→ runbook start/check → `docker build --network=host --add-host remotion.media:127.0.0.1 --build-arg APT_MIRROR --build-arg NPM_REGISTRY -t zhiying:71d87b49…`（**BUILD_EXIT=0**，log 0 error，trap 保证 stop）→ 镜像 ID `6bcdf7423f`（2.56GB）；tunnel `STOPPED`、443 listener=0、host worktree clean。
- **镜像内门禁**（`NODE_ENV=development`，scripts+docs+compose 只读挂载，image SHA = mounted SHA = 71d87b49）：**TTS-C.1A 13 suites 全 PASS（210 断言）** + frozen TTS 回归 m3b-tts **99 PASS**。
- **up 验证**：三容器 healthy @`zhiying:71d87b49…`；**mount 分离实测**：Web `/app/data/voice-materializations`（ro）、Worker（rw）、adapter 无该 mount；local root 200 / /api/projects 200；materialization GET `{"requests":[],"adapterReady":false}`；worker/web/adapter 日志无 error/recovery/heartbeat/path/migration 异常；resource leases 0。
- **Production 数据不变量（部署前后只读对比，全部一致）**：projects=3 全 m6、snapshot=0；**tts_jobs=351 + 逐行一致、本轮新增 TTS job=0**；artifacts/llm_usage/usage_events/assets/asset_bindings/render_jobs 逐行一致；voice_profiles/revisions 0/0；TTS-B Assignment/Performance artifact=0；generation_runs 不变、dispatch=0；**六张 materialization 表 0 行**；materialization root 0 文件 0 symlink（目录由挂载创建但空）；registry 未发布；adapter 未 reload；IndexTTS2 calls=0；resource leases=0；integrity=ok + FK 空；无项目切换 m7。
- **状态**：**M7.3B FROZEN；TTS-A FROZEN；TTS-B FROZEN；TTS-C.0 FROZEN；TTS-C.1A.R1 deployed；TTS-C.1A pending independent Review PASS；TTS-C.1A not frozen；TTS-C.1B not started；TTS-C.1C not started；TTS-C.2 not started**。
- **本轮未执行**：不在 production POST materialization（零 request/job/projection 业务行）；不写 registry；不 reload adapter；不调用 IndexTTS2；不 enqueue TTS；不调用 LLM/APIYi；不创建 narration audio；不创建 snapshot；不切换项目 m7；不开始 1B/1C/C.2。
- **证据边界**：GitHub Actions 是 independently observable evidence（run 30923486472 / conclusion success / 双 artifact digest 可在 GitHub 核验）；production 证据来自 Agent 现场命令，OPS-AUDIT-BRIDGE 不可用，**不是** independently verified。

### 15.13 TTS-C.1A.R2 部署证据（f7965c2，2026-08-04）

- **部署链**：exact code SHA `f7965c2df4d0513ce631044134841c59af988354` = production runtime SHA = host checkout SHA（树内含 R2 五个提交：durable final evidence / periodic recovery / POST gate + DB-time lease / durability closure tests / tf-08 drift 稳定）；`ZHIYING_RELEASE_TAG=f7965c2…`；**`TTS_C1A_MATERIALIZATION_POST_ENABLED` 未设置（= false，POST 503 feature gate 生效）**；`ZHIYING_MATERIALIZATION_RECOVERY_INTERVAL_MS` 未设置（= 默认 10s cadence）。
- **GitHub Actions 独立 CI**：exact code SHA `f7965c2…` 的 run `30929972029` = **completed / success**——`M7 Quality Gate`（`QUALITY_GATE_TOTAL_SUITES=45`：原 40 + **R2 新增 5**（recovery-loop/final-evidence/validation-evidence/replay-integrity/resource-cleanup））+ `TTS-C Contract Gate`（150/150 双引擎 FAIL=0，§2 SQL SHA `c88f64ac…` 不变）；artifacts：`m7-quality-gate-f7965c2…`（id `8900804136`，36427 B，digest `sha256:b403421b…`）+ `tts-c-contract-gate-f7965c2…`（id `8900724736`，13392 B，digest `sha256:0cb4f6fe…`）。
- **R2 修复内容（独立 Review FAIL 关闭项）**：**POST feature gate**（env 缺失/非 true → 503 `MATERIALIZATION_NOT_ENABLED`，GET 不受影响，不泄漏内部配置）；**P0-A periodic recovery**（`MaterializationRecoveryController`：启动即 sweep + 10s cadence 持续 sweep、inFlight 不重入、单 job 异常隔离不 fatal、stop() 停 timer 等 settle、limit 有界；RCY-LOOP-01..05 实证无 POST/无重启自动恢复）；**共享 safe final-file validator**（`materialized-file-validator.ts`：verify/durabilize 双模式，fd 级 SHA/WAV header 解析、path inode/dev 一致性、fsync final + dir、`MaterializedFileEvidence` 不可伪造；worker/recovery/validation 三路径同契约）；**P0-B rename 后 final evidence**（temp 只作早期失败；rename 后重新 O_NOFOLLOW 打开 → fd SHA → fd WAV → fsync → dir fsync → evidence；`afterRenameBeforeFinalEvidence` hook；FINAL-01..06 实证替换/symlink/fsync 失败均拒绝）；**P0-C recovery durability**（recovery 用 durabilize 重新建立 fsync + exact Revision/Assignment reread + fenced 裁决 + validate→commit inode 复核；fsync/containment/漂移失败 → 不 succeeded；REC-DUR-02/03 注入 fsync 失败 → indeterminate）；**P0-D validation Phase 3 evidence fence**（`ValidatedProjectionEvidence` + handle.candidate 绑定 + current projection 逐项 reread + Revision/Assignment reread + file inode 复核；VAL-EV-01..05 实证删文件/替换/投影漂移/Assignment 漂移 → MATERIALIZATION_UNUSABLE/SOURCE_STALE，不 reused）；**existing replay fail-closed**（succeeded/reused 返回 reused 前 8 项检查：materialization_id/exact projection/id 匹配/status/Revision usable/Assignment 匹配/safe file validator/SHA-WAV-path；REPLAY-01..07 实证损坏后不 reused，GET 不冒充 ready）；**资源生命周期**（外层 try/finally 统一关闭 source/temp/final/dir fd + timer + listener + temp；CLEAN-01..06 实证 fd 计数稳定、无 staging 残留、cleanup 不覆盖原错误）；**API final-state**（finalize 后重读 request/job/projection；message 全覆盖含 indeterminate≠cancelled）；**DB-time lease**（validation 创建/takeover/scheduler claim/heartbeat 全部 `DB_NOW_MS + duration`，host 时钟漂移不影响）。
- **mutation proof（7 项禁用验证均 FAIL）**：recovery 不执行 file fsync → recovery 5 FAIL；recovery 不执行 dir fsync → 5 FAIL；final evidence 改回 temp evidence → final-evidence 4 FAIL；replay 跳过 file validator → replay-integrity 3 FAIL；finalize 跳过 projection reread → validation-evidence 1 FAIL；periodic loop 禁用 → recovery-loop 3 FAIL；temp cleanup 禁用 → resource-cleanup 3 FAIL。
- **pre-deployment backup**：`/vol1/1000/backups/zhiying/tts-c1a-r2-20260804T164041Z`（integrity=ok；FK 空；**SHA256SUMS 0 FAILED**；含 zhiying.db online backup、schema、29 表 CSV（tts_jobs 351 + hash、六表 0 行）、compose×2、`.env.production`（内容不进报告）、previous runtime `71d87b49` + previous docs `ee89f65`、**POST feature gate 当前值（未设置 = false）**、materialization dir inventory + symlink scan + staging 扫描（全 0）、BACKUP_COMPLETED_AT、SHA256SUMS）。
- **migration rehearsal**（production DB 副本，标准入口）：对象数不变（6 表/47 trigger/3 index）、重跑幂等、六表 0 行、**tts_jobs 351 + hash `0f53a86c…` 不变**、integrity ok + FK 空；§2 SQL SHA `c88f64ac…` 不变（R2 零 schema 变更）。
- **Exact-SHA 构建**：宿主机 checkout `f7965c2…` → runbook start/check → `docker build --network=host --add-host remotion.media:127.0.0.1 --build-arg APT_MIRROR --build-arg NPM_REGISTRY -t zhiying:f7965c2…`（**BUILD_EXIT=0**，log 0 error）→ 镜像 ID `02e20cb0a9`（2.56GB）；tunnel 清理、443 listener=0、host worktree clean。
- **镜像内门禁**（NODE_ENV=development，scripts+docs+compose 只读挂载，SHA 一致）：**TTS-C.1A 18 suites 全 PASS（279 断言）**。
- **up 验证**：三容器 healthy @`zhiying:f7965c2…`；mount 分离保持（web ro / worker rw / adapter 无）；**POST smoke = 503 `MATERIALIZATION_NOT_ENABLED`（production POST disabled，零业务行创建）**；GET 200 `{"requests":[],"adapterReady":false}`；root//api/projects 200；worker/web 日志无 error/recovery/heartbeat/path/migration 异常；recovery loop 启动无错误；leases=0。
- **Production 数据不变量（部署前后只读对比，全部一致）**：projects=3 全 m6、snapshot=0；tts_jobs=351 逐行一致、新增 TTS job=0；artifacts/llm_usage/usage_events/assets/bindings/render 逐行一致；voice_profiles/revisions=0；Assignment/Performance=0；generation_runs 不变、dispatch=0；六表 0 行；materialization root 0 文件 0 symlink；registry 未发布；adapter 未 reload；IndexTTS2 calls=0；leases=0；integrity ok + FK 空；无项目切换 m7。
- **状态**：**M7.3B FROZEN；TTS-A FROZEN；TTS-B FROZEN；TTS-C.0 FROZEN；TTS-C.1A.R2 deployed；TTS-C.1A pending independent Review PASS；TTS-C.1A not frozen；TTS-C.1B not started；TTS-C.1C not started；TTS-C.2 not started；production POST disabled**。
- **本轮未执行**：不在 production POST materialization（feature gate 503）；不写 registry；不 reload adapter；不调用 IndexTTS2；不 enqueue TTS；不调用 LLM/APIYi；不创建 narration audio/snapshot；不切换项目 m7；不开始 1B/1C/C.2。
- **证据边界**：GitHub Actions 是 independently observable evidence（run 30929972029 / conclusion success / 双 artifact digest 可在 GitHub 核验）；production 证据来自 Agent 现场命令，OPS-AUDIT-BRIDGE 不可用，**不是** independently verified。

### 15.14 TTS-C.1A.R3 部署证据（a400853，2026-08-05）

- **部署链**：exact code SHA `a40085336bdada2f15d792d873ccecdaa08ffee5` = production runtime SHA = host checkout SHA（树内含 R3 四个提交：commit-sealed file identity / recovery cancellation + succeeded-state validation / GET integrity / commit-seal tests）；`ZHIYING_RELEASE_TAG=a400853…`；**`TTS_C1A_MATERIALIZATION_POST_ENABLED` 未设置（= false，POST 503）**。
- **GitHub Actions 独立 CI**：exact code SHA `a400853…` 的 run `30970308511` = **completed / success**——`M7 Quality Gate`（`QUALITY_GATE_TOTAL_SUITES=49`：原 45 + **R3 新增 4**（commit-seal/recovery-cancellation/get-integrity/db-time-stale））+ `TTS-C Contract Gate`（150/150 双引擎 FAIL=0，§2 SQL SHA `c88f64ac…` 不变）；artifacts：`m7-quality-gate-a400853…`（id `8916282616`，37529 B，digest `sha256:6d0d1330…`）+ `tts-c-contract-gate-a400853…`（id `8916254170`，13388 B，digest `sha256:4d5d92e6…`）。
- **R3 修复内容（独立 Review FAIL 关闭项）**：**P0-A held final-file evidence**（`HeldMaterializedFileEvidence`：final fd O_RDONLY|O_NOFOLLOW + parent fd O_RDONLY|O_DIRECTORY|O_NOFOLLOW 持有到 DB commit 完成或失败；close() 恰好一次；evidence 增加 ctimeNs/parentDev/parentIno；SHA/WAV 均从 held fd 读取；workerFinalize 只接受 held capability——普通伪造对象 SEAL-06 实证拒绝）；**P0-B commit-time current-file seal**（`assertHeldEvidenceCurrentSync`：BEGIN IMMEDIATE 内同步复核 path lstat ↔ held fd dev/inode/size/mtimeNs/ctimeNs + parent dev/inode；fence 到 COMMIT 无 await/hook；SEAL-01..04b 实证同 inode 改写/同长度改 bytes/mtime 漂移/rename 替换/伪造 mtime 替换全部拒绝；DIR-01..03 parent 替换/symlink/dev-inode 拒绝）；**同 inode 原地改写闭环**（fdStat + pathStat 双层 mtime/ctime 检查——rename 覆盖使 ctime 不可伪造，多层防线）；**Validation Phase 3 强化**（VAL-SEAL-01..05：同 inode overwrite/同 size 改 bytes/parent 替换/Assignment 整体漂移（content hash）/provider 漂移全部不 reused）；**Recovery cancel fence**（durabilize 前预裁决 cancel_requested/subscriber=0 → cancelled 不 durabilize（hook=0 实证）；success 事务再检查；REC-CANCEL-01..05 + REC-EXIST-01/02 确定性裁决不悬挂 running）；**唯一复用验证入口**（`validateReusableMaterializationRequest`：succeeded/reused/waiting+succeeded/jobOutcome/GET 五路径统一 8 项 fail-closed；STATE-01..04 实证 waiting+succeeded 结构性拒绝、succeeded+damaged → MATERIALIZATION_UNUSABLE）；**GET fail-closed integrity**（`integrityStatusOf`：verified/missing/damaged/source_stale/unchecked；损坏时 materialization.status='unusable' 不再显示 file_ready_unpublished；GET-INT-01..05 零 mkdir/零文件写含缺失目录）；**verify/create 路径分离**（`ensureExistingDestinationParentSafe` 绝不 mkdir / `ensureOrCreateDestinationParentSafe` 仅 Worker）；**DB-time lease 全闭环**（Phase 1 事务内 dbNow 一次读取，expired running/validating/takeover/lease 创建全用 DB 时间；CLOCK-01..04 mock Date.now ±1h 不影响裁决）；**exact source classification**（worker/recovery/validation/replay 全部 classifyProjectVoiceAssignment current_candidate + content hash 整体漂移检测 + provider 参与）。
- **mutation proof（9 项禁用验证均 FAIL）**：commit-time stat 复核全移除 → commit-seal 12 FAIL；mtime/ctime fence 移除 → 4 FAIL；validation 只看 inode → validation-evidence 1 FAIL；recovery 忽略 subscriber（两处）→ recovery-cancellation 5 FAIL；waiting+succeeded 直接 reused → get-integrity 2 FAIL；GET 跳过 validator → 4 FAIL；stale branch 改回 Date.now → db-time-stale 1 FAIL；parent 全层移除 → commit-seal 12 FAIL；verify 允许 mkdir → get-integrity 1 FAIL。注：path inode 与 fdStat ctime 互为备份（rename 覆盖使 ctime 不可伪造），单层变异被互补层兜住——最终以整组 fence 移除验证（12 FAIL）。
- **pre-deployment backup**：`/vol1/1000/backups/zhiying/tts-c1a-r3-20260805T024921Z`（integrity ok、FK 空、**SHA256SUMS 0 FAILED**；含 online backup、schema、29 表 CSV（tts_jobs 351 + hash、六表 0 行）、compose×2、`.env.production`（内容不进报告）、previous runtime `f7965c2` + previous docs `b454e63`、POST feature gate 值（false）、materialization inventory + symlink/staging scan（0）、BACKUP_COMPLETED_AT、SHA256SUMS）。
- **migration rehearsal**：对象数不变（6 表/47 trigger/3 index）、重跑幂等、六表 0 行、**tts_jobs 351 + hash `0f53a86c…` 不变**、integrity ok + FK 空；§2 SQL SHA 不变（R3 零 schema 变更）。
- **Exact-SHA 构建**：runbook start/check → `docker build --network=host --add-host remotion.media:127.0.0.1 --build-arg APT_MIRROR --build-arg NPM_REGISTRY -t zhiying:a400853…`（BUILD_EXIT=0，log 0 error）→ 镜像 ID `d0e3e40338`（2.56GB）；tunnel 清理、443=0、worktree clean。
- **镜像内门禁**（NODE_ENV=development，scripts+docs+compose 只读挂载，SHA 一致）：**22 suites 全 PASS（334 断言）+ m3b-tts 99 PASS**。
- **up 验证**：三容器 healthy @`zhiying:a400853…`；mount 分离保持（web ro / worker rw / adapter 无）；**POST smoke = 503 `MATERIALIZATION_NOT_ENABLED`**；GET 200 `{"requests":[],"adapterReady":false}`；root//api/projects 200；worker/web 日志无 error/recovery/heartbeat/path/migration 异常；leases=0。
- **Production 数据不变量（部署前后只读对比，全部一致）**：projects=3 全 m6、snapshot=0；tts_jobs=351 逐行一致、新增 TTS job=0；artifacts/llm_usage/usage_events/assets/bindings/render 逐行一致；voice_profiles/revisions=0；Assignment/Performance=0；generation_runs 不变、dispatch=0；六表 0 行；materialization root 0 文件 0 symlink；registry 未发布；adapter 未 reload；IndexTTS2 calls=0；leases=0；integrity ok + FK 空；无项目切换 m7。
- **状态**：**M7.3B FROZEN；TTS-A FROZEN；TTS-B FROZEN；TTS-C.0 FROZEN；TTS-C.1A.R3 deployed；TTS-C.1A pending independent Review PASS；TTS-C.1A not frozen；TTS-C.1B not started；TTS-C.1C not started；TTS-C.2 not started；production POST disabled**。
- **本轮未执行**：不在 production POST materialization（feature gate 503）；不写 registry；不 reload adapter；不调用 IndexTTS2；不 enqueue TTS；不调用 LLM/APIYi；不创建 narration audio/snapshot；不切换项目 m7；不开始 1B/1C/C.2。
- **证据边界**：GitHub Actions 是 independently observable evidence（run 30970308511 / conclusion success / 双 artifact digest 可在 GitHub 核验）；production 证据来自 Agent 现场命令，OPS-AUDIT-BRIDGE 不可用，**不是** independently verified。

### 15.15 TTS-C.1A.R7 部署证据 + TTS-C.1A 正式冻结（37eaac6 / c29801b，2026-08-06）

- **部署链**：deployed SHA `37eaac6c8c8969239cab00848f6291454615a912` = production runtime SHA = host checkout SHA（`ZHIYING_RELEASE_TAG=37eaac6…`；runtime code 内容来自 `17d40787ce70c025d7daa012c04a76bc69c10a2b`，`37eaac6…` 仅多 complexity-policy docs）；previous runtime `a400853…`（R3）；deployment UTC `2026-08-06T01:16Z`（compose up 完成）；evidence commit `c29801b3b313a41560e4e0547033c2a409ed244c`（`docs/evidence/tts-c-r17/deployment.md`）。
- **pre-deployment backup**：`/vol1/1000/backups/zhiying/tts-c1a-r7-20260805T142306Z`（SHA256SUMS 42 项全 OK）。
- **Exact-SHA 构建**：`zhiying:37eaac6…` 镜像 ID `dd37ee1b7e56`（2.56GB，image code SHA 与宿主 checkout 一致）+ `zhiying-indextts2-adapter:37eaac6…` 镜像 ID `0ad9789bb9bb`（135MB）；`node:22-bookworm` 基础镜像经宿主机代理拉取并 8 层 digest 校验后 `docker load`；remotion.media CONNECT tunnel 用于构建内下载，构建后 tunnel 清理（STOPPED）。
- **镜像内门禁**（不跑 mutation gate；scripts/docs/compose 只读挂载来源同为 `37eaac6…`）：`QUALITY_GATE_RESULT=PASS`，`QUALITY_GATE_TOTAL_SUITES=52`。
- **up 验证**：三容器（web/worker/adapter）healthy @`37eaac6…`；日志无 error/exception/migration/recovery/heartbeat/lease/materialization 异常；adapter 无 reload/registry 活动。
- **Smoke（production）**：`GET /` 200；`GET /api/projects` 200；`POST /api/projects/<id>/voice-materializations` → **503 `MATERIALIZATION_NOT_ENABLED`**；`GET` → 200 `{"requests":[],"adapterReady":false}`；未创建任何 materialization；未调用 IndexTTS2。
- **Production 数据不变量（before/after 全一致）**：integrity ok、FK 空、tts_jobs 351 / hash `56a4baf0…` 不变、六张 TTS-C.1A 表全 0、projects=3、voice_profiles/revisions=0、materialization root 0 文件 0 symlink、POST gate disabled、migration/schema 无变化（§2 SQL SHA `c88f64ac…` 不变）。
- **Review 结论**：**TTS-C.1A.R7 Final Proportional Review = PASS**（proportional-risk rubric，无真实可复现 production blocker；R7 为 1A 防御复杂度上限，不启动 R8）；**TTS-C.1A.R7 Deployment Evidence Review = PASS**。
- **状态**：**M7.3B FROZEN；TTS-A FROZEN；TTS-B FROZEN；TTS-C.0 FROZEN；TTS-C.1A = FROZEN；production POST remains disabled；TTS-C.1B / 1C planning authorized（implementation not started）；TTS-C.2 not authorized**。
- **证据边界**：本轮未引用新的 GitHub Actions run；部署证据为镜像内 gate + Agent 现场命令（`docs/evidence/tts-c-r17/deployment.md`），OPS-AUDIT-BRIDGE 不可用，**不是** independently verified。
