# TTS-C 实施计划（TTS-C.0.R9 修订；runtime implementation not started）

> 状态：**TTS-C.0.R9 architecture closure completed；pending independent Review PASS；
> TTS-C runtime implementation not started；TTS-C.1A not started**。
> 本计划按 TTS-C.0.R9 Review 闭环更新。R9 关闭独立 Review 对 R8 的 FAIL 发现（docs-only，零 runtime/零 migration/零 schema）：
> ① **database-time lease fencing**（所有 lease 列统一 INTEGER epoch milliseconds：validation/worker
> lease_expires_at_epoch_ms；权限判断时间 = SQLite DB 当前时间 `DB_NOW_MS = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`，
> trigger 内 SELECT 计算；`DB_NOW_MS <= lease_expires_at_epoch_ms` 即 owner 仍有权限；
> 业务 evidence 时间（activated_at / file_durable_at / activation_requested_at / failed_at / validation_started_at）
> 保持 ISO 8601 文本但被冻结不得晚于 `DB_NOW_ISO`；
> fence 比较在 activation / dispatch / execution / renewal / takeover 全部 trigger 内 SELECT 计算，
> **不再**使用 caller-supplied `NEW.activated_at` / `NEW.created_at` / `NEW.observed_at`——
> §0/§2.2/§2.2b/§2.6/§2.9/§2.10）；
> ② **indeterminate entry evidence seal**（`voice_registry_publications` BEFORE UPDATE
> `trg_vrp_indeterminate_seal`：进入 indeterminate 的同一次 UPDATE 不得增删 evidence；
> `trg_vrp_indeterminate_shape`：OLD evidence shape 必须与 OLD.status 匹配——
> §2.9）；
> ③ **indeterminate exact-attempt resolution**（`voice_registry_publication_activations` 增加
> `CHECK (attempt >= 1)` + `activation_mode` 双态（normal_owner_finalize / indeterminate_reconciliation）
> + `resolution_evidence` + `resolution_evidence_hash`；resolve 时 `owner_token=NULL` +
> `attempt = publication.attempt` exact + `indeterminate_from_status='activation_pending'` +
> observed SHA = persisted candidate SHA——§2.10）；
> ④ **legacy cutover reachable：subject_mode 双路径**（`voice_registry_publications` 新增
> `subject_mode` 列 + 拆分 `subject_type`：`materialization_publish` /
> `legacy_cutover_publish`（publish_and_cutover）/ `legacy_cutover_existing`（cutover_existing）/
> `registry_rebuild`；`legacy_cutover_existing` 路径让已 published_usable projection 可被
> legacy mapping 收尾——避免 `mapped_verified + published_usable` 死路；
> 一对多由 `UNIQUE(mapped_voice_materialization_id) WHERE NOT NULL` 强制（一对一模式）——§2.8/§2.9）；
> ⑤ **materialization_publish 与 legacy mapping 互斥冻结**（publication INSERT 时
> `materialization_publish` subject 不允许被 legacy 已 mapped_verified/mapping_pending 引用——
> `materialization_publish blocked by legacy mapping` ABORT；legacy 走
> `legacy_cutover_publish` 或 `legacy_cutover_existing`——§2.9）；
> ⑥ **atomic claim/job execution coupling**（新增第 13 表 `tts_job_execution_transitions`
> append-only command：`UNIQUE(job_id)` + `UNIQUE(claim_id)`；单条 INSERT 原子同步
> claim/job status/owner/lease/heartbeat/result artifact；
> 直接 UPDATE job/claim.status 出 queued/generation_pending 一律 ABORT（`trg_tjs_command_required` /
> `trg_tsc_command_required`）——§2.2c）；
> ⑦ **voice identity compatibility freeze**（`tts_jobs.voice_profile_revision` legacy 兼容通道
> TTS-C 行 INSERT + UPDATE 由 `trg_tts_jobs_revision_compat` 强制
> `CAST(voice_profile_revisions.revision_number AS TEXT)=voice_profile_revision` 一致；
> immutable trigger 把它纳入写后冻结列——§2.0）；
> ⑧ **journal identity seal + generation uniqueness**（继承 R8：`voice_registry_publications.generation`
> DB-level UNIQUE；DB 仅保证唯一性，单调分配由应用层 `BEGIN IMMEDIATE` 序列化协议保证——schema 注释明确
> 不维护 sequence，不混称——§2.9）；
> ⑨ **可执行 SQLite contract 实证**（§2 全部为可直接转 migration 的真实 SQL，临时目录 sqlite3 3.45.1
> + Python sqlite3 实证：schema apply / foreign_key_check（空）/ integrity_check（ok）/ happy path
> 全链 / crash-retry 闭环 / legacy failed→rollback→新 publication→成功 / **legacy_cutover_publish +
> legacy_cutover_existing 双路径** / claim atomic dispatch / **claim/job atomic execution coupling** /
> mutation 验证全量 360 项——逐项计数见设计文档 §10.5；临时 SQL/DB 不入仓库）。
> R7/R8 的 publication journal、projection/publication 分离、无环 claim/job、result 封存、subscriber identity、
> initializing 状态、initial INSERT 冻结、exact voice identity、validation fencing、attempt 证据不可变、
> provenance 闭包、cutover journal、lease fencing 由 R9 继承并强化；
> R8 被独立 Review 判 FAIL 的 9 项阻断（A-I）全部关闭。
> 每阶段：独立 migration、独立 tests、独立 Review、独立 deployment gate、不跨阶段、不产生半成品 active 状态。

