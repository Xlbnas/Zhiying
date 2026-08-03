# TTS-C 实施计划（TTS-C.0.R3 修订；runtime implementation not started）

> 状态：**TTS-C.0.R3 architecture closure completed；pending independent Review PASS；
> TTS-C runtime implementation not started；TTS-C.1A not started**。
> 本计划按 TTS-C.0.R3 Review 结论更新：① 新增 **`tts_synthesis_claims`**（unschedulable reuse reservation，Scheduler 永不 claim `validating_reuse`）；② 共享 request **fan-in**（many-to-one + fan-out + per-request cancellation）；③ **persisted execution phases**（`tts_generation_attempts.execution_phase` 持久化真相）；④ 原子 **claim/job/request/artifact** 成功终局；⑤ materialization 拆 **requests/jobs/projections 三层**（1A 止于 `file_ready_unpublished`，目标路径固定 voice-root-relative）；⑥ **legacy_adapter_voice_entries** shadow + publisher source union；⑦ **adapter activation acknowledgement**（registryGeneration + /health activeRegistrySha256 + poll）。最终 schema（9 表）见设计文档 §2（自包含，实施者不得跨 commit 拼接）。
> 每阶段：独立 migration、独立 tests、独立 Review、独立 deployment gate、不跨阶段、不产生半成品 active 状态。

---

## 0. 总原则（R3 强化）

- **exact source 纪律**：全链路显式 artifact ID；禁止 current/latest/default。
- **mutable job ≠ immutable artifact**：`tts_jobs`（mutable execution）+ `sentence_audio_artifacts`（immutable result，trigger ABORT）；regeneration = 新 job + 新 artifact + 新文件。
- **synthesis reservation**：`tts_synthesis_claims` 是 active synthesis identity 的唯一 reservation（partial unique）；`validating_reuse` **Scheduler 永不 claim**——**不能在 artifact 校验前产生可执行 queued job**；artifact usable 不建 job；unusable 才在 claim 保护下转 queued。
- **共享 fan-in**：`tts_audio_requests` many-to-one → claim/job；成功/失败 fan-out 全部有效 subscriber；per-request cancel 仅 detach 该 envelope，全部取消才置 job-level `cancel_requested=1`。
- **persisted phases**：crash recovery 由 `tts_generation_attempts.execution_phase` 持久化真相驱动（provider_in_flight → indeterminate；response_persisted/file_validated/file_durable → 本地恢复，不重调 provider）；**不得仅凭 status='running' 无条件 requeue**。
- **原子成功终局**：文件（temp→校验→rename→fsync）先于 DB；单 BEGIN IMMEDIATE 内 artifact/attempt/job/claim/requests 原子完成；cancel 优先。
- **durability 顺序**：文件先于 SQLite commit。
- **零真实 provider 门禁**：自动化测试用临时 DB + Mock provider；真实 provider 仅人工验收命令。
- **单门禁入口**：每阶段新测试并入 `scripts/run-m7-quality-gate.sh`（suite 数递增）。
- **部署纪律**：exact-SHA build + 镜像内 gate + backup + compose up + invariants + docs evidence commit；禁手工 sqlite3。

---

## TTS-C.1A — Materialization requests/jobs/projection（实现到 `file_ready_unpublished`）

**范围**（设计文档 §2.6–2.8/§7）：
- 三层表：`voice_materialization_requests`（envelope，requestId scope = per (profile, revision)，assignment 授权）+ `voice_materialization_jobs`（mutable Worker execution，claim/lease/heartbeat/retry/cancel）+ `voice_materializations`（canonical projection，`UNIQUE(profile, revision)`，状态机 `file_ready_unpublished → registry_pending → published_usable`）。
- 1A durability 流程：exact source validator → materialization claim（单 BEGIN IMMEDIATE）→ temp copy → SHA/codec/size 校验 → final rename + file fsync + dir fsync → BEGIN IMMEDIATE（projection=file_ready_unpublished + job=succeeded + all linked requests=succeeded）→ COMMIT。
- 目标路径**固定 voice-root-relative**（`<profile_id>/<revision_id>/reference.wav`），禁止"data-relative 或 voice-root-relative"二选一。
- 1A 边界：API **不声称 adapter ready**；**TTS dispatch 不可使用**；不写 registry（`registry_pending/published_usable` 属 1B）。
- Worker 唯一 writer（Web 无 voice/registry 挂载、无文件写）；`/voice-config` 目录挂载。
- 测试：请求幂等/conflict（同 scope 同 requestId 异 source 409）/多请求复用同一 projection/job/fan-out/并发 single-flight/orphan 清理（不得删 DB 已引用）/archive 语义（历史 Assignment 授权可 materialize）/路径 containment（voice-root-relative 严格）。
- **不含**：registry 发布、adapter reload、capability、TTS 合成。
- **deployment gate**：materialize 不触发合成；production 可安全部署（voice-library 仍 0/0，无 materialize 动作）。

