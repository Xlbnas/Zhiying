# Zhiying → Codex Skill Migration
# Phase 1C — Adversarial Architecture Review

审查日期：2026-08-22（Asia/Shanghai）  
审查输入：`01_CURRENT_SYSTEM_INVENTORY.md`、`02_MIGRATION_AUDIT.md`，以及仅用于验证争议判断的关键源码、测试与既有生产记录。  
审查性质：对抗性架构复核；本轮未修改生产代码、配置、数据库、Docker/Compose 或服务。

## Verdict

**NEEDS_REVISION**

Phase 1B 的迁移方向成立：Codex/Skill 应接管推理与 SOP，Remotion、FFmpeg、IndexTTS2、字幕、时间校准、素材门禁和 provenance 应复用，旧 LLM workflow 平台应逐步退出。

但当前方案尚不能进入实现，原因不是需要更多新架构，而是 1B 把数个不同性质的职责合并分类，并把尚未存在的“文件 artifact 接口”当成了现有薄包装边界：

1. `project_stages` 的流程状态可以退休，但它目前同时提供 locked/current pointer；`project_versions` 又是 append-only 内容与来源事实。Final Render、subtitle/reconciliation 等生产路径仍直接依赖这些语义。
2. 当前绝大多数 JSON artifact 存在 SQLite `artifacts.content_json` / `project_versions.content`，不是 `data/projects/<id>/...` 下可直接传给 CLI 的 JSON 文件。Final Render 的 runtime audio staging 还会按 exact job 回查 DB 中的 attempt/source/historical audio artifact。
3. 当前 Worker 是真实执行与恢复边界，不只是旧 workflow glue。直接抽出单次 render/TTS 函数会同时切断 claim、lease、cancel、retry、stale recovery、SIGTERM requeue、source fence 与 exact-job provenance。
4. Phase 1B 的 CLI 链没有生成 subtitle timing 的入口，却要求 `reconcile` 接收 subtitle artifact；素材 acquire/upload/generate/bind 也没有替代入口。
5. 当前成片链仍消费 M6 `narration-audio@1.0` 与默认 voice；TTS-B/C 的 voice assignment、`narration-audio@2.0` 和新 synthesis provenance 尚未接入 Final Render。`zhiying tts --voice ...` 不是当前 M6 production path 的薄包装。
6. 1A/1B 对 render publish 顺序的描述与代码不一致：代码先把验证后的临时 MP4 rename 到正式路径，再写 `render_artifacts`，最后 `completeJob`；而报告写成了 manifest 先于 rename。

因此：迁移目标可继续，但 1B 的分类矩阵、CLI contract 和 data/manifest strategy 必须修订后才能实现。

## Confirmed Decisions

以下判断经对抗复核后仍成立：

| Decision | Result | Evidence |
|---|---|---|
| Codex 接管 research/script 等推理与流程判断 | CONFIRMED | `src/lib/llm/` 与 `src/worker/llm-executor.ts` 是 DeepSeek stage execution；目标明确由 Codex 替代该推理层。没有证据表明 DeepSeek executor 承担媒体执行职责。 |
| Skill 只承载 SOP、decision rules、review criteria | CONFIRMED | 精确时间计算、subtitle compile、reconciliation、media probe、render 与 TTS 均已有确定性实现，不应搬进 Skill。 |
| Remotion composition、props schema、visual gate 保留 | CONFIRMED | `src/worker/index.ts:273-381` 对 payload/schema、demo marker、runtime staging、visual gate 与 composition 做生产校验；本地和 M6 Golden Case 均经过该路径。 |
| FFmpeg/ffprobe、loudness、media validation 保留 | CONFIRMED | `src/worker/index.ts:489-559`、`src/lib/render/artifact.ts`；M6 production report 记录 ffprobe、loudnorm、visual audit 与 NVENC 成片。 |
| IndexTTS2 Node provider → adapter → Feiniu upstream 的调用方式保留 | CONFIRMED | `src/lib/tts/indextts2.ts:49-152` 与 adapter contract 已闭合；没有证据支持改成 MCP 或新 HTTP 服务。 |
| subtitle compiler 与 timing reconciliation 属确定性业务能力 | CONFIRMED | 两条 API 都是同步 deterministic build，无 Worker/queue；见 subtitle route `:1-67`、reconciliation route `:1-55`。 |
| 不新增 queue/scheduler/worker/state machine/plugin/MCP | CONFIRMED | 当前已有 scheduler、Worker、SQLite transaction/lease；在没有替代证据时再造一套只会扩大状态面。 |
| 旧 Next.js/Worker/SQLite 在迁移完成前必须共存 | CONFIRMED | 旧 Zhiying 不能删除，且当前生产执行、下载、恢复、voice/asset 管理仍依赖这些入口。 |
| LLM-only `run-stage` / `lock-stage` / `cancel-job` 可作为最终退休候选 | CONFIRMED WITH PRECONDITION | `cancel-job` 只操作 `llm_jobs`（`src/app/api/workflow/cancel-job/route.ts:2-58`），调用者是 StagePanel/测试；必须先迁完旧项目与内容 schema。 |