---

## 0. 总原则（R6 强化）

- **exact source 纪律**：全链路显式 artifact ID；禁止 current/latest/default。
- **mutable job ≠ immutable artifact**：`tts_jobs`（mutable execution）+ `sentence_audio_artifacts`（immutable result，trigger ABORT）；regeneration = 新 job + 新 artifact + 新文件。
- **synthesis reservation（可回收 + fenced）**：`tts_synthesis_claims` 是 active synthesis identity 的唯一 reservation（partial unique）；`validating_reuse` **Scheduler 永不 claim**；validating 阶段带独立 validation owner/lease/attempt；lease 过期 → fenced CAS 接管重验（不永久阻塞）；**finalization 必须 fenced**（§3.1 contract；`changes=0` → `STALE_VALIDATION_OWNER` 零副作用）；artifact usable 不建 job；unusable 才在 claim 保护下转 generation_pending + 恰好一个 queued job。
- **零 subscriber 语义**：最后 subscriber 在 validating_reuse 阶段取消 → 直接取消 claim 不建 job；generation_pending/running 阶段取消 → 才置 `job.cancel_requested=1`；**不允许创建 zero-subscriber provider job**；validator/cancel/takeover 三方竞争由事务串行单裁决。
- **共享 fan-in**：`tts_audio_requests` many-to-one → claim/job；成功/失败 fan-out 全部有效 subscriber；per-request cancel 仅 detach 该 envelope；**consumer 真相 = `WHERE result_artifact_id=:id`**（R6：producing claim_id 不是全量真相）。
- **persisted phases**：crash recovery 由 `tts_generation_attempts.execution_phase` 持久化真相驱动；**不得仅凭 status='running' 无条件 requeue**（TTS-C 行 trigger 禁止 running→queued；legacy 行隔离）；**attempt 证据 phase-aware write-once + 终态全冻结**（R6：`trg_tga_evidence`，`file_durable` 后字节证据不可改）。
- **relational provenance 闭包**：artifact 的 attempt∈job∈claim 由 composite FK + BEFORE INSERT trigger 数据库级强制；**artifact↔attempt 字节证据逐项一致**（R6：path/SHA/size/codec/sr/ch/duration/provider/model/canonical 全闭包）；content hash 一致性由 final transaction 内 **exact fenced reread 逐项比较**强制（R6 §8.2）。
- **原子成功终局**：文件（temp→校验→rename→fsync）先于 DB；单 BEGIN IMMEDIATE 内按冻结顺序 attempt→artifact→job→claim→requests 原子完成；任一步失败整事务回滚（attempt 恢复 file_durable）；cancel 优先。
- **crash-safe cutover**：stable view 与 candidate view 分离；**global registry publication journal（R8：第 10 表
  `voice_registry_publications` + 第 11 表 atomic activation command，一次一个 frozen subject，global active
  single-flight，activation 仅经单条原子 command）**；candidate 意图/证据持久化
  （非进程内状态）；active SHA 与 DB 可 reconciliation（按 journal subject 完成，不凭 per-key row）；未知 SHA fail-closed；
  **cutover journal 不可变**（字段按状态转换冻结写入权限；mapped_active 全冻结；旧 owner 不得原地改 candidate evidence）。