## TTS-C.1B — Legacy shadow + global publisher + adapter reload/activation ack

**范围**（设计文档 §8/§9）：
- **legacy shadow**：`legacy_adapter_voice_entries`（独立于 TTS-A；`mapping_status=unmapped/mapped/retired`；不伪造 TTS-A 数据）；publisher source union = validated non-retired legacy + published/registry_pending TTS-A materializations；canonical key 唯一，冲突 fail-closed；新 TTS-A voice 发布不删 legacy entry；cutover 前后 legacy 集合与 SHA 完全保持。
- **global registry publisher**：全局发布锁 + DB 全量确定性重建 + temp/fsync/rename/dir-fsync；registry 文档含 `registryGeneration + publisherSchemaVersion`。
- **adapter hot reload + LKG health**：mtime/inode/size 检测 → 原子加载 → swap → 失败保持 LKG（ready=true/degraded=true/detail=VOICE_REGISTRY_PUBLISH_FAILURE）；无 LKG → ready=false + 503；Docker healthcheck 视 LKG degraded 为 healthy。
- **activation acknowledgement**：publish → projection=registry_pending → poll adapter /health → `activeRegistrySha256 == published SHA` → projection=published_usable；adapter 保持 LKG（active != candidate）→ 保持 registry_pending，不得标记 usable。
- 测试：真实 Python parser/reloader + mock upstream；cutover 全等性断言；activation 轮询（LKG 不误标 usable）；LKG/degraded/empty 矩阵。
- **deployment gate**：adapter 镜像变更需 exact-SHA 重建 + 镜像内 gate + 部署；production 仍零合成。

## TTS-C.1C — Provider capability snapshot/compiler

**范围**（设计文档 §7 capability neutral matrix）：capability snapshot 固化与执行前比对；capability compiler 纯函数——neutral 默认值 → supported no-op（unsupportedFlags=[]）；非 neutral 无通道 → explicit unsupported（不静默丢弃）；编译结果进 provenance + `synthesisPayloadFingerprint`。
测试：neutral 矩阵全 unit 不 block；非 neutral 全矩阵；compiler 版本化。
**deployment gate**：纯函数 + 快照存储，production 零合成。

## TTS-C.2 — Request envelope + synthesis claim + durable job + persisted attempt + immutable artifact