## Incorrect / Risky Decisions

| Severity | Phase 1A / 1B decision | Adversarial evidence | Required revision |
|---|---|---|---|
| BLOCKER | 把“现有 artifact/file layout”描述成可直接给 path-based CLI 使用 | `artifacts.content_json` 与 `project_versions.content` 才是 scenes/script/subtitle/reconciliation/final source 的实际存储；`data/projects/` 主要承载 WAV/MP4。`runtime-audio.ts:118-193,263-318` 必须从 DB 解析 attempt/source/historical manifest。 | 第一实施版继续使用 SQLite artifact registry 和 explicit artifact ID；不得假装已有 file-native contract。是否导出为文件是后续独立迁移。 |
| BLOCKER | `zhiying render --scenes <path> ...` 是薄 wrapper | `enqueueFinalRender()` 在一个 `BEGIN IMMEDIATE` 内重读 current sources、构建 sourceKey、检查 active job、写 source/job/attempt（`bridge.ts:467-616`）；Worker staging 依赖这些 DB identity。 | 第一版 `render` 应包装现有 `enqueueFinalRender(projectId)` + job observe/download；不能先拆掉 DB/source fence。 |
| BLOCKER | `zhiying tts --plan <path> --voice ...` 可直接复用当前稳定生产链 | M6 `audio.ts` 读取 current plan、默认 voice，并以 tts_jobs + lazy finalize 形成 `narration-audio@1.0`；`audio-v2.ts:23-26,284-298` 明确 v2 仅实现机制、未接 API/UI；Final Render 仍 import v1 audio。 | 先选择并冻结 M6 v1 或 TTS-B/C v2 作为迁移 contract；在完整成片 parity 前不能混用。 |
| BLOCKER | 四个 CLI 命令闭合当前生产链 | `reconcile` 需要 subtitle timing，但 1B 未提供生成它的命令；移除 Next 后也没有素材 acquire/upload/generate/bind 的替代入口。 | 明确复用现有 subtitle/reconciliation functions；补足 subtitle 能力（单独命令或固定 timeline 命令）。资产入口在删除 Next 前必须保留或轻量暴露。 |
| HIGH | 文件状态可以优先替代 DB 状态 | active render guard、source/job/attempt 原子写、version allocation、asset active-binding uniqueness、TTS dedupe、claim/heartbeat/cancel/retry 与 GPU lease 都是事务或并发事实，不是普通文件 provenance。 | 文件承载媒体与可移植 manifest；SQLite 或外部执行器继续承载少量 transaction/lock/lease/idempotency，直到有等价验证。 |
| HIGH | 先从 Worker 抽出 direct single-run executor，再评估 scheduler | `runRenderJob` 的 lease heartbeat 从 bundle 前覆盖到 render 后，lease lost 会 abort 且禁止提交 success（`worker/index.ts:598-665`）；Worker 启动还回收多类 stale job。 | Reuse first：先让 CLI 调用现有 enqueue/worker；只有外部执行器 contract 已定义并通过 kill/restart/cancel/contention tests，才抽离 executor。 |
| HIGH | `Workflow stage state` 整体 RETIRE | Final Render/reconciliation 通过 `project_stages.locked_version → project_versions` 选 authoritative scenes；`operations.ts` 在单个 `BEGIN IMMEDIATE` 中保证 version + pointer + stale propagation 原子提交。 | 拆分“流程推进状态”和“accepted/current artifact pointer + immutable versions”。前者可退休，后者必须 KEEP/EXTRACT。 |
| HIGH | `Workflow UI / Jobs UI / settings` 整体 RETIRE | Jobs/download backend 实现 exact job→manifest→file fail-closed contract（download route `:1-63`）；voice settings 对应真实 profile/revision ingest，而不是纯 stage UI。 | 只把 UI presentation 标为 RETIRE；下载/inspect identity 与 voice/asset 管理能力分别 KEEP/EXTRACT/UNKNOWN。 |
| HIGH | Render manifest 是“immutable writer”，且 manifest 在 rename 前落库 | 实际顺序为 `renameSync`（`worker/index.ts:544`）→ `persistRenderArtifact`（`:545-558`）→ `completeJob`（`:559`）；`persistRenderArtifact` 使用 `INSERT OR REPLACE`（`render/artifact.ts:159-181`），DB 并未强制 immutable。 | 修正 1A/1B 事实描述；迁移 parity 以实际 fail-closed 行为为基线，不以注释中的顺序为基线。实施前明确 orphan/retry 与 manifest write-once contract。 |
| MEDIUM | 所有 deployment/runtime packaging 都 KEEP | 当前 compose 同时打包 web、通用 Worker、adapter；如果最终退休 web/LLM orchestration，不可能原样 KEEP 整个拓扑。 | KEEP 镜像依赖、Chrome/FFmpeg、volume/network/GPU facts；现有 web/worker service topology 标为 transition/UNKNOWN。 |
| MEDIUM | `Asset acquisition / binding` 整包 KEEP | file/provenance/binding/readiness 是业务能力；Next routes、generation enqueue、UI mutation 是入口/调度层。 | 继续按 provider/model/binding/gate 与 API/enqueue/UI 分拆，禁止整目录分类。 |

