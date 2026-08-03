# TTS-C 实施计划（TTS-C.0.R4 修订；runtime implementation not started）

> 状态：**TTS-C.0.R4 architecture closure completed；pending independent Review PASS；
> TTS-C runtime implementation not started；TTS-C.1A not started**。
> 本计划按 TTS-C.0.R4 Review 结论更新：① **reclaimable validation**（`tts_synthesis_claims`/`voice_materialization_jobs` 的 validating 阶段带 validation_owner_token/lease/attempt + CAS stale recovery，不永久阻塞）；② **validating 阶段取消语义**（最后 subscriber 在 validating_reuse 取消 → 直接取消 claim 不建 job；generation_pending/running 才置 cancel_requested；零 subscriber 不产生 provider job）；③ **materialization 真正 single-flight**（`validating_existing` + partial unique `uq_voice_materialization_jobs_active`；envelope 增 `project_id` + `UNIQUE(project_id, request_id)`；不依赖 projection UNIQUE 单独承担）；④ **materialization fan-out/durability**（文件 durable 后单事务 projection/job/requests 原子）；⑤ **legacy single-source mapping cutover**（5 态：unmapped/mapping_pending/mapped_verified → 用 legacy；mapped_active → 用 TTS-A projection；retired → 不输出；每 key 恰好一个 source；等价性验证 + atomic cutover + LKG 保持 legacy emitted）；⑥ **artifact fan-in provenance**（`sentence_audio_artifacts` 删单数 request_id → claim_id/job_id/successful_attempt_id NOT NULL + originating_request_id 仅审计）；⑦ **完整 request/claim 状态机与 trigger**（waiting→succeeded reuse 路径；claim validating_reuse→succeeded/cancelled/generation_pending/failed 等；全部非法倒退 trigger ABORT）；⑧ **schema 真实 contract**（设计文档 §2 每表给出 REFERENCES+ON DELETE/CHECK/partial unique/immutable-field trigger/invalid-transition trigger/DELETE trigger/NULL 语义/authoritative reader/API redaction/legacy compat，不以注释代替）；⑨ **并行开发矩阵**（§11）。
> 每阶段：独立 migration、独立 tests、独立 Review、独立 deployment gate、不跨阶段、不产生半成品 active 状态。

---

## 0. 总原则（R4 强化）

- **exact source 纪律**：全链路显式 artifact ID；禁止 current/latest/default。
- **mutable job ≠ immutable artifact**：`tts_jobs`（mutable execution）+ `sentence_audio_artifacts`（immutable result，trigger ABORT）；regeneration = 新 job + 新 artifact + 新文件。
- **synthesis reservation（可回收）**：`tts_synthesis_claims` 是 active synthesis identity 的唯一 reservation（partial unique）；`validating_reuse` **Scheduler 永不 claim**——**不能在 artifact 校验前产生可执行 queued job**；validating 阶段带独立 validation owner/lease/attempt，lease 过期 → CAS 接管重验（不永久阻塞）；artifact usable 不建 job；unusable 才在 claim 保护下转 queued。
- **零 subscriber 语义**：最后 subscriber 在 validating_reuse 阶段取消 → 直接取消 claim 不建 job；generation_pending/running 阶段取消 → 才置 `job.cancel_requested=1`；**不允许创建 zero-subscriber provider job**。
- **共享 fan-in**：`tts_audio_requests` many-to-one → claim/job；成功/失败 fan-out 全部有效 subscriber；per-request cancel 仅 detach 该 envelope。
- **persisted phases**：crash recovery 由 `tts_generation_attempts.execution_phase` 持久化真相驱动（provider_in_flight → indeterminate；response_persisted/file_validated/file_durable → 本地恢复，不重调 provider）；**不得仅凭 status='running' 无条件 requeue**。
- **原子成功终局**：文件（temp→校验→rename→fsync）先于 DB；单 BEGIN IMMEDIATE 内 artifact/attempt/job/claim/requests 原子完成；cancel 优先。
- **durability 顺序**：文件先于 SQLite commit。
- **零真实 provider 门禁**：自动化测试用临时 DB + Mock provider；真实 provider 仅人工验收命令。
- **单门禁入口**：每阶段新测试并入 `scripts/run-m7-quality-gate.sh`（suite 数递增）。
- **部署纪律**：exact-SHA build + 镜像内 gate + backup + compose up + invariants + docs evidence commit；禁手工 sqlite3。