- **lease-expiry fencing**（R6 全量 + R7 publication）：所有 renewal（validation/materialization/publication）与
  finalize/T5 的 WHERE 必须含 `lease >= :now`；每个外部副作用步骤前 fenced verify/renew（changes=1）；
  过期未接管 → 旧 owner 不得 renewal/finalize/新副作用。
- **无环 claim/job + atomic dispatch + result 封存（R8）**：`tts_jobs.claim_id` 唯一权威（`uq_tts_jobs_claim`）；
  validating_reuse→generation_pending 仅经 `tts_claim_generation_dispatches` 单条原子 command（恰好一个 queued job，
  dispatch 失败 claim 保持 validating_reuse）；TTS-C job result row-state invariant（succeeded⇔result，INSERT+全 UPDATE）+ DELETE 禁；
  attempt/artifact 全链 voice/provider 一致。
- **initializing + waiting link closure（R8）**：tar/vmr envelope 先 `initializing`（占用 requestId、链接全 NULL、
  不计 subscriber）；`initializing → waiting` 必须同一事务完成 authoritative link（tar→claim_id exact identity /
  vmr→job_id exact identity，trigger 强制）；全部新表 BEFORE INSERT 冻结初始状态（terminal 直插全拒）。
- **零真实 provider 门禁**：自动化测试用临时 DB + Mock provider；真实 provider 仅人工验收命令。
- **单门禁入口**：每阶段新测试并入 `scripts/run-m7-quality-gate.sh`（suite 数递增）。
- **部署纪律**：exact-SHA build + 镜像内 gate + backup + compose up + invariants + docs evidence commit；禁手工 sqlite3。

---

## TTS-C.1A — Materialization requests/jobs/projection（实现到 `file_ready_unpublished`；R8 分离模型）

**scope**（设计文档 §2.5–2.7/§5/§6）：
- 三层表：`voice_materialization_requests`（project-scoped envelope：`project_id + UNIQUE(project_id, request_id)`；
  **R7-G `initializing` 状态**：占用 requestId、链接全 NULL、不计 subscriber；**R8-H waiting link closure**：
  initializing→waiting 必须同一事务完成 exact job 链接（`waiting requires job link` trigger）；R7-H INSERT 初始状态 initializing）
  + `voice_materialization_jobs`（含 `validating_existing` unschedulable + partial unique `uq_voice_materialization_jobs_active`；
  状态依赖 CHECK 冻结所有权语义；Scheduler 只领取 `queued`；R7-H INSERT 初始状态 validating_existing）
  + `voice_materializations`（`UNIQUE(profile, revision)`；**R7-B 状态仅 file_ready_unpublished/published_usable/failed/
  indeterminate，无 registry_pending**；`published_by_publication_id` 引用 §2.9；1A 止于 file_ready_unpublished）。