## RETIRE Reversals

### 1. Workflow stage state — partial reversal

Phase 1B 的整行 `RETIRE` 必须拆开：

- 可 RETIRE：`not_started/generated/edited/locked/stale` 的通用阶段推进体验、run/lock UI workflow、LLM stage capability。
- 必须 KEEP/EXTRACT：append-only `project_versions` 内容、exact source IDs/versions、accepted/locked pointer、上游 snapshot、生成/编辑与 pointer 的原子提交。

理由：当前 Final Render 和 reconciliation 并不接受任意 scenes 文件；它们只接受 `project_stages` 指向的 exact locked `project_versions` 行。若退休 pointer 而只保留文件，Codex 或 renderer 将失去“哪个版本被正式接受”的事实，可能把 stale scenes 与新 audio/subtitle 混合。

目标 manifest 可以最终替代 `project_stages` 的 accepted pointer，但必须先有明确字段、原子发布方式和 parity test；Skill 中的“我判断这个版本可用”不能替代持久化 acceptance fact。

### 2. Workflow UI / Jobs UI / settings — row reversal by split

- Stage/workflow presentation 可以 RETIRE。
- Jobs 页面本身可以最终 RETIRE，但其 exact-job progress、error、output identity、download/inline fail-closed contract 必须迁到 `inspect`/CLI 或继续复用 backend。
- Voice settings 不能随 workflow UI 一并退休。若迁移后仍允许新增/更新 reference voice，则 profile/revision ingest、canonicalization、registry publication 是真实业务入口；若只允许使用现有 Feiniu registry，则这部分应标 UNKNOWN，而不是默认 RETIRE。

### 3. LLM provider/executor — no reversal

保持 RETIRE 候选。需要先抽取 output schema、SOP、review rules，并保留旧项目只读兼容；没有发现它承担 render/TTS crash recovery 或外部媒体 contract。

### 4. LLM workflow API — no reversal

保持 RETIRE 候选。`run-stage`、`lock-stage`、`cancel-job` 的实际生产作用限于旧 LLM stage；其中 cancel route 不是 render/TTS 的通用取消 contract。

## KEEP Reversals

### 1. Voice registry / reference identity — split KEEP and UNKNOWN

Phase 1B 把 `src/lib/voice-library/`、adapter registry 与 TTS-C publication/recovery 合为 KEEP，证据不足：