---

## TTS-C.1A — Materialization requests/jobs/projection（实现到 `file_ready_unpublished`）

**范围**（设计文档 §2.6–2.8/§5/§6/§7）：
- 三层表：`voice_materialization_requests`（**project-scoped** envelope：`project_id + UNIQUE(project_id, request_id)`；assignment 必须属于同 project）+ `voice_materialization_jobs`（mutable Worker execution；**含 `validating_existing` unschedulable 状态 + partial unique `uq_voice_materialization_jobs_active`（validating_existing/queued/running/indeterminate）**；Scheduler 只领取 `queued`）+ `voice_materializations`（canonical projection，`UNIQUE(profile, revision)`，状态机 `file_ready_unpublished → registry_pending → published_usable`）。
- **single-flight 算法**：Phase 1（BEGIN IMMEDIATE：envelope-first → 查 projection → 查/建 active job=validating_existing（validation owner/lease/attempt）→ 多 request 链接同一 job）→ 事务外 exact projection/file validator → Phase 3（BEGIN IMMEDIATE：usable → 全部 request succeeded/reused + job succeeded，**零文件写**；unusable → active subscriber=0 → job cancelled；否则 job → queued）→ Worker 才执行 temp copy。
- **stale validating recovery**：validation lease 过期 → BEGIN IMMEDIATE CAS 接管（validation_attempt+1）→ 重跑 exact validator（本地复制无 provider 副作用，未进入文件写阶段可安全重验）。
- **1A durability 流程**：exact source validator → materialization claim（单 BEGIN IMMEDIATE）→ temp copy → SHA/codec/size 校验 → final rename + file fsync + dir fsync → **单事务 fan-out**（重读 job owner/lease + exact Voice Revision + 全部 active request subscriber + identity/Assignment/project 自洽（任一 mismatch → 回滚 + REQUEST_STATE_INCONSISTENT）→ projection=file_ready_unpublished → job=succeeded → 全部未取消 request=succeeded + materialization_id）→ COMMIT。
- 目标路径**固定 voice-root-relative**（`<profile_id>/<revision_id>/reference.wav`）。
- 1A 边界：API 不声称 adapter ready；TTS dispatch 不可用；不写 registry。
- 测试：并发两 requestId 单 job；validating_existing Scheduler 不 copy；usable 零文件写；不可用恰好一个 queued；无两 Worker 同写；fan-out 原子（无部分成功）；stale validating CAS 不永久阻塞；零 subscriber 不建 job；archive 语义。
- **不含**：registry 发布、adapter reload、capability、TTS 合成。
- **deployment gate**：materialize 不触发合成；production 可安全部署（voice-library 仍 0/0）。
- 1A 边界：API **不声称 adapter ready**；**TTS dispatch 不可使用**；不写 registry（`registry_pending/published_usable` 属 1B）。
- Worker 唯一 writer（Web 无 voice/registry 挂载、无文件写）；`/voice-config` 目录挂载。
- 测试：请求幂等/conflict（同 scope 同 requestId 异 source 409）/多请求复用同一 projection/job/fan-out/并发 single-flight/orphan 清理（不得删 DB 已引用）/archive 语义（历史 Assignment 授权可 materialize）/路径 containment（voice-root-relative 严格）。
- **不含**：registry 发布、adapter reload、capability、TTS 合成。
- **deployment gate**：materialize 不触发合成；production 可安全部署（voice-library 仍 0/0，无 materialize 动作）。

## TTS-C.1B — Legacy single-source mapping cutover + global publisher + adapter reload/activation ack