- **fenced single-flight 算法**：Phase 1（BEGIN IMMEDIATE：envelope-first → 查 projection + metadata hash → 查/建
  active job=validating_existing（validation owner/lease/attempt）→ 多 request 链接同一 job）→ 事务外 exact
  projection/file validator → Phase 3（BEGIN IMMEDIATE **fenced finalize**：usable → 全部未取消 request `reused` +
  job succeeded，**零文件写**；unusable → active subscriber=0 → fenced cancelled，否则 fenced → `queued`；
  `changes=0` → `STALE_VALIDATION_OWNER` 整事务回滚零文件写）→ Worker 才执行 temp copy。
- **stale validating recovery**：validation lease 过期 → fenced CAS 接管（attempt+1）→ 重跑 exact validator；
  lease renewal 仅当前 owner（token+attempt+status WHERE，旧 owner changes=0）。
- **1A durability 流程**：exact source validator → materialization claim（单 BEGIN IMMEDIATE）→ temp copy →
  SHA/codec/size 校验 → final rename + file fsync + dir fsync → **单事务 fan-out**（fenced 重读 job owner/lease/status +
  exact Voice Revision + 全部 active subscriber + identity/Assignment/project 自洽（任一 mismatch → 回滚 +
  REQUEST_STATE_INCONSISTENT）→ projection=file_ready_unpublished → job=succeeded → 全部未取消 request=succeeded +
  materialization_id）→ COMMIT。目标路径固定 voice-root-relative（`<profile_id>/<revision_id>/reference.wav`）。
- Worker 唯一 writer（Web 无 voice/registry 挂载、无文件写）；`/voice-config` 目录挂载。

**R8 边界（1A 明确不包含）**：**不得创建半成品 registry publication**——`voice_registry_publications`（§2.9）与
`voice_registry_publication_activations`（§2.10）两张表结构在 1A migration 中就位（含 global active single-flight、
generation UNIQUE、subject INSERT 验证、atomic activation trigger），但 1A 不写任何 publication/activation 行
（publisher 集成属 1B）；projection 保持 `file_ready_unpublished`，**激活只能经 1B 的单条 atomic activation
command**，1A 无任何写 `published_usable` 的路径。

**tests**（设计文档 §10.2/§10.3/§10.5/§10.6 落地）：请求幂等/conflict（同 scope 同 requestId 异 source 409）；
并发两 requestId 单 job；validating_existing Scheduler 不 copy；usable 零文件写；不可用恰好一个 queued；
两 Worker claim 唯一 running owner（MF-5）；fan-out 原子（无部分成功）；stale validating CAS 不永久阻塞（MF-1/2）；
零 subscriber 不建 job（MF-6）；pair mismatch/project mismatch/非法状态组合 ABORT（PC-4/5/6）；
orphan 清理（不得删 DB 已引用）；archive 语义（历史 Assignment 授权可 materialize）；路径 containment；
initializing 不计 subscriber（SL-08）；vmat/vmr/vmjob 初始状态直插拒绝（INIT）；1A 无 publication 行（RP-00 断言 count=0）。

**not included**：registry 发布（1B）、adapter reload（1B）、capability（1C）、TTS 合成（C.2）；API 不声称 adapter ready；TTS dispatch 不可用。

**deployment gate**：materialize 不触发合成；production 可安全部署（voice-library 仍 0/0，无 materialize 动作；
`voice_registry_publications` 0 行）。

## TTS-C.1B — Legacy crash-safe cutover + global publisher + adapter reload/activation ack

