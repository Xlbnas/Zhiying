# TTS-C 实施计划（TTS-C.0.R2 修订；runtime implementation not started）

> 状态：**TTS-C.0.R2 architecture closure completed；pending independent Review PASS；
> TTS-C runtime implementation not started；TTS-C.1A not started**。
> 本计划按 TTS-C.0.R2 Review 结论更新：① 1A 只实现到 `file_ready_unpublished`（materialization 状态机 + `voice_materialization_state` 精确 schema 已冻结）；② 1B 增加 **legacy registry cutover** + empty registry + LKG health 语义；③ C.2 冻结 **active synthesis constraint**（partial unique）+ **phase-aware crash recovery** + **原子成功终局事务** + attempt journal 修正。
> 每阶段：独立 migration、独立 tests、独立 Review、独立 deployment gate、不跨阶段、不产生半成品 active 状态。

---

## 0. 总原则（R2 强化）

- **exact source 纪律**：全链路显式 artifact ID；禁止 current/latest/default。
- **mutable job ≠ immutable artifact**：`tts_jobs`（mutable execution + active synthesis claim）+ `sentence_audio_artifacts`（immutable result，trigger ABORT）；regeneration = 新 job + 新 artifact + 新文件。
- **active synthesis single-flight**：partial unique index（`WHERE status IN ('queued','running','indeterminate')`）强制——不同 requestId 同 synthesis key 必须链接同一 active job；**不设 artifact fingerprint UNIQUE**（多 immutable candidate 合法共存）。
- **phase-aware recovery**：恢复行为由 latest attempt phase 决定（queued/claimed_pre_provider 可 requeue；provider_in_flight → indeterminate；response_received/file_durable → 本地恢复）；**不得仅凭 status='running' 无条件 requeue**。
- **原子成功终局**：文件（temp→校验→rename→fsync）先于 DB；单 BEGIN IMMEDIATE 内 artifact/attempt/job/envelope 四者原子完成；cancel 优先。
- **durability 顺序**：文件先于 SQLite commit。
- **零真实 provider 门禁**：自动化测试用临时 DB + Mock provider；真实 provider 仅人工验收命令。
- **单门禁入口**：每阶段新测试并入 `scripts/run-m7-quality-gate.sh`（suite 数递增）。
- **部署纪律**：exact-SHA build + 镜像内 gate + backup + compose up + invariants + docs evidence commit；禁手工 sqlite3。

---

## TTS-C.1A — Voice materialization durable requests/files/DB projection（实现到 `file_ready_unpublished`）

**范围**（设计文档 §8.4/§8.5）：
- `voice_materialization_state` 表（**R2 已冻结精确 schema**：`id/voice_profile_id/voice_profile_revision_id/request_id/assignment_artifact_id/status/source_canonical_sha256/destination_relative_path/published_registry_generation/legacy_import_provenance/error_code/error_message/created_at/updated_at`，`UNIQUE(profile, revision, request_id)`）。
- materialization request envelope：`{requestId, voiceProfileId, voiceProfileRevisionId, assignmentArtifactId}`；裁决 = exact Assignment artifact 存在 + source 自洽 + exact voice usable（**不按 Profile active 状态**；archive 后合法历史 Assignment 引用的 revision 允许 materialize）。
- 状态机：`requested → file_writing → file_ready_unpublished →（failed/indeterminate 任意阶段）`；**1A 只实现到 `file_ready_unpublished`**。
- 1A 边界：API **不声称 adapter ready**；**TTS dispatch 不可使用**（未发布 voice 不可用于合成）；`registry_pending/published_usable` 属 1B。
- Worker 唯一 writer（Web 无 voice/registry 挂载、无文件写）；`/voice-config` 目录挂载（非单文件 bind）；文件发布 temp 写 + fsync + rename + 目录 fsync。
- 测试：幂等/并发 single-flight（全局锁）/orphan 清理（不得删 DB 已引用）/archive 语义/路径 containment/状态机边界（不产生半成品 active）。
- **不含**：registry 发布、adapter reload、capability。
- **deployment gate**：materialize 不触发合成；production 可安全部署（voice-library 仍 0/0，无 materialize 动作）。

## TTS-C.1B — Global registry publisher + adapter hot reload + legacy cutover