**范围**（设计文档 §2.9/§7/§9）：
- **legacy shadow（single-source mapping）**：`legacy_adapter_voice_entries` 5 态（`unmapped/mapping_pending/mapped_verified → emitted registry 用 legacy entry`；`mapped_active → emitted registry 用 TTS-A voice_materialization`（legacy 行只保留 provenance）；`retired → 不输出`）；**每个 canonical key 在任一 candidate registry 中恰好一个 source**（修复 R3 双来源冲突）；映射等价性验证（voice key / reference SHA-256 / speaker identity policy / adapter compatibility key / containment / codec-sr-channels）通过才 `mapped_verified`；不伪造 TTS-A 数据。
- **atomic cutover**：publish candidate（用 TTS-A projection）→ adapter `activeRegistrySha256 == candidate SHA` → legacy row → `mapped_active` + projection → `published_usable`；失败/LKG（active != candidate）→ legacy **remains emitted source**（不丢旧 voice）+ projection 保持 `registry_pending`。
- **global registry publisher**：全局发布锁 + DB 全量确定性重建 + temp/fsync/rename/dir-fsync；registry 文档含 `registryGeneration + publisherSchemaVersion`；cutover 前后 legacy 集合与 SHA 完全保持。
- **adapter hot reload + LKG health**：mtime/inode/size 检测 → 原子加载 → swap → 失败保持 LKG（ready=true/degraded=true/detail=VOICE_REGISTRY_PUBLISH_FAILURE）；无 LKG → ready=false + 503；Docker healthcheck 视 LKG degraded 为 healthy。
- **activation acknowledgement**：publish → projection=registry_pending → poll /health → `activeRegistrySha256 == published SHA` → projection=published_usable；LKG（active != candidate）→ 保持 registry_pending。
- 测试：真实 Python parser/reloader + mock upstream；mapping 状态机（5 态转移 + 每 key 单 source 断言）；cutover 全等性；activation 轮询；LKG/degraded/empty 矩阵。
- **deployment gate**：adapter 镜像变更需 exact-SHA 重建 + 镜像内 gate + 部署；production 仍零合成。

## TTS-C.1C — Provider capability snapshot/compiler

**范围**（设计文档 §7 capability neutral matrix）：capability snapshot 固化与执行前比对；capability compiler 纯函数——neutral 默认值 → supported no-op（unsupportedFlags=[]）；非 neutral 无通道 → explicit unsupported（不静默丢弃）；编译结果进 provenance + `synthesisPayloadFingerprint`。
测试：neutral 矩阵全 unit 不 block；非 neutral 全矩阵；compiler 版本化。
**deployment gate**：纯函数 + 快照存储，production 零合成。

## TTS-C.2 — Request envelope + synthesis claim + durable job + persisted attempt + immutable artifact