**scope**（设计文档 §2.8/§7）：
- **legacy shadow + crash-safe cutover**：`legacy_adapter_voice_entries` 5 态 + cutover 列
  （owner/lease/attempt + **R8-A/B retryable link**：`pending_publication_id`（T1 fill / rollback clear，仅引用
  failed/cancelled publication 才可清空）+ `candidate_source_selector` + `candidate_activated_at`；
  **无 candidate generation/SHA 权威重复列**——pending/current evidence 统一经 pending_publication_id → journal）；
  **stable/candidate 双 view**（stable：unmapped/mapped_verified/mapping_pending → legacy，mapped_active → TTS-A，
  retired → 不输出；candidate：仅 pending key 用 TTS-A）；**每个 canonical key 恰好一个 source**（冲突 fail-closed）；
  映射等价性验证 6 项通过才 `mapped_verified`（**R8-C 前置：mapped materialization=file_ready_unpublished**）；
  不伪造 TTS-A 数据。
- **cutover 协议 T1-T5**（设计文档 §7.3）：持久化 candidate 意图（mapping_pending + pending_publication_id）→
  写 candidate registry（temp/fsync/rename/dir-fsync）→ adapter reload → poll active SHA →
  **R8-D 单条 atomic activation command**（一条 `voice_registry_publication_activations` INSERT 原子完成
  fencing + projection→published_usable + legacy→mapped_active + publication→active；任一 mismatch 整体 ABORT）。
- **crash reconciliation 6 点矩阵**（设计文档 §7.4）：含 LKG 保持 legacy、stale cutover owner fenced CAS 接管、
  未知 SHA fail-closed（不 retire legacy、不错误标 published_usable）。
- **global registry publisher**：全局发布锁 + DB 全量确定性重建 + temp/fsync/rename/dir-fsync；registry 文档含
  `registryGeneration + publisherSchemaVersion`；cutover 前后 legacy 集合与 SHA 完全保持。
- **adapter hot reload + LKG health**：mtime/inode/size 检测 → 原子加载 → swap → 失败保持 LKG
  （ready=true/degraded=true/detail=VOICE_REGISTRY_PUBLISH_FAILURE）；无 LKG → ready=false + 503；
  Docker healthcheck 视 LKG degraded 为 healthy。

**tests**：真实 Python parser/reloader + mock upstream；mapping 状态机（5 态全矩阵 + 每 key 单 source 断言）；
cutover crash 矩阵 CC-1…CC-6（设计文档 §10.4）；cutover 全等性；activation 轮询；LKG/degraded/empty 矩阵；
**R8 新增**（设计文档 §10.7）：LR-01…05（retryable legacy link）、PA-01…08（atomic publication activation）、
PE-01…04（indeterminate evidence closure）。

**not included**：capability compiler（1C）、TTS 合成（C.2）。

**deployment gate**：adapter 镜像变更需 exact-SHA 重建 + 镜像内 gate + 部署；production 仍零合成。

## TTS-C.1C — Provider capability snapshot/compiler

**scope**（设计文档 §12 capability neutral matrix）：capability snapshot 固化与执行前比对；capability compiler
纯函数——neutral 默认值 → supported no-op（unsupportedFlags=[]）；非 neutral 无通道 → explicit unsupported
（不静默丢弃）；编译结果进 provenance + `synthesisPayloadFingerprint`。

**tests**：neutral 矩阵全 unit 不 block；非 neutral 全矩阵；compiler 版本化。

**not included**：materialization（1A）、registry/cutover（1B）、TTS 合成。

**deployment gate**：纯函数 + 快照存储，production 零合成。

## TTS-C.2 — Request envelope + synthesis claim + durable job + persisted attempt + immutable artifact

**scope**（设计文档 §2.0–2.4/§3/§4/§8）：
- 新表：`tts_audio_requests`（**R8-H**：initializing→waiting 必须 exact claim 链接，`waiting requires claim link`）、
  `tts_synthesis_claims`（fenced reclaimable validation：§3.1 contract + takeover CAS + fenced renewal + 三方竞争单裁决）、
  **`tts_claim_generation_dispatches`（R8-F 第 12 表）**（append-only atomic dispatch command：单条 INSERT 原子完成
  fencing + subscriber>0 + 恰好一个 queued job + claim→generation_pending；UNIQUE(claim_id)；generation_pending
  无 dispatch 的状态迁移 ABORT）、
  `tts_generation_attempts`（persisted phase + 全矩阵 trigger）、
  `sentence_audio_artifacts`（immutable；**relational provenance 闭包**：composite FK + BEFORE INSERT trigger）。