- KEEP：Feiniu adapter 当前消费的 registry JSON、reference WAV、`profile@revision` identity、Node request contract。
- KEEP/EXTRACT（若要新增声音）：reference ingest/canonicalization 与 exact profile/revision identity。
- UNKNOWN：TTS-C materialization、registry publication/activation/recovery 全套是否是 Codex 新链必需。现有 production records 明确长期保持 voice profiles/revisions 为 0，M6 成片使用 legacy registry；新链尚未接 Final Render。

不能为了“保住声音能力”而默认迁移整个 TTS-C control plane，也不能因为它未进入 Golden Case 就删除它。

### 2. Deployment/runtime packaging — split KEEP and transition

- KEEP：Remotion/Chrome/FFmpeg 依赖、Feiniu mounts、adapter network、GPU/NVENC 环境事实、版本精确锁定。
- TRANSITION/UNKNOWN：当前 web + all-role Worker compose 拓扑。`WORKER_ROLE` 在 `worker/index.ts:671-675` 仍注明除 `all` 外未实现，因此现在没有可直接复用的 render-only deployment role。

### 3. Render manifest / provenance — keep semantics, not all implementation claims

必须保留 exact source/attempt/output identity、probe/hash/audit/loudness 与 fail-closed download。但当前 DB writer 是 job-coupled 且 `INSERT OR REPLACE`；它不是现成的 file-manifest writer。KEEP 的对象应是 contract 与验证函数，不应误写成“所有存储实现原样不动”。

### 4. Asset acquisition / binding — split core from control surface

KEEP 素材文件、license/provenance、requirement binding、readiness/resolver、render assetMap。Next API、UI mutation 和 durable generation enqueue 分别作为过渡入口或 EXTRACT；不得用一个 KEEP 覆盖整目录。

## EXTRACT Revisions

### 1. Render execution: expose before extracting

Phase 1B 建议从 `src/worker/index.ts` 抽出 single-run executor。更小、更安全的第一步是：

```text
CLI render(projectId)
  → existing enqueueFinalRender(projectId)
  → existing render_jobs / scheduler / Worker
  → exact job status + resolveJobArtifact
```

这已经是薄 wrapper，并完整复用 source fence、active guard、GPU lease、cancel、retry、stale recovery、runtime staging、quality gate 和 exact output identity。只有未来 external executor 明确承担这些语义时，才把 render body 从 Worker 解耦。

### 2. TTS execution: do not bypass the existing job/finalize path

第一版应包装既有 plan→tts_jobs→Worker→lazy finalize 路径，不直接调用 `IndexTts2Provider.synthesize()` 后自行拼 manifest。直接 provider call 会丢失 provider/voice snapshot、unit dedupe、cancel/retry、ffprobe duration、atomic file finalize 与 master provenance。

在选择 M6 v1 或 TTS-B/C v2 前，不批准 `--voice` contract。若选择 v2，还必须先证明 v2 audio/subtitle/reconciliation/final-render 能闭合。

### 3. Final Render Bridge: keep DB-backed source fence initially

不要先“去掉旧 job 依赖”。`enqueueFinalRender()` 当前把 source snapshot、active guard、job 与 attempt 放在同一个 `BEGIN IMMEDIATE` 中；`runtime-audio` 又验证 payload 与 persisted source deep-equal。第一版 CLI 应直接复用该函数，而不是复制成 path resolver。

### 4. Subtitle/reconciliation: expose existing synchronous functions

这两项已经接近理想的 deterministic CLI core：`buildSubtitleTiming(projectId)` 与 `buildTimingReconciliation(projectId)` 无 Worker、无 queue。CLI 必须补足 subtitle 步骤；可以是独立 `subtitles` 命令，也可以是固定顺序的 `timeline` 命令，但不能让 Skill 自己计算 cue/frame。

### 5. Asset entrypoints: preserve before Next retirement

Current Final Render 的 visual readiness 依赖 acquire/upload/generate/bind 与 physical file staging。若 Next.js 被移除，至少一种现有入口必须继续可调用：保留 API，或对其底层函数做薄 CLI 暴露。不能仅要求 Codex 手写 asset manifest，因为那会绕过 magic-byte、license、binding uniqueness、source fence 与 readiness gates。

### 6. Prompt registry: extract content, not runtime registry mechanics

只抽取领域 SOP、output schema、review criteria、失败修正规则。stage registry、capability、run permission、job routing 不进入 Skill。