**范围**（设计文档 §2.1–2.5/§3/§4/§5/§6）：
- 新表：`tts_audio_requests`（envelope，`UNIQUE(project_id, request_id)`，many-to-one 到 claim，含 `claim_id/job_id/result_artifact_id/status/error`）、`tts_synthesis_claims`（**唯一 synthesis reservation（可回收）**：partial unique `WHERE status IN ('validating_reuse','generation_pending','running','indeterminate')`；`validating_reuse` 带 `validation_owner_token/validation_lease_expires_at/validation_attempt/candidate_artifact_id/candidate_artifact_metadata_hash/validation_started_at`，lease 过期 → BEGIN IMMEDIATE CAS 接管重验（validation_attempt+1，不调用 provider），不永久阻塞）、`tts_generation_attempts`（persisted execution phase + recovery temp/final/audio evidence 列）、`sentence_audio_artifacts`（immutable，trigger ABORT，无 fingerprint UNIQUE，exact reader；**fan-in provenance：`claim_id/job_id/successful_attempt_id` NOT NULL + `originating_request_id` 仅审计，无单数 request_id**）。
- `tts_jobs` ALTER：加 `claim_id/originating_request_id/exact_source_fingerprint/synthesis_payload_fingerprint/final_tts_input_fingerprint/generation_variant_id/result_artifact_id`；**强制 partial unique `uq_tts_jobs_active_synthesis`**；`output_path/duration_ms/audio_sha256/result_json` 降级 legacy 兼容。
- **unschedulable reuse reservation 算法**（三阶段）：Phase 1（BEGIN IMMEDIATE：envelope-first + 取得/创建 claim=validating_reuse + envelope 链接 claim + 读 candidate artifact metadata）→ 事务外 exact validator → Phase 3（BEGIN IMMEDIATE：usable → 链接 artifact + claim=succeeded，**不建 job**；unusable → claim 保护下 INSERT queued job + claim=generation_pending）。**Scheduler 在 Phase 1/2 之间运行 provider 调用仍为 0**；candidate damaged 时恰好一个 queued job；并发两 requestId 只创建一个 claim/job。
- **共享 fan-in**：成功/失败 fan-out 全部有效 subscriber（`UPDATE tts_audio_requests SET status=..., result_artifact_id=? WHERE claim_id=? AND status IN ('waiting','running')`）；每 envelope request identity 与 claim 全一致，任一 mismatch → 整事务回滚 + `REQUEST_STATE_INCONSISTENT`；same-request replay 从自己 envelope 得相同 result。
- **per-request cancellation（含 validating 阶段）**：单 envelope cancel 仅 detach 该 subscriber；还有 active subscriber → claim/job 继续；**最后 subscriber 在 validating_reuse 阶段取消 → 直接取消 claim（不建 job，释放 active unique）**；**generation_pending/running 阶段取消 → 才置 job `cancel_requested=1`**；admin job cancel 可取消全体但记录 provenance；success 与最后 cancel 由同事务原子裁决；**不允许创建 zero-subscriber provider job**。测试矩阵：A+B 共享、A cancel B 成功、双 cancel 无 job、last cancel 与 Phase 3 并发原子、validating 阶段双 cancel。
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

## 并行开发矩阵（冻结：并行开发，串行集成/Review/部署）

| lane | 并行度 | 说明 |
|---|---|---|
| 1A 与 1C | **可并行开发** | 不同本地 worktree/local branch（1A materialization schema/durability；1C capability compiler 纯函数） |
| 1B adapter parser/reloader 测试骨架 | **可并行准备** | 只写 adapter 侧测试骨架；publisher integration 等 1A schema PASS |
| 1B publisher integration | 串行 | 依赖 1A schema PASS |
| C.2 | 串行 | 等 1A/1B/1C 全部 PASS（claim/fan-in/persisted phases 依赖三者的 schema） |
| C.3 → C.4 → C.5 | **runtime 串行** | 只允许 schema/mock/test planning 提前并行 |

**Git 纪律**：
- 不推阶段 remote branch；
- **单一 integrator 拥有 `m7`**（禁止多人同时 push m7）；
- 各 lane agent 返回独立 commit SHA；
- integrator 按顺序 cherry-pick 到最新 m7；
- **每个 exact SHA 单独 typecheck/build/tests/Review/deploy**；
- **禁止一次合并多个未 Review lane**（每 lane 必须独立 Review PASS 后才并入）。

## 未决事项（进入 1A 前定）

1. delivery 编译策略（文本改写 vs 显式 unsupported，推荐显式 unsupported）。
2. pace 经 adapter 扩展直传可行性。
3. unit vs sentence 原子单位（推荐 unit）。
4. capability 升级后存量音频失效策略。
5. pronunciation dictionary 是否纳入（建议 C.3 后）。
6. master 拼接实现（Node PCM vs ffmpeg concat，C.4 定）。
7. `voice_materialization_state` 与 TTS-C.2 `tts_audio_requests` 的 envelope 实现是否统一（schema 已冻结，实现细节 1A 定）。

> 注：`materialization_state` 精确 schema 与 request envelope 已在 `docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md` §8.5 冻结（R2），不再属于"进入 1A 后再决定"项。