- `tts_jobs` 纯增量迁移（ADD COLUMN×7 + 2 unique index + trigger 组；零 rebuild；legacy 行 WHEN 隔离）；
  **R8-G row-state result invariant**（INSERT+全 UPDATE：succeeded⇔result_artifact_id；result artifact job/claim 一致）；
  **R8-I immutable identity seal**（narration_plan_artifact_id/narration_plan_version/payload_json/provider/
  voice_profile_id/voice_profile_revision_id 创建后不可改；payload_json 与 frozen synthesis payload fingerprint exact 对应）；
  `output_path/duration_ms/audio_sha256/result_json` 降级 legacy 兼容。
- **unschedulable reuse reservation 算法**（三阶段 + fenced finalize，设计文档 §3）；
  **validating 阶段取消语义**（§4：零 subscriber → cancelled 无 job；cancel 优先单裁决）；
- **共享 fan-in** + **per-request cancellation 矩阵**；
- **persisted recovery phases** + **indeterminate resolution**（不自动重调；显式 resolve）；
- **原子成功终局 6 步顺序**（§8.2；任一失败整事务回滚，attempt 恢复 file_durable；无部分成功；cancel 优先）；
- fingerprint 三分离实现。

**tests**（设计文档 §10.1/§10.3/§10.5/§10.7 落地）：VF-1…5（fencing/接管/续租/三方竞争）；reuse reservation 竞态
（Scheduler provider=0；usable 零新 job；damaged 恰好一个 queued）；fan-in/fan-out/单请求取消矩阵；
PC-1…7（provenance ABORT 矩阵）；phase recovery 矩阵；原子终局（五者一致 + 回滚恢复 file_durable）；
attempt trigger（immutable/phase 禁倒退/终态无出边）；非法状态组合 CHECK；fingerprint 矩阵；零真实 provider；
**R8 新增**：CJ-09…13（exact-one atomic dispatch）、EN-01…05（envelope waiting link closure）、
JR-01…05（job row-state result invariant）。

**not included**：preview/selection（C.3）、manifest/master（C.4）、subtitle timing v2（C.5）。

**deployment gate**：可部署；production 不 enqueue 任何 TTS job（新增=0 不变量保持）。

## TTS-C.3 — Preview/override/variant/A-B/selection

**scope**：preview（同一合成路径 + preview 标记；selection=null）；A/B（显式 variant/seed/override artifact——
adapter 无 variation 通道时禁止同请求伪造 A/B）；selection 持久化（selectedAudioArtifactId 只引用 immutable
artifact/overrideRequestId/reviewedBy/reviewedAt/source/bulk/unit override）；失效规则（局部失效，禁 full
regeneration）；review lock（source 漂移 → stale fail-closed）。

**tests**：A/B 不覆盖旧 artifact；失效矩阵逐项；override provenance；lock 漂移 stale；零真实 provider。

**not included**：manifest/master/subtitle。

**deployment gate**：selection 不影响既有管线；production 零 TTS job 不变量保持。

## TTS-C.4 — Selection manifest + immutable master audio + ffprobe

**scope**：`narration_audio_selection_manifest@2.0` artifact（不含 master 信息；ordered units + selected immutable
artifact IDs + SHA/duration/fingerprint + silence/gap + reviewSource；逐 index 对齐校验）；
`narration_master_audio@1.0` immutable artifact（masterInputFingerprint 非循环）；顺序：selected immutable manifest →
durable master temp/write/probe/rename/fsync → immutable master artifact DB commit；master 拼接实现决策
（Node PCM concat vs ffmpeg concat）。

**tests**：manifest 对齐/缺失/重复/stale artifact；master 失败不覆盖旧；时长防线 ±100ms；ffprobe 实测断言。