**范围**（设计文档 §5.3/§5.4/§8.1/§8.2/§8.3）：
- global registry publisher：全局发布锁 + 从 DB **全量确定性重建**完整 registry（canonical ordering）+ temp write → fsync → rename → directory fsync；无并发 read-modify-write patch；crash 后从 DB 重建。
- **legacy registry cutover**：首次启用 DB-authoritative publisher 前读取并严格验证现有 registry → 合法 entry 导入 legacy materialization rows（import provenance）→ 新 DB 全量重建结果与旧 entry 集合完全一致才允许切换；**不得因 DB rows 空发布空 registry；不得首次 materialize 新 voice 时删全部 legacy entries；无法映射 entry fail-closed + 人工裁决**。
- **empty registry**：空集合不替换现有 registry；adapter `voices=[]` 拒绝保留；cold start 无 LKG → `VOICE_REGISTRY_EMPTY` ready=false。
- **adapter hot reload + LKG health**：mtime/inode/size 检测 → 原子加载临时 RegistryState → swap → 失败保持 last-known-good（ready=true/degraded=true/detail=VOICE_REGISTRY_PUBLISH_FAILURE）；无 LKG + invalid → ready=false + synthesize 503；Docker healthcheck 视 LKG degraded 为 healthy；不依赖 Docker restart / 不需要 docker.sock。
- 测试：真实 Python parser/reloader + mock upstream；cutover 全等性断言；LKG/degraded/empty 矩阵；并发 synthesize 不消费过期 registry。
- **不含**：capability compile（1C）、TTS 合成。
- **deployment gate**：adapter 镜像变更需 exact-SHA 重建 + 镜像内 gate + 部署；production 仍零合成。

## TTS-C.1C — Provider capability snapshot/compiler

**范围**（设计文档 §7 capability neutral matrix）：capability snapshot（provider/model/providerVersion/providerCommit + capabilityCompilerVersion）固化与执行前比对；capability compiler 纯函数——neutral 默认值 → supported no-op（unsupportedFlags=[]）；非 neutral 无通道 → explicit unsupported（不静默丢弃）；编译结果进入 provenance + `synthesisPayloadFingerprint`。
测试：neutral 矩阵全 unit 不 block；非 neutral 全矩阵；compiler 版本化。
**deployment gate**：纯函数 + 快照存储，production 零合成。

## TTS-C.2 — Request envelope + durable job + attempt journal + immutable artifact + fingerprints + active synthesis constraint

**范围**（设计文档 §3/§4/§5/§6/§7）：
- 新表：`tts_audio_requests`（`UNIQUE(project_id, request_id)`）、`tts_generation_attempts`（append-one-row-per-provider-call；immutable request identity + mutable lifecycle + 禁 DELETE + DB trigger 限状态倒退）、`sentence_audio_artifacts`（immutable，trigger ABORT，exact reader）。
- `tts_jobs` ALTER：加 `tts_audio_request_id/exact_source_fingerprint/synthesis_payload_fingerprint/final_tts_input_fingerprint/generation_variant_id/result_artifact_id`；**强制 partial unique `uq_tts_jobs_active_synthesis`（project_id, unit_id, final_tts_input_fingerprint, generation_variant_id）WHERE status IN ('queued','running','indeterminate')**；`output_path/duration_ms/audio_sha256/result_json` 降级 legacy 兼容。
- **两阶段事务算法**：Phase 1（BEGIN IMMEDIATE 同步 DB 裁决：envelope-first + usable artifact metadata candidate + active job 查找 + INSERT envelope/job 精确链接）→ Phase 2（事务外 exact file validator）→ Phase 3（重入 BEGIN IMMEDIATE 完成复用或 repair；并发期间不得双开 job）。
- **phase-aware crash recovery**：latest attempt phase 驱动（queued/claimed_pre_provider → requeue；provider_in_flight → indeterminate 禁自动重调；response_received/file_durable → 本地恢复不重调 provider；db_completed → exact reader 验证）；**不得仅凭 status='running' 无条件 requeue**。
- **indeterminate resolution**：不自动重调；保留 active claim；用户显式 resolve（接受可恢复结果 / 标记 failed / 新 request + explicit variant）；usage/cost 保留。
- **原子成功终局**：文件（attempt temp → probe/SHA/size/codec → final rename → fsync file → fsync dir）后单 BEGIN IMMEDIATE（重读 job/envelope/active identity → INSERT artifact → UPDATE attempt succeeded → UPDATE job succeeded + result_artifact_id + clear owner/lease → UPDATE envelope result_artifact_id）→ COMMIT；任一失败整事务回滚、durable 文件为 orphan、cleanup 不触发第二次 provider；cancel 优先。
- fingerprint 三分离实现（exactSourceFingerprint 不含 materialization transport；synthesisPayloadFingerprint 只含实际 provider payload；generationVariantId = 候选生成身份，opaque 不进 synthesis payload 除非 seed/override 真正进 payload）。
- 测试：active unique（不同 requestId 同 key 链同一 job；indeterminate 占 claim；终态释放）；artifact 多 candidate 共存（repair/repeat 不冲突）；两阶段裁决并发；phase recovery 矩阵；原子终局（四者一致，无部分成功）；attempt trigger（immutable 字段禁改/状态禁倒退）；fingerprint 矩阵；零真实 provider。
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
| C.2 | ✓ | ✓ | ✓ | ✓ | ✗（active unique + 原子终局，不产半成功） | ✗ |
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
