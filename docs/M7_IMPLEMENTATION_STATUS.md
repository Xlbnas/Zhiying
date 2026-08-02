# M7 实施状态技术文档

> 面向开发与接力 agent 的技术状态文件，不是宣传介绍。
> 每次 milestone 完成或 production 部署后必须更新本文件。

## 1. 元信息

| 项 | 值 |
|---|---|
| 字段 | 值 |
|---|---|
| statusUpdatedAt | 2026-08-02T09:10Z（M7.3B.R1 deployed；M7.3B pending independent Review PASS，TTS-A not started） |
| reviewedCodeSHA | `a71f0fed1028da0f2a47305d22df120d8165f714`（M7.3B.R1 closure 代码 commit；M7.3A frozen code 为 `aa3f814…`） |
| productionRuntimeSHA | `a71f0fed1028da0f2a47305d22df120d8165f714`（容器镜像实际代码 SHA） |
| productionHostCheckoutSHA | `a71f0fed1028da0f2a47305d22df120d8165f714`（宿主机 checkout；可因 docs/ops commit 高于 runtime） |
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
| **M7.3B Visual Sequences / Shots Contract + DAG Foundation** | **IMPLEMENTED（待部署 + Review）** | `96ddcc8`/`c7cbba0`/`468d0c1`/`85e826c`（+ 后续部署证据 docs） | visual-sequences@1.0 / shots@1.0 契约、exact-source provenance、确定性语义校验、candidate generation（Worker LLM dispatch + commit-time source fence）、M7 candidate DAG 与 stale classification、API；**not yet production-piloted** |

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

独立 Review 判定 M7.3B FAIL，修复 5 项 blocker（本小节为修复记录；M7.3B pending Review PASS）：

1. **queued dispatch source conflict（P0，`src/lib/llm-generation/dispatch.ts`）**：`enqueueGenerationDispatch` 此前只在 generation_run 存在时比较 source；worker 未 claim 前只有 queued dispatch 时，同 requestId 不同 source 被错误返回 queued/running 而非 409。修复：单 BEGIN IMMEDIATE 内，对最终重读到的 dispatch row 在按 status 返回**之前**强制 `source_artifact_id` 一致性检查（queued/running/succeeded/failed/cancelled 一律适用）→ `RequestIdConflictError`。保持：same-source 幂等（同一 dispatchId）、run-level conflict、不新增 dispatch、不修改原 source、不调用 provider。
2. **Visual Sequence 全局 beat 顺序（P0，`visual-sequences/validate.ts`）**：新增 `SEQUENCE_BEAT_ORDER_MISMATCH`——`sequences.flatMap(beatIds)` 必须与 beats 顺序**逐项相同**（时间线顺序，不得排序比较）；与 gap/overlap/duplicate/within-sequence non-contiguous 并存（多 issue 允许）。
3. **Shot 全局 sequence/unit 顺序（P0，`shots/validate.ts`）**：新增 `SHOT_SEQUENCE_ORDER_MISMATCH`（shots 首次出现去重后的 sequence 顺序必须与 exact Visual Sequence artifact 逐项相同）与 `SHOT_UNIT_ORDER_MISMATCH`（`shots.flatMap(unitIds)` 必须与 canonical 时间线 sequences→beats→units 逐项相同）；删除无效的 `seenSeqOrder` 死变量。
4. **DAG usable-candidate 语义（P1，`m7-dag/readiness.ts`）**：dependency 缺失判定从"节点状态 ∈ {blocked, not_generated}"改为**usableCandidateCount**——eligible/current → usable；needs_review：visual_intent_plan 可用于 visual_sequences 与 shots（unresolved 在两层均非阻断）、visual_sequences 可用于 shots、narration_plan_v2 needs_review 不可用；stale/invalid → 不可用。上游 running/failed 且无可用 candidate → 下游 blocked；上游有旧合法 candidate 同时 regenerate running → 下游不被误判 blocked。
5. **reference ID schema（P1，`visual-sequences/schema.ts`、`shots/schema.ts`）**：`beatIds` 精确 `^B\d{3}$`、`visualIntentIds`/`visualIntentId` 精确 `^V\d{3}$`、`unitIds` 精确 `^N\d{3}$`（保留 Q/H 已有约束）；malformed reference 在 schema 层拒绝，exact-but-missing 合法格式 ID 仍由 semantic validator 报 NOT_FOUND。

## 5. 当前正在进行的工作