**范围**（设计文档 §2.1–2.5/§3/§4/§5/§6）：
- 新表：`tts_audio_requests`（envelope，`UNIQUE(project_id, request_id)`，many-to-one 到 claim，含 `claim_id/job_id/result_artifact_id/status/error`）、`tts_synthesis_claims`（**唯一 synthesis reservation**：partial unique `WHERE status IN ('validating_reuse','generation_pending','running','indeterminate')`；`validating_reuse` Scheduler 永不 claim）、`tts_generation_attempts`（persisted execution phase：`created/provider_in_flight/response_persisted/file_validated/file_durable/succeeded/transport_failed/validation_failed/indeterminate` + recovery temp/final/audio evidence 列）、`sentence_audio_artifacts`（immutable，trigger ABORT，无 fingerprint UNIQUE，exact reader）。
- `tts_jobs` ALTER：加 `claim_id/originating_request_id/exact_source_fingerprint/synthesis_payload_fingerprint/final_tts_input_fingerprint/generation_variant_id/result_artifact_id`；**强制 partial unique `uq_tts_jobs_active_synthesis`**；`output_path/duration_ms/audio_sha256/result_json` 降级 legacy 兼容。
- **unschedulable reuse reservation 算法**（三阶段）：Phase 1（BEGIN IMMEDIATE：envelope-first + 取得/创建 claim=validating_reuse + envelope 链接 claim + 读 candidate artifact metadata）→ 事务外 exact validator → Phase 3（BEGIN IMMEDIATE：usable → 链接 artifact + claim=succeeded，**不建 job**；unusable → claim 保护下 INSERT queued job + claim=generation_pending）。**Scheduler 在 Phase 1/2 之间运行 provider 调用仍为 0**；candidate damaged 时恰好一个 queued job；并发两 requestId 只创建一个 claim/job。
- **共享 fan-in**：成功/失败 fan-out 全部有效 subscriber（`UPDATE tts_audio_requests SET status=..., result_artifact_id=? WHERE claim_id=? AND status IN ('waiting','running')`）；每 envelope request identity 与 claim 全一致，任一 mismatch → 整事务回滚 + `REQUEST_STATE_INCONSISTENT`；same-request replay 从自己 envelope 得相同 result。
- **per-request cancellation**：单 envelope cancel 仅 detach 该 subscriber；还有 active subscriber → claim/job 继续；全部取消 → 才置 job `cancel_requested=1`；admin job cancel 可取消全体但记录 provenance；success 与最后 cancel 由同事务原子裁决。测试矩阵：A+B 共享、A cancel B 成功、双 cancel job cancelled、A cancel 与 success 并发无悬空 envelope。
- **persisted recovery phases**：provider 调用前 `INSERT attempt phase=provider_in_flight` 先 COMMIT；response → recovery temp + fsync + `response_persisted`；校验 → `file_validated`；rename+fsync → `file_durable`；recovery 按 phase（provider_in_flight → indeterminate；response_persisted/file_validated/file_durable → 本地恢复不重调 provider）；recovery 校验 attempt/job/claim/source/fingerprint/owner，任一不一致 → indeterminate；cleanup 不得删 DB 引用文件。
- **indeterminate resolution**：不自动重调；保留 active claim；用户显式 resolve（接受可恢复结果 / 标记 failed / 新 request + explicit variant）；usage/cost 保留。
- **原子成功终局**：文件 durable 后单 BEGIN IMMEDIATE 9 步（重读 claim/job/attempt/全部 subscriber → INSERT artifact → attempt succeeded → job succeeded + result → claim succeeded + result → 全部未取消 envelope succeeded）→ COMMIT；任一失败整事务回滚 + recoverable orphan + 不调用 provider；无部分成功；cancel 优先。
- fingerprint 三分离实现（exactSourceFingerprint 不含 materialization transport；synthesisPayloadFingerprint 只含实际 provider payload；generationVariantId = 候选生成身份）。
- 测试：active unique 与 claim 双保险（indeterminate 占 claim；终态释放）；reuse reservation 竞态（Scheduler 运行 provider=0；usable 零新 job；damaged 恰好一个 queued）；fan-in/fan-out/单请求取消矩阵；phase recovery 矩阵；原子终局（五者一致）；attempt trigger（immutable 禁改/phase 禁倒退）；fingerprint 矩阵；零真实 provider。
- **deployment gate**：可部署；production 不 enqueue 任何 TTS job（新增=0 不变量保持）。

## TTS-C.3 — Preview/override/variant/A-B/selection

**范围**（设计文档 §9 失效规则 + 设计文档 §7.2 的 variant 语义）：
- preview（同一合成路径 + preview 标记；selection=null）；A/B（显式 variant/seed/override artifact——**adapter 无 variation 通道时禁止同请求伪造 A/B**）；selection 持久化（per-unit：selectedAudioArtifactId（**只引用 immutable artifact**）/overrideRequestId/reviewedBy/reviewedAt/source/bulk/unit override）。
- 失效规则实现（§9 表）：文本/voice/performance/pronunciation/capability 变化 → 受影响 unit 局部失效 + 重生成；未变 unit 复用 exact artifact；禁 full regeneration。
- review lock（selected 后可 lock；source 漂移 → stale + 重 review，fail-closed）。
- 测试：A/B 不覆盖旧 artifact；失效矩阵逐项；override provenance；lock 漂移 stale；零真实 provider。
- **不含**：manifest/master/subtitle。
- **deployment gate**：selection 不影响既有管线；production 零 TTS job 不变量保持。