## Minimal Final Target

在现有事实下，最小目标不应先追求“零数据库”，而应先追求“Codex 不依赖旧 workflow UI/LLM orchestration”：

```text
Codex
  → Zhiying Skill
       SOP / reasoning / review / failure correction only
  → thin project-aware CLI
       explicit projectId + exact artifact/job IDs
  → existing SQLite artifact/runtime registry
       accepted source refs / transactions / idempotency / jobs / leases
  → existing deterministic functions and current Worker executor
       narration / subtitle / reconciliation / assets / render / inspect
  → Feiniu IndexTTS2 adapter + Remotion + FFmpeg/ffprobe
  → data/projects media files + exact output provenance
```

第一实施切片应优先复用现有入口：

1. `inspect`：读取 project/artifact/job，复用 schema、readiness、ffprobe 与 exact-job resolution。
2. `tts`：基于 explicit project/source artifact，复用现有 enqueue、Worker、finalize；不直接重写 provider loop。
3. `subtitle/timeline`：直接调用已有 subtitle timing 与 reconciliation builders。
4. `render`：调用 `enqueueFinalRender(projectId)`，等待/返回 exact job，最终走 `resolveJobArtifact`。
5. assets：实现 CLI 前继续保留现有 API；只有确认 Codex 的真实素材输入方式后再决定是否需要单独命令。

这不是最终永久保留通用 Worker 的结论。它是 reuse-first 的迁移顺序：先移除 LLM workflow 依赖，再用实测决定能否把 Worker 缩为 deterministic executor。若外部执行器本身提供 durable job、cancel、restart recovery 与 resource lock，可在第二步替代相应 SQLite runtime rows；否则这些少量事务机制必须保留。

## Implementation Gate

**IMPLEMENTATION_READY: NO**

以下 blocker 关闭前，不应创建 Skill 或 CLI：

1. **Artifact contract 未冻结**：确认第一版是否继续以 SQLite artifact ID 为 canonical input。推荐先 DB-backed；file-native manifest 另做 export/import parity 后再切换。
2. **TTS 主链未选择**：M6 v1/default voice 与 TTS-B/C v2/custom voice 二选一作为首个迁移 contract，并证明一直闭合到 subtitle、reconciliation、Final Render。
3. **External executor contract 未定义**：明确继续使用现有 Worker，还是由其他执行器提供 durable launch、cancel、kill/restart recovery、retry、GPU mutual exclusion 与 result collection。
4. **CLI 链不完整**：补足 subtitle timing；明确资产 acquire/upload/generate/bind 在 Next 退出后的可调用入口。
5. **Production 现场未复核**：只读确认 Feiniu 当前 release SHA、production DB 中 M6/M7 consumer、active registry/reference voice、Golden Case MP4/manifest 与实际 mounts。
6. **Render commit contract 有事实冲突**：以代码实测确认 rename/manifest/job terminal 的失败窗口与 retry 行为，修正 1A/1B 后再冻结 CLI parity。
7. **父级架构 Source of Truth 缺失**：`视频生成器_架构设计文档.md` 仍未找到；实现前需确认它是否已废止、移动或仍是约束来源。
8. **Retirement parity gate 未定义**：至少要有一个 production-like Golden Case，在 Codex entrypoint 下验证 audio、subtitle、reconciliation、assets、render、inspect，并包含 Worker kill/recovery 与 cancel；通过前不退休旧入口。

满足上述条件时，优先实现 DB-backed thin wrapper，而不是先搬目录、导出全部 JSON、拆 Worker 或引入新的状态系统。

## Phase 1C Result

```text
VERDICT: NEEDS_REVISION

IMPLEMENTATION_READY: NO

BLOCKERS:
artifact 仍是 DB-backed 而非 file-native；Worker/external executor 的 lease/recovery/cancel 边界未冻结；M6 与 TTS-B/C 音频链未选定；CLI 缺 subtitle 与 asset 入口；Feiniu 当前生产事实未现场复核；render publish 顺序在报告与代码间不一致。

REPORT:
docs/skill_migration/03_ARCHITECTURE_REVIEW.md
```

本阶段到此停止；未修改生产代码、配置、数据库、Docker/Compose、飞牛服务或目录结构，未创建 Skill/CLI，未删除旧模块，也未进入下一阶段。