- **M7.3A 正式 FROZEN（独立 Review PASS）**：final code/runtime = `aa3f8145825f5a33542f54e90e661e0cccf3e692`；deployment evidence docs = `36ff32e3301f51bf054efbee029fc1e6115ad3f5`；independent Review = PASS。冻结语义见 §7。
- **M7.3B — Visual Sequences / Shots Contract + DAG Foundation**（已实现并部署 6f109d0；独立 Review **FAIL / not accepted**）→ **M7.3B.R1 review closure in progress**：修复 5 项 blocker（queued dispatch source conflict、Visual Sequence canonical beat order、Shot canonical sequence/unit order、DAG usable-candidate 语义、reference ID schema，见 §4.12）。**M7.3B pending independent Review PASS；TTS-A not started。**
- **Production legacy 审计（只报告，不修改）**：generated assets 19；provenance NULL 19（全为历史 legacy）；NULL + requirement_json 缺失/损坏 1；active legacy bindings 17；active bindings 指向当前 active scenes 中缺失的 requirement 10（分布于 2 个项目，均为历史绑定；未删除/重绑）。
- 下一步：M7.3B.R1 部署 + 等待独立 Review PASS；随后按序 TTS-A → TTS-B → TTS-C → narration master → ffprobe → subtitle timing → timing-reconciliation@2.0 → storyboard → animatic → final render。

## 6. 尚未完成 TODO

- [x] Production 部署（M7.3A.2 e62f5c2 / M7.3A.3 07b39dc 已完成）
- [ ] M7.3B — Visual Sequences / Shots（已实现待部署，见 §4.11；**not yet production-piloted**）
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

- **M7.3B 已批准启动**（Visual Sequences / Shots Contract + DAG Foundation）。M7.3B 自身边界：
  - **不要** 创建 `timing-reconciliation@2.0`、最终时间轴、startMs/endMs/durationMs/frames 字段。
  - **不要** 重新生成 narration master / subtitle timing；**不要** 迁移 asset requirement 或 sceneId→shotId binding；**不要** 改造 asset resolver。
  - **不要** 生成 Storyboard / Animatic / Editorial Gate / Final Render；不实现 MG runtime states、Remotion Sequence 映射。
  - **不要** 创建 M7 pipeline snapshot；**不要** 切换任何项目到 m7。
  - **不要** 实现 TTS-A/B/C、Voice Profile、Narration Performance Plan；不生成 production Sequence/Shot artifact；不对 production 项目调 visual-sequences/shots POST；不调用真实 LLM/APIYi（M7.3B 验证只走临时 DB + Mock）。
  - **不要** 自动重新生成污染项目 TTS。
  - **不要** 循环重试 S001-R01 图片生成。
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
- `scripts/test-llm-dispatch.ts`
- `scripts/test-workflow-stages.ts`
- `scripts/test-m6310-usage.ts`

### 11.2 M7.3A.2/M7.3A.3 新增/扩展测试

- `scripts/test-m73b-visual-sequences.ts`（92 PASS，M7.3B.R1 更新）：sequences schema（含 reference ID 精确限制）/ 语义校验全矩阵 / **canonical beat order（SEQUENCE_BEAT_ORDER_MISMATCH：reversed blocks、三块交换、classify invalid_source、generation repair attemptCount=2 零自动排序）** / classify / 双源 chain precheck / 向后兼容
- `scripts/test-m73b-shots.ts`（96 PASS，M7.3B.R1 更新）：shots schema（含 reference ID 精确限制）/ 语义校验全矩阵 / **canonical sequence/unit order（SHOT_SEQUENCE_ORDER_MISMATCH + SHOT_UNIT_ORDER_MISMATCH：block 前置、shot block 交换、classify invalid_source、generation repair attemptCount=2）** / classify / precheck / 向后兼容
- `scripts/test-m73b-generation.ts`（76 PASS，M7.3B.R1 更新）：Web enqueue-only / Worker Mock 执行 / 幂等复用 / 409 冲突 / 并发 single-flight / repair attemptCount / 3 次失败终态 / source drift（before dispatch / during generation / before commit，commit-time fence 零 artifact）/ **queued dispatch source conflict（sequences+shots：409、dispatch count=1、原 source 未覆盖、runs=0、provider calls=0；同 source 重复同 dispatchId；并发不同 source 恰好一胜一 409；generic enqueue 与 visual-intents route 既有 stage 回归）** / production override 禁用
- `scripts/test-m73b-dag.ts`（53 PASS，M7.3B.R1 更新）：图结构（无环/无反向边）/ 节点状态机（not_generated→running→ready/blocked/needs_review）/ TTS 并行边界 / Voice/Performance 概念源零影响 / narration 漂移传播 / **usable-candidate 语义（intent running/failed 无 candidate → sequences blocked；sequences running/failed 无 candidate → shots blocked；旧合法 candidate + regenerate running 不误 blocked；intent/sequences needs_review 可用；narration needs_review 不可用）** / 无 m7 激活

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