## TTS-C.4 — Selection manifest + immutable master audio + ffprobe

**范围**（设计文档 §8）：
- `narration_audio_selection_manifest@2.0` artifact（**不含 master 信息**；含 ordered units + selected immutable sentence audio artifact IDs + SHA/duration/fingerprint + silence/gap + reviewSource；顺序逐 index 对齐校验）。
- `narration_master_audio@1.0` immutable artifact（引用 selectionManifestArtifactId + ContentHash + concatCompilerVersion；**masterInputFingerprint 非循环**；output 相对路径/SHA/size/codec/sr/channels/ffprobeDurationMs）。
- 顺序：selected immutable manifest → durable master temp/write/probe/rename/fsync → immutable master artifact DB commit。
- master 拼接实现决策（Node PCM concat 现状 vs ffmpeg concat filter——静态 ffmpeg 可用性已验证于构建门禁）。
- 测试：manifest 对齐/缺失/重复/stale artifact；master 失败不覆盖旧；时长防线 ±100ms；ffprobe 实测断言。
- **不含**：subtitle timing v2（下阶段）。
- **deployment gate**：v2 manifest/master 不接 UI；production 零 TTS job 不变量保持。

## TTS-C.5 — Subtitle timing v2/reconciliation/stale graph/review UI

**范围**（设计文档 §9 stale 图 + UI）：
- `subtitle_timing_v2` artifact 层（复用既有 schema+compiler）+ `timing-reconciliation@2.0`（三源 reconcile）接入 DAG；downstream 失效按 §9 规则。
- Review UI：Voice Assignment / Performance / Sentence Audio / Master / Timing review 节点 + preview/A-B/accept/reject/bulk/lock/stale 提示/failed-retry/cost-usage。
- **production acceptance gate**：人工验收命令（真实 IndexTTS2、真实材料、受控 project）独立于 CI；验收前 production 不产生业务 TTS 数据。
- 测试：stale 传播矩阵；UI 只读 smoke；DAG 状态机。

---

## 阶段门禁与禁止

| 阶段 | 独立 migration | 独立 tests | 独立 Review | deployment gate | 半成品 active | production 真 provider |
|---|---|---|---|---|---|---|
| 1A | ✓ | ✓ | ✓ | ✓ | ✗（止于 `file_ready_unpublished`，API 不声称 ready） | ✗ |
| 1B | ✓ | ✓ | ✓ | ✓ | ✗（cutover 全等后才切换 publisher） | ✗ |
| 1C | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| C.2 | ✓ | ✓ | ✓ | ✓ | ✗（claim reservation + 原子终局，不产半成功） | ✗ |
| C.3 | ✓ | ✓ | ✓ | ✓ | ✗（preview/selection 显式动作） | ✗ |
| C.4 | ✓ | ✓ | ✓ | ✓ | ✗（master 显式构建） | ✗ |
| C.5 | ✓ | ✓ | ✓ | ✓ | ✗ | 仅人工验收命令 |

## 依赖顺序与建议

- **依赖**：1A → 1B → 1C → C.2 → C.3 → C.4 → C.5（1B 依赖 1A 的 DB projection + legacy cutover；1C 独立于 1A/1B 可并行开发但 C.2 需三者齐备）。
- **建议首先实现**：**TTS-C.1A**（零音频风险、解锁 materialization、为 1B 的 cutover 与 1C 的 capability 提供 DB 基础）。
- **可并行**：1C（capability compiler 纯函数）与 1A/1B 并行。

## 未决事项（进入 1A 前定）

1. delivery 编译策略（文本改写 vs 显式 unsupported，推荐显式 unsupported）。
2. pace 经 adapter 扩展直传可行性。
3. unit vs sentence 原子单位（推荐 unit）。
4. capability 升级后存量音频失效策略。
5. pronunciation dictionary 是否纳入（建议 C.3 后）。
6. master 拼接实现（Node PCM vs ffmpeg concat，C.4 定）。
7. `voice_materialization_state` 与 TTS-C.2 `tts_audio_requests` 的 envelope 实现是否统一（schema 已冻结，实现细节 1A 定）。

> 注：`materialization_state` 精确 schema 与 request envelope 已在 `docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md` §8.5 冻结（R2），不再属于"进入 1A 后再决定"项。