**not included**：subtitle timing v2。

**deployment gate**：v2 manifest/master 不接 UI；production 零 TTS job 不变量保持。

## TTS-C.5 — Subtitle timing v2/reconciliation/stale graph/review UI

**scope**：`subtitle_timing_v2` artifact 层 + `timing-reconciliation@2.0` 接入 DAG；Review UI（Voice Assignment /
Performance / Sentence Audio / Master / Timing review 节点 + preview/A-B/accept/reject/bulk/lock/stale 提示/
failed-retry/cost-usage）；**production acceptance gate**：人工验收命令（真实 IndexTTS2）独立于 CI。

**tests**：stale 传播矩阵；UI 只读 smoke；DAG 状态机。

**deployment gate**：验收前 production 不产生业务 TTS 数据。

---

## 阶段门禁与禁止

| 阶段 | 独立 migration | 独立 tests | 独立 Review | deployment gate | 半成品 active | production 真 provider |
|---|---|---|---|---|---|---|
| 1A | ✓ | ✓ | ✓ | ✓ | ✗（止于 `file_ready_unpublished`，API 不声称 ready） | ✗ |
| 1B | ✓ | ✓ | ✓ | ✓ | ✗（cutover 全等 + crash 矩阵后才切换 publisher） | ✗ |
| 1C | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| C.2 | ✓ | ✓ | ✓ | ✓ | ✗（claim reservation + 原子终局，不产半成功） | ✗ |
| C.3 | ✓ | ✓ | ✓ | ✓ | ✗（preview/selection 显式动作） | ✗ |
| C.4 | ✓ | ✓ | ✓ | ✓ | ✗（master 显式构建） | ✗ |
| C.5 | ✓ | ✓ | ✓ | ✓ | ✗ | 仅人工验收命令 |

## 依赖顺序（R9 DAG，取代 R5/R8 的 1A→1B→1C 链）

```text
R9 PASS
├─ 1A ∥ 1C            （可并行开发：不同 worktree/local branch）
└─ 1B-prep            （adapter parser/reloader 测试骨架可并行准备）

1A PASS
→ 1B publisher integration（依赖 1A 的 DB projection + legacy cutover 表）

1A + 1B + 1C PASS
→ C.2（claim/fan-in/persisted phases + execution_transitions 依赖三者 schema 齐备）

C.2 PASS
→ C.3 → C.4 → C.5（runtime 串行；仅 schema/mock/test planning 可提前并行）
```

更新 1A/1B/C.2 schema 边界以采用 R9 contract（epoch_ms lease + DB_NOW_MS fence + indeterminate entry
evidence seal + activation_mode + resolution_evidence_hash + subject_mode 双路径 +
execution_transitions atomic command + voice_revision compat closure）。

**建议首先实现**：**TTS-C.1A**（零音频风险、解锁 materialization、为 1B cutover 提供 DB 基础）——但 1A 未开始，
须待本 R9 独立 Review PASS。

## 并行开发矩阵（冻结：并行开发，串行集成/Review/部署）

| lane | 并行度 | 说明 |
|---|---|---|
| 1A 与 1C | **可并行开发** | 不同本地 worktree/local branch（1A materialization schema/durability；1C capability compiler 纯函数） |
| 1B adapter parser/reloader 测试骨架 | **可并行准备** | 只写 adapter 侧测试骨架；publisher integration 等 1A PASS |
| 1B publisher integration | 串行 | 依赖 1A PASS |
| C.2 | 串行 | 等 1A/1B/1C 全部 PASS |
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

> 注：materialization schema、request envelope、validation/cutover fencing、crash-safe cutover 协议、
> relational provenance 闭包、attempt/materialization/cutover 证据不可变与全部状态机已在
> `docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md`（R8）以可执行 contract 冻结，不再属于"进入 1A 后再决定"项。
