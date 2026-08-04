# TTS-C Incremental Narration 架构设计（TTS-C.0.R12 修订，只读审计，未实现）

> 状态：**TTS-C.0.R12 architecture revision completed；pending independent Review；
> TTS-C runtime implementation not started；TTS-C.1A / 1B / 1C not started**。
> 本文档是只读架构审计产物（R12 修订）：不修改 runtime code / schema / config / migration / compose。
> 运行时真相以真实代码为准（审计基线 m7 @ `f8a9928`；TTS-A final code `1460efd…`、TTS-B final code `86f7f52…` 均已 FROZEN）。
> R9/R10 独立 Review = **FAIL**（R10/R11 分别关闭其 FAIL 发现）；**R11 独立 Review = FAIL**；R12 关闭其对 R11 的
> FAIL 发现（全部 docs-only，零 runtime/零 migration/零 schema 变更）：
> **P0-C（R12 核心）**（historical command replay：R11 per-column fence 用"EXISTS 任意历史 command 行、
> 其字段值等于 NEW"授权直接 UPDATE——command 表 append-only，历史 worker_claim/renewal/takeover/
> state_transition 行永久存在：可先 worker_claim w1 → takeover w2，再直接
> `UPDATE claim.owner_token='w1'` 被历史行错误放行，形成 claim owner=w1 / job owner=w2 的
> split-brain；同样可复活 terminal owner、回退 attempt/lease/heartbeat/error 证据）；
> **P0-A**（owner/lease/attempt 无唯一原子入口：R10 只保护 status，`owner_token / lease /
> validation_attempt / claimed_by / claimed_at / heartbeat_at / attempt / started_at / finished_at`
> 仍可被两条无 command 的应用 UPDATE 直接改写，claim/job owner 可 split、attempt 可伪造）、
> **P0-B**（`queued/generation_pending → failed/cancelled` 状态边存在但无合法 command，不可达）、
> **P1-A**（runner 无真实事务能力：PyEngine 每次 exec 自动 commit、CLI 每次新进程，无法测试
> BEGIN IMMEDIATE 跨语句回滚）、**P1-B**（27-suite M7 gate 不含 TTS-C contract，CI 未真正绑定
> contract）。R10 已实证正确的部分（database-time fencing、indeterminate seal/resolve、双路径 cutover、
> worker_claim/state_transition 生命周期、voice identity、dispatch/activation 原子性）全部保留不回退：
> **P0-1**（execution transition 第一条 command 因 owner 死锁永不可执行）、**P0-2**（`UNIQUE(job_id)`/
> `UNIQUE(claim_id)` 阻断完整生命周期）、**P0-3**（`legacy_cutover_existing` 不可达）、
> **P1-1**（360 证据口径不可追溯且与实施报告 23/29 矛盾）、**P1-2**（retired entry 实际仍占活跃唯一位，
> 与注释矛盾）及全部 P2 文档一致性问题。R9 已实证正确的部分（database-time fencing、indeterminate
> entry seal + exact-attempt resolve、publish_and_cutover、rollback/retry、activation/dispatch 原子性、
> voice identity、SM 联合判定）全部保留不回退：
> ① **database-time lease fencing**（所有 lease 列统一改为 `lease_expires_at_epoch_ms INTEGER`：
> `tts_synthesis_claims.lease_expires_at_epoch_ms` / `validation_lease_expires_at_epoch_ms`、
> `voice_materialization_jobs.lease_expires_at_epoch_ms` / `validation_lease_expires_at_epoch_ms`、
> `voice_registry_publications.lease_expires_at_epoch_ms`；**权限判断时间 = SQLite 数据库当前时间**
> `DB_NOW_MS = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`（trigger 内 SELECT 计算），
> `DB_NOW_MS <= lease_expires_at_epoch_ms` 即 owner 仍有权限（**含等值**）；过期判定 =
> `lease_expires_at_epoch_ms < DB_NOW_MS`（**严格小于**）；`julianday` 浮点 → epoch ms 的 CAST 截断
> 在边界存在最多约 1ms 的**保守**误差（只可能提前判过期，绝不宽限——实证 drift ∈ {-1, 0}）；
> 激活/分派/执行 fencing 在 trigger 内**不再使用** `NEW.activated_at` / `NEW.created_at` /
> `NEW.observed_at` 等业务 evidence 时间；**业务 evidence 时间**（`file_durable_at` /
> `activation_requested_at` / `activated_at` / `failed_at` / `validation_started_at` /
> `claimed_at` / `heartbeat_at`）保持 ISO 8601 文本，但被冻结：不得明显晚于
> `DB_NOW_ISO = strftime('%Y-%m-%dT%H:%M:%fZ','now')`（trigger BEFORE INSERT/UPDATE 强制，否则
> `evidence timestamp in future` ABORT）；外部 I/O 即使在 lease 到期前完成，commit 时若 DB
> 当前时间已越期，fenced UPDATE/command 一律不命中，旧 owner 零副作用——takeover/reconciliation owner
> 重新裁决）；
> ② **indeterminate entry evidence seal**（`voice_registry_publications` 增加 BEFORE UPDATE 触发器
> `trg_vrp_indeterminate_seal`：当 `NEW.status='indeterminate' AND OLD.status!='indeterminate'` 时
> `candidate_registry_sha256 / candidate_manifest_json / candidate_manifest_sha256 /
> file_durable_at / activation_requested_at` 必须与 OLD 逐项相等——不得在进入 indeterminate 的同一
> UPDATE 中新增、修改或清除证据；只允许修改 `status / indeterminate_from_status / owner_token /
> lease_expires_at_epoch_ms / error_code / error_message / updated_at`；
> 进入 indeterminate 时额外校验 OLD evidence shape：
> `building` 时 candidate/manifest/file/activation 全 NULL；
> `candidate_persisted` 时 candidate/manifest 非 NULL、file/activation NULL；
> `file_durable` 时 candidate/manifest/file 非 NULL、activation NULL；
> `activation_pending` 时 candidate/manifest/file/activation 全非 NULL）；
> ③ **indeterminate exact-attempt resolution**（`voice_registry_publication_activations`：
> 新增 `CHECK (attempt >= 1)`；新增 `activation_mode` 列 + CHECK 冻结两态：
> `normal_owner_finalize` 时 `owner_token` 非 NULL、`resolution_evidence` 可 NULL；
> `indeterminate_reconciliation` 时 `owner_token` NULL、`resolution_evidence` 非 NULL、
> `resolution_evidence_hash` 非 NULL、`command.attempt` 必须等于 `publication.attempt`、
> `publication.indeterminate_from_status='activation_pending'`、`observed SHA` 等于
> persisted candidate SHA；
> trigger 在同一 statement 内同时校验 attempt 精确匹配与 resolution_evidence 完备，任一不满足
> ABORT 整条回滚——indeterminate resolve 与 normal finalize 共享唯一 activation command 入口，
> 但 mode 决定 owner/evidence 语义）；
> ④ **legacy cutover reachable：mapping_mode 双路径（R10 修复 P0-3）**（`legacy_adapter_voice_entries`
> 新增 `mapping_mode` 列（`'publish_and_cutover' | 'cutover_existing'`，unmapped→mapped_verified 时
> 写入、写后不可改）；`voice_registry_publications.subject_mode` 与 `subject_type` 联合判定保留：
> **路径 A publish_and_cutover**：`mapping_mode='publish_and_cutover'` + `projection.status=
> 'file_ready_unpublished'` + 无 active-flight `materialization_publish` 在飞（确定性竞争裁决），
> 激活路径 = projection → published_usable + legacy → mapped_active + publication → active；
> **路径 B cutover_existing**：`mapping_mode='cutover_existing'` + `projection.status=
> 'published_usable'` + `published_by_publication_id` 非 NULL，激活路径 = projection 保持
> published_usable（**projection publication evidence 零修改**）+ legacy → mapped_active +
> publication → active；publication INSERT 时 entry 必须为 `mapped_verified`（随后 entry 才转
> mapping_pending 指向本 publication——解除 R9 的 mapping_pending 前置死锁）；
> `trg_vrp_subject` 按 `mapping_mode` 校验 projection 状态匹配；`mapped_verified` 后普通
> `materialization_publish` 仍被互斥冻结 ABORT；publication 先完成后导入的 legacy entry 走
> cutover_existing，消除 `mapped_verified + published_usable` 不可达组合）；
> ⑤ **materialization_publish 与 legacy mapping 互斥冻结 + 竞争裁决**（publication INSERT：
> `subject_type='materialization_publish'` 的目标 projection 被 legacy entry 以
> `mapping_status IN ('mapped_verified','mapping_pending')` 引用 → ABORT
> `materialization_publish blocked by legacy mapping`（情况 1）；projection 已普通发布后导入的
> legacy entry 允许 `mapping_mode='cutover_existing'`（情况 2）；active-flight
> `materialization_publish` 在飞时建立 `publish_and_cutover` 映射 → ABORT
> `legacy_adapter_voice_entries projection publication in flight`（情况 3 确定性裁决：
> 待 publication 完成后改走 cutover_existing））；
> ⑥ **atomic claim/job execution transition（R10 重写，修复 P0-1/P0-2）**（第 13 张权威表
> `tts_job_execution_transitions`（append-only command）：显式 `command_kind` 双态——
> **worker_claim**（首次 ownership establishment：`claim generation_pending（owner NULL）+
> job queued（claimed_by NULL）→ 双侧 running`，不验证旧 owner 相等，验证双方无 owner +
> exact relation + command lease > DB_NOW_MS + attempt = claim.validation_attempt，一条 statement
> 同步写入 `claim.owner_token/lease` 与 `job.claimed_by/claimed_at/heartbeat_at/attempt/started_at`）；
> **state_transition**（`running/indeterminate → succeeded/failed/cancelled/indeterminate`，
> owner fencing：`claim.owner_token = job.claimed_by = command.worker_owner_token` +
> claim lease >= DB_NOW_MS + 双侧 attempt exact；`→indeterminate` 保留双侧 owner/lease 供
> resolve fence 与 §3.6 execution takeover（R11 起为 execution_takeover command），终态清空）；
> 幂等模型：`transition_request_id UNIQUE` + 语义防重
> `UNIQUE(job_id, from_job_status, to_job_status, worker_attempt)`——同一 job 的多阶段 command
> （`queued→running→succeeded/…`）可连续写入，完全相同的 replay 唯一拒绝，**不再使用**全生命周期
> `UNIQUE(job_id)`/`UNIQUE(claim_id)`；
> 显式四状态冻结 `from_claim_status/to_claim_status/from_job_status/to_job_status`（状态对必须相等，
> 分裂状态不可提交）；`trg_tjs_command_required`/`trg_tsc_command_required` 扩展为**全部** TTS-C
> 状态迁移必须存在精确匹配（from,to）的 command 行，直接 UPDATE 一律 ABORT）；
> ⑦ **voice identity compatibility freeze**（`tts_jobs.voice_profile_revision`（legacy 文本列）：
> Worker/adapter 真实**仍读取**该列（沿用 TTS-B/M7.1 兼容通道，`src/worker/tts-executor.ts`），
> R9 选**方案 1**——TTS-C 行写入时 `trg_tts_jobs_revision_compat` BEFORE INSERT + BEFORE UPDATE 强制：
> `voice_profile_revision_id` 与 `voice_profile_revision` 双向一致（同事务重读
> `voice_profile_revisions.id = NEW.voice_profile_revision_id` 的 `revision_number`，必须等于
> `NEW.voice_profile_revision` 字符串表达；否则 `voice_profile_revision compat mismatch` ABORT）；
> TTS-C 行 `voice_profile_revision` 一经写入即冻结（immutable trigger 扩展）；
> 不允许 `voice_profile_revision_id = A, voice_profile_revision = B` 漂移；
> `VOICE_PROFILE_REVISION_COMPAT_PROVIDER`（生成 `revision_number` 字符串表达）的应用层
> helper 与 DB trigger 共同承担闭包责任，legacy `tts_jobs.voice_profile_revision` 列保留为
> 兼容通道但被 TTS-C 写一致性冻结）；
> ⑧ **journal 与 job identity seal**（继承 R8 + R9）：
> `voice_registry_publications.generation` **DB-level UNIQUE** 保证不重复；单调分配由应用层
> 在 `BEGIN IMMEDIATE` 事务内 `SELECT COALESCE(MAX(generation),0)+1` 完成——DB 仅保证唯一性，
> 单调性由应用层 `BEGIN IMMEDIATE` 序列化协议保证（schema 注释明确：DB 不维护 sequence；
> 文档表述 = DB 保证唯一 + 应用 BEGIN IMMEDIATE 保证单调，不混称）；
> `tts_jobs` TTS-C 行 immutable 字段补充 `narration_plan_artifact_id /
> narration_plan_version / payload_json / provider / voice_profile_id`；
> `voice_profile_revision` 由 ⑦ 加入 TTS-C immutable；
> `payload_json` 必须在 job 创建时与 frozen `synthesis_payload_fingerprint` exact 对应
> （应用层同事务验证，SQL 不可计算），创建后不可改）；
> ⑨ **R8 9 项阻断（A-I）继承**：retryable legacy publication link / single-source candidate evidence /
> atomic publication activation / indeterminate evidence closure / exact-one claim dispatch /
> TTS job result row-state invariant / envelope dependency closure / generation UNIQUE /
> 可执行 SQLite contract 实证——由 R10 强化并在 §10.5 计数 + §10.8 R10 矩阵新增回归；
> **可复跑 evidence 入库**（`docs/evidence/tts-c-r10/`：extraction + runner + 测试 + 两引擎原始输出——
> 只从本文档 §2 提取 SQL，不维护手写 schema 副本，计数可追溯）。
> R5/R6/R7/R8 的 validation finalization fencing、可执行 contract、relational provenance 闭包、
> attempt 证据不可变、cutover journal、lease-expiry fencing、global publication journal、
> 无环 claim/job 关系由 R9/R10 继承并强化。

---

## 0. 本文档是唯一权威 schema contract（R7 起完全可执行）

最终表 13 张：`tts_audio_requests`、`tts_synthesis_claims`、`tts_jobs`（现有表纯增量迁移）、
`tts_generation_attempts`、`sentence_audio_artifacts`、`voice_materialization_requests`、
`voice_materialization_jobs`、`voice_materializations`、`legacy_adapter_voice_entries`、
`voice_registry_publications`（global registry publication journal）、
**`voice_registry_publication_activations`（R8 新增第 11 表：append-only atomic activation command）**、
**`tts_claim_generation_dispatches`（R8 新增第 12 表：append-only exact-one claim dispatch command）**、
**`tts_job_execution_transitions`（R9 新增第 13 表；R10 重写：append-only atomic claim/job execution coupling command，双 command 语义 + 全生命周期多 transition）**。
§2 每个表给出**可直接转成 migration 的完整 SQL**（实施者逐字转写，不得跨历史 commit 拼接、不得改写约束语义）。

**§2 SQL 的基座前提（R10 明确）**：§2 是面向**既有真实 DB** 的 migration contract——`tts_jobs` 为
既有表（§2.0 纯 ADD COLUMN，既有真实列见 §2.0 清单），FK 父键 `projects / artifacts / voice_profiles /
voice_profile_revisions` 为既有 TTS-A/B 表（真实 DDL 见 `src/lib/db.ts`）。因此"从 §2 提取 SQL 重建
临时 DB"必须先建立这些**既有基座表**（evidence runner 内的最小基座 fixture 即按 §1/§2.0 与
`src/lib/db.ts` 逐列构造），§2 自身不含这些表的 CREATE 语句。

**R9 database-time fencing 全局约定**（§2 全部 lease 列统一）：

```sql
-- 所有 lease 列类型：INTEGER (epoch milliseconds, UTC)
-- 触发器内权限判断时间（SELECT 计算，触发求值时刻取 DB now）：
DB_NOW_MS = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
DB_NOW_ISO = strftime('%Y-%m-%dT%H:%M:%fZ','now')
-- fencing 模板：DB_NOW_MS <= lease_expires_at_epoch_ms 即 owner 仍有权限
-- evidence 时间上限：file_durable_at / activation_requested_at / activated_at /
--   failed_at / validation_started_at <= DB_NOW_ISO（trigger 强制，否则
--   `evidence timestamp in future` ABORT）
```

**SQLite 执行规则（实证于 sqlite3 3.45.1 + Python sqlite3，runner 与原始输出入库 `docs/evidence/tts-c-r10/`）**：

- `RAISE(ABORT, ...)` 的错误消息**必须是字符串字面量**（SQLite 不接受表达式拼接）；冻结错误文本格式为
  `'<table> invalid transition'` / `'<table> immutable field'` / `'<table> delete forbidden'` / provenance 专用文本；
- `ALTER TABLE ... ADD COLUMN` 允许带 `REFERENCES`（default NULL）与 `CHECK`（既有行必须全部通过；
  legacy `tts_jobs` 行新列全 NULL，CHECK 恒通过）——**`tts_jobs` 迁移零 table rebuild**；
- FK 在**每个连接**需 `PRAGMA foreign_keys=ON`（应用层责任；migration 不含 PRAGMA）；
- composite FK 的父键允许是 UNIQUE INDEX（不必是 PK）；子表列含 NULL 时该 FK 跳过检查；
- UNIQUE INDEX 中 NULL 互不相等（legacy 行 `final_tts_input_fingerprint` 为 NULL，不受 partial unique 影响）；
- fencing 比较 NULL 候选必须用 `IS`（如 `candidate_artifact_id IS ?`），`=` 对 NULL 恒不成立；
- SHA CHECK 必须 `length(x)=64 AND x NOT GLOB '*[^0-9a-f]*'`（长度+小写 hex 双重，不允许只验长度）；
- 路径 CHECK（DB 层边界）：拒绝 absolute（`LIKE '/%'`）、traversal（`..` 段）、backslash ambiguity（`GLOB '*\*'`）；
  **reader 层边界**（事务外 authoritative reader）才执行 resolve/realpath/regular-file/non-symlink/root containment——
  两层职责分离，DB 不做 realpath，reader 不做 DB 约束；
- BEFORE INSERT/UPDATE trigger 先于 FK 与 CHECK enforcement 执行（跨表 trigger 是第一道，composite FK/CHECK 是第二道）；
- 同表多 trigger 按**创建逆序**触发（后创建的先触发；实证于 3.45.1）——列限定 `UPDATE OF x` 与通用 `UPDATE` 混合时，
  冻结行为以实证消息为准（替换 result/job 链接时 link/identity trigger 先于 immutable 报 ABORT，均为合法拒绝）；
- `NOT NULL` / CHECK 与 BEFORE INSERT pair/validation trigger 同时拦截同一非法值时的冻结消息以 trigger 为准
  （trigger 先于约束 enforcement；如 `voice_materialization_jobs` 源字段 NULL 报 `source identity mismatch`，
  artifact 字节/格式同时违规时报 provenance 消息，constraint 为第二道防线）。

---

## 1. 现有真实状态（TTS-C 起点）

### 1.1 Voice Library（TTS-A，FROZEN `1460efd…`）

- `voice_profiles`：`id / schema_version('voice-profile@1.0') / display_name / provider('indextts2') / status(active|archived) / created_at / updated_at`。
- `voice_profile_revisions`（trigger ABORT 不可变）：`id / schema_version / voice_profile_id / revision_number / request_id / provider / adapter_compatibility_key / original_audio_sha256 / canonical_audio_sha256 / original_filename_display / canonical_audio_path / codec / sample_rate / channels / duration_ms / transcript / language / metadata_json / request_fingerprint / created_at`，`UNIQUE(voice_profile_id, revision_number)` + `UNIQUE(voice_profile_id, request_id)`。
- canonical 文件：`voice-library/<pid>/<rid>/reference.wav`；canonical 参数冻结：WAV / pcm_s16le / mono / 48000Hz；`validateVoiceProfileRevisionExact` 单一真相源。
- **archive 语义（冻结）**：archive 不删除 revision、不使历史 Assignment 失效；仅禁止新建 Assignment/新 revision。TTS-C 表**不复制此判断**（DB trigger 只验证 profile/revision exact pair 存在；archived profile 的 historical materialize/synthesize 合法）。

### 1.2 TTS-B（FROZEN `86f7f52…`）

- `voice_assignment_requests` envelope；`project_voice_assignment` artifact（exact 双 ID，artifacts 表 kind=`project_voice_assignment`）；`narration_performance_plan` artifact（三层 source 自洽，kind=`narration_performance_plan`）；`narration_plan_v2` artifact；`generation_runs/attempts/dispatch_jobs`。
- 真实 `artifacts` 表：`id / project_id / kind / version / content_json / file_path / created_at`（**无 content_hash / schema_version 列**）——
  artifact content hash 由应用层 canonical JSON sha256 计算（SQL 内不可计算，见 §2.4 边界说明）。

### 1.3 现有 TTS job 体系（M3-B / M7.1；TTS-C 中降级）

- `tts_jobs`（现有列，真实 schema 见 §2.0）含 `output_path/duration_ms/audio_sha256/result_json`（legacy 兼容）；worker `tts-executor.ts`；`recoverStaleTtsJobs`（legacy requeue 语义保留，**不得用于 TTS-C 无条件 requeue**；TTS-C 行 `claim_id IS NOT NULL`，由 trigger WHEN 守卫隔离）。

### 1.4 IndexTTS2 Adapter（`server.py`）

- `/v1/synthesize` 仅 `text + voiceProfile@voiceRevision + useRandom=false + emotion='none'`；registry 启动加载一次；拒绝 `voices=[]`；containment + `_check_voice`；materialization API 不存在。

### 1.5 官方实现对照（R11 只读参考审计）

编码前对 SQLite / Temporal / BullMQ 的**官方文档与官方仓库**做只读对照，只为 owner/lease fencing、
same-state renewal/takeover、append-only transition evidence、prestart cancellation/failure、crash
recovery 找借鉴点。不引入任何新依赖，不做分布式改造。

**SQLite（官方 [Transaction](https://www.sqlite.org/lang_transaction.html) /
[CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html)）**

- 借鉴：`BEGIN IMMEDIATE` 立即取写锁、单写者串行化（§3.4 三方竞争依赖此）；`RAISE(ABORT,...)`
  在 trigger 内终止当前 statement（同 statement 内已做变更随该 statement 回滚，触发整条 command
  INSERT 原子性）；`UPDATE OF col` 触发器只在该列出现在 SET 子句时触发（per-column fence 基础）；
  FOR EACH ROW 仅行级 trigger；3.45.1 下 `RAISE` 消息必须是字符串字面量（本文档冻结规则一致）。
- 不兼容/边界：`RAISE(ABORT)` 只回滚当前 statement，不回滚整个显式事务——应用多语句事务
  （§8.2 原子成功终局）任一步失败必须显式 `ROLLBACK` 整事务（冻结流程已含）；`BEGIN` 不嵌套
  （同事务内二次 BEGIN 报错，测试必须用单一 BEGIN IMMEDIATE）。

**Temporal（官方 [Activity Heartbeats](https://docs.temporal.io/encyclopedia/activity-heartbeats) 语义）**

- 借鉴：长时间 Activity 必须周期 heartbeat，错过 heartbeatTimeout 即视为失联可被重试——等价于知影
  lease 过期 + `execution_takeover`（attempt+1）；heartbeat 只延长 lease、不改变 task 身份。
- 不兼容：Temporal 用事件溯源 + 全局 history 服务 + workflow 确定性重放；知影是单机 SQLite 行级
  状态 + `BEGIN IMMEDIATE` 原子多行更新，无需事件溯源。未采用。

**BullMQ（官方 [Worker Stalling](https://docs.bullmq.io/guide/workers/worker-stalling) /
[Lock Renewal](https://docs.bullmq.io/guide/workers/workers#stalled-jobs) 语义）**

- 借鉴：worker 持锁（lockDuration 默认 30s）必须周期性续锁（`updateProgress`/`extendLock`），
  锁过期 → stall 检测把 job 移回 waiting 或（超 maxStalledCount）failed——等价于知影
  `lease_renewal`（续租）与 lease 过期裁决；"只有 stalled 事件没有 stalled 状态"——知影改用显式
  `indeterminate` 状态 + 显式 resolve/takeover，不自动 requeue。
- 不兼容：BullMQ 用 Redis 分布式锁 + 乐观锁脚本，stall 后 job 回 waiting 自动重跑——知影 TTS-C
  **禁止 running→queued requeue**（触发器级），失联走 `indeterminate`（保留 owner 供 fence）+
  lease 过期后 `execution_takeover`（attempt+1）或显式 resolve。未采用自动回队。

**采纳结论**：owner/lease/attempt 的一切变化收敛到单表 append-only command（每行 = 一次原子
transition evidence），由 SQLite 同 statement 原子性替代分布式锁；heartbeat/renewal 只动
lease+heartbeat 不动状态；takeover 必须 attempt+1 换 owner；prestart 取消/失败走显式 command 不留
不可达边。不引入 Temporal/BullMQ 依赖。


---

## 2. 最终 schema（13 表，可执行 contract）

> 以下 SQL 已经 `docs/evidence/tts-c-r10/` runner 从本节代码块**逐字提取**重建临时 DB（sqlite3 3.45.1 +
> 当前 Python sqlite3 双引擎，基座前提见 §0）+ `PRAGMA foreign_key_check`（空）/ `integrity_check`（ok）
> 通过，并经 mutation 验证实证（R10 矩阵 + R9/R8 回归子集：每项触发预期 CHECK/trigger/FK/UNIQUE 失败或
> fencing `changes=0`，逐项计数见 §10.5 与 runner 原始输出）+ happy path 全链 + crash-retry 闭环 +
> legacy rollback→retry 闭环 + materialization/legacy atomic activation + claim atomic dispatch +
> **worker claim → running → succeeded/failed/indeterminate→resolve 全生命周期** +
> **legacy_cutover_publish 与 legacy_cutover_existing 双路径**——详见 §10.5。
> §2 代码块的可执行语句已从本文档提取重建临时 DB 并重跑全部验证（语句级一致，注释不计）。

### 2.0 `tts_jobs` 迁移（纯 ADD COLUMN + INDEX + TRIGGER；零 rebuild）

现有真实列（不得改动语义）：`id / project_id / narration_plan_artifact_id / narration_plan_version / unit_id /
provider / voice_profile_id / voice_profile_revision / status / payload_json / output_path / duration_ms /
audio_sha256 / result_json / queued_at / started_at / finished_at / claimed_by / claimed_at / heartbeat_at /
attempt / max_attempts / progress / error_code / error_message / cancel_requested`。

迁移顺序（单 migration 内）：

```sql
-- 1) ADD COLUMN（FK default NULL 合法；既有 351 行 legacy 数据不受影响）
ALTER TABLE tts_jobs ADD COLUMN claim_id TEXT REFERENCES tts_synthesis_claims(id) ON DELETE SET NULL;
ALTER TABLE tts_jobs ADD COLUMN originating_request_id TEXT;
ALTER TABLE tts_jobs ADD COLUMN exact_source_fingerprint TEXT;
ALTER TABLE tts_jobs ADD COLUMN synthesis_payload_fingerprint TEXT;
ALTER TABLE tts_jobs ADD COLUMN final_tts_input_fingerprint TEXT;
ALTER TABLE tts_jobs ADD COLUMN generation_variant_id TEXT;
ALTER TABLE tts_jobs ADD COLUMN result_artifact_id TEXT REFERENCES sentence_audio_artifacts(id) ON DELETE RESTRICT;
ALTER TABLE tts_jobs ADD COLUMN voice_profile_revision_id TEXT REFERENCES voice_profile_revisions(id);
-- R12：applied-command execution head（TTS-C 行由 dispatch 写入 seq=0/last=NULL；
-- legacy 行 claim_id IS NULL 保持 NULL，不受 TTS-C trigger 影响）
ALTER TABLE tts_jobs ADD COLUMN last_execution_command_id TEXT;
ALTER TABLE tts_jobs ADD COLUMN execution_command_seq INTEGER;

-- 2) composite provenance FK 父键 + TTS-C active 唯一 + R7-D 单 claim 单 job
CREATE UNIQUE INDEX uq_tts_jobs_id_claim ON tts_jobs (id, claim_id);
CREATE UNIQUE INDEX uq_tts_jobs_active_synthesis
ON tts_jobs (project_id, unit_id, final_tts_input_fingerprint, generation_variant_id)
WHERE status IN ('queued','running','indeterminate');
CREATE UNIQUE INDEX uq_tts_jobs_claim ON tts_jobs (claim_id) WHERE claim_id IS NOT NULL;

-- 3) TTS-C 不可变字段 trigger（WHEN 守卫含 OLD 侧：legacy 行双向 NULL 不受影响；
--    TTS-C 行 claim_id 写后不可 NULL、不可换、不可从 legacy 反向获得；身份字段不可改；
--    R8-I 补充 narration_plan_artifact_id / narration_plan_version / payload_json / provider /
--    voice_profile_id 全不可改（payload_json 创建时必须与 frozen synthesis_payload_fingerprint
--    exact 对应——应用层同事务验证，SQL 不可计算）；
--    R9 ⑦ 补充 voice_profile_revision（TTS-C 行创建后不可改，与 voice_profile_revision_id
--    经 trg_tts_jobs_revision_compat 双向冻结）；application layer 同事务重读
--    voice_profile_revisions.revision_number 字符串表达填 voice_profile_revision；
--    voice_profile_revision_id 与 result_artifact_id 首次非 NULL 后不可改；
--    succeeded/failed/cancelled 终态冻结；
--    R10 ⑥ 修正：indeterminate **不是**终态——transition trigger 允许
--    indeterminate→succeeded/failed/cancelled 显式 resolve（§2.2c command 唯一入口），
--    不可再把 indeterminate 当终态冻结 status 出边（R9 该冻结与自身状态机矛盾，
--    R10 由 JS-10 实证发现并修复；indeterminate 期间 result 由 result-invariant
--    与 write-once 子句继续冻结）
CREATE TRIGGER trg_tts_jobs_immutable BEFORE UPDATE ON tts_jobs
WHEN (OLD.claim_id IS NOT NULL OR NEW.claim_id IS NOT NULL) AND (
     OLD.claim_id IS NOT NEW.claim_id
  OR OLD.originating_request_id IS NOT NEW.originating_request_id
  OR OLD.exact_source_fingerprint IS NOT NEW.exact_source_fingerprint
  OR OLD.synthesis_payload_fingerprint IS NOT NEW.synthesis_payload_fingerprint
  OR OLD.final_tts_input_fingerprint IS NOT NEW.final_tts_input_fingerprint
  OR OLD.generation_variant_id IS NOT NEW.generation_variant_id
  OR OLD.narration_plan_artifact_id IS NOT NEW.narration_plan_artifact_id
  OR OLD.narration_plan_version IS NOT NEW.narration_plan_version
  OR OLD.voice_profile_revision IS NOT NEW.voice_profile_revision
  OR OLD.payload_json IS NOT NEW.payload_json
  OR OLD.provider IS NOT NEW.provider
  OR OLD.voice_profile_id IS NOT NEW.voice_profile_id
  OR (OLD.voice_profile_revision_id IS NOT NULL AND NEW.voice_profile_revision_id IS NOT OLD.voice_profile_revision_id)
  OR (OLD.result_artifact_id IS NOT NULL AND NEW.result_artifact_id IS NOT OLD.result_artifact_id)
  OR (OLD.status IN ('succeeded','failed','cancelled') AND (
        NEW.result_artifact_id IS NOT OLD.result_artifact_id
     OR NEW.status IS NOT OLD.status)))
BEGIN SELECT RAISE(ABORT,'tts_jobs immutable field'); END;

-- 4) TTS-C 状态机 trigger（守卫含 OLD/NEW 任一侧：legacy 双向 NULL 行 running→queued requeue 仍允许；
--    TTS-C 行 running→queued 永远 ABORT；status+claim_id 联合 downgrade 被多重拦截）
CREATE TRIGGER trg_tts_jobs_transition BEFORE UPDATE OF status ON tts_jobs
WHEN (OLD.claim_id IS NOT NULL OR NEW.claim_id IS NOT NULL)
  AND OLD.status IS NOT NEW.status AND NOT (
     (OLD.status='queued'        AND NEW.status IN ('running','failed','cancelled'))
  OR (OLD.status='running'       AND NEW.status IN ('succeeded','failed','cancelled','indeterminate'))
  OR (OLD.status='indeterminate' AND NEW.status IN ('succeeded','failed','cancelled')))
BEGIN SELECT RAISE(ABORT,'tts_jobs invalid transition'); END;

-- 5) TTS-C 行 INSERT/UPDATE validation（R6-A 继承 + R7-CJ-01/H/I + R8-F：
--    初始状态只能 queued；TTS-C job 必须由 matching dispatch command 创建
--    （tts_claim_generation_dispatches.claim_id+job_id 精确匹配——应用直接 INSERT 一律 ABORT）；
--    voice_profile_id/revision_id exact pair 且 provider == revision.provider；
--    身份字段 NULL 一律 ABORT——不得用 NULL 绕过 uq_tts_jobs_active_synthesis）
CREATE TRIGGER trg_tts_jobs_claim_validation BEFORE INSERT ON tts_jobs
WHEN NEW.claim_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'tts_jobs claim identity required')
    WHERE NEW.exact_source_fingerprint IS NULL
       OR NEW.synthesis_payload_fingerprint IS NULL
       OR NEW.final_tts_input_fingerprint IS NULL
       OR NEW.generation_variant_id IS NULL
       OR NEW.project_id IS NULL OR NEW.unit_id IS NULL
       OR NEW.narration_plan_artifact_id IS NULL
       OR NEW.voice_profile_revision_id IS NULL;
  SELECT RAISE(ABORT,'tts_jobs claim identity mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM tts_synthesis_claims c
                      WHERE c.id=NEW.claim_id
                        AND c.project_id=NEW.project_id
                        AND c.unit_id=NEW.unit_id
                        AND c.final_tts_input_fingerprint=NEW.final_tts_input_fingerprint
                        AND c.generation_variant_id=NEW.generation_variant_id);
  SELECT RAISE(ABORT,'tts_jobs initial state queued required')
    WHERE NEW.status IS NOT 'queued';
  SELECT RAISE(ABORT,'tts_jobs dispatch command required')
    WHERE NOT EXISTS (SELECT 1 FROM tts_claim_generation_dispatches d
                      WHERE d.claim_id=NEW.claim_id AND d.job_id=NEW.id);
  SELECT RAISE(ABORT,'tts_jobs voice revision pair mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM voice_profile_revisions r
                      WHERE r.id=NEW.voice_profile_revision_id
                        AND r.voice_profile_id=NEW.voice_profile_id
                        AND r.provider=NEW.provider);
END;
CREATE TRIGGER trg_tts_jobs_claim_validation_update BEFORE UPDATE ON tts_jobs
WHEN NEW.claim_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'tts_jobs claim identity required')
    WHERE NEW.exact_source_fingerprint IS NULL
       OR NEW.synthesis_payload_fingerprint IS NULL
       OR NEW.final_tts_input_fingerprint IS NULL
       OR NEW.generation_variant_id IS NULL
       OR NEW.project_id IS NULL OR NEW.unit_id IS NULL
       OR NEW.narration_plan_artifact_id IS NULL
       OR NEW.voice_profile_revision_id IS NULL;
  SELECT RAISE(ABORT,'tts_jobs claim identity mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM tts_synthesis_claims c
                      WHERE c.id=NEW.claim_id
                        AND c.project_id=NEW.project_id
                        AND c.unit_id=NEW.unit_id
                        AND c.final_tts_input_fingerprint=NEW.final_tts_input_fingerprint
                        AND c.generation_variant_id=NEW.generation_variant_id);
END;

-- 6) R8-G：TTS-C job result row-state invariant（对 INSERT 与所有 UPDATE 生效，不只监听 UPDATE OF status：
--    claim_id IS NOT NULL 时 status='succeeded' ⇔ result_artifact_id IS NOT NULL；
--    status!='succeeded' ⇒ result_artifact_id IS NULL；
--    running/queued/failed 状态单独 SET result_artifact_id 一律 ABORT）
CREATE TRIGGER trg_tts_jobs_result_invariant BEFORE INSERT ON tts_jobs
WHEN NEW.claim_id IS NOT NULL AND (
     (NEW.status='succeeded' AND NEW.result_artifact_id IS NULL)
  OR (NEW.status IS NOT 'succeeded' AND NEW.result_artifact_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'tts_jobs result status invariant violated'); END;
CREATE TRIGGER trg_tts_jobs_result_invariant_update BEFORE UPDATE ON tts_jobs
WHEN NEW.claim_id IS NOT NULL AND (
     (NEW.status='succeeded' AND NEW.result_artifact_id IS NULL)
  OR (NEW.status IS NOT 'succeeded' AND NEW.result_artifact_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'tts_jobs result status invariant violated'); END;
-- R7-E 保留：result artifact 的 job_id/claim_id 必须等于当前 job
CREATE TRIGGER trg_tts_jobs_result BEFORE UPDATE OF result_artifact_id ON tts_jobs
WHEN NEW.claim_id IS NOT NULL AND NEW.result_artifact_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'tts_jobs result artifact job mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM sentence_audio_artifacts a
                      WHERE a.id=NEW.result_artifact_id
                        AND a.job_id=NEW.id
                        AND a.claim_id=NEW.claim_id);
END;

-- 7) R7-E：TTS-C job DELETE 禁（legacy 行不受影响）
CREATE TRIGGER trg_tts_jobs_delete_tts_c BEFORE DELETE ON tts_jobs
WHEN OLD.claim_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'tts_jobs tts-c delete forbidden'); END;

-- 8) R9 ⑦：TTS-C 行 voice_profile_revision ↔ voice_profile_revision_id compat closure
--    （BEFORE INSERT + BEFORE UPDATE：双 trigger 同步校验；TTS-C 行 voice_profile_revision 必须
--    等于 voice_profile_revisions.revision_number 的字符串表达；legacy 行 voice_profile_revision
--    允许任意值因 voice_profile_revision_id=NULL；voice_profile_revision 与 voice_profile_revision_id
--    双向漂移一律 ABORT）
CREATE TRIGGER trg_tts_jobs_revision_compat BEFORE INSERT ON tts_jobs
WHEN NEW.claim_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'tts_jobs voice_profile_revision compat mismatch')
    WHERE NEW.voice_profile_revision IS NULL
       OR NEW.voice_profile_revision_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM voice_profile_revisions r
         WHERE r.id=NEW.voice_profile_revision_id
           AND CAST(r.revision_number AS TEXT)=NEW.voice_profile_revision
           AND r.voice_profile_id=NEW.voice_profile_id);
END;
CREATE TRIGGER trg_tts_jobs_revision_compat_update BEFORE UPDATE ON tts_jobs
WHEN NEW.claim_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'tts_jobs voice_profile_revision compat mismatch')
    WHERE NEW.voice_profile_revision IS NULL
       OR NEW.voice_profile_revision_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM voice_profile_revisions r
         WHERE r.id=NEW.voice_profile_revision_id
           AND CAST(r.revision_number AS TEXT)=NEW.voice_profile_revision
           AND r.voice_profile_id=NEW.voice_profile_id);
END;

-- 9) R11 ⑥：claim/job 状态与 owner 字段迁移必须经 tts_job_execution_transitions atomic command（五类 command 语义）；
--    `trg_tjs_command_required` / `trg_tsc_command_required` / per-column fence 在 §2.2c 集中定义（避免重复）。
```

- 现有列保留；`output_path/duration_ms/audio_sha256/result_json` legacy 兼容（TTS-C 不写不读为 authoritative）。
- **TTS-C 行语义（R6-A 继承）**：`claim_id` 在 INSERT 时写入后**永不可变**（不可 NULL、不可换、legacy 行不可凭空获得）；
  `originating_request_id / exact_source_fingerprint / synthesis_payload_fingerprint / final_tts_input_fingerprint /
  generation_variant_id` 写后不可改；`project_id / unit_id / narration_plan_artifact_id` 必须完整（身份字段 NULL → ABORT）。
- **R7-D 无环 claim/job 模型 + R8-F exact-one dispatch**：**`tts_synthesis_claims` 不再有 `job_id` 列**；唯一权威 relation =
  `tts_jobs.claim_id`（`uq_tts_jobs_claim` 保证一个 claim 最多一个 job）；
  claim 的 job = `SELECT * FROM tts_jobs WHERE claim_id = claim.id`（commit 后恒一致，无"第二边"可忘写）。
  保证：`validating_reuse` claim → 无 job（TTS-C job INSERT 必须匹配 `tts_claim_generation_dispatches`
  command 行（claim_id+job_id），应用直接 INSERT 一律 ABORT）；`generation_pending/running` generated claim →
  恰好一个 job（dispatch trigger 同一 statement 内建 job + 转 claim；claim→running 时 job 必须已存在；
  同 claim 第二次 dispatch → `UNIQUE(claim_id)` ABORT）；reuse `succeeded` claim → 无 job；
  一个 claim 永远不能有两个 job；generated 终态 claim 恒有恰好一个 job（DELETE 禁）。
- **R7-I exact voice/provider identity**：TTS-C job 必须 `voice_profile_revision_id`（exact revision ID，legacy 行
  NULL 兼容）；`voice_profile_id/revision_id` exact pair 且 `provider == revision.provider`（INSERT pair trigger 强制）；
  voice identity 创建后不可改；`attempt.provider == job.provider`（§2.3）；`artifact` voice/provider 与
  job/attempt/revision 逐项一致（§2.4）。
- **R8-I job identity seal**：TTS-C 行 `narration_plan_artifact_id / narration_plan_version / payload_json /
  provider / voice_profile_id` 创建后全不可改（immutable trigger）；`payload_json` 必须在创建时与 frozen
  `synthesis_payload_fingerprint` exact 对应（应用层同事务重算比较，SQL 不可表达；创建后两者均不可改）。
- **R9 ⑦ voice_profile_revision compat closure**：`voice_profile_revision`（legacy 文本列）Worker/adapter 仍
  读取；TTS-C 行 INSERT 与 UPDATE 由 `trg_tts_jobs_revision_compat` 强制
  `CAST(revision_number AS TEXT)=voice_profile_revision` 一致；immutable trigger 把它纳入
  `voice_profile_revision` 写后冻结列；不允许 `voice_profile_revision_id = A, voice_profile_revision = B` 漂移
  （VI-05/VI-06 实证）。
- **R11 ⑥ claim/job execution coupling + owner command closure**：TTS-C 行任何 status 迁移与
  执行期 owner 字段（claim `owner_token/lease/validation_attempt`、job
  `claimed_by/claimed_at/heartbeat_at/attempt/started_at/finished_at/error_*`）必须经
  `tts_job_execution_transitions` command INSERT（§2.2c：worker_claim / lease_renewal /
  execution_takeover / prestart_terminal / state_transition），`trg_tjs_command_required` /
  `trg_tsc_command_required` 精确匹配（from,to）command 行、per-column fence 精确匹配本变更，
  任何直接 UPDATE 一律 ABORT；result_artifact_id 写后不可改、status↔result row-state invariant
  同步关闭。
- **R8-G result row-state invariant**：`result_artifact_id` 首次非 NULL 后不可改；**row-state invariant 对 INSERT 与
  所有 UPDATE 生效**（不只 `UPDATE OF status`）：`succeeded ⇔ result IS NOT NULL`、非 succeeded ⇒ result IS NULL
  （running/queued/failed 单独写 result 一律 ABORT）；result artifact 必须 `job_id == job.id AND claim_id == job.claim_id`。
- Scheduler 只 claim `status='queued'` 且 `claim.status IN ('generation_pending','running')` 的 job；**`validating_reuse` 阶段无 queued job**。
- 依赖顺序说明：`tts_jobs` 的 `claim_id`/`result_artifact_id` FK 指向后建表——SQLite 允许前向 FK 引用（运行时解析），
  但 migration 应先建新表再执行 §2.0（或同 migration 内先 CREATE 后 ALTER）。

### 2.1 `tts_audio_requests`（request envelope；many-to-one → claim；R7-G initializing）

```sql
CREATE TABLE tts_audio_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  unit_id TEXT NOT NULL CHECK (unit_id GLOB 'N[0-9][0-9][0-9]'),
  exact_source_fingerprint TEXT NOT NULL,
  synthesis_payload_fingerprint TEXT NOT NULL,
  final_tts_input_fingerprint TEXT NOT NULL,
  generation_variant_id TEXT NOT NULL DEFAULT 'default',
  claim_id TEXT REFERENCES tts_synthesis_claims(id) ON DELETE SET NULL,
  job_id TEXT REFERENCES tts_jobs(id) ON DELETE SET NULL,
  result_artifact_id TEXT REFERENCES sentence_audio_artifacts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN
    ('initializing','waiting','running','succeeded','failed','cancelled','indeterminate')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, request_id),
  CHECK (
       (status='initializing' AND claim_id IS NULL AND job_id IS NULL AND result_artifact_id IS NULL)
    OR (status IN ('waiting','running','indeterminate')
        AND result_artifact_id IS NULL AND claim_id IS NOT NULL)
    OR (status='succeeded' AND result_artifact_id IS NOT NULL)
    OR (status IN ('failed','cancelled') AND result_artifact_id IS NULL))
);
-- R7-H：初始状态 initializing
CREATE TRIGGER trg_tar_initial BEFORE INSERT ON tts_audio_requests
WHEN NEW.status IS NOT 'initializing'
BEGIN SELECT RAISE(ABORT,'tts_audio_requests initial state initializing required'); END;
CREATE TRIGGER trg_tar_immutable BEFORE UPDATE ON tts_audio_requests
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.request_id IS NOT NEW.request_id
  OR OLD.unit_id IS NOT NEW.unit_id
  OR OLD.exact_source_fingerprint IS NOT NEW.exact_source_fingerprint
  OR OLD.synthesis_payload_fingerprint IS NOT NEW.synthesis_payload_fingerprint
  OR OLD.final_tts_input_fingerprint IS NOT NEW.final_tts_input_fingerprint
  OR OLD.generation_variant_id IS NOT NEW.generation_variant_id
  OR (OLD.claim_id IS NOT NULL AND OLD.claim_id IS NOT NEW.claim_id)
  OR (OLD.job_id IS NOT NULL AND OLD.job_id IS NOT NEW.job_id)
  OR (OLD.result_artifact_id IS NOT NULL AND OLD.result_artifact_id IS NOT NEW.result_artifact_id)
  OR (OLD.status='succeeded' AND (
        NEW.claim_id IS NOT OLD.claim_id
     OR NEW.job_id IS NOT OLD.job_id
     OR NEW.result_artifact_id IS NOT OLD.result_artifact_id
     OR NEW.status IS NOT OLD.status))
BEGIN SELECT RAISE(ABORT,'tts_audio_requests immutable field'); END;
CREATE TRIGGER trg_tar_transition BEFORE UPDATE OF status ON tts_audio_requests
WHEN OLD.status IS NOT NEW.status AND NOT (
     (OLD.status='initializing' AND NEW.status IN ('waiting','cancelled','failed'))
  OR (OLD.status='waiting' AND NEW.status IN ('running','succeeded','failed','cancelled','indeterminate'))
  OR (OLD.status='running' AND NEW.status IN ('succeeded','failed','cancelled','indeterminate'))
  OR (OLD.status='indeterminate' AND NEW.status IN ('succeeded','failed','cancelled')))
BEGIN SELECT RAISE(ABORT,'tts_audio_requests invalid transition'); END;
-- R8-H：initializing → waiting 必须已链接 exact claim（job_id 可 NULL：validating/reuse 阶段尚无 job；
-- claim identity 由 trg_tar_claim_link_update 同事务强制；无 claim 的 committed waiting 行结构上不可能）
CREATE TRIGGER trg_tar_waiting_link BEFORE UPDATE OF status ON tts_audio_requests
WHEN OLD.status='initializing' AND NEW.status='waiting' AND NEW.claim_id IS NULL
BEGIN SELECT RAISE(ABORT,'tts_audio_requests waiting requires claim link'); END;
CREATE TRIGGER trg_tar_delete_abort BEFORE DELETE ON tts_audio_requests
BEGIN SELECT RAISE(ABORT,'tts_audio_requests delete forbidden'); END;
-- R7-F：claim 链接 identity closure（INSERT + UPDATE；request 的 project/unit/final fingerprint/variant
-- 必须与 claim 逐项一致——不得跨 project/unit/fingerprint 计入 subscriber）
CREATE TRIGGER trg_tar_claim_link BEFORE INSERT ON tts_audio_requests
WHEN NEW.claim_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'tts_audio_requests claim identity mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM tts_synthesis_claims c
                      WHERE c.id=NEW.claim_id
                        AND c.project_id=NEW.project_id
                        AND c.unit_id=NEW.unit_id
                        AND c.final_tts_input_fingerprint=NEW.final_tts_input_fingerprint
                        AND c.generation_variant_id=NEW.generation_variant_id);
END;
CREATE TRIGGER trg_tar_claim_link_update BEFORE UPDATE OF claim_id ON tts_audio_requests
WHEN NEW.claim_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'tts_audio_requests claim identity mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM tts_synthesis_claims c
                      WHERE c.id=NEW.claim_id
                        AND c.project_id=NEW.project_id
                        AND c.unit_id=NEW.unit_id
                        AND c.final_tts_input_fingerprint=NEW.final_tts_input_fingerprint
                        AND c.generation_variant_id=NEW.generation_variant_id);
END;
-- R7-F：job 链接 identity closure（INSERT + UPDATE；job.claim_id==request.claim_id 且
-- project/unit/exact/synthesis/final fingerprint/variant 与 request 全等）
CREATE TRIGGER trg_tar_job_link BEFORE INSERT ON tts_audio_requests
WHEN NEW.job_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'tts_audio_requests job identity mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM tts_jobs j
                      WHERE j.id=NEW.job_id AND j.claim_id=NEW.claim_id
                        AND j.project_id=NEW.project_id AND j.unit_id=NEW.unit_id
                        AND j.exact_source_fingerprint=NEW.exact_source_fingerprint
                        AND j.synthesis_payload_fingerprint=NEW.synthesis_payload_fingerprint
                        AND j.final_tts_input_fingerprint=NEW.final_tts_input_fingerprint
                        AND j.generation_variant_id=NEW.generation_variant_id);
END;
CREATE TRIGGER trg_tar_job_link_update BEFORE UPDATE OF job_id ON tts_audio_requests
WHEN NEW.job_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'tts_audio_requests job identity mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM tts_jobs j
                      WHERE j.id=NEW.job_id AND j.claim_id=NEW.claim_id
                        AND j.project_id=NEW.project_id AND j.unit_id=NEW.unit_id
                        AND j.exact_source_fingerprint=NEW.exact_source_fingerprint
                        AND j.synthesis_payload_fingerprint=NEW.synthesis_payload_fingerprint
                        AND j.final_tts_input_fingerprint=NEW.final_tts_input_fingerprint
                        AND j.generation_variant_id=NEW.generation_variant_id);
END;
-- R7-SL-07：result 链接 identity 校验**同时覆盖 BEFORE INSERT 与 BEFORE UPDATE OF result_artifact_id**
-- （result artifact 与 request 的 project/exact/synthesis/final fingerprint/variant 一致；
-- unit 经 linked claim 传递校验；reuse 语义下 artifact.claim_id（producing claim）不必等于 request.claim_id——合法）
CREATE TRIGGER trg_tar_result_link BEFORE INSERT ON tts_audio_requests
WHEN NEW.result_artifact_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'tts_audio_requests result artifact identity mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM sentence_audio_artifacts a
      WHERE a.id=NEW.result_artifact_id
        AND a.project_id=NEW.project_id
        AND a.exact_source_fingerprint=NEW.exact_source_fingerprint
        AND a.synthesis_payload_fingerprint=NEW.synthesis_payload_fingerprint
        AND a.final_tts_input_fingerprint=NEW.final_tts_input_fingerprint
        AND a.generation_variant_id=NEW.generation_variant_id
        AND (NEW.claim_id IS NULL
             OR EXISTS (SELECT 1 FROM tts_synthesis_claims c
                        WHERE c.id=NEW.claim_id AND c.unit_id=a.unit_id
                          AND c.project_id=a.project_id
                          AND c.final_tts_input_fingerprint=a.final_tts_input_fingerprint
                          AND c.generation_variant_id=a.generation_variant_id)));
END;
CREATE TRIGGER trg_tar_result_link_update BEFORE UPDATE OF result_artifact_id ON tts_audio_requests
WHEN NEW.result_artifact_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'tts_audio_requests result artifact identity mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM sentence_audio_artifacts a
      WHERE a.id=NEW.result_artifact_id
        AND a.project_id=NEW.project_id
        AND a.exact_source_fingerprint=NEW.exact_source_fingerprint
        AND a.synthesis_payload_fingerprint=NEW.synthesis_payload_fingerprint
        AND a.final_tts_input_fingerprint=NEW.final_tts_input_fingerprint
        AND a.generation_variant_id=NEW.generation_variant_id
        AND (NEW.claim_id IS NULL
             OR EXISTS (SELECT 1 FROM tts_synthesis_claims c
                        WHERE c.id=NEW.claim_id AND c.unit_id=a.unit_id
                          AND c.project_id=a.project_id
                          AND c.final_tts_input_fingerprint=a.final_tts_input_fingerprint
                          AND c.generation_variant_id=a.generation_variant_id)));
END;
```

- **initializing 语义（R7-G + R8-H）**：`initializing` 只负责占用 `(project_id, request_id)`（UNIQUE）；`claim_id/job_id/
  result_artifact_id` 必须全 NULL（CHECK）；**不计入 active subscriber**（active subscriber 只统计
  `status IN ('waiting','running')`）；Scheduler 不可见；`initializing → waiting` 必须在同一事务内完成 exact
  claim/job identity link（Phase 1 单事务：INSERT initializing → 创建/读取 claim/job → 链接 exact identity →
  initializing→waiting → COMMIT）——**R8-H：`waiting` 必须 `claim_id` 非 NULL（`trg_tar_waiting_link` + CHECK
  双重强制；job_id 可 NULL，validating/reuse 阶段尚无 job），无 claim 的 committed waiting 行结构上不可能**；
  crash 前 transaction 回滚不产生 committed initializing；
  **推荐不允许长期 committed initializing**（异常清理走 `initializing → cancelled/failed`）。
- `succeeded` 必须带 `result_artifact_id`；`failed/cancelled` **不得伪装成功 result**（CHECK 强制 NULL）。
- **终态链接封存（R6-D 继承）**：`claim_id` / `job_id` / `result_artifact_id` 各自**首次非 NULL 后不可改**；`succeeded` 后
  claim/job/result/status linkage 全部不可改（替换 result / 从 NULL 写入 job / 替换 claim 一律 ABORT——实证 IS-10/11/11b）。
- **subscriber identity closure（R7-F）**：request 链接 claim 时必须同 `project_id/unit_id/final_tts_input_fingerprint/
  generation_variant_id`（INSERT + UPDATE 双 trigger）；`request.job_id` 非 NULL 时 `job.claim_id == request.claim_id`
  且 job 的 project/unit/exact/synthesis/final fingerprint/variant 与 request 全等；cross-project/cross-unit/
  cross-fingerprint request 无法落库为 subscriber（实证 SL-01/02/03/04）。
- **result 链接校验覆盖 INSERT + UPDATE（R7-SL-07）**：result artifact 与 request 的 project/exact/synthesis/final
  fingerprint/variant 一致；unit 经 linked claim 传递校验（reuse claim 下 `artifact.claim_id` 是 producing claim，
  不等于 reuse claim.id 属合法语义，unit/fingerprint 仍必须一致）。
- **authoritative reader**：`getTtsAudioRequestExact(projectId, requestId)`（exact request identity，无 latest fallback）。
- **API redaction**：序列化出口不含任何 path。**legacy compat**：新表，无历史兼容问题。

### 2.2 `tts_synthesis_claims`（唯一 synthesis reservation；可回收；fenced；R7-D 无环；R9 ① database-time fencing）

```sql
CREATE TABLE tts_synthesis_claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  unit_id TEXT NOT NULL CHECK (unit_id GLOB 'N[0-9][0-9][0-9]'),
  final_tts_input_fingerprint TEXT NOT NULL,
  generation_variant_id TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL CHECK (status IN
    ('validating_reuse','generation_pending','running','succeeded','failed','cancelled','indeterminate')),
  result_artifact_id TEXT REFERENCES sentence_audio_artifacts(id) ON DELETE RESTRICT,
  owner_token TEXT,
  -- R9 ①：lease 列统一 INTEGER epoch milliseconds（UTC）
  lease_expires_at_epoch_ms INTEGER,
  validation_owner_token TEXT,
  validation_lease_expires_at_epoch_ms INTEGER,
  validation_attempt INTEGER NOT NULL DEFAULT 0,
  candidate_artifact_id TEXT REFERENCES sentence_audio_artifacts(id) ON DELETE RESTRICT,
  candidate_artifact_metadata_hash TEXT,
  validation_started_at TEXT,
  -- R12：applied-command execution head（dispatch 后 seq=0/last=NULL；每应用一条 execution
  -- command 双侧同时 +1 并写入该 command id；legacy/validating_reuse 不参与）
  last_execution_command_id TEXT,
  execution_command_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
       (status='validating_reuse'
        AND validation_owner_token IS NOT NULL AND validation_lease_expires_at_epoch_ms IS NOT NULL
        AND validation_attempt >= 1 AND validation_started_at IS NOT NULL
        AND owner_token IS NULL AND lease_expires_at_epoch_ms IS NULL
        AND result_artifact_id IS NULL)
    OR (status='generation_pending'
        AND validation_owner_token IS NULL AND validation_lease_expires_at_epoch_ms IS NULL
        AND owner_token IS NULL AND lease_expires_at_epoch_ms IS NULL
        AND result_artifact_id IS NULL
        AND candidate_artifact_id IS NULL AND candidate_artifact_metadata_hash IS NULL)
    OR (status='running'
        AND owner_token IS NOT NULL AND lease_expires_at_epoch_ms IS NOT NULL
        AND validation_owner_token IS NULL AND validation_lease_expires_at_epoch_ms IS NULL
        AND result_artifact_id IS NULL)
    OR (status='succeeded' AND result_artifact_id IS NOT NULL
        AND owner_token IS NULL AND lease_expires_at_epoch_ms IS NULL
        AND validation_owner_token IS NULL AND validation_lease_expires_at_epoch_ms IS NULL)
    OR (status IN ('failed','cancelled') AND result_artifact_id IS NULL
        AND owner_token IS NULL AND lease_expires_at_epoch_ms IS NULL
        AND validation_owner_token IS NULL AND validation_lease_expires_at_epoch_ms IS NULL)
    -- R11 ⑥：indeterminate 保留 Worker owner/lease（lease_renewal / execution_takeover /
    -- state_transition resolve 的 fence 都依赖在飞 owner；只有 succeeded/failed/cancelled
    -- 三终态才清空）
    OR (status='indeterminate' AND result_artifact_id IS NULL
        AND owner_token IS NOT NULL AND lease_expires_at_epoch_ms IS NOT NULL
        AND validation_owner_token IS NULL AND validation_lease_expires_at_epoch_ms IS NULL))
);
CREATE UNIQUE INDEX uq_tts_synthesis_claim_active
ON tts_synthesis_claims (project_id, unit_id, final_tts_input_fingerprint, generation_variant_id)
WHERE status IN ('validating_reuse','generation_pending','running','indeterminate');

-- R7-H：初始状态 validating_reuse
CREATE TRIGGER trg_tsc_initial BEFORE INSERT ON tts_synthesis_claims
WHEN NEW.status IS NOT 'validating_reuse'
BEGIN SELECT RAISE(ABORT,'tts_synthesis_claims initial state validating_reuse required'); END;
-- R7-D/CJ-03b：running 必须已有 job（tts_jobs.claim_id 反向；uq_tts_jobs_claim 保证最多一个）
CREATE TRIGGER trg_tsc_running_job BEFORE UPDATE OF status ON tts_synthesis_claims
WHEN NEW.status='running' AND OLD.status IS NOT NEW.status
  AND NOT EXISTS (SELECT 1 FROM tts_jobs j WHERE j.claim_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'tts_synthesis_claims running requires exactly one job'); END;
-- R8-F/CJ-09：validating_reuse→generation_pending 必须由 dispatch command 驱动
-- （dispatch trigger 在同一 statement 内先建 job 再转 claim；只改 claim 后 COMMIT 结构上不可能）
CREATE TRIGGER trg_tsc_generation_pending_dispatch BEFORE UPDATE OF status ON tts_synthesis_claims
WHEN OLD.status='validating_reuse' AND NEW.status='generation_pending'
  AND NOT EXISTS (SELECT 1 FROM tts_claim_generation_dispatches d WHERE d.claim_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'tts_synthesis_claims generation_pending requires dispatch command'); END;
-- R11 ⑥：generation_pending→running 必须经 worker_claim command；generation_pending→failed/cancelled
-- 必须经 prestart_terminal command；终态/indeterminate 必须经
-- state_transition command 驱动；trg_tsc_command_required 在 §2.2c 集中定义（避免重复）
-- R9 ①：evidence 时间（validation_started_at / updated_at）不得明显晚于 DB 当前时间
CREATE TRIGGER trg_tsc_evidence_time BEFORE INSERT ON tts_synthesis_claims
WHEN NEW.validation_started_at IS NOT NULL
  AND NEW.validation_started_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'tts_synthesis_claims evidence timestamp in future'); END;
CREATE TRIGGER trg_tsc_evidence_time_update BEFORE UPDATE ON tts_synthesis_claims
WHEN (NEW.validation_started_at IS NOT NULL
      AND NEW.validation_started_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')))
  OR (NEW.updated_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'tts_synthesis_claims evidence timestamp in future'); END;
CREATE TRIGGER trg_tsc_immutable BEFORE UPDATE ON tts_synthesis_claims
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.unit_id IS NOT NEW.unit_id
  OR OLD.final_tts_input_fingerprint IS NOT NEW.final_tts_input_fingerprint
  OR OLD.generation_variant_id IS NOT NEW.generation_variant_id
  OR (OLD.result_artifact_id IS NOT NULL AND OLD.result_artifact_id IS NOT NEW.result_artifact_id)
  OR (OLD.status='succeeded' AND (
        NEW.result_artifact_id IS NOT OLD.result_artifact_id
     OR NEW.status IS NOT OLD.status))
BEGIN SELECT RAISE(ABORT,'tts_synthesis_claims immutable field'); END;
CREATE TRIGGER trg_tsc_transition BEFORE UPDATE OF status ON tts_synthesis_claims
WHEN OLD.status IS NOT NEW.status AND NOT (
     (OLD.status='validating_reuse'   AND NEW.status IN ('succeeded','generation_pending','cancelled','failed'))
  OR (OLD.status='generation_pending' AND NEW.status IN ('running','cancelled','failed'))
  OR (OLD.status='running'            AND NEW.status IN ('succeeded','failed','cancelled','indeterminate'))
  OR (OLD.status='indeterminate'      AND NEW.status IN ('succeeded','failed','cancelled')))
BEGIN SELECT RAISE(ABORT,'tts_synthesis_claims invalid transition'); END;
CREATE TRIGGER trg_tsc_delete_abort BEFORE DELETE ON tts_synthesis_claims
BEGIN SELECT RAISE(ABORT,'tts_synthesis_claims delete forbidden'); END;
-- R6-D：claim result 链接 identity 校验（result artifact 与 claim 的 project/unit/final fingerprint/variant 一致；
-- reuse 语义下 artifact.claim_id（producing claim）不必等于本 claim.id——合法）
CREATE TRIGGER trg_tsc_result_link BEFORE UPDATE OF result_artifact_id ON tts_synthesis_claims
WHEN NEW.result_artifact_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'tts_synthesis_claims result artifact identity mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM sentence_audio_artifacts a
      WHERE a.id=NEW.result_artifact_id
        AND a.project_id=NEW.project_id
        AND a.unit_id=NEW.unit_id
        AND a.final_tts_input_fingerprint=NEW.final_tts_input_fingerprint
        AND a.generation_variant_id=NEW.generation_variant_id);
END;
```

- **所有权语义（冻结，CHECK 强制）**：
  - `validating_reuse`：`validation_owner_token/validation_lease_expires_at/validation_attempt(>=1)/validation_started_at` 有效；
    `owner_token/lease_expires_at/result_artifact_id` 全 NULL；candidate 列可 NULL（无候选 → 直接按 unusable 走 generation_pending）；
  - `generation_pending`：validation owner **必须清空**；Worker owner 必须 NULL（job 尚未被 claim）；candidate 列清空；
  - `running`：Worker `owner_token/lease_expires_at` 有效；validation owner 清空；
  - `succeeded`：`result_artifact_id` NOT NULL；owner/lease/validation 全清；
  - `failed/cancelled/indeterminate`：owner/lease/validation 全清；result NULL。
- **状态机（R5 冻结，消除歧义）**：`validating_reuse → succeeded | generation_pending | cancelled | failed`；
  `generation_pending → running | cancelled | failed`（preflight/job 校验失败 → failed；**不允许 indeterminate**——尚无执行在飞）；
  `running → succeeded | failed | cancelled | indeterminate`；
  `indeterminate → succeeded | failed | cancelled`（显式 resolve，不回 generation_pending/running）。
- **R7-D 无环 job 关系 + R8-F exact-one dispatch（替代 R6 的 job_id 双向字段）**：本表**没有 `job_id` 列**；
  claim 的 job 唯一真相 = `SELECT * FROM tts_jobs WHERE claim_id = claim.id`（§2.0 `uq_tts_jobs_claim` 保证最多一个）。
  不变量：`validating_reuse` → 无 job（§2.0 job INSERT 必须匹配 dispatch command，实证 CJ-01）；
  `generation_pending` → 恰好一个 job（唯一入口 = §2.2b dispatch command 同一 statement 建 job + 转 claim；
  无 dispatch 行直接转 generation_pending 一律 ABORT（`trg_tsc_generation_pending_dispatch`，实证 CJ-09））；
  `running` → 恰好一个 job（`trg_tsc_running_job` + uq，实证 CJ-03）；
  reuse `succeeded` → 无 job（实证 CJ-04）；generated `succeeded/failed/cancelled/indeterminate` → 恰好一个 job
  （job DELETE 禁，实证 CJ-13）；一个 claim 永远不能有两个 job（实证 CJ-02 + CJ-12）。
  **commit 后一致性不再依赖"应用在同一事务记得写第二边"**——单边 relation 恒一致，dispatch 单一 statement 原子。
- **终态链接封存（R6-D 继承）**：`result_artifact_id` **首次非 NULL 后不可改**；`succeeded` 后 result/status linkage
  全部不可改（实证 IS-12b）。
- **authoritative**：active synthesis identity 唯一真相（partial unique 覆盖 validating/generation_pending/running/indeterminate）。

### 2.2b `tts_claim_generation_dispatches`（第 12 表：append-only exact-one dispatch command；R8-F）

> unusable finalize（validating_reuse → generation_pending + 恰好一个 queued job）的**唯一入口**。
> 应用执行**一条 INSERT statement**；AFTER INSERT trigger 在同一 SQLite statement 内完成全部状态更新——
> 任一验证失败 RAISE(ABORT) 则整条 statement 回滚：claim 保持 `validating_reuse`、无 job、无 dispatch 行。
> 不再允许"UPDATE claim → generation_pending"+"INSERT job"两条可独立提交的应用语句作为唯一约束。

```sql
CREATE TABLE tts_claim_generation_dispatches (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES tts_synthesis_claims(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL,
  validation_owner_token TEXT NOT NULL,
  validation_attempt INTEGER NOT NULL,
  candidate_artifact_id TEXT,
  candidate_artifact_metadata_hash TEXT,
  project_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  narration_plan_artifact_id TEXT NOT NULL,
  narration_plan_version INTEGER NOT NULL,
  provider TEXT NOT NULL,
  voice_profile_id TEXT NOT NULL,
  voice_profile_revision TEXT NOT NULL,
  voice_profile_revision_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  originating_request_id TEXT,
  exact_source_fingerprint TEXT NOT NULL,
  synthesis_payload_fingerprint TEXT NOT NULL,
  final_tts_input_fingerprint TEXT NOT NULL,
  generation_variant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL,
  UNIQUE (claim_id)
);
-- R8-F + R9 ①：AFTER INSERT 原子 dispatch（同一 SQLite statement 内 1→4 顺序执行；任一步 ABORT 整条回滚；
--                fence 比较使用 DB_NOW_MS，**不再** 用 NEW.created_at 作为时间判定基准）
CREATE TRIGGER trg_tcgd_dispatch AFTER INSERT ON tts_claim_generation_dispatches
BEGIN
  -- 1) fenced 验证 validating_reuse owner/token/attempt/lease/candidate（IS 语义；不命中 = STALE_VALIDATION_OWNER）
  SELECT RAISE(ABORT,'tts_claim_generation_dispatches fencing mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM tts_synthesis_claims c
                      WHERE c.id=NEW.claim_id AND c.status='validating_reuse'
                        AND c.validation_owner_token=NEW.validation_owner_token
                        AND c.validation_attempt=NEW.validation_attempt
                        AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
                            <= c.validation_lease_expires_at_epoch_ms
                        AND c.candidate_artifact_id IS NEW.candidate_artifact_id
                        AND c.candidate_artifact_metadata_hash IS NEW.candidate_artifact_metadata_hash);
  -- 2) active subscriber > 0（zero-subscriber provider job 禁止）
  SELECT RAISE(ABORT,'tts_claim_generation_dispatches zero subscriber')
    WHERE NOT EXISTS (SELECT 1 FROM tts_audio_requests r
                      WHERE r.claim_id=NEW.claim_id AND r.status IN ('waiting','running'));
  -- 3) INSERT 恰好一个 queued job（全部冻结身份字段来自 command 行；job 侧 trigger 复核
  --    claim identity / dispatch 匹配 / 初始状态 queued / voice exact pair / revision compat）
  INSERT INTO tts_jobs (id, project_id, narration_plan_artifact_id, narration_plan_version, unit_id,
    provider, voice_profile_id, voice_profile_revision, voice_profile_revision_id, status, payload_json,
    queued_at, claim_id, originating_request_id, exact_source_fingerprint, synthesis_payload_fingerprint,
    final_tts_input_fingerprint, generation_variant_id, execution_command_seq)
  VALUES (NEW.job_id, NEW.project_id, NEW.narration_plan_artifact_id, NEW.narration_plan_version, NEW.unit_id,
    NEW.provider, NEW.voice_profile_id, NEW.voice_profile_revision, NEW.voice_profile_revision_id, 'queued',
    NEW.payload_json, NEW.created_at, NEW.claim_id, NEW.originating_request_id, NEW.exact_source_fingerprint,
    NEW.synthesis_payload_fingerprint, NEW.final_tts_input_fingerprint, NEW.generation_variant_id, 0);
  -- 4) claim → generation_pending + 清 validation owner/candidate/lease（trg_tsc_generation_pending_dispatch
  --    验证本 command 行存在；CHECK 复核 generation_pending 所有权语义）
  UPDATE tts_synthesis_claims
  SET status='generation_pending', validation_owner_token=NULL, validation_lease_expires_at_epoch_ms=NULL,
      candidate_artifact_id=NULL, candidate_artifact_metadata_hash=NULL, updated_at=NEW.created_at
  WHERE id=NEW.claim_id AND status='validating_reuse';
  SELECT RAISE(ABORT,'tts_claim_generation_dispatches claim update failed')
    WHERE changes()=0;
END;
CREATE TRIGGER trg_tcgd_update_abort BEFORE UPDATE ON tts_claim_generation_dispatches
BEGIN SELECT RAISE(ABORT,'tts_claim_generation_dispatches is immutable'); END;
CREATE TRIGGER trg_tcgd_delete_abort BEFORE DELETE ON tts_claim_generation_dispatches
BEGIN SELECT RAISE(ABORT,'tts_claim_generation_dispatches delete forbidden'); END;
```

- **exact-one 不变量（R8-F 冻结）**：`validating_reuse` → 0 job；`generation_pending` → 恰好 1 个
  queued/running/terminal job；`running` → 恰好 1 job；reuse `succeeded` → 0 job；generated
  `succeeded/failed/cancelled/indeterminate` → 恰好 1 job（job DELETE 禁 + dispatch `UNIQUE(claim_id)`）。
- **单 commit boundary**：dispatch INSERT statement 成功 ⇔ claim=generation_pending 且恰好一个 queued job 同时
  持久化；job INSERT 失败（如 job id 冲突/trigger ABORT）→ 整条 statement 回滚，claim 保持 validating_reuse
  （实证 CJ-11）；同 claim 第二次 dispatch → `UNIQUE(claim_id)` ABORT（实证 CJ-12）。
- **append-only evidence**：dispatch command 行永久保存（job 身份字段快照 = 创建时冻结值；UPDATE/DELETE 禁）；
  `payload_json` 与 job `synthesis_payload_fingerprint` 的 exact 对应在 dispatch 前由应用层同事务重算验证
  （SQL 不可计算 fingerprint）。

### 2.2c `tts_job_execution_transitions`（第 13 表：append-only atomic claim/job execution coupling command；R12 ⑥ 重写）

> claim 与 job 的状态/所有权**唯一同步入口**。应用执行**一条 INSERT statement**；AFTER INSERT trigger 在同一
> SQLite statement 内完成验证 + claim/job 同步 UPDATE——任一验证失败 RAISE(ABORT) 则整条 statement
> 回滚：claim 与 job 状态不变、无 execution 行遗留。直接 `UPDATE tts_jobs SET status=...`
> 或 `UPDATE tts_synthesis_claims SET status=...`（出 `generation_pending`/`running`/`indeterminate`）
> 一律 ABORT（`trg_tjs_command_required` / `trg_tsc_command_required`）。
>
> **R12 修复 R11 遗留 P0（historical command replay）**：R11 的 per-column fence 用
> "EXISTS 任意历史 command 行、其字段值等于 NEW" 授权直接 UPDATE——由于 command 表 append-only，
> 历史 worker_claim/renewal/takeover/state_transition 行永久存在，攻击者可以先 worker_claim w1 →
> takeover w2，再直接 `UPDATE claim.owner_token='w1'`，fence 找到历史 worker_claim w1 错误放行，
> 形成 claim owner=w1 / job owner=w2 的 split-brain；同样可复活 terminal owner、回退 attempt/
> lease/heartbeat/error 证据。R12 采用 **applied-command chain（execution head）**：
>
> - claim 增加 `last_execution_command_id` + `execution_command_seq`（NOT NULL DEFAULT 0）；
>   job 增加同名兼容列（legacy 行 claim_id IS NULL 保持 NULL；TTS-C 行 dispatch 时 seq=0/last=NULL）；
>   两侧 head **始终相等**（同一 command 原子推进两侧）。
> - command 行增加 `previous_command_id` + `command_seq`（>=1）：第一条 command
>   （worker_claim 或 prestart_terminal）`previous_command_id IS NULL AND command_seq=1`
>   （target old head = NULL/0）；后续 command `previous_command_id = 双侧当前 head id`、
>   `command_seq = 双侧当前 seq + 1`；`UNIQUE(job_id, command_seq)` + `UNIQUE(claim_id, command_seq)`
>   保证每个 job/claim 的 chain 无重复、无跳号、不可回退、不可重复消费。
> - **direct mutation fence 一律绑定 NEW head**：受保护字段变化时必须同时满足
>   `NEW.last_execution_command_id IS NOT OLD.last_execution_command_id`、
>   `NEW.execution_command_seq IS OLD.execution_command_seq + 1`，且存在**唯一** command `e`
>   （`e.id = NEW.last_execution_command_id`、`e.previous_command_id IS OLD.last_execution_command_id`、
>   `e.command_seq = NEW.execution_command_seq`、job/claim exact、from/to = OLD/NEW status、
>   该字段与 e 对应字段逐项一致）。**历史 command 的 id/seq 永远不等于当前 head 的
>   NEW 值（seq 必须 = OLD+1、id 必须 = 该 seq 的 command），因此历史行不能授权任何直接 UPDATE。**
>
> `command_kind` 五类互斥语义保持 R11（worker_claim / lease_renewal / execution_takeover /
> prestart_terminal / state_transition），本轮强化：renewal/takeover/state_transition 的
> owner/attempt/head 校验改为 **claim↔job 精确配对 JOIN**（单一 EXISTS 内同时裁决
> `claim.owner_token = job.claimed_by`、attempt 双侧相等、head 双侧相等、status 双侧 exact），
> 不再用两个互不关联的 EXISTS。
>
> 关闭的不对称/分裂/重放状态（结构上不可提交）：
> - 历史 command 值重放（owner/lease/attempt/heartbeat/error 回旧值）→ chain fence ABORT（HR-01…11）；
> - head 回退 / 跳 seq / 只推进一侧 / 复用已消费 command → head fence ABORT（HR-09…13）；
> - command.previous_command_id 不等于当前双侧 head → chain mismatch ABORT（HR-14）；
> - command_seq 跳号或重复 → chain/UNIQUE ABORT（HR-15）；
> - running 只改 claim owner / 只改 job owner/attempt / 只更新 heartbeat → ABORT（JS-18/19/20）；
> - terminal 后 owner/claimed_by/heartbeat/attempt/error 复活 → fence + shape ABORT（JS-21/HR-06/07/08）；
> - 终态两侧 succeeded 携带不同 result_artifact_id → ABORT。

```sql
CREATE TABLE tts_job_execution_transitions (
  id TEXT PRIMARY KEY,
  -- caller 幂等键（完全相同的 transition replay 唯一拒绝；每次新的 logical transition 必须新 id）
  transition_request_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  -- R12：applied-command chain——previous_command_id 必须 = 双侧当前 execution head id；
  -- command_seq 必须 = 双侧当前 seq + 1；第一条 command（worker_claim/prestart_terminal）
  -- previous IS NULL 且 seq=1（target old head = NULL/0）
  previous_command_id TEXT,
  command_seq INTEGER NOT NULL CHECK (command_seq >= 1),
  -- R12：五类 command 显式互斥分态（每类携带本类证据字段，禁止混带他类字段——表 CHECK 强制）
  command_kind TEXT NOT NULL CHECK (command_kind IN
    ('worker_claim','lease_renewal','execution_takeover','prestart_terminal','state_transition')),
  -- 显式四状态冻结（trigger 复核两侧真实 old state；分裂状态不可提交）
  from_claim_status TEXT NOT NULL CHECK (from_claim_status IN
    ('generation_pending','running','indeterminate')),
  to_claim_status TEXT NOT NULL CHECK (to_claim_status IN
    ('running','succeeded','failed','cancelled','indeterminate')),
  from_job_status TEXT NOT NULL CHECK (from_job_status IN ('queued','running','indeterminate')),
  to_job_status TEXT NOT NULL CHECK (to_job_status IN
    ('running','succeeded','failed','cancelled','indeterminate')),
  -- Worker identity：worker_claim/execution_takeover = 新 owner；lease_renewal/state_transition = 当前
  -- owner（fence 比对）；prestart_terminal = NULL（无 owner）。fence 一律 claim↔job 精确配对。
  worker_owner_token TEXT,
  -- 新 lease：worker_claim/lease_renewal/execution_takeover 必填；prestart/state_transition NULL
  worker_lease_expires_at_epoch_ms INTEGER,
  worker_attempt INTEGER NOT NULL CHECK (worker_attempt >= 1),
  -- worker_claim/execution_takeover 必填；lease_renewal 仅 heartbeat_at 必填；prestart/state_transition 全 NULL
  claimed_at TEXT,
  heartbeat_at TEXT,
  -- 仅 state_transition succeeded 必填；非 succeeded 禁
  result_artifact_id TEXT,
  error_code TEXT,
  error_message TEXT,
  reason TEXT,
  activated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- R12：每个 job/claim 的 chain 唯一（append-only，无重复 seq / 无跳号窗口 / 不可重复消费）
  UNIQUE (job_id, command_seq),
  UNIQUE (claim_id, command_seq),
  -- R12 五类互斥 shape CHECK（同一 command 不得混带他类证据字段；renewal/takeover 双侧状态精确相等）
  CHECK (
       (command_kind='worker_claim'
        AND from_claim_status='generation_pending' AND to_claim_status='running'
        AND from_job_status='queued' AND to_job_status='running'
        AND worker_owner_token IS NOT NULL
        AND worker_lease_expires_at_epoch_ms IS NOT NULL
        AND claimed_at IS NOT NULL AND heartbeat_at IS NOT NULL
        AND result_artifact_id IS NULL AND error_code IS NULL
        AND error_message IS NULL AND reason IS NULL)
    OR (command_kind='lease_renewal'
        AND from_claim_status=to_claim_status AND from_claim_status IN ('running','indeterminate')
        AND from_job_status=to_job_status AND from_job_status IN ('running','indeterminate')
        AND from_claim_status=from_job_status
        AND worker_owner_token IS NOT NULL
        AND worker_lease_expires_at_epoch_ms IS NOT NULL
        AND claimed_at IS NULL
        AND heartbeat_at IS NOT NULL
        AND result_artifact_id IS NULL AND error_code IS NULL
        AND error_message IS NULL AND reason IS NULL)
    OR (command_kind='execution_takeover'
        AND from_claim_status=to_claim_status AND from_claim_status IN ('running','indeterminate')
        AND from_job_status=to_job_status AND from_job_status IN ('running','indeterminate')
        AND from_claim_status=from_job_status
        AND worker_owner_token IS NOT NULL
        AND worker_lease_expires_at_epoch_ms IS NOT NULL
        AND claimed_at IS NOT NULL AND heartbeat_at IS NOT NULL
        AND result_artifact_id IS NULL AND error_code IS NULL
        AND error_message IS NULL AND reason IS NULL)
    OR (command_kind='prestart_terminal'
        AND from_claim_status='generation_pending'
        AND to_claim_status IN ('failed','cancelled')
        AND from_job_status='queued'
        AND to_job_status=to_claim_status
        AND worker_owner_token IS NULL
        AND worker_lease_expires_at_epoch_ms IS NULL
        AND claimed_at IS NULL AND heartbeat_at IS NULL
        AND result_artifact_id IS NULL
        AND ((to_claim_status='failed' AND error_code IS NOT NULL)
             OR (to_claim_status='cancelled' AND (reason IS NOT NULL OR error_code IS NOT NULL))))
    OR (command_kind='state_transition'
        AND from_claim_status=from_job_status
        AND to_claim_status=to_job_status
        AND from_claim_status IN ('running','indeterminate')
        AND to_claim_status IN ('succeeded','failed','cancelled','indeterminate')
        AND NOT (from_claim_status='indeterminate' AND to_claim_status='indeterminate')
        AND worker_owner_token IS NOT NULL
        AND worker_lease_expires_at_epoch_ms IS NULL
        AND claimed_at IS NULL AND heartbeat_at IS NULL
        AND ((to_claim_status='succeeded' AND result_artifact_id IS NOT NULL
              AND error_code IS NULL AND error_message IS NULL AND reason IS NULL)
             OR (to_claim_status IN ('failed','cancelled','indeterminate')
                 AND result_artifact_id IS NULL
                 AND ((to_claim_status='failed' AND error_code IS NOT NULL)
                      OR (to_claim_status IN ('cancelled','indeterminate')
                          AND (reason IS NOT NULL OR error_code IS NOT NULL)))))))
);
-- R12 ⑥：AFTER INSERT 原子状态耦合（同一 SQLite statement 内 1→10 顺序执行；任一步 ABORT 整条回滚）
CREATE TRIGGER trg_tjet_execute AFTER INSERT ON tts_job_execution_transitions
BEGIN
  -- 1) job.claim_id == claim.id exact relation + 双侧 exact old state
  SELECT RAISE(ABORT,'tts_job_execution_transitions job claim mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM tts_jobs j
                      WHERE j.id=NEW.job_id
                        AND j.claim_id=NEW.claim_id
                        AND j.status=NEW.from_job_status)
       OR NOT EXISTS (SELECT 1 FROM tts_synthesis_claims c
                      WHERE c.id=NEW.claim_id
                        AND c.status=NEW.from_claim_status);
  -- 2) applied-command chain：双侧 execution head 必须精确相等，且
  --    previous_command_id = 当前 head id、command_seq = 当前 seq + 1
  --    （首条 command：previous IS NULL、seq=1、双侧 head = NULL/0）
  SELECT RAISE(ABORT,'tts_job_execution_transitions chain mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM tts_synthesis_claims c
                      JOIN tts_jobs j ON j.id=NEW.job_id AND j.claim_id=NEW.claim_id
                      WHERE c.id=NEW.claim_id
                        AND c.last_execution_command_id IS j.last_execution_command_id
                        AND c.execution_command_seq = j.execution_command_seq
                        AND NEW.previous_command_id IS c.last_execution_command_id
                        AND NEW.command_seq = c.execution_command_seq + 1
                        AND NEW.command_seq = j.execution_command_seq + 1);
  -- 3) worker_claim：双方必须无 owner；command lease 必须 > DB_NOW_MS；attempt 与 claim 一致
  SELECT RAISE(ABORT,'tts_job_execution_transitions ownership conflict')
    WHERE NEW.command_kind='worker_claim'
      AND (EXISTS (SELECT 1 FROM tts_synthesis_claims c
                   WHERE c.id=NEW.claim_id
                     AND (c.owner_token IS NOT NULL OR c.lease_expires_at_epoch_ms IS NOT NULL))
        OR EXISTS (SELECT 1 FROM tts_jobs j
                   WHERE j.id=NEW.job_id
                     AND (j.claimed_by IS NOT NULL OR j.claimed_at IS NOT NULL
                          OR j.heartbeat_at IS NOT NULL))
        OR NEW.worker_lease_expires_at_epoch_ms
           <= (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)));
  SELECT RAISE(ABORT,'tts_job_execution_transitions attempt mismatch')
    WHERE NEW.command_kind='worker_claim'
      AND NOT EXISTS (SELECT 1 FROM tts_synthesis_claims c
                      WHERE c.id=NEW.claim_id AND c.validation_attempt=NEW.worker_attempt);
  -- 4) lease_renewal：claim↔job 精确配对 JOIN——当前 owner 双侧 exact（且 = command owner）、
  --    双侧 attempt exact（= command attempt）、双侧 head exact、双侧 status 精确相等、
  --    旧 lease >= DB_NOW + 新 lease > 旧 lease + 新 lease > DB_NOW + heartbeat 不早于旧
  SELECT RAISE(ABORT,'tts_job_execution_transitions worker fencing mismatch')
    WHERE NEW.command_kind='lease_renewal'
      AND NOT EXISTS (SELECT 1 FROM tts_synthesis_claims c
                      JOIN tts_jobs j ON j.id=NEW.job_id AND j.claim_id=NEW.claim_id
                      WHERE c.id=NEW.claim_id
                        AND c.owner_token = j.claimed_by
                        AND c.owner_token = NEW.worker_owner_token
                        AND c.validation_attempt = j.attempt
                        AND c.validation_attempt = NEW.worker_attempt
                        AND c.status = j.status
                        AND c.last_execution_command_id = j.last_execution_command_id
                        AND c.execution_command_seq = j.execution_command_seq
                        AND c.lease_expires_at_epoch_ms >=
                            (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
                        AND NEW.worker_lease_expires_at_epoch_ms > c.lease_expires_at_epoch_ms
                        AND NEW.worker_lease_expires_at_epoch_ms >
                            (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
                        AND NEW.heartbeat_at >= COALESCE(j.heartbeat_at,'1970-01-01T00:00:00.000Z'));
  -- 5) execution_takeover：claim↔job 精确配对 JOIN——旧 owner 双侧 exact（claim.owner_token =
  --    job.claimed_by，均非 NULL）、attempt 双侧 exact（= command.worker_attempt-1）、
  --    head 双侧 exact、旧 lease < DB_NOW_MS（已过期）、新 owner 不同、新 lease > DB_NOW_MS
  SELECT RAISE(ABORT,'tts_job_execution_transitions worker fencing mismatch')
    WHERE NEW.command_kind='execution_takeover'
      AND NOT EXISTS (SELECT 1 FROM tts_synthesis_claims c
                      JOIN tts_jobs j ON j.id=NEW.job_id AND j.claim_id=NEW.claim_id
                      WHERE c.id=NEW.claim_id
                        AND c.owner_token IS NOT NULL AND j.claimed_by IS NOT NULL
                        AND c.owner_token = j.claimed_by
                        AND c.validation_attempt = j.attempt
                        AND c.validation_attempt = NEW.worker_attempt - 1
                        AND c.last_execution_command_id = j.last_execution_command_id
                        AND c.execution_command_seq = j.execution_command_seq
                        AND c.lease_expires_at_epoch_ms <
                            (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
                        AND NEW.worker_owner_token IS NOT c.owner_token
                        AND NEW.worker_lease_expires_at_epoch_ms >
                            (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)));
  -- 6) prestart_terminal：双侧无 Worker owner；attempt 与 claim 一致
  SELECT RAISE(ABORT,'tts_job_execution_transitions ownership conflict')
    WHERE NEW.command_kind='prestart_terminal'
      AND (EXISTS (SELECT 1 FROM tts_synthesis_claims c
                   WHERE c.id=NEW.claim_id
                     AND (c.owner_token IS NOT NULL OR c.lease_expires_at_epoch_ms IS NOT NULL))
        OR EXISTS (SELECT 1 FROM tts_jobs j
                   WHERE j.id=NEW.job_id
                     AND (j.claimed_by IS NOT NULL OR j.claimed_at IS NOT NULL
                          OR j.heartbeat_at IS NOT NULL))
        OR NOT EXISTS (SELECT 1 FROM tts_synthesis_claims c
                       WHERE c.id=NEW.claim_id AND c.validation_attempt=NEW.worker_attempt));
  -- 7) state_transition：claim↔job 精确配对 JOIN——owner 双侧 exact（= command owner）、
  --    双侧 attempt exact（= command attempt）、head 双侧 exact、双侧 status 精确相等、
  --    claim lease >= DB_NOW_MS
  SELECT RAISE(ABORT,'tts_job_execution_transitions worker fencing mismatch')
    WHERE NEW.command_kind='state_transition'
      AND NOT EXISTS (SELECT 1 FROM tts_synthesis_claims c
                      JOIN tts_jobs j ON j.id=NEW.job_id AND j.claim_id=NEW.claim_id
                      WHERE c.id=NEW.claim_id
                        AND c.owner_token = j.claimed_by
                        AND c.owner_token = NEW.worker_owner_token
                        AND c.validation_attempt = j.attempt
                        AND c.validation_attempt = NEW.worker_attempt
                        AND c.status = j.status
                        AND c.last_execution_command_id = j.last_execution_command_id
                        AND c.execution_command_seq = j.execution_command_seq
                        AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
                            <= c.lease_expires_at_epoch_ms);
  -- 8) result artifact job/claim identity 双绑定（仅 succeeded；表 CHECK 已强制必填/禁填）
  SELECT RAISE(ABORT,'tts_job_execution_transitions result artifact identity mismatch')
    WHERE NEW.to_job_status='succeeded'
      AND NOT EXISTS (SELECT 1 FROM sentence_audio_artifacts a
                      WHERE a.id=NEW.result_artifact_id
                        AND a.job_id=NEW.job_id
                        AND a.claim_id=NEW.claim_id);
  -- 9) UPDATE claim（按 kind 分派；always 推进 execution head）
  UPDATE tts_synthesis_claims
  SET status=NEW.to_claim_status,
      owner_token=(CASE
        WHEN NEW.command_kind IN ('worker_claim','execution_takeover') THEN NEW.worker_owner_token
        WHEN NEW.command_kind IN ('prestart_terminal','state_transition')
             AND NEW.to_claim_status IN ('succeeded','failed','cancelled') THEN NULL
        ELSE owner_token END),
      lease_expires_at_epoch_ms=(CASE
        WHEN NEW.command_kind IN ('worker_claim','lease_renewal','execution_takeover')
             THEN NEW.worker_lease_expires_at_epoch_ms
        WHEN NEW.command_kind IN ('prestart_terminal','state_transition')
             AND NEW.to_claim_status IN ('succeeded','failed','cancelled') THEN NULL
        ELSE lease_expires_at_epoch_ms END),
      validation_attempt=(CASE WHEN NEW.command_kind='execution_takeover'
                               THEN NEW.worker_attempt ELSE validation_attempt END),
      result_artifact_id=(CASE WHEN NEW.to_claim_status='succeeded' THEN NEW.result_artifact_id
                               ELSE result_artifact_id END),
      last_execution_command_id=NEW.id,
      execution_command_seq=NEW.command_seq,
      updated_at=NEW.activated_at
  WHERE id=NEW.claim_id AND status=NEW.from_claim_status;
  SELECT RAISE(ABORT,'tts_job_execution_transitions claim update failed')
    WHERE changes()=0;
  -- 10) UPDATE job（按 kind 分派；always 推进 execution head；indeterminate 保留 claimed_by 供 fence）
  UPDATE tts_jobs
  SET status=NEW.to_job_status,
      claimed_by=(CASE
        WHEN NEW.command_kind IN ('worker_claim','execution_takeover') THEN NEW.worker_owner_token
        WHEN NEW.command_kind IN ('prestart_terminal','state_transition')
             AND NEW.to_job_status IN ('succeeded','failed','cancelled') THEN NULL
        ELSE claimed_by END),
      claimed_at=(CASE
        WHEN NEW.command_kind IN ('worker_claim','execution_takeover') THEN NEW.claimed_at
        WHEN NEW.command_kind IN ('prestart_terminal','state_transition')
             AND NEW.to_job_status IN ('succeeded','failed','cancelled') THEN NULL
        ELSE claimed_at END),
      heartbeat_at=(CASE
        WHEN NEW.command_kind IN ('worker_claim','lease_renewal','execution_takeover')
             THEN NEW.heartbeat_at
        WHEN NEW.command_kind IN ('prestart_terminal','state_transition')
             AND NEW.to_job_status IN ('succeeded','failed','cancelled') THEN NULL
        ELSE heartbeat_at END),
      attempt=(CASE WHEN NEW.command_kind IN ('worker_claim','execution_takeover')
                    THEN NEW.worker_attempt ELSE attempt END),
      started_at=(CASE WHEN NEW.command_kind='worker_claim' THEN NEW.claimed_at ELSE started_at END),
      result_artifact_id=(CASE WHEN NEW.to_job_status='succeeded' THEN NEW.result_artifact_id
                               ELSE result_artifact_id END),
      error_code=(CASE WHEN NEW.to_job_status='succeeded' THEN NULL
                       WHEN NEW.to_job_status IN ('failed','cancelled','indeterminate')
                       THEN NEW.error_code ELSE error_code END),
      error_message=(CASE WHEN NEW.to_job_status='succeeded' THEN NULL
                       WHEN NEW.to_job_status IN ('failed','cancelled','indeterminate')
                       THEN NEW.error_message ELSE error_message END),
      finished_at=(CASE WHEN NEW.to_job_status IN ('succeeded','failed','cancelled')
                       THEN NEW.activated_at ELSE finished_at END),
      last_execution_command_id=NEW.id,
      execution_command_seq=NEW.command_seq
  WHERE id=NEW.job_id AND status=NEW.from_job_status;
  SELECT RAISE(ABORT,'tts_job_execution_transitions job update failed')
    WHERE changes()=0;
END;
CREATE TRIGGER trg_tjet_update_abort BEFORE UPDATE ON tts_job_execution_transitions
BEGIN SELECT RAISE(ABORT,'tts_job_execution_transitions is immutable'); END;
CREATE TRIGGER trg_tjet_delete_abort BEFORE DELETE ON tts_job_execution_transitions
BEGIN SELECT RAISE(ABORT,'tts_job_execution_transitions delete forbidden'); END;
-- R9 ① 继承：command evidence 时间不得晚于 DB 当前时间（caller 不得回填未来）
CREATE TRIGGER trg_tjet_evidence_time BEFORE INSERT ON tts_job_execution_transitions
WHEN NEW.activated_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  OR NEW.created_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  OR (NEW.claimed_at IS NOT NULL
      AND NEW.claimed_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')))
  OR (NEW.heartbeat_at IS NOT NULL
      AND NEW.heartbeat_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'tts_job_execution_transitions evidence timestamp in future'); END;
-- R12 ⑥：TTS-C job 任何状态迁移必须存在精确匹配（from,to）的 execution command 行——
--    直接 UPDATE 一律 ABORT（command 执行期间本 command 行已存在且 from/to 精确匹配，故放行；
--    legacy 行 claim_id NULL 不受限）
CREATE TRIGGER trg_tjs_command_required BEFORE UPDATE OF status ON tts_jobs
WHEN OLD.claim_id IS NOT NULL AND NEW.claim_id IS NOT NULL
  AND OLD.status IS NOT NEW.status
  AND NOT EXISTS (SELECT 1 FROM tts_job_execution_transitions e
                  WHERE e.job_id=NEW.id AND e.claim_id=NEW.claim_id
                    AND e.from_job_status=OLD.status AND e.to_job_status=NEW.status)
BEGIN SELECT RAISE(ABORT,'tts_jobs state transition requires execution command'); END;
-- R12 ⑥：claim 出 generation_pending/running/indeterminate 必须存在精确匹配（from,to）的
--    execution command 行（validating_reuse 出口走 §2.2b dispatch / §3.1 fenced finalize，不在此列）
CREATE TRIGGER trg_tsc_command_required BEFORE UPDATE OF status ON tts_synthesis_claims
WHEN OLD.status IN ('generation_pending','running','indeterminate')
  AND OLD.status IS NOT NEW.status
  AND NOT EXISTS (SELECT 1 FROM tts_job_execution_transitions e
                  WHERE e.claim_id=NEW.id
                    AND e.from_claim_status=OLD.status AND e.to_claim_status=NEW.status)
BEGIN SELECT RAISE(ABORT,'tts_synthesis_claims state transition requires execution command'); END;
-- R12：execution head 直接修改 fence（claim 侧）——head 必须精确推进到唯一 command e：
--   e.id = NEW.last_execution_command_id、e.previous_command_id IS OLD.last_execution_command_id、
--   e.command_seq = NEW.execution_command_seq = OLD.execution_command_seq+1、
--   e.from_claim_status = OLD.status、e.to_claim_status = NEW.status。
--   历史 command id/seq 无法通过（seq 必须 OLD+1；该 seq 的 command 只能是本次应用的 e）。
CREATE TRIGGER trg_tsc_head_command BEFORE UPDATE OF last_execution_command_id, execution_command_seq
  ON tts_synthesis_claims
WHEN (OLD.last_execution_command_id IS NOT NEW.last_execution_command_id
      OR OLD.execution_command_seq IS NOT NEW.execution_command_seq)
  AND NOT EXISTS (SELECT 1 FROM tts_job_execution_transitions e
                  WHERE e.claim_id=NEW.id
                    AND e.id IS NEW.last_execution_command_id
                    AND e.previous_command_id IS OLD.last_execution_command_id
                    AND e.command_seq IS NEW.execution_command_seq
                    AND NEW.execution_command_seq IS OLD.execution_command_seq+1
                    AND e.from_claim_status=OLD.status
                    AND e.to_claim_status=NEW.status)
BEGIN SELECT RAISE(ABORT,'tts_synthesis_claims execution head requires command'); END;
-- R12：execution head 直接修改 fence（job 侧；legacy 行 claim_id NULL 不受限）
CREATE TRIGGER trg_tjs_head_command BEFORE UPDATE OF last_execution_command_id, execution_command_seq
  ON tts_jobs
WHEN OLD.claim_id IS NOT NULL AND NEW.claim_id IS NOT NULL
  AND (OLD.last_execution_command_id IS NOT NEW.last_execution_command_id
       OR OLD.execution_command_seq IS NOT NEW.execution_command_seq)
  AND NOT EXISTS (SELECT 1 FROM tts_job_execution_transitions e
                  WHERE e.job_id=NEW.id AND e.claim_id=NEW.claim_id
                    AND e.id IS NEW.last_execution_command_id
                    AND e.previous_command_id IS OLD.last_execution_command_id
                    AND e.command_seq IS NEW.execution_command_seq
                    AND NEW.execution_command_seq IS OLD.execution_command_seq+1
                    AND e.from_job_status=OLD.status
                    AND e.to_job_status=NEW.status)
BEGIN SELECT RAISE(ABORT,'tts_jobs execution head requires command'); END;
-- R12：受保护字段 direct mutation fence（chain-match 模式）——任何受保护字段变化必须同时
--   推进 head 到唯一 command e（同上 head 匹配），且该字段与 e 对应字段逐项一致；
--   禁止"EXISTS 任意历史 command 字段值相等"式授权（R11 P0 根因，R12 关闭）。
CREATE TRIGGER trg_tsc_owner_command BEFORE UPDATE OF owner_token ON tts_synthesis_claims
WHEN OLD.status IN ('generation_pending','running','indeterminate')
  AND OLD.owner_token IS NOT NEW.owner_token
  AND NOT EXISTS (SELECT 1 FROM tts_job_execution_transitions e
                  WHERE e.claim_id=NEW.id
                    AND e.id IS NEW.last_execution_command_id
                    AND e.previous_command_id IS OLD.last_execution_command_id
                    AND e.command_seq IS NEW.execution_command_seq
                    AND NEW.execution_command_seq IS OLD.execution_command_seq+1
                    AND e.from_claim_status=OLD.status
                    AND e.to_claim_status=NEW.status
                    AND ((e.command_kind IN ('worker_claim','execution_takeover')
                          AND e.worker_owner_token IS NEW.owner_token)
                      OR (e.command_kind='state_transition'
                          AND e.to_claim_status IN ('succeeded','failed','cancelled')
                          AND NEW.owner_token IS NULL)))
BEGIN SELECT RAISE(ABORT,'tts_synthesis_claims owner requires execution command'); END;
CREATE TRIGGER trg_tsc_lease_command BEFORE UPDATE OF lease_expires_at_epoch_ms ON tts_synthesis_claims
WHEN OLD.status IN ('generation_pending','running','indeterminate')
  AND OLD.lease_expires_at_epoch_ms IS NOT NEW.lease_expires_at_epoch_ms
  AND NOT EXISTS (SELECT 1 FROM tts_job_execution_transitions e
                  WHERE e.claim_id=NEW.id
                    AND e.id IS NEW.last_execution_command_id
                    AND e.previous_command_id IS OLD.last_execution_command_id
                    AND e.command_seq IS NEW.execution_command_seq
                    AND NEW.execution_command_seq IS OLD.execution_command_seq+1
                    AND e.from_claim_status=OLD.status
                    AND e.to_claim_status=NEW.status
                    AND ((e.command_kind IN ('worker_claim','lease_renewal','execution_takeover')
                          AND e.worker_lease_expires_at_epoch_ms IS NEW.lease_expires_at_epoch_ms)
                      OR (e.command_kind='state_transition'
                          AND e.to_claim_status IN ('succeeded','failed','cancelled')
                          AND NEW.lease_expires_at_epoch_ms IS NULL)))
BEGIN SELECT RAISE(ABORT,'tts_synthesis_claims lease requires execution command'); END;
CREATE TRIGGER trg_tsc_attempt_command BEFORE UPDATE OF validation_attempt ON tts_synthesis_claims
WHEN OLD.status IN ('generation_pending','running','indeterminate')
  AND OLD.validation_attempt IS NOT NEW.validation_attempt
  AND NOT EXISTS (SELECT 1 FROM tts_job_execution_transitions e
                  WHERE e.claim_id=NEW.id
                    AND e.id IS NEW.last_execution_command_id
                    AND e.previous_command_id IS OLD.last_execution_command_id
                    AND e.command_seq IS NEW.execution_command_seq
                    AND NEW.execution_command_seq IS OLD.execution_command_seq+1
                    AND e.from_claim_status=OLD.status
                    AND e.to_claim_status=NEW.status
                    AND e.command_kind='execution_takeover'
                    AND e.worker_attempt IS NEW.validation_attempt
                    AND e.worker_attempt IS OLD.validation_attempt+1)
BEGIN SELECT RAISE(ABORT,'tts_synthesis_claims attempt requires execution command'); END;
CREATE TRIGGER trg_tjs_claimedby_command BEFORE UPDATE OF claimed_by ON tts_jobs
WHEN OLD.claim_id IS NOT NULL AND NEW.claim_id IS NOT NULL
  AND OLD.claimed_by IS NOT NEW.claimed_by
  AND NOT EXISTS (SELECT 1 FROM tts_job_execution_transitions e
                  WHERE e.job_id=NEW.id AND e.claim_id=NEW.claim_id
                    AND e.id IS NEW.last_execution_command_id
                    AND e.previous_command_id IS OLD.last_execution_command_id
                    AND e.command_seq IS NEW.execution_command_seq
                    AND NEW.execution_command_seq IS OLD.execution_command_seq+1
                    AND e.from_job_status=OLD.status
                    AND e.to_job_status=NEW.status
                    AND ((e.command_kind IN ('worker_claim','execution_takeover')
                          AND e.worker_owner_token IS NEW.claimed_by)
                      OR (e.command_kind='state_transition'
                          AND e.to_job_status IN ('succeeded','failed','cancelled')
                          AND NEW.claimed_by IS NULL)))
BEGIN SELECT RAISE(ABORT,'tts_jobs claimed_by requires execution command'); END;
CREATE TRIGGER trg_tjs_claimedat_command BEFORE UPDATE OF claimed_at ON tts_jobs
WHEN OLD.claim_id IS NOT NULL AND NEW.claim_id IS NOT NULL
  AND OLD.claimed_at IS NOT NEW.claimed_at
  AND NOT EXISTS (SELECT 1 FROM tts_job_execution_transitions e
                  WHERE e.job_id=NEW.id AND e.claim_id=NEW.claim_id
                    AND e.id IS NEW.last_execution_command_id
                    AND e.previous_command_id IS OLD.last_execution_command_id
                    AND e.command_seq IS NEW.execution_command_seq
                    AND NEW.execution_command_seq IS OLD.execution_command_seq+1
                    AND e.from_job_status=OLD.status
                    AND e.to_job_status=NEW.status
                    AND ((e.command_kind IN ('worker_claim','execution_takeover')
                          AND e.claimed_at IS NEW.claimed_at)
                      OR (e.command_kind='state_transition'
                          AND e.to_job_status IN ('succeeded','failed','cancelled')
                          AND NEW.claimed_at IS NULL)))
BEGIN SELECT RAISE(ABORT,'tts_jobs claimed_at requires execution command'); END;
CREATE TRIGGER trg_tjs_heartbeat_command BEFORE UPDATE OF heartbeat_at ON tts_jobs
WHEN OLD.claim_id IS NOT NULL AND NEW.claim_id IS NOT NULL
  AND OLD.heartbeat_at IS NOT NEW.heartbeat_at
  AND NOT EXISTS (SELECT 1 FROM tts_job_execution_transitions e
                  WHERE e.job_id=NEW.id AND e.claim_id=NEW.claim_id
                    AND e.id IS NEW.last_execution_command_id
                    AND e.previous_command_id IS OLD.last_execution_command_id
                    AND e.command_seq IS NEW.execution_command_seq
                    AND NEW.execution_command_seq IS OLD.execution_command_seq+1
                    AND e.from_job_status=OLD.status
                    AND e.to_job_status=NEW.status
                    AND ((e.command_kind IN ('worker_claim','lease_renewal','execution_takeover')
                          AND e.heartbeat_at IS NEW.heartbeat_at)
                      OR (e.command_kind='state_transition'
                          AND e.to_job_status IN ('succeeded','failed','cancelled')
                          AND NEW.heartbeat_at IS NULL)))
BEGIN SELECT RAISE(ABORT,'tts_jobs heartbeat_at requires execution command'); END;
CREATE TRIGGER trg_tjs_attempt_command BEFORE UPDATE OF attempt ON tts_jobs
WHEN OLD.claim_id IS NOT NULL AND NEW.claim_id IS NOT NULL
  AND OLD.attempt IS NOT NEW.attempt
  AND NOT EXISTS (SELECT 1 FROM tts_job_execution_transitions e
                  WHERE e.job_id=NEW.id AND e.claim_id=NEW.claim_id
                    AND e.id IS NEW.last_execution_command_id
                    AND e.previous_command_id IS OLD.last_execution_command_id
                    AND e.command_seq IS NEW.execution_command_seq
                    AND NEW.execution_command_seq IS OLD.execution_command_seq+1
                    AND e.from_job_status=OLD.status
                    AND e.to_job_status=NEW.status
                    AND ((e.command_kind='worker_claim' AND e.worker_attempt IS NEW.attempt)
                      OR (e.command_kind='execution_takeover'
                          AND e.worker_attempt IS NEW.attempt
                          AND e.worker_attempt IS OLD.attempt+1)))
BEGIN SELECT RAISE(ABORT,'tts_jobs attempt requires execution command'); END;
CREATE TRIGGER trg_tjs_startedat_command BEFORE UPDATE OF started_at ON tts_jobs
WHEN OLD.claim_id IS NOT NULL AND NEW.claim_id IS NOT NULL
  AND OLD.started_at IS NOT NEW.started_at
  AND NOT EXISTS (SELECT 1 FROM tts_job_execution_transitions e
                  WHERE e.job_id=NEW.id AND e.claim_id=NEW.claim_id
                    AND e.id IS NEW.last_execution_command_id
                    AND e.previous_command_id IS OLD.last_execution_command_id
                    AND e.command_seq IS NEW.execution_command_seq
                    AND NEW.execution_command_seq IS OLD.execution_command_seq+1
                    AND e.from_job_status=OLD.status
                    AND e.to_job_status=NEW.status
                    AND e.command_kind='worker_claim' AND e.claimed_at IS NEW.started_at)
BEGIN SELECT RAISE(ABORT,'tts_jobs started_at requires execution command'); END;
CREATE TRIGGER trg_tjs_finishedat_command BEFORE UPDATE OF finished_at ON tts_jobs
WHEN OLD.claim_id IS NOT NULL AND NEW.claim_id IS NOT NULL
  AND OLD.finished_at IS NOT NEW.finished_at
  AND NOT EXISTS (SELECT 1 FROM tts_job_execution_transitions e
                  WHERE e.job_id=NEW.id AND e.claim_id=NEW.claim_id
                    AND e.id IS NEW.last_execution_command_id
                    AND e.previous_command_id IS OLD.last_execution_command_id
                    AND e.command_seq IS NEW.execution_command_seq
                    AND NEW.execution_command_seq IS OLD.execution_command_seq+1
                    AND e.from_job_status=OLD.status
                    AND e.to_job_status=NEW.status
                    AND e.activated_at IS NEW.finished_at
                    AND ((e.command_kind='state_transition'
                          AND e.to_job_status IN ('succeeded','failed','cancelled'))
                      OR e.command_kind='prestart_terminal'))
BEGIN SELECT RAISE(ABORT,'tts_jobs finished_at requires execution command'); END;
CREATE TRIGGER trg_tjs_errorcode_command BEFORE UPDATE OF error_code ON tts_jobs
WHEN OLD.claim_id IS NOT NULL AND NEW.claim_id IS NOT NULL
  AND OLD.error_code IS NOT NEW.error_code
  AND NOT EXISTS (SELECT 1 FROM tts_job_execution_transitions e
                  WHERE e.job_id=NEW.id AND e.claim_id=NEW.claim_id
                    AND e.id IS NEW.last_execution_command_id
                    AND e.previous_command_id IS OLD.last_execution_command_id
                    AND e.command_seq IS NEW.execution_command_seq
                    AND NEW.execution_command_seq IS OLD.execution_command_seq+1
                    AND e.from_job_status=OLD.status
                    AND e.to_job_status=NEW.status
                    AND ((e.command_kind='state_transition'
                          AND e.to_job_status IN ('failed','cancelled','indeterminate')
                          AND e.error_code IS NEW.error_code)
                      OR (e.command_kind='state_transition'
                          AND e.to_job_status='succeeded'
                          AND NEW.error_code IS NULL)
                      OR (e.command_kind='prestart_terminal'
                          AND e.error_code IS NEW.error_code)))
BEGIN SELECT RAISE(ABORT,'tts_jobs error_code requires execution command'); END;
CREATE TRIGGER trg_tjs_errormsg_command BEFORE UPDATE OF error_message ON tts_jobs
WHEN OLD.claim_id IS NOT NULL AND NEW.claim_id IS NOT NULL
  AND OLD.error_message IS NOT NEW.error_message
  AND NOT EXISTS (SELECT 1 FROM tts_job_execution_transitions e
                  WHERE e.job_id=NEW.id AND e.claim_id=NEW.claim_id
                    AND e.id IS NEW.last_execution_command_id
                    AND e.previous_command_id IS OLD.last_execution_command_id
                    AND e.command_seq IS NEW.execution_command_seq
                    AND NEW.execution_command_seq IS OLD.execution_command_seq+1
                    AND e.from_job_status=OLD.status
                    AND e.to_job_status=NEW.status
                    AND ((e.command_kind='state_transition'
                          AND e.to_job_status IN ('failed','cancelled','indeterminate')
                          AND e.error_message IS NEW.error_message)
                      OR (e.command_kind='state_transition'
                          AND e.to_job_status='succeeded'
                          AND NEW.error_message IS NULL)
                      OR (e.command_kind='prestart_terminal'
                          AND e.error_message IS NEW.error_message)))
BEGIN SELECT RAISE(ABORT,'tts_jobs error_message requires execution command'); END;
-- R12：TTS-C job terminal owner shape——status IN (succeeded,failed,cancelled) 时
-- claimed_by/claimed_at/heartbeat_at 必须全 NULL（进入 terminal 的同一 command 写入 NULL 后
-- 后续任何复活被 per-column chain fence + 本 shape 双拒绝）
CREATE TRIGGER trg_tjs_terminal_shape BEFORE UPDATE ON tts_jobs
WHEN OLD.claim_id IS NOT NULL AND NEW.claim_id IS NOT NULL
  AND NEW.status IN ('succeeded','failed','cancelled')
  AND (NEW.claimed_by IS NOT NULL OR NEW.claimed_at IS NOT NULL
       OR NEW.heartbeat_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'tts_jobs terminal owner shape violated'); END;
```

- **claim/job 状态同步不变量（R12 ⑥ 冻结）**：
  - claim `generation_pending` ↔ job `queued`（唯一入口 = §2.2b dispatch command；双侧 head =
    NULL/0）；
  - claim `running` ↔ job `running`（唯一入口 = §2.2c command）；双侧 owner/lease/attempt 恒等
    （`claim.owner_token = job.claimed_by`、`claim.validation_attempt = job.attempt`）；
  - **execution head 恒等**：`claim.last_execution_command_id = job.last_execution_command_id`、
    `claim.execution_command_seq = job.execution_command_seq`——每应用一条 command 双侧同时 +1
    并写入该 command id；head 不可回退、不可跳号、不可只推进一侧、不可重复消费；
  - claim `succeeded` ↔ job `succeeded` ↔ 同一 `result_artifact_id`；终态双侧 owner/lease 清空；
  - claim `failed/cancelled` ↔ job `failed/cancelled`（state_transition 或 prestart_terminal；
    终态双侧 owner/lease 清空、error evidence 冻结）；
  - claim `indeterminate` ↔ job `indeterminate`（state_transition；**保留**双侧 owner/lease/attempt，
    供 renewal / takeover / resolve fence）；**indeterminate 不是终态**——只有
    `succeeded / failed / cancelled` 三个终态清 owner/lease；
  - 全部 UPDATE 必须经此命令；任一直接 UPDATE（status / owner 字段 / head）触发对应 trigger ABORT；
- **append-only evidence**：transition command 行永久保存（`transition_request_id` 唯一幂等键；
  `UNIQUE(job_id, command_seq)` + `UNIQUE(claim_id, command_seq)` 使每个 job/claim 的 chain 严格
  单调——同一 seq 不可能出现两次，跳号窗口结构上不存在；UPDATE/DELETE 禁）；
- **DB_NOW_MS fence**：`worker_lease_expires_at_epoch_ms` 由应用层 `now+TTL` 写入；worker_claim 要求
  command lease > DB_NOW_MS；lease_renewal 要求旧 lease >= DB_NOW_MS 且新 lease > 旧 lease 且
  新 lease > DB_NOW_MS；execution_takeover 要求旧 lease < DB_NOW_MS（已过期）且新 lease > DB_NOW_MS；
  state_transition 要求 claim lease >= DB_NOW_MS；比较由 trigger 内 SELECT 计算——caller 不得通过
  `activated_at`/`claimed_at`/`heartbeat_at` 回填绕过；
- **R12 ⑥ 与 §2.2b dispatch 协同**：dispatch 建 job（head=NULL/0）后由 worker_claim command
  （seq=1，previous=NULL）推 claim/job 至 running；若 subscriber 在 dispatch 与 worker_claim 之间
  全部取消，或 Scheduler 裁决无需启动 Provider，则由 **prestart_terminal** command（seq=1，
  previous=NULL）直接双侧 failed/cancelled；
- **成功终局事务边界（§8.2）**：`running→succeeded` state_transition command 是原子成功终局事务内的
  一条 statement（attempt→artifact→command→requests fan-out），不成为另一个独立事务。

### 2.3 `tts_generation_attempts`（persisted execution phase）

```sql
CREATE TABLE tts_generation_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES tts_jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  execution_phase TEXT NOT NULL CHECK (execution_phase IN
    ('created','provider_in_flight','response_persisted','file_validated','file_durable',
     'succeeded','transport_failed','validation_failed','indeterminate')),
  recovery_temp_relative_path TEXT,
  final_relative_path TEXT,
  response_hash TEXT,
  audio_sha256 TEXT CHECK (audio_sha256 IS NULL OR
    (length(audio_sha256)=64 AND audio_sha256 NOT GLOB '*[^0-9a-f]*')),
  output_size INTEGER,
  codec TEXT,
  sample_rate INTEGER,
  channels INTEGER,
  ffprobe_duration_ms INTEGER,
  provider_request_id TEXT,
  error_classification TEXT,
  usage_record_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (job_id, attempt_number),
  UNIQUE (id, job_id),
  CHECK (
       (execution_phase IN ('created','provider_in_flight')
        AND recovery_temp_relative_path IS NULL AND final_relative_path IS NULL
        AND response_hash IS NULL AND audio_sha256 IS NULL AND finished_at IS NULL)
    OR (execution_phase IN ('response_persisted','file_validated')
        AND recovery_temp_relative_path IS NOT NULL AND response_hash IS NOT NULL
        AND final_relative_path IS NULL AND finished_at IS NULL)
    OR (execution_phase='file_durable'
        AND final_relative_path IS NOT NULL AND audio_sha256 IS NOT NULL AND finished_at IS NULL)
    OR (execution_phase='succeeded'
        AND final_relative_path IS NOT NULL AND audio_sha256 IS NOT NULL AND finished_at IS NOT NULL)
    OR (execution_phase IN ('transport_failed','validation_failed')
        AND error_classification IS NOT NULL AND finished_at IS NOT NULL)
    OR (execution_phase='indeterminate' AND finished_at IS NOT NULL))
);
-- R7-H：初始状态 created
CREATE TRIGGER trg_tga_initial BEFORE INSERT ON tts_generation_attempts
WHEN NEW.execution_phase IS NOT 'created'
BEGIN SELECT RAISE(ABORT,'tts_generation_attempts initial state created required'); END;
-- R7-VI-03：attempt.provider == job.provider（INSERT + UPDATE OF provider）
CREATE TRIGGER trg_tga_job_provider BEFORE INSERT ON tts_generation_attempts
WHEN NEW.provider IS NOT (SELECT provider FROM tts_jobs WHERE id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'tts_generation_attempts provider mismatch'); END;
CREATE TRIGGER trg_tga_job_provider_update BEFORE UPDATE OF provider ON tts_generation_attempts
WHEN NEW.provider IS NOT (SELECT provider FROM tts_jobs WHERE id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'tts_generation_attempts provider mismatch'); END;
CREATE TRIGGER trg_tga_immutable BEFORE UPDATE ON tts_generation_attempts
WHEN OLD.job_id IS NOT NEW.job_id OR OLD.attempt_number IS NOT NEW.attempt_number
  OR OLD.provider IS NOT NEW.provider OR OLD.model IS NOT NEW.model
  OR OLD.request_hash IS NOT NEW.request_hash OR OLD.request_json IS NOT NEW.request_json
  OR OLD.started_at IS NOT NEW.started_at
BEGIN SELECT RAISE(ABORT,'tts_generation_attempts immutable field'); END;
CREATE TRIGGER trg_tga_transition BEFORE UPDATE OF execution_phase ON tts_generation_attempts
WHEN OLD.execution_phase IS NOT NEW.execution_phase AND NOT (
     (OLD.execution_phase='created'             AND NEW.execution_phase IN ('provider_in_flight','transport_failed'))
  OR (OLD.execution_phase='provider_in_flight'  AND NEW.execution_phase IN ('response_persisted','transport_failed','indeterminate'))
  OR (OLD.execution_phase='response_persisted'  AND NEW.execution_phase IN ('file_validated','validation_failed','indeterminate'))
  OR (OLD.execution_phase='file_validated'      AND NEW.execution_phase IN ('file_durable','validation_failed','indeterminate'))
  OR (OLD.execution_phase='file_durable'        AND NEW.execution_phase IN ('succeeded','indeterminate')))
BEGIN SELECT RAISE(ABORT,'tts_generation_attempts invalid transition'); END;
CREATE TRIGGER trg_tga_delete_abort BEFORE DELETE ON tts_generation_attempts
BEGIN SELECT RAISE(ABORT,'tts_generation_attempts delete forbidden'); END;
-- R6-B：attempt 证据 phase-aware、write-once、terminal immutable（不限于限制 execution_phase 变化）
CREATE TRIGGER trg_tga_evidence BEFORE UPDATE ON tts_generation_attempts
WHEN (
  -- 1) write-once：任何已写入的证据字段不得改写（含 file_durable 后的 final path/audio 证据与 usage_record_id）
     (OLD.provider_request_id IS NOT NULL AND NEW.provider_request_id IS NOT OLD.provider_request_id)
  OR (OLD.recovery_temp_relative_path IS NOT NULL AND NEW.recovery_temp_relative_path IS NOT OLD.recovery_temp_relative_path)
  OR (OLD.response_hash IS NOT NULL AND NEW.response_hash IS NOT OLD.response_hash)
  OR (OLD.audio_sha256 IS NOT NULL AND NEW.audio_sha256 IS NOT OLD.audio_sha256)
  OR (OLD.output_size IS NOT NULL AND NEW.output_size IS NOT OLD.output_size)
  OR (OLD.codec IS NOT NULL AND NEW.codec IS NOT OLD.codec)
  OR (OLD.sample_rate IS NOT NULL AND NEW.sample_rate IS NOT OLD.sample_rate)
  OR (OLD.channels IS NOT NULL AND NEW.channels IS NOT OLD.channels)
  OR (OLD.ffprobe_duration_ms IS NOT NULL AND NEW.ffprobe_duration_ms IS NOT OLD.ffprobe_duration_ms)
  OR (OLD.final_relative_path IS NOT NULL AND NEW.final_relative_path IS NOT OLD.final_relative_path)
  OR (OLD.usage_record_id IS NOT NULL AND NEW.usage_record_id IS NOT OLD.usage_record_id)
  OR (OLD.error_classification IS NOT NULL AND NEW.error_classification IS NOT OLD.error_classification)
  -- 2) terminal freeze：succeeded/transport_failed/validation_failed/indeterminate 全部证据字段不得增改删（含 NULL→value）
  OR (
       OLD.execution_phase IN ('succeeded','transport_failed','validation_failed','indeterminate')
       AND (
              NEW.provider_request_id IS NOT OLD.provider_request_id
           OR NEW.recovery_temp_relative_path IS NOT OLD.recovery_temp_relative_path
           OR NEW.response_hash IS NOT OLD.response_hash
           OR NEW.audio_sha256 IS NOT OLD.audio_sha256
           OR NEW.output_size IS NOT OLD.output_size
           OR NEW.codec IS NOT OLD.codec
           OR NEW.sample_rate IS NOT OLD.sample_rate
           OR NEW.channels IS NOT OLD.channels
           OR NEW.ffprobe_duration_ms IS NOT OLD.ffprobe_duration_ms
           OR NEW.final_relative_path IS NOT OLD.final_relative_path
           OR NEW.usage_record_id IS NOT OLD.usage_record_id
           OR NEW.error_classification IS NOT OLD.error_classification
           OR NEW.finished_at IS NOT OLD.finished_at
       )
  )
  -- 3) phase window：证据字段只能在指定 phase 首次写入（禁止早写/迟写；列表 = 禁止首次写入的 phase）
  OR (NEW.provider_request_id IS NOT NULL AND OLD.provider_request_id IS NULL
      AND NEW.execution_phase IN ('created','succeeded','transport_failed','validation_failed','indeterminate'))
  OR (NEW.recovery_temp_relative_path IS NOT NULL AND OLD.recovery_temp_relative_path IS NULL
      AND NEW.execution_phase IN ('created','provider_in_flight','succeeded','transport_failed','validation_failed','indeterminate'))
  OR (NEW.response_hash IS NOT NULL AND OLD.response_hash IS NULL
      AND NEW.execution_phase IN ('created','provider_in_flight','succeeded','transport_failed','validation_failed','indeterminate'))
  OR (NEW.audio_sha256 IS NOT NULL AND OLD.audio_sha256 IS NULL
      AND NEW.execution_phase IN ('created','provider_in_flight','response_persisted','succeeded','transport_failed','validation_failed','indeterminate'))
  OR (NEW.output_size IS NOT NULL AND OLD.output_size IS NULL
      AND NEW.execution_phase IN ('created','provider_in_flight','response_persisted','succeeded','transport_failed','validation_failed','indeterminate'))
  OR (NEW.codec IS NOT NULL AND OLD.codec IS NULL
      AND NEW.execution_phase IN ('created','provider_in_flight','response_persisted','succeeded','transport_failed','validation_failed','indeterminate'))
  OR (NEW.sample_rate IS NOT NULL AND OLD.sample_rate IS NULL
      AND NEW.execution_phase IN ('created','provider_in_flight','response_persisted','succeeded','transport_failed','validation_failed','indeterminate'))
  OR (NEW.channels IS NOT NULL AND OLD.channels IS NULL
      AND NEW.execution_phase IN ('created','provider_in_flight','response_persisted','succeeded','transport_failed','validation_failed','indeterminate'))
  OR (NEW.ffprobe_duration_ms IS NOT NULL AND OLD.ffprobe_duration_ms IS NULL
      AND NEW.execution_phase IN ('created','provider_in_flight','response_persisted','succeeded','transport_failed','validation_failed','indeterminate'))
  OR (NEW.final_relative_path IS NOT NULL AND OLD.final_relative_path IS NULL
      AND NEW.execution_phase IN ('created','provider_in_flight','response_persisted','file_validated','succeeded','transport_failed','validation_failed','indeterminate'))
  OR (NEW.usage_record_id IS NOT NULL AND OLD.usage_record_id IS NULL
      AND NEW.execution_phase IN ('created','succeeded','transport_failed','validation_failed','indeterminate'))
  OR (NEW.error_classification IS NOT NULL AND OLD.error_classification IS NULL
      AND NEW.execution_phase IN ('created','provider_in_flight','response_persisted','file_validated','file_durable','succeeded'))
)
BEGIN SELECT RAISE(ABORT,'tts_generation_attempts evidence immutable'); END;
```

- **合法来源逐项（R5 冻结）**：`transport_failed` ← `created | provider_in_flight`；
  `validation_failed` ← `response_persisted | file_validated`；
  `indeterminate` ← `provider_in_flight | response_persisted | file_validated | file_durable`；
  **`succeeded` 终态不得再进入任何状态**；`transport_failed/validation_failed/indeterminate` 同为 attempt 终态（重试 = 新 attempt 行，`UNIQUE(job_id, attempt_number)`）。
- **证据写入权限表（R6-B 冻结，`trg_tga_evidence` 逐条强制）**：

  | 证据字段 | 允许首次写入的 phase | file_durable 后 | 终态后 |
  |---|---|---|---|
  | `provider_request_id` | provider_in_flight / response_persisted / file_validated / file_durable | 冻结 | 冻结 |
  | `recovery_temp_relative_path` / `response_hash` | response_persisted / file_validated / file_durable | 冻结 | 冻结 |
  | `audio_sha256` / `output_size` / `codec` / `sample_rate` / `channels` / `ffprobe_duration_ms` | file_validated / file_durable | 冻结 | 冻结 |
  | `final_relative_path` | 仅 file_durable | **冻结** | 冻结 |
  | `usage_record_id` | provider_in_flight / response_persisted / file_validated / file_durable | **冻结** | 冻结 |
  | `error_classification` | 仅 transport_failed / validation_failed / indeterminate | — | 冻结 |
  | `finished_at` | 仅终态转移（transport_failed / validation_failed / indeterminate / succeeded） | — | 冻结 |

  三层强制：① **write-once**——任何已写证据字段不得改写（含 `file_durable` 后 `final_relative_path/audio_sha256/
  output_size/codec/sample_rate/channels/ffprobe_duration_ms/response_hash/provider_request_id/usage_record_id`）；
  ② **terminal freeze**——`succeeded/transport_failed/validation_failed/indeterminate` 后全部证据字段不可增改删（含 NULL→value）；
  ③ **phase window**——字段只能在指定 phase 首次写入（禁止 created 早写 / 终态迟写）。
  这保证 `file_durable` 后字节证据完全冻结，**不依赖 execution_phase 转移限制**。
- `UNIQUE(id, job_id)` 是 `sentence_audio_artifacts` composite FK 的父键（§2.4）。
- **R7-H/I**：INSERT 初始状态只能是 `created`（`trg_tga_initial`，禁直接 INSERT terminal phase）；
  `attempt.provider == job.provider`（INSERT + UPDATE OF provider 双 trigger，实证 VI-03）。
- **authoritative**：execution phase 持久化真相（crash recovery 依据）。

### 2.4 `sentence_audio_artifacts`（immutable result；relational provenance 闭包）

```sql
CREATE TABLE sentence_audio_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL DEFAULT 'sentence-audio-artifact@1.0',
  unit_id TEXT NOT NULL CHECK (unit_id GLOB 'N[0-9][0-9][0-9]'),
  narration_plan_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  narration_plan_content_hash TEXT NOT NULL,
  assignment_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  assignment_content_hash TEXT NOT NULL,
  performance_plan_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  performance_plan_content_hash TEXT NOT NULL,
  voice_profile_id TEXT NOT NULL REFERENCES voice_profiles(id) ON DELETE RESTRICT,
  voice_profile_revision_id TEXT NOT NULL REFERENCES voice_profile_revisions(id) ON DELETE RESTRICT,
  canonical_audio_sha256 TEXT NOT NULL CHECK
    (length(canonical_audio_sha256)=64 AND canonical_audio_sha256 NOT GLOB '*[^0-9a-f]*'),
  exact_source_fingerprint TEXT NOT NULL,
  synthesis_payload_fingerprint TEXT NOT NULL,
  final_tts_input_fingerprint TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_version TEXT,
  provider_commit TEXT,
  capability_compiler_version TEXT NOT NULL,
  capability_snapshot_json TEXT NOT NULL,
  compiled_payload_json TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  successful_attempt_id TEXT NOT NULL,
  originating_request_id TEXT,
  output_relative_path TEXT NOT NULL CHECK
    (output_relative_path <> '..' AND output_relative_path NOT LIKE '/%'
     AND output_relative_path NOT GLOB '../*' AND output_relative_path NOT GLOB '*/..'
     AND output_relative_path NOT GLOB '*/../*' AND output_relative_path NOT GLOB '*\*'
     AND length(output_relative_path) > 0),
  audio_sha256 TEXT NOT NULL CHECK
    (length(audio_sha256)=64 AND audio_sha256 NOT GLOB '*[^0-9a-f]*'),
  output_size INTEGER NOT NULL CHECK (output_size > 0),
  codec TEXT NOT NULL,
  sample_rate INTEGER NOT NULL CHECK (sample_rate > 0),
  channels INTEGER NOT NULL CHECK (channels > 0),
  ffprobe_duration_ms INTEGER NOT NULL CHECK (ffprobe_duration_ms >= 0),
  generation_variant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL,
  FOREIGN KEY (claim_id) REFERENCES tts_synthesis_claims(id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id, claim_id) REFERENCES tts_jobs(id, claim_id) ON DELETE RESTRICT,
  FOREIGN KEY (successful_attempt_id, job_id) REFERENCES tts_generation_attempts(id, job_id) ON DELETE RESTRICT
);
CREATE TRIGGER trg_saa_provenance BEFORE INSERT ON sentence_audio_artifacts
BEGIN
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: attempt not in succeeded phase')
    WHERE (SELECT execution_phase FROM tts_generation_attempts WHERE id=NEW.successful_attempt_id)
          IS NOT 'succeeded';
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: project mismatch')
    WHERE NEW.project_id IS NOT (SELECT project_id FROM tts_jobs WHERE id=NEW.job_id)
       OR NEW.project_id IS NOT (SELECT project_id FROM tts_synthesis_claims WHERE id=NEW.claim_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: unit mismatch')
    WHERE NEW.unit_id IS NOT (SELECT unit_id FROM tts_jobs WHERE id=NEW.job_id)
       OR NEW.unit_id IS NOT (SELECT unit_id FROM tts_synthesis_claims WHERE id=NEW.claim_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: fingerprint/variant mismatch')
    WHERE NEW.final_tts_input_fingerprint IS NOT (SELECT final_tts_input_fingerprint FROM tts_synthesis_claims WHERE id=NEW.claim_id)
       OR NEW.generation_variant_id IS NOT (SELECT generation_variant_id FROM tts_synthesis_claims WHERE id=NEW.claim_id)
       OR NEW.final_tts_input_fingerprint IS NOT (SELECT final_tts_input_fingerprint FROM tts_jobs WHERE id=NEW.job_id)
       OR NEW.generation_variant_id IS NOT (SELECT generation_variant_id FROM tts_jobs WHERE id=NEW.job_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: exact source fingerprint mismatch')
    WHERE NEW.exact_source_fingerprint IS NOT (SELECT exact_source_fingerprint FROM tts_jobs WHERE id=NEW.job_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: synthesis payload fingerprint mismatch')
    WHERE NEW.synthesis_payload_fingerprint IS NOT (SELECT synthesis_payload_fingerprint FROM tts_jobs WHERE id=NEW.job_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: narration plan identity mismatch')
    WHERE NEW.narration_plan_artifact_id IS NOT (SELECT narration_plan_artifact_id FROM tts_jobs WHERE id=NEW.job_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: narration plan artifact invalid')
    WHERE NOT EXISTS (SELECT 1 FROM artifacts WHERE id=NEW.narration_plan_artifact_id
                      AND kind='narration_plan_v2' AND project_id=NEW.project_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: assignment artifact invalid')
    WHERE NOT EXISTS (SELECT 1 FROM artifacts WHERE id=NEW.assignment_artifact_id
                      AND kind='project_voice_assignment' AND project_id=NEW.project_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: performance plan artifact invalid')
    WHERE NOT EXISTS (SELECT 1 FROM artifacts WHERE id=NEW.performance_plan_artifact_id
                      AND kind='narration_performance_plan' AND project_id=NEW.project_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: voice revision pair mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM voice_profile_revisions r
                      WHERE r.id=NEW.voice_profile_revision_id
                      AND r.voice_profile_id=NEW.voice_profile_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: canonical sha256 mismatch')
    WHERE NEW.canonical_audio_sha256 IS NOT (SELECT canonical_audio_sha256 FROM voice_profile_revisions WHERE id=NEW.voice_profile_revision_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: provider mismatch')
    WHERE NEW.provider IS NOT (SELECT provider FROM tts_generation_attempts WHERE id=NEW.successful_attempt_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: model mismatch')
    WHERE NEW.model IS NOT (SELECT model FROM tts_generation_attempts WHERE id=NEW.successful_attempt_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: path mismatch')
    WHERE NEW.output_relative_path IS NOT (SELECT final_relative_path FROM tts_generation_attempts WHERE id=NEW.successful_attempt_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: audio sha256 mismatch')
    WHERE NEW.audio_sha256 IS NOT (SELECT audio_sha256 FROM tts_generation_attempts WHERE id=NEW.successful_attempt_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: output size mismatch')
    WHERE NEW.output_size IS NOT (SELECT output_size FROM tts_generation_attempts WHERE id=NEW.successful_attempt_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: codec mismatch')
    WHERE NEW.codec IS NOT (SELECT codec FROM tts_generation_attempts WHERE id=NEW.successful_attempt_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: sample rate mismatch')
    WHERE NEW.sample_rate IS NOT (SELECT sample_rate FROM tts_generation_attempts WHERE id=NEW.successful_attempt_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: channels mismatch')
    WHERE NEW.channels IS NOT (SELECT channels FROM tts_generation_attempts WHERE id=NEW.successful_attempt_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: duration mismatch')
    WHERE NEW.ffprobe_duration_ms IS NOT (SELECT ffprobe_duration_ms FROM tts_generation_attempts WHERE id=NEW.successful_attempt_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: job voice profile mismatch')
    WHERE NEW.voice_profile_id IS NOT (SELECT voice_profile_id FROM tts_jobs WHERE id=NEW.job_id)
       OR NEW.voice_profile_revision_id IS NOT (SELECT voice_profile_revision_id FROM tts_jobs WHERE id=NEW.job_id);
  SELECT RAISE(ABORT,'sentence_audio_artifacts provenance: job provider mismatch')
    WHERE NEW.provider IS NOT (SELECT provider FROM tts_jobs WHERE id=NEW.job_id);
END;
CREATE TRIGGER trg_saa_update_abort BEFORE UPDATE ON sentence_audio_artifacts
BEGIN SELECT RAISE(ABORT,'sentence_audio_artifacts is immutable'); END;
CREATE TRIGGER trg_saa_delete_abort BEFORE DELETE ON sentence_audio_artifacts
BEGIN SELECT RAISE(ABORT,'sentence_audio_artifacts delete forbidden'); END;
```

- **relational provenance 闭包（三层强制）**：
  1. **composite FK**：`(job_id, claim_id) REFERENCES tts_jobs(id, claim_id)` —— artifact 的 job 必须属于该 claim；
     `(successful_attempt_id, job_id) REFERENCES tts_generation_attempts(id, job_id)` —— attempt 必须属于该 job；
     父键 `uq_tts_jobs_id_claim` / `tts_generation_attempts.UNIQUE(id, job_id)`；
  2. **BEFORE INSERT trigger**（`trg_saa_provenance`，R6-C 全闭包）：
     - attempt 必须是 `execution_phase='succeeded'` 的 exact successful attempt；
     - `project_id / unit_id / final_tts_input_fingerprint / generation_variant_id` 与 claim、job 逐项一致；
     - **`exact_source_fingerprint` / `synthesis_payload_fingerprint` 与 job 逐项一致（R6-C 新增）**；
     - **`output_relative_path` / `audio_sha256` / `output_size` / `codec` / `sample_rate` / `channels` /
       `ffprobe_duration_ms` 与 attempt 逐项一致（R6-C 新增字节证据闭包）**；
     - **`provider` / `model` 与 attempt 逐项一致（R6-C 新增）**；
     - **`canonical_audio_sha256` 与 exact Voice Revision 行一致（R6-C 新增）**；
     - **`voice_profile_id` / `voice_profile_revision_id` 与 job 逐项一致；`provider` 与 job 一致（R7-VI-04 新增）**；
     - narration plan 与 job 冻结的 `narration_plan_artifact_id` 完全一致（exact source identity）；
     - assignment/performance/narration artifact 必须是 `artifacts` 表中**同 project、正确 kind** 的真实行；
     - voice revision 必须 `voice_profile_id` 精确配对（pair trigger，不只检查两个 ID 分别存在）；
  3. **应用层边界（同事务，非 SQL 可表达）**：`*_content_hash` 与 artifacts 行 canonical JSON sha256 的一致性、
     fingerprint 语义值（exact/synthesis/final 的规范构成）、voice revision 文件与行的一致性，
     由 final success transaction 内的 **fenced 重读逐项比较**强制（§8.2 列出 exact reread 清单）；
     fingerprint 一致性已由 trigger 覆盖（hash/ID 均已编入 fingerprint）。
- **字段语义（R6-D 冻结）**：`claim_id` = **producing claim**（INSERT 时固定，不可改）；`job_id` = **producing job**；
  reuse 复用路径下其它 claim 的 `result_artifact_id` 指向本 artifact 时，`artifact.claim_id` 仍是原 producing claim——
  因此**所有 consumer/request 真相 = `SELECT * FROM tts_audio_requests WHERE result_artifact_id = :artifact_id`**
  （fan-in 跨 producing/reuse claim 全量命中）；**不得**声称通过 producing `claim_id` 可查询全部 reuse consumers
  （实证 IS-20：按 result_artifact_id 得 2 个 consumer，按 producing claim_id 只得 1 个）。
- **不可变**：UPDATE/DELETE 全禁（trigger ABORT）；**无 fingerprint UNIQUE**（多 immutable candidate 合法共存）；
- `originating_request_id` 仅审计 provenance；
- **authoritative reader**：`validateSentenceAudioArtifactExact`（schema 可解析、resolve/realpath/regular-file/非 symlink/root containment、
  audio_sha256、output_size、codec/sr/ch、duration 全检；damaged → fail-closed）——reader 边界与 DB CHECK 边界分离（§0）；
- **API redaction**：`output_relative_path` 永不序列化输出。
- **profile/revision pair 不采用 composite FK 的原因**：父键需要 `voice_profile_revisions` 上的
  `UNIQUE(voice_profile_id, id)` 冗余索引——触碰 TTS-A FROZEN 表；选择子表 pair trigger（等价强制力，零冻结表改动）。

### 2.5 `voice_materialization_requests`（project-scoped envelope；R7-G initializing）

```sql
CREATE TABLE voice_materialization_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  voice_profile_id TEXT NOT NULL REFERENCES voice_profiles(id) ON DELETE RESTRICT,
  voice_profile_revision_id TEXT NOT NULL REFERENCES voice_profile_revisions(id) ON DELETE RESTRICT,
  assignment_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL,
  job_id TEXT REFERENCES voice_materialization_jobs(id) ON DELETE SET NULL,
  materialization_id TEXT REFERENCES voice_materializations(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN
    ('initializing','waiting','running','succeeded','reused','failed','cancelled','indeterminate')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, request_id),
  CHECK (
       (status='initializing' AND job_id IS NULL AND materialization_id IS NULL)
    OR (status IN ('succeeded','reused') AND materialization_id IS NOT NULL)
    OR (status IN ('waiting','running','indeterminate')
        AND materialization_id IS NULL AND job_id IS NOT NULL)
    OR (status IN ('failed','cancelled') AND materialization_id IS NULL))
);
-- R7-H：初始状态 initializing
CREATE TRIGGER trg_vmr_initial BEFORE INSERT ON voice_materialization_requests
WHEN NEW.status IS NOT 'initializing'
BEGIN SELECT RAISE(ABORT,'voice_materialization_requests initial state initializing required'); END;
CREATE TRIGGER trg_vmr_pair BEFORE INSERT ON voice_materialization_requests
BEGIN
  SELECT RAISE(ABORT,'voice_materialization_requests voice revision pair mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM voice_profile_revisions r
                      WHERE r.id=NEW.voice_profile_revision_id
                      AND r.voice_profile_id=NEW.voice_profile_id);
  SELECT RAISE(ABORT,'voice_materialization_requests assignment artifact invalid')
    WHERE NOT EXISTS (SELECT 1 FROM artifacts WHERE id=NEW.assignment_artifact_id
                      AND kind='project_voice_assignment' AND project_id=NEW.project_id);
END;
CREATE TRIGGER trg_vmr_immutable BEFORE UPDATE ON voice_materialization_requests
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.request_id IS NOT NEW.request_id
  OR OLD.voice_profile_id IS NOT NEW.voice_profile_id
  OR OLD.voice_profile_revision_id IS NOT NEW.voice_profile_revision_id
  OR OLD.assignment_artifact_id IS NOT NEW.assignment_artifact_id
  OR OLD.request_fingerprint IS NOT NEW.request_fingerprint
  OR (OLD.job_id IS NOT NULL AND OLD.job_id IS NOT NEW.job_id)
  OR (OLD.materialization_id IS NOT NULL AND OLD.materialization_id IS NOT NEW.materialization_id)
  OR (OLD.status IN ('succeeded','reused') AND (
        NEW.job_id IS NOT OLD.job_id
     OR NEW.materialization_id IS NOT OLD.materialization_id
     OR NEW.status IS NOT OLD.status))
BEGIN SELECT RAISE(ABORT,'voice_materialization_requests immutable field'); END;
CREATE TRIGGER trg_vmr_transition BEFORE UPDATE OF status ON voice_materialization_requests
WHEN OLD.status IS NOT NEW.status AND NOT (
     (OLD.status='initializing' AND NEW.status IN ('waiting','cancelled','failed'))
  OR (OLD.status='waiting' AND NEW.status IN ('running','succeeded','reused','failed','cancelled','indeterminate'))
  OR (OLD.status='running' AND NEW.status IN ('succeeded','failed','cancelled','indeterminate'))
  OR (OLD.status='indeterminate' AND NEW.status IN ('succeeded','failed','cancelled')))
BEGIN SELECT RAISE(ABORT,'voice_materialization_requests invalid transition'); END;
-- R8-H：initializing → waiting 必须已链接 exact job（job profile/revision identity 由
-- trg_vmr_job_link_update 同事务强制；无 job 的 committed waiting 行结构上不可能）
CREATE TRIGGER trg_vmr_waiting_link BEFORE UPDATE OF status ON voice_materialization_requests
WHEN OLD.status='initializing' AND NEW.status='waiting' AND NEW.job_id IS NULL
BEGIN SELECT RAISE(ABORT,'voice_materialization_requests waiting requires job link'); END;
CREATE TRIGGER trg_vmr_delete_abort BEFORE DELETE ON voice_materialization_requests
BEGIN SELECT RAISE(ABORT,'voice_materialization_requests delete forbidden'); END;
-- R6-E：job/materialization 链接 identity 校验（与 request 的 profile/revision 一致；
-- job_id / materialization_id write-once 由 immutable 覆盖；succeeded/reused 终态链接不可改）
CREATE TRIGGER trg_vmr_job_link BEFORE INSERT ON voice_materialization_requests
WHEN NEW.job_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'voice_materialization_requests job identity mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM voice_materialization_jobs j
                      WHERE j.id=NEW.job_id
                        AND j.voice_profile_id=NEW.voice_profile_id
                        AND j.voice_profile_revision_id=NEW.voice_profile_revision_id);
END;
CREATE TRIGGER trg_vmr_job_link_update BEFORE UPDATE OF job_id ON voice_materialization_requests
WHEN NEW.job_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'voice_materialization_requests job identity mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM voice_materialization_jobs j
                      WHERE j.id=NEW.job_id
                        AND j.voice_profile_id=NEW.voice_profile_id
                        AND j.voice_profile_revision_id=NEW.voice_profile_revision_id);
END;
CREATE TRIGGER trg_vmr_mat_link BEFORE INSERT ON voice_materialization_requests
WHEN NEW.materialization_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'voice_materialization_requests materialization identity mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM voice_materializations m
                      WHERE m.id=NEW.materialization_id
                        AND m.voice_profile_id=NEW.voice_profile_id
                        AND m.voice_profile_revision_id=NEW.voice_profile_revision_id);
END;
CREATE TRIGGER trg_vmr_mat_link_update BEFORE UPDATE OF materialization_id ON voice_materialization_requests
WHEN NEW.materialization_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'voice_materialization_requests materialization identity mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM voice_materializations m
                      WHERE m.id=NEW.materialization_id
                        AND m.voice_profile_id=NEW.voice_profile_id
                        AND m.voice_profile_revision_id=NEW.voice_profile_revision_id);
END;
```

- **requestId scope = (project_id, request_id)**；同 scope 同 requestId：same exact profile/revision/assignment/source → replay；different identity → 409 `REQUEST_ID_CONFLICT`；
- **initializing 语义（R7-G + R8-H，与 §2.1 对称）**：只占用 `(project_id, request_id)`；`job_id/materialization_id` 必须 NULL；
  不计 subscriber、Scheduler 不可见；`initializing → waiting` 同一事务完成 exact link——**R8-H：`waiting` 必须
  `job_id` 非 NULL（`trg_vmr_waiting_link` + CHECK 双重强制），无 job 的 committed waiting 行结构上不可能**；
  crash 前回滚不产生 committed initializing；推荐不允许长期 committed initializing（清理走 `initializing → cancelled/failed`）。
- **终态语义（R5 冻结，禁止混写）**：existing projection 复用 → **`reused`**（`waiting → reused`，无 running）；
  新复制成功 → **`succeeded`**（`waiting/running → succeeded`，共享 job fan-out 时 envelope 可从 waiting 直接 succeeded）；
  两者都必须带 `materialization_id`；`failed/cancelled` 不得带 `materialization_id`（CHECK 强制，不得伪装成功）；
- **链接封存（R6-E）**：`job_id` / `materialization_id` 各自**首次非 NULL 后不可改**；`succeeded/reused` 终态
  job/materialization/status linkage 不可改；`job_id` 写入时 job 的 profile/revision 必须与 request 一致，
  `materialization_id` 写入时 projection 的 profile/revision 必须与 request 一致（identity link trigger）。
- Assignment artifact 必须属于同一 `project_id` 且 kind=`project_voice_assignment`（FK + pair trigger 双强制）。

### 2.6 `voice_materialization_jobs`（mutable Worker execution；fenced single-flight；R9 ① database-time fencing）

```sql
CREATE TABLE voice_materialization_jobs (
  id TEXT PRIMARY KEY,
  voice_profile_id TEXT NOT NULL REFERENCES voice_profiles(id) ON DELETE RESTRICT,
  voice_profile_revision_id TEXT NOT NULL REFERENCES voice_profile_revisions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN
    ('validating_existing','queued','running','succeeded','failed','cancelled','indeterminate')),
  owner_token TEXT,
  -- R9 ①：lease 列统一 INTEGER epoch milliseconds（UTC）
  lease_expires_at_epoch_ms INTEGER,
  heartbeat_at TEXT,
  validation_owner_token TEXT,
  validation_lease_expires_at_epoch_ms INTEGER,
  validation_attempt INTEGER NOT NULL DEFAULT 0,
  candidate_materialization_id TEXT REFERENCES voice_materializations(id) ON DELETE RESTRICT,
  candidate_materialization_metadata_hash TEXT,
  source_canonical_sha256 TEXT NOT NULL CHECK
    (length(source_canonical_sha256)=64 AND source_canonical_sha256 NOT GLOB '*[^0-9a-f]*'),
  adapter_compatibility_key TEXT NOT NULL,
  destination_voice_root_relative_path TEXT NOT NULL CHECK
    (destination_voice_root_relative_path <> '..'
     AND destination_voice_root_relative_path NOT LIKE '/%'
     AND destination_voice_root_relative_path NOT GLOB '../*'
     AND destination_voice_root_relative_path NOT GLOB '*/..'
     AND destination_voice_root_relative_path NOT GLOB '*/../*'
     AND destination_voice_root_relative_path NOT GLOB '*\*'
     AND length(destination_voice_root_relative_path) > 0),
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
       (status='validating_existing'
        AND validation_owner_token IS NOT NULL AND validation_lease_expires_at_epoch_ms IS NOT NULL
        AND validation_attempt >= 1
        AND owner_token IS NULL AND lease_expires_at_epoch_ms IS NULL AND heartbeat_at IS NULL)
    OR (status='queued'
        AND validation_owner_token IS NULL AND validation_lease_expires_at_epoch_ms IS NULL
        AND owner_token IS NULL AND lease_expires_at_epoch_ms IS NULL AND heartbeat_at IS NULL)
    OR (status='running'
        AND owner_token IS NOT NULL AND lease_expires_at_epoch_ms IS NOT NULL AND heartbeat_at IS NOT NULL
        AND validation_owner_token IS NULL AND validation_lease_expires_at_epoch_ms IS NULL)
    OR (status IN ('succeeded','failed','cancelled','indeterminate')
        AND owner_token IS NULL AND lease_expires_at_epoch_ms IS NULL AND heartbeat_at IS NULL
        AND validation_owner_token IS NULL AND validation_lease_expires_at_epoch_ms IS NULL))
);
CREATE UNIQUE INDEX uq_voice_materialization_jobs_active
ON voice_materialization_jobs (voice_profile_id, voice_profile_revision_id)
WHERE status IN ('validating_existing','queued','running','indeterminate');

-- R7-H：初始状态 validating_existing
CREATE TRIGGER trg_vmjob_initial BEFORE INSERT ON voice_materialization_jobs
WHEN NEW.status IS NOT 'validating_existing'
BEGIN SELECT RAISE(ABORT,'voice_materialization_jobs initial state validating_existing required'); END;

-- R6-E：execution identity（source SHA / adapter key 与 exact Voice Revision 自洽；destination 路径格式冻结）
CREATE TRIGGER trg_vmjob_pair BEFORE INSERT ON voice_materialization_jobs
BEGIN
  SELECT RAISE(ABORT,'voice_materialization_jobs voice revision pair mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM voice_profile_revisions r
                      WHERE r.id=NEW.voice_profile_revision_id
                      AND r.voice_profile_id=NEW.voice_profile_id);
  SELECT RAISE(ABORT,'voice_materialization_jobs source identity mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM voice_profile_revisions r
                      WHERE r.id=NEW.voice_profile_revision_id
                        AND r.canonical_audio_sha256=NEW.source_canonical_sha256
                        AND r.adapter_compatibility_key=NEW.adapter_compatibility_key);
  SELECT RAISE(ABORT,'voice_materialization_jobs destination path mismatch')
    WHERE NEW.destination_voice_root_relative_path
          <> NEW.voice_profile_id || '/' || NEW.voice_profile_revision_id || '/reference.wav';
END;
CREATE TRIGGER trg_vmjob_immutable BEFORE UPDATE ON voice_materialization_jobs
WHEN OLD.voice_profile_id IS NOT NEW.voice_profile_id
  OR OLD.voice_profile_revision_id IS NOT NEW.voice_profile_revision_id
  OR OLD.destination_voice_root_relative_path IS NOT NEW.destination_voice_root_relative_path
  OR OLD.source_canonical_sha256 IS NOT NEW.source_canonical_sha256
  OR OLD.adapter_compatibility_key IS NOT NEW.adapter_compatibility_key
BEGIN SELECT RAISE(ABORT,'voice_materialization_jobs immutable field'); END;
-- R9 ①：evidence 时间（heartbeat_at / updated_at）不得明显晚于 DB 当前时间
CREATE TRIGGER trg_vmjob_evidence_time_update BEFORE UPDATE ON voice_materialization_jobs
WHEN (NEW.heartbeat_at IS NOT NULL
      AND NEW.heartbeat_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')))
  OR (NEW.updated_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'voice_materialization_jobs evidence timestamp in future'); END;
CREATE TRIGGER trg_vmjob_transition BEFORE UPDATE OF status ON voice_materialization_jobs
WHEN OLD.status IS NOT NEW.status AND NOT (
     (OLD.status='validating_existing' AND NEW.status IN ('queued','succeeded','cancelled','indeterminate'))
  OR (OLD.status='queued'              AND NEW.status IN ('running','failed','cancelled'))
  OR (OLD.status='running'             AND NEW.status IN ('succeeded','failed','cancelled','indeterminate'))
  OR (OLD.status='indeterminate'       AND NEW.status IN ('succeeded','failed','cancelled')))
BEGIN SELECT RAISE(ABORT,'voice_materialization_jobs invalid transition'); END;
CREATE TRIGGER trg_vmjob_delete_abort BEFORE DELETE ON voice_materialization_jobs
BEGIN SELECT RAISE(ABORT,'voice_materialization_jobs delete forbidden'); END;
```

- **Scheduler 只领取 `status='queued'`**；`validating_existing` unschedulable；
- **partial unique**：同 profile+revision 最多一个 active job——single-flight 主防线（projection 的 `UNIQUE(profile, revision)` 是第二道）；
- **execution identity 完整且不可变（R6-E）**：`source_canonical_sha256` / `adapter_compatibility_key` 在**任何状态**
  （validating_existing/queued/running/succeeded 等）都必须 NOT NULL 且与 exact Voice Revision 的
  `canonical_audio_sha256` / `adapter_compatibility_key` 自洽（source = revision canonical audio）；两者与
  `destination_voice_root_relative_path`（固定 `<pid>/<rid>/reference.wav`）一旦创建不得改
  （INSERT 被 pair trigger 拦截 NULL/自洽错误，UPDATE 被 immutable 拦截）；
- 所有权（CHECK 强制）：`validating_existing` → validation owner/lease/attempt 有效、Worker owner 全 NULL；
  `queued` → 全部 owner 清空；`running` → Worker owner/lease/heartbeat 有效、validation 清空；终态 → 全清。

### 2.7 `voice_materializations`（canonical projection；每 exact voice 唯一）

```sql
CREATE TABLE voice_materializations (
  id TEXT PRIMARY KEY,
  voice_profile_id TEXT NOT NULL REFERENCES voice_profiles(id) ON DELETE RESTRICT,
  voice_profile_revision_id TEXT NOT NULL REFERENCES voice_profile_revisions(id) ON DELETE RESTRICT,
  source_canonical_sha256 TEXT NOT NULL CHECK
    (length(source_canonical_sha256)=64 AND source_canonical_sha256 NOT GLOB '*[^0-9a-f]*'),
  adapter_compatibility_key TEXT NOT NULL,
  destination_voice_root_relative_path TEXT NOT NULL CHECK
    (destination_voice_root_relative_path <> '..'
     AND destination_voice_root_relative_path NOT LIKE '/%'
     AND destination_voice_root_relative_path NOT GLOB '../*'
     AND destination_voice_root_relative_path NOT GLOB '*/..'
     AND destination_voice_root_relative_path NOT GLOB '*/../*'
     AND destination_voice_root_relative_path NOT GLOB '*\*'
     AND length(destination_voice_root_relative_path) > 0),
  status TEXT NOT NULL CHECK (status IN
    ('file_ready_unpublished','published_usable','failed','indeterminate')),
  published_registry_generation INTEGER,
  published_registry_sha256 TEXT CHECK (published_registry_sha256 IS NULL OR
    (length(published_registry_sha256)=64 AND published_registry_sha256 NOT GLOB '*[^0-9a-f]*')),
  published_by_publication_id TEXT REFERENCES voice_registry_publications(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (voice_profile_id, voice_profile_revision_id),
  CHECK (
       (status='file_ready_unpublished'
        AND published_registry_generation IS NULL AND published_registry_sha256 IS NULL
        AND published_by_publication_id IS NULL)
    OR (status='published_usable'
        AND published_registry_generation IS NOT NULL AND published_registry_sha256 IS NOT NULL
        AND published_by_publication_id IS NOT NULL)
    OR (status IN ('failed','indeterminate')))
);
-- R7-H：初始状态 file_ready_unpublished
CREATE TRIGGER trg_vmat_initial BEFORE INSERT ON voice_materializations
WHEN NEW.status IS NOT 'file_ready_unpublished'
BEGIN SELECT RAISE(ABORT,'voice_materializations initial state file_ready_unpublished required'); END;
-- R6-F：source SHA / adapter key 与 exact Voice Revision 自洽；destination 路径格式冻结
CREATE TRIGGER trg_vmat_pair BEFORE INSERT ON voice_materializations
BEGIN
  SELECT RAISE(ABORT,'voice_materializations voice revision pair mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM voice_profile_revisions r
                      WHERE r.id=NEW.voice_profile_revision_id
                      AND r.voice_profile_id=NEW.voice_profile_id);
  SELECT RAISE(ABORT,'voice_materializations source identity mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM voice_profile_revisions r
                      WHERE r.id=NEW.voice_profile_revision_id
                        AND r.canonical_audio_sha256=NEW.source_canonical_sha256
                        AND r.adapter_compatibility_key=NEW.adapter_compatibility_key);
  SELECT RAISE(ABORT,'voice_materializations destination path mismatch')
    WHERE NEW.destination_voice_root_relative_path
          <> NEW.voice_profile_id || '/' || NEW.voice_profile_revision_id || '/reference.wav';
END;
-- R7-B/R6-F：execution identity + registry proof + published_by_publication_id write-once；published_usable 全证据冻结
CREATE TRIGGER trg_vmat_immutable BEFORE UPDATE ON voice_materializations
WHEN OLD.voice_profile_id IS NOT NEW.voice_profile_id
  OR OLD.voice_profile_revision_id IS NOT NEW.voice_profile_revision_id
  OR OLD.source_canonical_sha256 IS NOT NEW.source_canonical_sha256
  OR OLD.destination_voice_root_relative_path IS NOT NEW.destination_voice_root_relative_path
  OR OLD.adapter_compatibility_key IS NOT NEW.adapter_compatibility_key
  OR (OLD.published_registry_generation IS NOT NULL AND NEW.published_registry_generation IS NOT OLD.published_registry_generation)
  OR (OLD.published_registry_sha256 IS NOT NULL AND NEW.published_registry_sha256 IS NOT OLD.published_registry_sha256)
  OR (OLD.published_by_publication_id IS NOT NULL AND NEW.published_by_publication_id IS NOT OLD.published_by_publication_id)
  OR (OLD.status='published_usable' AND (
        NEW.source_canonical_sha256 IS NOT OLD.source_canonical_sha256
     OR NEW.adapter_compatibility_key IS NOT OLD.adapter_compatibility_key
     OR NEW.destination_voice_root_relative_path IS NOT OLD.destination_voice_root_relative_path
     OR NEW.published_registry_generation IS NOT OLD.published_registry_generation
     OR NEW.published_registry_sha256 IS NOT OLD.published_registry_sha256
     OR NEW.published_by_publication_id IS NOT OLD.published_by_publication_id))
BEGIN SELECT RAISE(ABORT,'voice_materializations immutable field'); END;
CREATE TRIGGER trg_vmat_transition BEFORE UPDATE OF status ON voice_materializations
WHEN OLD.status IS NOT NEW.status AND NOT (
     (OLD.status='file_ready_unpublished' AND NEW.status IN ('published_usable','failed','indeterminate'))
  OR (OLD.status='failed'                 AND NEW.status IN ('file_ready_unpublished'))
  OR (OLD.status='indeterminate'          AND NEW.status IN ('file_ready_unpublished','failed')))
BEGIN SELECT RAISE(ABORT,'voice_materializations invalid transition'); END;
-- R8-C/D + R10 ④：published_usable 必须经 atomic activation command（`voice_registry_publication_activations`）
-- 激活——subject_type 同时接受三种有效路径：
--   materialization_publish（subject_id=本 projection；subject_mode='publish_and_cutover'，
--     projection 在激活前为 file_ready_unpublished）
--   legacy_cutover_publish（subject_id=legacy entry.id 且其 mapped_voice_materialization_id=本 projection；
--     subject_mode='publish_and_cutover'；projection 激活前为 file_ready_unpublished）
--   legacy_cutover_existing（subject_id=legacy entry.id 且其 mapped_voice_materialization_id=本 projection；
--     subject_mode='cutover_existing'；projection 激活前已 published_usable——
--     activation 触发器在同一 statement 内通过 RAISE(ABORT, 'subject_type mismatch') 校验
--     subject_mode=`cutover_existing` 写入 publication 即表示 projection 保持已发布状态，
--     与 trg_vrp_subject 一致：legacy entry → mapped_active 而 projection evidence 不被改写）
-- generation/SHA 与 publication 逐项一致；直接 UPDATE（无 command 行）一律 ABORT
CREATE TRIGGER trg_vmat_publish BEFORE UPDATE OF status ON voice_materializations
WHEN NEW.status='published_usable' AND OLD.status IS NOT NEW.status
BEGIN
  SELECT RAISE(ABORT,'voice_materializations publication link mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM voice_registry_publications p
                      JOIN voice_registry_publication_activations a
                        ON a.publication_id=p.id
                      WHERE p.id=NEW.published_by_publication_id
                        AND p.status IN ('activation_pending','indeterminate')
                        AND p.generation=NEW.published_registry_generation
                        AND p.candidate_registry_sha256=NEW.published_registry_sha256
                        AND a.observed_active_registry_sha256=NEW.published_registry_sha256
                        AND (
                             (p.subject_type='materialization_publish' AND p.subject_id=NEW.id)
                          OR (p.subject_type='legacy_cutover_publish'
                              AND EXISTS (SELECT 1 FROM legacy_adapter_voice_entries l
                                          WHERE l.id=p.subject_id
                                            AND l.mapped_voice_materialization_id=NEW.id))
                          OR (p.subject_type='legacy_cutover_existing'
                              AND EXISTS (SELECT 1 FROM legacy_adapter_voice_entries l
                                          WHERE l.id=p.subject_id
                                            AND l.mapped_voice_materialization_id=NEW.id))));
END;
CREATE TRIGGER trg_vmat_delete_abort BEFORE DELETE ON voice_materializations
BEGIN SELECT RAISE(ABORT,'voice_materializations delete forbidden'); END;
```

- **projection 只记录 immutable canonical file（R7-B 冻结）**：状态仅 `file_ready_unpublished / published_usable / failed /
  indeterminate`；**`registry_pending` 已删除**——消除 R6 的 `registry_pending → failed` + registry proof write-once
  导致的 repair 不可达矛盾；registry 激活意图/证据全部移入 `voice_registry_publications`（§2.9），**不在 publication
  成功前把最终 generation/SHA 写入 projection**。
- **状态机（R7-B）**：`file_ready_unpublished → published_usable | failed | indeterminate`；
  `failed → file_ready_unpublished`（repair：新 materialization job 重新复制成功后 fenced 修复）；
  `indeterminate → file_ready_unpublished | failed`（exact 重验后显式 resolve）；
  **`published_usable` 不可逆（无出边）——已发布 projection 不再被重新发布**（新 global generation 中 stable view
  从已发布状态确定性复制，旧 published evidence 保留，实证 RP-08）。
- **activation evidence 封存（R8-C/D 取代 R7-B/R6-F 的"先 active 后 projection"模型）**：`adapter_compatibility_key` /
  `published_registry_generation` / `published_registry_sha256` / `published_by_publication_id` 全部 write-once；
  `published_usable` 后 profile/revision/source SHA/path/compatibility/generation/SHA/publication link
  **全部不可变**（实证 IS-14a/b/c/e）。
  `published_usable` 必须经 `published_by_publication_id` 指向的 publication 的 **atomic activation command**
  （`voice_registry_publication_activations`，§2.10）激活：command trigger 在同一 statement 内先更新 projection、
  最后才置 publication active——因此 `trg_vmat_publish` 验证的是"存在匹配 activation command 行 + publication 处于
  activation_pending/indeterminate + generation/SHA 一致 + subject 匹配"；subject 匹配同时接受
  `materialization_publish`（subject_id=本 projection）与 `legacy_cutover`（subject_id=legacy entry 且其
  `mapped_voice_materialization_id`=本 projection）两种（R8-C 单一模型：**legacy_cutover publication 本身同时发布
  目标 projection**，废弃"projection 必须预先 published_usable"的混用模型）；无 command 行的直接 UPDATE 一律 ABORT。
- **失败重试（R7-B）**：publication attempt 失败/indeterminate → projection 保持 file_ready_unpublished 不卡死 →
  **创建新的 publication row**（新 generation）重试；旧 attempt evidence 不覆盖不清除（实证 RP-01/RP-02 + crash-retry 闭环）。
- **published_usable 的文件损坏 repair**：不转移状态——新 materialization job 的 validator 比对 DB 证据与文件，
  按 immutable source revision 重新复制恢复 exact SHA（DB 行与 registry 证据不变，SHA 由 immutable source 决定）；
- `published_usable` 必须有 `published_registry_generation + published_registry_sha256 + published_by_publication_id`（CHECK 强制）；
- 目标路径固定 `<voice_profile_id>/<voice_profile_revision_id>/reference.wav`（voice-root-relative；pair trigger 冻结）；DELETE 禁。

### 2.8 `legacy_adapter_voice_entries`（legacy shadow；R7-C publication 引用）

```sql
CREATE TABLE legacy_adapter_voice_entries (
  id TEXT PRIMARY KEY,
  voice_profile_key TEXT NOT NULL,
  voice_revision_key TEXT NOT NULL,
  speaker_name TEXT NOT NULL,
  reference_asset_path_or_safe_projection TEXT NOT NULL,
  reference_sha256 TEXT NOT NULL CHECK
    (length(reference_sha256)=64 AND reference_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_registry_sha256 TEXT NOT NULL CHECK
    (length(source_registry_sha256)=64 AND source_registry_sha256 NOT GLOB '*[^0-9a-f]*'),
  imported_at TEXT NOT NULL,
  mapping_status TEXT NOT NULL CHECK (mapping_status IN
    ('unmapped','mapping_pending','mapped_verified','mapped_active','retired')),
  -- R10 ④⑤：cutover mode 显式两态（unmapped→mapped_verified 时写入，写后不可改）——
  --   publish_and_cutover：前置 projection=file_ready_unpublished（activation 同时发布 projection）
  --   cutover_existing：前置 projection=published_usable（activation 不重写 projection 任何 evidence）
  mapping_mode TEXT CHECK (mapping_mode IS NULL OR
    mapping_mode IN ('publish_and_cutover','cutover_existing')),
  mapped_voice_materialization_id TEXT REFERENCES voice_materializations(id) ON DELETE SET NULL,
  pending_publication_id TEXT REFERENCES voice_registry_publications(id) ON DELETE RESTRICT,
  retired_at TEXT,
  candidate_source_selector TEXT CHECK (candidate_source_selector IS NULL OR
    candidate_source_selector IN ('legacy','tts_a')),
  candidate_activated_at TEXT,
  UNIQUE (voice_profile_key, voice_revision_key),
  CHECK (
       (mapping_status='unmapped'
        AND retired_at IS NULL AND mapped_voice_materialization_id IS NULL
        AND mapping_mode IS NULL
        AND pending_publication_id IS NULL
        AND candidate_source_selector IS NULL AND candidate_activated_at IS NULL)
    OR (mapping_status='mapped_verified'
        AND retired_at IS NULL AND mapped_voice_materialization_id IS NOT NULL
        AND mapping_mode IS NOT NULL
        AND pending_publication_id IS NULL
        AND candidate_source_selector IS NULL AND candidate_activated_at IS NULL)
    OR (mapping_status='mapping_pending'
        AND retired_at IS NULL AND mapped_voice_materialization_id IS NOT NULL
        AND mapping_mode IS NOT NULL
        AND pending_publication_id IS NOT NULL
        AND candidate_source_selector='tts_a' AND candidate_activated_at IS NULL)
    OR (mapping_status='mapped_active'
        AND retired_at IS NULL AND mapped_voice_materialization_id IS NOT NULL
        AND mapping_mode IS NOT NULL
        AND pending_publication_id IS NOT NULL
        AND candidate_source_selector='tts_a' AND candidate_activated_at IS NOT NULL)
    OR (mapping_status='retired'
        AND retired_at IS NOT NULL))
);
-- R10 ④⑤：活跃 legacy mapping 一对一卡片性冻结——同一 projection 至多一个**活跃**
-- legacy entry 引用（mapped_verified/mapping_pending/mapped_active 不可重复）；
-- retired entry 永久保留历史 mapped ID 但**不再占用活跃唯一位**（partial index 排除
-- retired 行），允许新 legacy entry 映射同一 projection（走与 projection 当前状态匹配的
-- mapping_mode）；unmapped 行 mapped id 为 NULL 不参与。R9 注释声称 retired 行不强制
-- 但旧索引 uq_lve_mapped_materialization 实际占位——R10 以此索引使行为与语义对齐。
CREATE UNIQUE INDEX uq_lve_active_mapped_materialization
  ON legacy_adapter_voice_entries (mapped_voice_materialization_id)
  WHERE mapped_voice_materialization_id IS NOT NULL AND mapping_status <> 'retired';
-- R9 ④：mapped_verified → mapping_pending 时 legacy entry 本身不可同时 reference 别的
-- 同一 projection 的 active legacy_cutover_existing subject；mapped_active 路径同样。
-- （uq_lve_active_mapped_materialization 已强制 DB-level 活跃一对一；该 trigger 仅做冗余友好错误消息）
CREATE TRIGGER trg_lve_alias BEFORE UPDATE OF mapped_voice_materialization_id
  ON legacy_adapter_voice_entries
WHEN NEW.mapped_voice_materialization_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM legacy_adapter_voice_entries other
              WHERE other.id<>NEW.id
                AND other.mapped_voice_materialization_id=NEW.mapped_voice_materialization_id
                AND other.mapping_status IN ('mapped_verified','mapping_pending','mapped_active'))
BEGIN SELECT RAISE(ABORT,'legacy_adapter_voice_entries alias to same projection forbidden'); END;
-- R7-H：初始状态 unmapped
CREATE TRIGGER trg_lve_initial BEFORE INSERT ON legacy_adapter_voice_entries
WHEN NEW.mapping_status IS NOT 'unmapped'
BEGIN SELECT RAISE(ABORT,'legacy_adapter_voice_entries initial state unmapped required'); END;
CREATE TRIGGER trg_lve_immutable BEFORE UPDATE ON legacy_adapter_voice_entries
WHEN OLD.voice_profile_key IS NOT NEW.voice_profile_key
  OR OLD.voice_revision_key IS NOT NEW.voice_revision_key
  OR OLD.speaker_name IS NOT NEW.speaker_name
  OR OLD.reference_asset_path_or_safe_projection IS NOT NEW.reference_asset_path_or_safe_projection
  OR OLD.reference_sha256 IS NOT NEW.reference_sha256
  OR OLD.source_registry_sha256 IS NOT NEW.source_registry_sha256
  OR OLD.imported_at IS NOT NEW.imported_at
  OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT OLD.retired_at)
  -- R10 ④⑤：mapping_mode write-once（unmapped→mapped_verified 时 NULL→value；写后不可改；
  -- rollback 不清 mapping_mode；retired 保留历史值）
  OR (OLD.mapping_mode IS NOT NULL AND NEW.mapping_mode IS NOT OLD.mapping_mode)
  -- R8-A：pending_publication_id 仅允许 T1 fill（mapped_verified→mapping_pending，NULL→id）
  -- 与 rollback clear（mapping_pending→mapped_verified，id→NULL）；id→其他 id 非法替换一律 ABORT
  OR (OLD.pending_publication_id IS NOT NEW.pending_publication_id
      AND NOT (OLD.mapping_status='mapped_verified' AND NEW.mapping_status='mapping_pending'
               AND OLD.pending_publication_id IS NULL)
      AND NOT (OLD.mapping_status='mapping_pending' AND NEW.mapping_status='mapped_verified'
               AND NEW.pending_publication_id IS NULL))
BEGIN SELECT RAISE(ABORT,'legacy_adapter_voice_entries immutable field'); END;
CREATE TRIGGER trg_lve_transition BEFORE UPDATE OF mapping_status ON legacy_adapter_voice_entries
WHEN OLD.mapping_status IS NOT NEW.mapping_status AND NOT (
     (OLD.mapping_status='unmapped'        AND NEW.mapping_status IN ('mapped_verified','retired'))
  OR (OLD.mapping_status='mapped_verified' AND NEW.mapping_status IN ('mapping_pending','retired'))
  OR (OLD.mapping_status='mapping_pending' AND NEW.mapping_status IN ('mapped_active','mapped_verified'))
  OR (OLD.mapping_status='mapped_active'   AND NEW.mapping_status IN ('retired')))
BEGIN SELECT RAISE(ABORT,'legacy_adapter_voice_entries invalid transition'); END;
-- R10 ④⑤：unmapped → mapped_verified 前置按 mapping_mode 分流（R10 修复 R9 P0-3：
-- R9 只接受 file_ready_unpublished，使 legacy_cutover_existing 要求的 published_usable 永不可达）：
--   publish_and_cutover：projection 必须 file_ready_unpublished；且不得有 active-flight
--     materialization_publish publication 在飞（确定性竞争裁决——mapping 操作 ABORT，
--     待 publication 完成后改走 cutover_existing；publication creation 已冻结 subject，
--     映射不得把它改成 publish_and_cutover）
--   cutover_existing：projection 必须已 published_usable 且 published_by_publication_id 非 NULL
CREATE TRIGGER trg_lve_mapped_verified BEFORE UPDATE OF mapping_status ON legacy_adapter_voice_entries
WHEN OLD.mapping_status='unmapped' AND NEW.mapping_status='mapped_verified'
BEGIN
  SELECT RAISE(ABORT,'legacy_adapter_voice_entries mapping mode required')
    WHERE NEW.mapping_mode IS NULL;
  SELECT RAISE(ABORT,'legacy_adapter_voice_entries mapped materialization not file_ready_unpublished')
    WHERE NEW.mapping_mode='publish_and_cutover'
      AND NOT EXISTS (SELECT 1 FROM voice_materializations m
                      WHERE m.id=NEW.mapped_voice_materialization_id
                        AND m.status='file_ready_unpublished');
  SELECT RAISE(ABORT,'legacy_adapter_voice_entries projection publication in flight')
    WHERE NEW.mapping_mode='publish_and_cutover'
      AND EXISTS (SELECT 1 FROM voice_registry_publications p
                  WHERE p.subject_type='materialization_publish'
                    AND p.subject_id=NEW.mapped_voice_materialization_id
                    AND p.status IN ('building','candidate_persisted','file_durable',
                                     'activation_pending','indeterminate'));
  SELECT RAISE(ABORT,'legacy_adapter_voice_entries mapped materialization not published_usable')
    WHERE NEW.mapping_mode='cutover_existing'
      AND NOT EXISTS (SELECT 1 FROM voice_materializations m
                      WHERE m.id=NEW.mapped_voice_materialization_id
                        AND m.status='published_usable'
                        AND m.published_by_publication_id IS NOT NULL);
END;
-- R7-C + R8-B + R10 ④：mapping_pending 必须引用 exact active legacy_cutover_* publication
-- （单 subject 冻结；global single-flight 保证一个 active publication 最多一个 mapping_pending subject；
-- R10 ④：subject_type 同时接受 legacy_cutover_publish（projection file_ready_unpublished，
--   entry mapping_mode='publish_and_cutover'）与 legacy_cutover_existing（projection 已
--   published_usable，entry mapping_mode='cutover_existing'）；
--   mapped_active 由 trg_lve_alias + §2.9 trg_vrp_subject 校验 subject_mode 匹配）；
-- candidate generation/SHA/manifest evidence 单一权威 = publication 行，本行不再复制）
CREATE TRIGGER trg_lve_publication_link BEFORE UPDATE OF mapping_status ON legacy_adapter_voice_entries
WHEN NEW.mapping_status='mapping_pending' AND OLD.mapping_status IS NOT NEW.mapping_status
BEGIN
  SELECT RAISE(ABORT,'legacy_adapter_voice_entries publication link mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM voice_registry_publications p
                      WHERE p.id=NEW.pending_publication_id
                        AND p.status IN ('building','candidate_persisted','file_durable','activation_pending','indeterminate')
                        AND p.subject_type IN ('legacy_cutover_publish','legacy_cutover_existing')
                        AND p.subject_id=NEW.id);
END;
-- R8-A：rollback（mapping_pending → mapped_verified）仅当 referenced publication 已 failed/cancelled；
-- 必须同事务清 pending_publication_id + candidate projection 字段；旧 publication evidence 由
-- voice_registry_publications 永久保存（不需要本行保留已失败的 pending ID）；重试 = 新 publication.id 从 NULL 写入
CREATE TRIGGER trg_lve_rollback BEFORE UPDATE OF mapping_status ON legacy_adapter_voice_entries
WHEN OLD.mapping_status='mapping_pending' AND NEW.mapping_status='mapped_verified'
BEGIN
  SELECT RAISE(ABORT,'legacy_adapter_voice_entries rollback publication not failed')
    WHERE NOT EXISTS (SELECT 1 FROM voice_registry_publications p
                      WHERE p.id=OLD.pending_publication_id
                        AND p.subject_type IN ('legacy_cutover_publish','legacy_cutover_existing')
                        AND p.subject_id=NEW.id
                        AND p.status IN ('failed','cancelled'));
  SELECT RAISE(ABORT,'legacy_adapter_voice_entries rollback must clear pending evidence')
    WHERE NEW.pending_publication_id IS NOT NULL
       OR NEW.candidate_source_selector IS NOT NULL
       OR NEW.candidate_activated_at IS NOT NULL;
END;
-- R8-D：mapping_pending → mapped_active 必须经 atomic activation command（同一 statement 内
-- command trigger 先更新 projection/legacy，最后才置 publication active）；直接 UPDATE 一律 ABORT
CREATE TRIGGER trg_lve_activation BEFORE UPDATE OF mapping_status ON legacy_adapter_voice_entries
WHEN OLD.mapping_status='mapping_pending' AND NEW.mapping_status='mapped_active'
  AND NOT EXISTS (SELECT 1 FROM voice_registry_publication_activations a
                  WHERE a.publication_id=NEW.pending_publication_id
                    AND a.activated_at IS NEW.candidate_activated_at)
BEGIN SELECT RAISE(ABORT,'legacy_adapter_voice_entries activation command required'); END;
CREATE TRIGGER trg_lve_delete_abort BEFORE DELETE ON legacy_adapter_voice_entries
BEGIN SELECT RAISE(ABORT,'legacy_adapter_voice_entries delete forbidden'); END;
-- R6-G（R8 版）：cutover journal 不可变（mapped target write-once；candidate_source_selector 仅允许
-- T1 fill（mapped_verified→mapping_pending）与 rollback clear（mapping_pending→mapped_verified）；
-- candidate_activated_at 仅允许 T5 fill（mapping_pending→mapped_active，经 activation command）；
-- mapped_active 全冻结；旧 owner 不得原地改 candidate evidence——cutover 所有权已移入 publication
-- 表（§2.9），本行不再有 owner/attempt 列，也不再复制 publication generation/SHA（R8-B））
CREATE TRIGGER trg_lve_cutover_evidence BEFORE UPDATE ON legacy_adapter_voice_entries
WHEN (
  -- mapped target write-once（一旦 set 不可换/不可清）
  (OLD.mapped_voice_materialization_id IS NOT NULL
   AND NEW.mapped_voice_materialization_id IS NOT OLD.mapped_voice_materialization_id)
  -- candidate_source_selector：仅 T1 fill / rollback clear；其余增改删一律 ABORT
  OR (NEW.candidate_source_selector IS NOT OLD.candidate_source_selector
      AND NOT (OLD.mapping_status='mapped_verified' AND NEW.mapping_status='mapping_pending')
      AND NOT (OLD.mapping_status='mapping_pending' AND NEW.mapping_status='mapped_verified'
               AND NEW.candidate_source_selector IS NULL))
  -- candidate_activated_at：仅允许 T5 fill（mapping_pending→mapped_active）
  OR (NEW.candidate_activated_at IS NOT OLD.candidate_activated_at
      AND NOT (OLD.mapping_status='mapping_pending' AND NEW.mapping_status='mapped_active'))
  -- mapped_active 终态：mapping target、publication link 与全部 candidate 标记冻结
  OR (OLD.mapping_status='mapped_active' AND (
        NEW.mapped_voice_materialization_id IS NOT OLD.mapped_voice_materialization_id
     OR NEW.pending_publication_id IS NOT OLD.pending_publication_id
     OR NEW.candidate_source_selector IS NOT OLD.candidate_source_selector
     OR NEW.candidate_activated_at IS NOT OLD.candidate_activated_at))
)
BEGIN SELECT RAISE(ABORT,'legacy_adapter_voice_entries cutover evidence immutable'); END;
```

- **cutover 证据列（R8-B 冻结）**：**candidate generation/SHA/manifest 的单一权威 = `voice_registry_publications` 行**
  （唯一全局 journal）；本行只保留两个过程标记 `candidate_source_selector='tts_a'` / `candidate_activated_at`，
  **已删除 `candidate_registry_generation / candidate_registry_sha256 / candidate_created_at` 权威重复字段**——
  legacy pending/current evidence 统一经 `pending_publication_id → voice_registry_publications` 取得，不再复制
  publication generation/SHA，不存在跨表同步依赖；**`pending_publication_id` 是 mapping_pending/mapped_active 的
  权威 publication 引用（R7-C + R8-A）**；**cutover owner/lease/attempt 已移入 `voice_registry_publications`
  （§2.9）——T1-T5 共用同一 global owner/token/lease/attempt**。
- **mapping 状态机（R5 冻结 + R8-A rollback 可达）**：`unmapped → mapped_verified | retired`；
  `mapped_verified → mapping_pending | retired`；
  `mapping_pending → mapped_active | mapped_verified`（后者 = referenced publication 已 failed/cancelled 后的
  清证据回退——**rollback 不再是不可达状态**：`pending_publication_id` 从 NULL 写入（T1）、仅在 publication
  failed/cancelled 时清 NULL（rollback）、重试允许写入新的 publication.id；旧 failed/cancelled publication
  evidence 在 journal 永久保存）；
  `mapped_active → retired`；`retired` 终态；
- **publication 引用（R7-C + R8-A 冻结）**：`mapping_pending` 必须 `pending_publication_id` 指向 **active（非终态）且
  subject_type IN (`legacy_cutover_publish`,`legacy_cutover_existing`) + subject_id=本 entry** 的 publication
  （`trg_lve_publication_link`）；
  由于 global active single-flight，**一个 active publication 最多一个 mapping_pending subject**（第二个 key 在第一个
  publication active 时无法进入 mapping_pending，实证 RP-04）；`pending_publication_id` 仅允许 T1 fill 与
  rollback clear，**id→其他 id 非法替换一律 ABORT**（`trg_lve_immutable`，实证 LR-05）；
  rollback 必须 referenced publication `status IN (failed,cancelled)` 且 subject 匹配（`trg_lve_rollback`，
  实证 LR-02）；`mapped_active` 保留 `pending_publication_id` 指向激活它的 active publication（provenance link）。
- **journal 字段写入权限（R6-G 冻结，R8 版 `trg_lve_cutover_evidence`）**：
  `speaker_name` / `reference_asset_path_or_safe_projection` 等 import 字段**一旦导入不可变**（immutable trigger）；
  `mapped_voice_materialization_id` **write-once**（一旦 set 不可换/不可清）；
  以下字段只允许在冻结的唯一状态转换中写入：

  | 转换 | 允许写入 |
  |---|---|
  | `unmapped → mapped_verified` | `mapped_voice_materialization_id`（首次）+ `mapping_mode`（首次选定，write-once；前置按 mode 分流：`publish_and_cutover` 需 projection `file_ready_unpublished` 且无在飞 materialization publication；`cutover_existing` 需 projection `published_usable`，R10 ④⑤） |
  | `mapped_verified → mapping_pending`（T1） | `pending_publication_id`（NULL→publication.id 首次）+ `candidate_source_selector='tts_a'` |
  | `mapping_pending → mapped_verified`（rollback） | 清 `pending_publication_id`（→NULL）+ 清 `candidate_source_selector`（前提：referenced publication failed/cancelled，R8-A） |
  | `mapping_pending → mapped_active`（T5） | 仅 `candidate_activated_at`（必须经 atomic activation command，R8-D；`pending_publication_id` 保留指向 active publication） |
  | `mapped_active`（同状态/终态） | mapping target、publication link 与 candidate 标记全不可变 |

  任何非上述转换的 candidate 标记增改删（含 **mapping_pending 内旧 owner 原地改写**、mapped_active 内修改）
  一律 ABORT（实证 IS-15a/b/c/d/e/f/g/h + LR-05）。
- `mapped_active` 必须有 `mapped_voice_materialization_id` + `pending_publication_id` + `candidate_source_selector='tts_a'` +
  `candidate_activated_at`（CHECK 强制）；`retired` 必须有 `retired_at`；非 retired 的 `retired_at` 必须 NULL；
  `retired_at` write-once；
- 不伪造 TTS-A 数据（不写 voice_profiles/revisions）；DELETE 禁（append-only provenance）。

### 2.9 `voice_registry_publications`（第 10 表：global registry publication journal；R7-A）

> R6 已证明 per-projection/per-key candidate evidence 不能完整表达全局 registry publication——不再以"保持 9 表"
> 为目标牺牲正确性。本表记录**每一次** candidate publication attempt（T1 前取得 global reservation，T1-T5 共用
> 同一 global owner/token/lease/attempt），是 registry 激活的唯一 journal。

```sql
CREATE TABLE voice_registry_publications (
  id TEXT PRIMARY KEY,
  -- R9 ⑧：generation DB-level UNIQUE；单调分配由应用层 BEGIN IMMEDIATE 保证；
  -- DB 仅保证不重复，schema 注释明确不混称
  generation INTEGER NOT NULL UNIQUE,
  -- R10 ④⑤：subject_type 拆分
  --   materialization_publish：projection 独立发布（必须 file_ready_unpublished，legacy 未引用）
  --   legacy_cutover_publish：legacy entry 引用 + projection 同时发布（subject_mode='publish_and_cutover'）
  --   legacy_cutover_existing：projection 已 published_usable，legacy entry 走 cutover_existing 路径
  --   registry_rebuild：subject_id='global'，无 projection/legacy 更新
  subject_type TEXT NOT NULL CHECK (subject_type IN
    ('materialization_publish','legacy_cutover_publish','legacy_cutover_existing','registry_rebuild')),
  subject_id TEXT NOT NULL,
  -- R10 ④⑤：subject_mode 显式两态（与 subject_type + entry.mapping_mode 联合确定语义）
  subject_mode TEXT NOT NULL CHECK (subject_mode IN
    ('publish_and_cutover','cutover_existing','none')),
  stable_registry_sha256 TEXT NOT NULL CHECK
    (length(stable_registry_sha256)=64 AND stable_registry_sha256 NOT GLOB '*[^0-9a-f]*'),
  candidate_registry_sha256 TEXT CHECK (candidate_registry_sha256 IS NULL OR
    (length(candidate_registry_sha256)=64 AND candidate_registry_sha256 NOT GLOB '*[^0-9a-f]*')),
  candidate_manifest_json TEXT,
  candidate_manifest_sha256 TEXT CHECK (candidate_manifest_sha256 IS NULL OR
    (length(candidate_manifest_sha256)=64 AND candidate_manifest_sha256 NOT GLOB '*[^0-9a-f]*')),
  publisher_schema_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('building','candidate_persisted','file_durable','activation_pending',
     'active','failed','indeterminate','cancelled')),
  indeterminate_from_status TEXT CHECK (indeterminate_from_status IS NULL OR
    indeterminate_from_status IN ('building','candidate_persisted','file_durable','activation_pending')),
  owner_token TEXT,
  -- R9 ①：lease 列统一 INTEGER epoch milliseconds（UTC）
  lease_expires_at_epoch_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 1 OR status='failed' OR status='cancelled'),
  file_durable_at TEXT,
  activation_requested_at TEXT,
  activated_at TEXT,
  failed_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
       (status='building'
        AND owner_token IS NOT NULL AND lease_expires_at_epoch_ms IS NOT NULL AND attempt >= 1
        AND candidate_registry_sha256 IS NULL AND candidate_manifest_json IS NULL
        AND candidate_manifest_sha256 IS NULL
        AND file_durable_at IS NULL AND activation_requested_at IS NULL
        AND activated_at IS NULL AND failed_at IS NULL
        AND indeterminate_from_status IS NULL)
    OR (status='candidate_persisted'
        AND owner_token IS NOT NULL AND lease_expires_at_epoch_ms IS NOT NULL AND attempt >= 1
        AND candidate_registry_sha256 IS NOT NULL AND candidate_manifest_json IS NOT NULL
        AND candidate_manifest_sha256 IS NOT NULL
        AND file_durable_at IS NULL AND activation_requested_at IS NULL
        AND activated_at IS NULL AND failed_at IS NULL
        AND indeterminate_from_status IS NULL)
    OR (status='file_durable'
        AND owner_token IS NOT NULL AND lease_expires_at_epoch_ms IS NOT NULL AND attempt >= 1
        AND candidate_registry_sha256 IS NOT NULL AND candidate_manifest_json IS NOT NULL
        AND candidate_manifest_sha256 IS NOT NULL
        AND file_durable_at IS NOT NULL AND activation_requested_at IS NULL
        AND activated_at IS NULL AND failed_at IS NULL
        AND indeterminate_from_status IS NULL)
    OR (status='activation_pending'
        AND owner_token IS NOT NULL AND lease_expires_at_epoch_ms IS NOT NULL AND attempt >= 1
        AND candidate_registry_sha256 IS NOT NULL AND candidate_manifest_json IS NOT NULL
        AND candidate_manifest_sha256 IS NOT NULL
        AND file_durable_at IS NOT NULL AND activation_requested_at IS NOT NULL
        AND activated_at IS NULL AND failed_at IS NULL
        AND indeterminate_from_status IS NULL)
    OR (status='active'
        AND owner_token IS NULL AND lease_expires_at_epoch_ms IS NULL
        AND candidate_registry_sha256 IS NOT NULL AND candidate_manifest_json IS NOT NULL
        AND candidate_manifest_sha256 IS NOT NULL
        AND file_durable_at IS NOT NULL AND activation_requested_at IS NOT NULL
        AND activated_at IS NOT NULL AND failed_at IS NULL)
    OR (status='failed'
        AND owner_token IS NULL AND lease_expires_at_epoch_ms IS NULL
        AND failed_at IS NOT NULL AND error_code IS NOT NULL AND activated_at IS NULL)
    OR (status='indeterminate' AND owner_token IS NULL AND lease_expires_at_epoch_ms IS NULL
        AND activated_at IS NULL AND indeterminate_from_status IS NOT NULL)
    OR (status='cancelled' AND owner_token IS NULL AND lease_expires_at_epoch_ms IS NULL
        AND activated_at IS NULL))
);
-- R7-A：DB 级 global active single-flight（任意时刻全系统最多一个 active publication）
CREATE UNIQUE INDEX uq_voice_registry_publication_active
ON voice_registry_publications ((1))
WHERE status IN ('building','candidate_persisted','file_durable','activation_pending','indeterminate');

-- R7-H：初始状态 building
CREATE TRIGGER trg_vrp_initial BEFORE INSERT ON voice_registry_publications
WHEN NEW.status IS NOT 'building'
BEGIN SELECT RAISE(ABORT,'voice_registry_publications initial state building required'); END;
-- R10 ④⑤：publication subject INSERT 验证（含 subject_mode 联合判定 + 互斥冻结 + mapping_mode 分流）：
--   materialization_publish + subject_mode='publish_and_cutover' → file_ready_unpublished materialization
--     且 **未被** legacy_adapter_voice_entries 引用（mapping_status IN mapped_verified/mapping_pending）
--     ——禁止把已被 legacy 引用的 projection 走普通 materialization_publish（情况 1 裁决）；
--   legacy_cutover_publish + subject_mode='publish_and_cutover' → mapped_verified legacy entry
--     且 mapping_mode='publish_and_cutover' 且 mapped materialization='file_ready_unpublished'；
--   legacy_cutover_existing + subject_mode='cutover_existing' → mapped_verified legacy entry
--     且 mapping_mode='cutover_existing' 且 mapped materialization='published_usable'
--     且 published_by_publication_id 非 NULL（允许已发布 projection 的 legacy cutover 收尾；
--     publication INSERT 时 entry 为 mapped_verified——随后 entry 才经 T1 转 mapping_pending
--     指向本 publication，解除 R9 的 mapping_pending 前置死锁，R10 修复 R9 P0-3）；
--   registry_rebuild + subject_mode='none' → subject_id 严格 ='global'；
--   上述每对组合之外的 subject_mode 与 subject_type 不匹配一律 ABORT
CREATE TRIGGER trg_vrp_subject BEFORE INSERT ON voice_registry_publications
BEGIN
  SELECT RAISE(ABORT,'voice_registry_publications subject invalid')
    WHERE (NEW.subject_type='materialization_publish'
           AND (NEW.subject_mode IS NOT 'publish_and_cutover'
                OR NOT EXISTS (SELECT 1 FROM voice_materializations m
                               WHERE m.id=NEW.subject_id AND m.status='file_ready_unpublished')
                OR EXISTS (SELECT 1 FROM legacy_adapter_voice_entries l
                           WHERE l.mapped_voice_materialization_id=NEW.subject_id
                             AND l.mapping_status IN ('mapped_verified','mapping_pending'))))
    OR (NEW.subject_type='legacy_cutover_publish'
           AND (NEW.subject_mode IS NOT 'publish_and_cutover'
                OR NOT EXISTS (SELECT 1 FROM legacy_adapter_voice_entries l
                               JOIN voice_materializations m
                                 ON m.id=l.mapped_voice_materialization_id
                               WHERE l.id=NEW.subject_id
                                 AND l.mapping_status='mapped_verified'
                                 AND l.mapping_mode='publish_and_cutover'
                                 AND m.status='file_ready_unpublished')))
    OR (NEW.subject_type='legacy_cutover_existing'
           AND (NEW.subject_mode IS NOT 'cutover_existing'
                OR NOT EXISTS (SELECT 1 FROM legacy_adapter_voice_entries l
                               JOIN voice_materializations m
                                 ON m.id=l.mapped_voice_materialization_id
                               WHERE l.id=NEW.subject_id
                                 AND l.mapping_status='mapped_verified'
                                 AND l.mapping_mode='cutover_existing'
                                 AND m.status='published_usable'
                                 AND m.published_by_publication_id IS NOT NULL)))
    OR (NEW.subject_type='registry_rebuild'
           AND (NEW.subject_mode IS NOT 'none' OR NEW.subject_id IS NOT 'global'));
END;
-- R7-A + R8-E：identity/evidence write-once + 终态（active/failed/cancelled）全冻结 +
-- indeterminate 期间 candidate/manifest/file/activation evidence 冻结（禁止事后首次补写）+
-- indeterminate_from_status write-once
CREATE TRIGGER trg_vrp_immutable BEFORE UPDATE ON voice_registry_publications
WHEN OLD.generation IS NOT NEW.generation
  OR OLD.subject_type IS NOT NEW.subject_type
  OR OLD.subject_id IS NOT NEW.subject_id
  OR OLD.stable_registry_sha256 IS NOT NEW.stable_registry_sha256
  OR OLD.publisher_schema_version IS NOT NEW.publisher_schema_version
  OR (OLD.candidate_registry_sha256 IS NOT NULL AND NEW.candidate_registry_sha256 IS NOT OLD.candidate_registry_sha256)
  OR (OLD.candidate_manifest_json IS NOT NULL AND NEW.candidate_manifest_json IS NOT OLD.candidate_manifest_json)
  OR (OLD.candidate_manifest_sha256 IS NOT NULL AND NEW.candidate_manifest_sha256 IS NOT OLD.candidate_manifest_sha256)
  OR (OLD.indeterminate_from_status IS NOT NULL AND NEW.indeterminate_from_status IS NOT OLD.indeterminate_from_status)
  OR (OLD.status='indeterminate' AND (
        NEW.candidate_registry_sha256 IS NOT OLD.candidate_registry_sha256
     OR NEW.candidate_manifest_json IS NOT OLD.candidate_manifest_json
     OR NEW.candidate_manifest_sha256 IS NOT OLD.candidate_manifest_sha256
     OR NEW.file_durable_at IS NOT OLD.file_durable_at
     OR NEW.activation_requested_at IS NOT OLD.activation_requested_at))
  OR (OLD.status IN ('active','failed','cancelled') AND (
        NEW.candidate_registry_sha256 IS NOT OLD.candidate_registry_sha256
     OR NEW.candidate_manifest_json IS NOT OLD.candidate_manifest_json
     OR NEW.candidate_manifest_sha256 IS NOT OLD.candidate_manifest_sha256
     OR NEW.file_durable_at IS NOT OLD.file_durable_at
     OR NEW.activation_requested_at IS NOT OLD.activation_requested_at
     OR NEW.activated_at IS NOT OLD.activated_at
     OR NEW.failed_at IS NOT OLD.failed_at
     OR NEW.error_code IS NOT OLD.error_code
     OR NEW.error_message IS NOT OLD.error_message
     OR NEW.status IS NOT OLD.status))
BEGIN SELECT RAISE(ABORT,'voice_registry_publications immutable field'); END;
-- R8-E：进入 indeterminate 时必须记录来源状态（= OLD.status；立即 write-once）
CREATE TRIGGER trg_vrp_indeterminate_entry BEFORE UPDATE OF status ON voice_registry_publications
WHEN NEW.status='indeterminate' AND OLD.status IS NOT 'indeterminate'
  AND NEW.indeterminate_from_status IS NOT OLD.status
BEGIN SELECT RAISE(ABORT,'voice_registry_publications indeterminate origin required'); END;
-- R9 ②：进入 indeterminate 的同一次 UPDATE 不得增删 evidence；仅允许修改
--   status / indeterminate_from_status / owner_token / lease_expires_at_epoch_ms /
--   error_code / error_message / updated_at；candidate/manifest/file/activation evidence
--   全部与 OLD 逐项相等（写后冻结禁止事后补造）
CREATE TRIGGER trg_vrp_indeterminate_seal BEFORE UPDATE OF status ON voice_registry_publications
WHEN NEW.status='indeterminate' AND OLD.status IS NOT 'indeterminate'
  AND (NEW.candidate_registry_sha256 IS NOT OLD.candidate_registry_sha256
       OR NEW.candidate_manifest_json IS NOT OLD.candidate_manifest_json
       OR NEW.candidate_manifest_sha256 IS NOT OLD.candidate_manifest_sha256
       OR NEW.file_durable_at IS NOT OLD.file_durable_at
       OR NEW.activation_requested_at IS NOT OLD.activation_requested_at)
BEGIN SELECT RAISE(ABORT,'voice_registry_publications indeterminate entry evidence seal'); END;
-- R9 ②：进入 indeterminate 时 OLD evidence shape 必须与 OLD.status 匹配：
--   building            → candidate/manifest/file/activation 全 NULL
--   candidate_persisted → candidate/manifest 非 NULL, file/activation NULL
--   file_durable        → candidate/manifest/file 非 NULL, activation NULL
--   activation_pending  → candidate/manifest/file/activation 全非 NULL
-- 上述 shape 不匹配 → ABORT（与 R8-E indeterminate_from_status 互补，覆盖来源真相完整性）
CREATE TRIGGER trg_vrp_indeterminate_shape BEFORE UPDATE OF status ON voice_registry_publications
WHEN NEW.status='indeterminate' AND OLD.status IS NOT 'indeterminate'
  AND (
       (OLD.status='building'
            AND (OLD.candidate_registry_sha256 IS NOT NULL
                 OR OLD.candidate_manifest_json IS NOT NULL
                 OR OLD.candidate_manifest_sha256 IS NOT NULL
                 OR OLD.file_durable_at IS NOT NULL
                 OR OLD.activation_requested_at IS NOT NULL))
    OR (OLD.status='candidate_persisted'
            AND (OLD.candidate_registry_sha256 IS NULL
                 OR OLD.candidate_manifest_json IS NULL
                 OR OLD.candidate_manifest_sha256 IS NULL
                 OR OLD.file_durable_at IS NOT NULL
                 OR OLD.activation_requested_at IS NOT NULL))
    OR (OLD.status='file_durable'
            AND (OLD.candidate_registry_sha256 IS NULL
                 OR OLD.candidate_manifest_json IS NULL
                 OR OLD.candidate_manifest_sha256 IS NULL
                 OR OLD.file_durable_at IS NULL
                 OR OLD.activation_requested_at IS NOT NULL))
    OR (OLD.status='activation_pending'
            AND (OLD.candidate_registry_sha256 IS NULL
                 OR OLD.candidate_manifest_json IS NULL
                 OR OLD.candidate_manifest_sha256 IS NULL
                 OR OLD.file_durable_at IS NULL
                 OR OLD.activation_requested_at IS NULL))
  )
BEGIN SELECT RAISE(ABORT,'voice_registry_publications indeterminate origin shape mismatch'); END;
-- R9 ①：evidence 时间（file_durable_at / activation_requested_at / activated_at /
-- failed_at / updated_at）不得明显晚于 DB 当前时间（caller 不得回填未来）
CREATE TRIGGER trg_vrp_evidence_time_insert BEFORE INSERT ON voice_registry_publications
WHEN NEW.created_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'voice_registry_publications evidence timestamp in future'); END;
CREATE TRIGGER trg_vrp_evidence_time_update BEFORE UPDATE ON voice_registry_publications
WHEN (NEW.file_durable_at IS NOT NULL
      AND NEW.file_durable_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')))
  OR (NEW.activation_requested_at IS NOT NULL
      AND NEW.activation_requested_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')))
  OR (NEW.activated_at IS NOT NULL
      AND NEW.activated_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')))
  OR (NEW.failed_at IS NOT NULL
      AND NEW.failed_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')))
  OR (NEW.updated_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'voice_registry_publications evidence timestamp in future'); END;
-- R7-A + R8-D/E：状态机（failed/cancelled 终态 evidence；indeterminate 显式 resolve；重试 = 新 row；
-- active 只能经 atomic activation command——activation_pending→active 与
-- indeterminate(from=activation_pending)→active 必须存在匹配 command 行，直接 UPDATE 一律 ABORT；
-- building/candidate 阶段进入的 indeterminate 不得 resolve active）
CREATE TRIGGER trg_vrp_transition BEFORE UPDATE OF status ON voice_registry_publications
WHEN OLD.status IS NOT NEW.status AND NOT (
     (OLD.status='building'           AND NEW.status IN ('candidate_persisted','failed','cancelled','indeterminate'))
  OR (OLD.status='candidate_persisted' AND NEW.status IN ('file_durable','failed','cancelled','indeterminate'))
  OR (OLD.status='file_durable'        AND NEW.status IN ('activation_pending','failed','cancelled','indeterminate'))
  OR (OLD.status='activation_pending'  AND NEW.status IN ('failed','cancelled','indeterminate'))
  OR (OLD.status='indeterminate'       AND NEW.status IN ('failed','cancelled'))
  OR (NEW.status='active'
      AND (OLD.status='activation_pending'
           OR (OLD.status='indeterminate' AND OLD.indeterminate_from_status='activation_pending'))
      AND EXISTS (SELECT 1 FROM voice_registry_publication_activations a
                  WHERE a.publication_id=NEW.id
                    AND a.observed_active_registry_sha256 IS NEW.candidate_registry_sha256
                    AND a.activated_at IS NEW.activated_at)))
BEGIN SELECT RAISE(ABORT,'voice_registry_publications invalid transition'); END;
CREATE TRIGGER trg_vrp_delete_abort BEFORE DELETE ON voice_registry_publications
BEGIN SELECT RAISE(ABORT,'voice_registry_publications delete forbidden'); END;
```

- **global active single-flight（R7-A）**：`uq_voice_registry_publication_active` 覆盖
  building/candidate_persisted/file_durable/activation_pending/indeterminate——任意时刻全系统最多一个 active
  publication（第二个 T1 直接 UNIQUE ABORT，实证 RP-03）；`indeterminate` 保留在 active set（crash 后未知是否已
  激活，防第二个 publication 并发），显式 resolve 为 active/failed/cancelled 后释放。
- **T1 前 global reservation**：T1 事务内先 INSERT `building`（owner_token/lease_expires_at/attempt>=1）取得 global
  reservation，再推进 candidate 证据；T1-T5 共用同一 owner/token/lease/attempt（不是只在 T2 文件写阶段取进程锁）。
- **candidate manifest（R7-A）**：`candidate_manifest_json` 是 canonical、不可变、完整描述该 generation 中**每个
  canonical key** 的 emitted source 类型、source row/materialization ID、reference SHA、adapter key；
  `candidate_manifest_sha256`（manifest 自身哈希）与 `candidate_registry_sha256`（registry 文件 SHA）**分别冻结**。
- **状态机（R7-A + R8-D/E）**：`building → candidate_persisted | failed | cancelled | indeterminate`；
  `candidate_persisted → file_durable | failed | cancelled | indeterminate`；
  `file_durable → activation_pending | failed | cancelled | indeterminate`；
  `activation_pending → active | failed | cancelled | indeterminate`；
  `indeterminate → active | failed | cancelled`（显式 resolve）；`failed/cancelled` 终态（immutable evidence，
  **重试 = 新 publication row**，旧 evidence 不覆盖不清除，实证 RP-01/RP-02）。
  **R8-D**：`active` 的两个入边（`activation_pending→active` 与 `indeterminate(from=activation_pending)→active`）
  **必须存在匹配的 `voice_registry_publication_activations` command 行**（observed SHA==candidate SHA 且
  activated_at 一致）——activation 由 command trigger 在同一 statement 内完成，**不存在可独立提交的
  publication active 状态**（实证 PA-01）。
  **R8-E**：进入 `indeterminate` 必须立即写入 `indeterminate_from_status = 来源状态`（write-once）；
  indeterminate 期间 candidate SHA/manifest/file_durable_at/activation_requested_at **全部冻结**（含禁止
  NULL→value 首次补写，实证 PE-02）；`indeterminate → active` 仅允许 `indeterminate_from_status='activation_pending'`
  且 candidate 证据已完整存在（只能填 confirmed `activated_at`）；building/candidate 阶段进入的 indeterminate
  **不得 resolve active**，只能 failed/cancelled（实证 PE-03/PE-04）。
- **R8-I generation seal**：`generation` **UNIQUE**（`CREATE TABLE` 内约束）——单调分配必须在
  `BEGIN IMMEDIATE` 下 `SELECT COALESCE(MAX(generation),0)+1` 取得，重复 generation 直接 UNIQUE ABORT（实证 PA-08）。
- **R8-D subject INSERT 验证**（`trg_vrp_subject`）：`materialization_publish` → subject_id 必须是
  `file_ready_unpublished` materialization；`legacy_cutover` → subject_id 必须是 `mapped_verified` legacy entry
  且其 mapped materialization = `file_ready_unpublished`；`registry_rebuild` → subject_id 必须严格 ='global'
  （实证 PA-06/PA-07）。
- **成功 T5 = 单一 atomic activation command（R8-D，取代 R7-B/C 的应用依次 UPDATE）**：
  `INSERT INTO voice_registry_publication_activations (...)` 一条 statement——AFTER INSERT trigger 同一
  statement 内完成 fenced 验证 + projection→published_usable（published_by_publication_id +
  generation/SHA 一次写入）+ legacy entry→mapped_active（如 subject 是 legacy_cutover）+ 最后
  publication→active；任一步失败整条 statement 回滚，**无部分提交**（§2.10/§7.3 T5）。
- **lease fencing（R6-H 迁移到 publication）**：renewal / T5 finalize 的 WHERE 必须
  `AND owner_token=:token AND attempt=:attempt AND lease_expires_at >= :now`；过期未接管 → 旧 owner 不得
  renewal/finalize/新外部副作用（实证 RP-11/RP-12）；takeover CAS 按 `lease_expires_at < :now` attempt+1 换主。
- **subject 冻结（R7-C）**：一个 publication attempt 只改变一个 canonical voice key
  （`subject_type='materialization_publish'`：subject_id = voice_materializations.id；
  `subject_type='legacy_cutover'`：subject_id = legacy_adapter_voice_entries.id；
  `subject_type='registry_rebuild'`：subject_id = 'global'，纯重建无新 key）；其余 key 由 stable view 确定性复制。
- DELETE 禁（append-only journal）。

### 2.10 `voice_registry_publication_activations`（第 11 表：append-only atomic activation command；R8-D）

> publication activation（T5 / crash reconciliation case 3 / activation_indeterminate resolve）的**唯一入口**。
> 应用执行**一条 INSERT statement**；AFTER INSERT trigger 在同一 SQLite statement 内完成全部状态更新——
> 任一步 RAISE(ABORT) 则整条 statement 回滚：publication 保持 activation_pending/indeterminate，
> projection/legacy 零变化。**不存在可独立提交的 publication active 状态**。

```sql
CREATE TABLE voice_registry_publication_activations (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES voice_registry_publications(id) ON DELETE RESTRICT,
  owner_token TEXT,
  -- R9 ③：attempt 必须 >= 1（normal owner finalize 与 indeterminate resolve 共享 attempt 通道）
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  observed_active_registry_sha256 TEXT NOT NULL CHECK
    (length(observed_active_registry_sha256)=64 AND observed_active_registry_sha256 NOT GLOB '*[^0-9a-f]*'),
  activated_at TEXT NOT NULL,
  -- R9 ③：activation_mode 显式两态冻结
  --   normal_owner_finalize     → owner_token NOT NULL, resolution_evidence 可 NULL
  --   indeterminate_reconciliation → owner_token NULL, resolution_evidence NOT NULL,
  --                                  resolution_evidence_hash NOT NULL,
  --                                  attempt = publication.attempt 精确匹配
  activation_mode TEXT NOT NULL CHECK (activation_mode IN
    ('normal_owner_finalize','indeterminate_reconciliation')),
  resolution_evidence TEXT,
  resolution_evidence_hash TEXT CHECK (resolution_evidence_hash IS NULL OR
    (length(resolution_evidence_hash)=64 AND resolution_evidence_hash NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL,
  UNIQUE (publication_id),
  CHECK (
       (activation_mode='normal_owner_finalize'
        AND owner_token IS NOT NULL
        AND resolution_evidence IS NULL AND resolution_evidence_hash IS NULL)
    OR (activation_mode='indeterminate_reconciliation'
        AND owner_token IS NULL
        AND resolution_evidence IS NOT NULL
        AND resolution_evidence_hash IS NOT NULL))
);
-- R8-D + R9 ①③：AFTER INSERT 原子激活（同一 SQLite statement 内 1→5 顺序执行；任一步 ABORT 整条回滚；
--                fence 比较使用 DB_NOW_MS，**不再** 用 NEW.activated_at 作为时间判定基准）
CREATE TRIGGER trg_vrpa_activate AFTER INSERT ON voice_registry_publication_activations
BEGIN
  -- 1) fenced 验证 owner/token/attempt/DB_NOW/observed SHA（activation_pending 在飞）
  --    或 activation_indeterminate resolve（owner 已清；from=activation_pending；只允许
  --    使用已存在的 candidate 证据 + 填 confirmed activated_at / resolution evidence）
  SELECT RAISE(ABORT,'voice_registry_publication_activations fencing mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM voice_registry_publications p
                      WHERE p.id=NEW.publication_id
                        AND p.candidate_registry_sha256=NEW.observed_active_registry_sha256
                        AND ((p.status='activation_pending'
                              AND NEW.activation_mode='normal_owner_finalize'
                              AND p.owner_token IS NEW.owner_token
                              AND p.attempt=NEW.attempt
                              AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
                                  <= p.lease_expires_at_epoch_ms)
                          OR (p.status='indeterminate'
                              AND NEW.activation_mode='indeterminate_reconciliation'
                              AND p.indeterminate_from_status='activation_pending'
                              AND NEW.owner_token IS NULL
                              AND p.attempt=NEW.attempt)));
  -- 2) materialization_publish / legacy_cutover_publish：projection → published_usable
  --    （file_ready_unpublished 前置；本句覆盖 publish_and_cutover 路径的两类 subject_type）
  UPDATE voice_materializations
  SET status='published_usable',
      published_registry_generation=(SELECT generation FROM voice_registry_publications
                                     WHERE id=NEW.publication_id),
      published_registry_sha256=NEW.observed_active_registry_sha256,
      published_by_publication_id=NEW.publication_id,
      updated_at=NEW.activated_at
  WHERE (SELECT subject_type FROM voice_registry_publications WHERE id=NEW.publication_id)
        IN ('materialization_publish','legacy_cutover_publish')
    AND (SELECT subject_mode FROM voice_registry_publications WHERE id=NEW.publication_id)
        ='publish_and_cutover'
    AND id=(CASE (SELECT subject_type FROM voice_registry_publications WHERE id=NEW.publication_id)
              WHEN 'materialization_publish'
                THEN (SELECT subject_id FROM voice_registry_publications WHERE id=NEW.publication_id)
              WHEN 'legacy_cutover_publish'
                THEN (SELECT mapped_voice_materialization_id FROM legacy_adapter_voice_entries
                      WHERE id=(SELECT subject_id FROM voice_registry_publications
                                WHERE id=NEW.publication_id))
            END)
    AND status='file_ready_unpublished';
  SELECT RAISE(ABORT,'voice_registry_publication_activations materialization subject mismatch')
    WHERE (SELECT subject_type FROM voice_registry_publications WHERE id=NEW.publication_id)
          IN ('materialization_publish','legacy_cutover_publish')
      AND changes()=0;
  -- 3) legacy_cutover_existing：projection **保持** published_usable（不再 UPDATE 状态；
  --    activation 仅填 legacy entry → mapped_active；publication → active）
  -- 不对 projection 触发任何 UPDATE——仅 legacy entry 推进状态（与 §2.7 trg_vmat_publish
  --   对 legacy_cutover_existing 的零投影写入一致）
  UPDATE legacy_adapter_voice_entries
  SET mapping_status='mapped_active', candidate_activated_at=NEW.activated_at
  WHERE (SELECT subject_type FROM voice_registry_publications WHERE id=NEW.publication_id)='legacy_cutover_existing'
    AND (SELECT subject_mode FROM voice_registry_publications WHERE id=NEW.publication_id)='cutover_existing'
    AND id=(SELECT subject_id FROM voice_registry_publications WHERE id=NEW.publication_id)
    AND mapping_status='mapping_pending'
    AND pending_publication_id=NEW.publication_id;
  SELECT RAISE(ABORT,'voice_registry_publication_activations legacy subject mismatch')
    WHERE (SELECT subject_type FROM voice_registry_publications WHERE id=NEW.publication_id)='legacy_cutover_existing'
      AND changes()=0;
  -- 3b) legacy_cutover_publish：mapped projection 已由 (2) 更新；legacy entry 再推进
  UPDATE legacy_adapter_voice_entries
  SET mapping_status='mapped_active', candidate_activated_at=NEW.activated_at
  WHERE (SELECT subject_type FROM voice_registry_publications WHERE id=NEW.publication_id)='legacy_cutover_publish'
    AND id=(SELECT subject_id FROM voice_registry_publications WHERE id=NEW.publication_id)
    AND mapping_status='mapping_pending'
    AND pending_publication_id=NEW.publication_id;
  SELECT RAISE(ABORT,'voice_registry_publication_activations legacy cutover publish subject mismatch')
    WHERE (SELECT subject_type FROM voice_registry_publications WHERE id=NEW.publication_id)='legacy_cutover_publish'
      AND changes()=0;
  -- 4) publication → active（最后；trg_vrp_transition 验证本 command 行存在）；
  --    DB_NOW_MS 比对代替 caller-supplied activated_at 作为时间判定
  UPDATE voice_registry_publications
  SET status='active', owner_token=NULL, lease_expires_at_epoch_ms=NULL,
      activated_at=NEW.activated_at, updated_at=NEW.activated_at
  WHERE id=NEW.publication_id
    AND candidate_registry_sha256=NEW.observed_active_registry_sha256
    AND ((status='activation_pending'
          AND owner_token IS NEW.owner_token AND attempt=NEW.attempt
          AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
              <= lease_expires_at_epoch_ms)
      OR (status='indeterminate' AND indeterminate_from_status='activation_pending'
          AND attempt=NEW.attempt));
  SELECT RAISE(ABORT,'voice_registry_publication_activations publication update failed')
    WHERE changes()=0;
END;
-- R9 ③：indeterminate resolve 必填 resolution_evidence + resolution_evidence_hash
CREATE TRIGGER trg_vrpa_resolution_evidence BEFORE INSERT ON voice_registry_publication_activations
WHEN (NEW.activation_mode='indeterminate_reconciliation'
      AND (NEW.resolution_evidence IS NULL OR NEW.resolution_evidence_hash IS NULL))
  OR (NEW.activation_mode='normal_owner_finalize'
      AND (NEW.resolution_evidence IS NOT NULL OR NEW.resolution_evidence_hash IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'voice_registry_publication_activations resolution_evidence required'); END;
-- R9 ①：activated_at / created_at 不得明显晚于 DB 当前时间（caller 不得回填未来）
CREATE TRIGGER trg_vrpa_evidence_time BEFORE INSERT ON voice_registry_publication_activations
WHEN NEW.activated_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  OR NEW.created_at > (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'voice_registry_publication_activations evidence timestamp in future'); END;
CREATE TRIGGER trg_vrpa_update_abort BEFORE UPDATE ON voice_registry_publication_activations
BEGIN SELECT RAISE(ABORT,'voice_registry_publication_activations is immutable'); END;
CREATE TRIGGER trg_vrpa_delete_abort BEFORE DELETE ON voice_registry_publication_activations
BEGIN SELECT RAISE(ABORT,'voice_registry_publication_activations delete forbidden'); END;
```

- **原子性（R8-D 冻结）**：activation INSERT statement 成功 ⇔ publication=active + projection=published_usable
  （如适用）+ legacy=mapped_active（如适用）同时持久化；任一 subject mismatch / fencing 不命中 / changes=0 /
  trigger ABORT → 整条 statement 回滚（实证 PA-02/PA-03/PA-04/PA-05）。
- **subject 语义（R8-C 冻结，唯一模型）**：`materialization_publish` → 更新 subject projection；
  `legacy_cutover` → 同时更新 mapped projection 与 legacy entry（publication 本身发布目标 projection；
  legacy entry 不能激活其他 projection——projection 必须等于 entry.mapped_voice_materialization_id，实证 PA-05）；
  `registry_rebuild` → 无 subject 更新，仅 publication→active。
- **append-only evidence**：command 行永久保存（owner/attempt/observed SHA/activated_at/resolution_evidence；
  UPDATE/DELETE 禁；`UNIQUE(publication_id)` 保证一个 publication 至多一次成功 activation——已 active 后
  第二次 INSERT 必因 fencing 不命中 ABORT）。
- **indeterminate resolve 专用语义（R8-E）**：`owner_token` 填 NULL、`attempt` 填 journal 当前 attempt、
  `resolution_evidence` 记录裁决依据；只允许 `indeterminate_from_status='activation_pending'` 且 observed SHA ==
  已持久化 candidate SHA——不得首次填写 candidate manifest/SHA/file_durable_at（immutable trigger indeterminate
  冻结段强制）。

---

## 3. Validation finalization fencing（`tts_synthesis_claims`，R5 修复；R9 ① database-time fencing）

### 3.1 fenced finalization contract（冻结旧 validator 无法提交）

validator 在事务外完成 exact artifact reader（`validateSentenceAudioArtifactExact`）后，
Phase 3 必须在**同一 `BEGIN IMMEDIATE`** 中先 fencing 重读、再单条 fenced UPDATE 完成终局。
重读项与 `UPDATE ... WHERE`  fencing 条件**逐项相同**：

```text
status == 'validating_reuse'
validation_owner_token == 本 validator token
validation_attempt == 本次 attempt
(SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    <= validation_lease_expires_at_epoch_ms   ← R9 ① DB_NOW_MS（trigger 内取数）
candidate_artifact_id IS 本次 candidate（NULL 用 IS）
candidate_artifact_metadata_hash IS 本次读取的 metadata hash（NULL 用 IS）
```

**usable（reuse → succeeded，不建 job）**：

```sql
UPDATE tts_synthesis_claims
SET status='succeeded', result_artifact_id=:artifact_id,
    validation_owner_token=NULL, validation_lease_expires_at_epoch_ms=NULL,
    candidate_artifact_id=NULL, candidate_artifact_metadata_hash=NULL,
    updated_at=:now
WHERE id=:claim_id AND status='validating_reuse'
  AND validation_owner_token=:token AND validation_attempt=:attempt
  AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      <= validation_lease_expires_at_epoch_ms
  AND candidate_artifact_id IS :candidate_artifact_id
  AND candidate_artifact_metadata_hash IS :candidate_metadata_hash;
-- changes=1 必须；同事务内随后 fan-out 全部未取消 subscriber（§4）
```

**unusable（→ generation_pending + 恰好一个 queued job）**（R8-F：**单一 atomic dispatch command**——不再允许
"UPDATE claim → generation_pending" + "INSERT job" 两条可独立提交的应用语句作为唯一约束）：

```sql
-- 一条 INSERT statement（同一 BEGIN IMMEDIATE 内）：
INSERT INTO tts_claim_generation_dispatches
  (id, claim_id, job_id, validation_owner_token, validation_attempt,
   candidate_artifact_id, candidate_artifact_metadata_hash,
   project_id, unit_id, narration_plan_artifact_id, narration_plan_version,
   provider, voice_profile_id, voice_profile_revision, voice_profile_revision_id,
   payload_json, originating_request_id, exact_source_fingerprint,
   synthesis_payload_fingerprint, final_tts_input_fingerprint, generation_variant_id, created_at)
VALUES (:dispatch_id, :claim_id, :job_id, :token, :attempt,
   :candidate_artifact_id, :candidate_metadata_hash,
   :project_id, :unit_id, :narration_plan_artifact_id, :narration_plan_version,
   :provider, :voice_profile_id, :voice_profile_revision, :voice_profile_revision_id,
   :payload_json, :originating_request_id, :exact_source_fingerprint,
   :synthesis_payload_fingerprint, :final_tts_input_fingerprint, :generation_variant_id, :now);
-- §2.2b AFTER INSERT trigger 在同一 statement 内原子完成：
--   1) fenced 验证 validating_reuse owner/token/attempt/lease/candidate（不命中 → ABORT = STALE_VALIDATION_OWNER）
--   2) 验证 active subscriber > 0
--   3) INSERT 恰好一个 queued job（job 侧 trigger 复核 claim identity / dispatch 匹配 /
--      初始状态 queued / voice profile+revision exact pair / provider==revision.provider）
--   4) claim → generation_pending + 清 validation owner/candidate
-- 任一步失败 → 整条 INSERT statement 回滚：claim 保持 validating_reuse、无 job、无 dispatch 行（CJ-11）
-- 同 claim 第二次 dispatch → UNIQUE(claim_id) ABORT（CJ-12）
```

**零 subscriber（→ cancelled，无 job）**：同 WHERE 的 fenced UPDATE 置 `status='cancelled'` 并清空
validation owner/lease + candidate 列（`changes=1` 必须）。

**`changes=0` → 返回 `STALE_VALIDATION_OWNER`，整事务回滚**：不修改 claim/job/request/projection、
不创建 queued job、不 fan-out、不复用 artifact、不写文件（事务外 I/O 结果全部丢弃）。

### 3.2 Takeover CAS（lease 过期接管；R9 ① DB_NOW_MS 比对）

```sql
UPDATE tts_synthesis_claims
SET validation_owner_token=:new_token,
    validation_lease_expires_at_epoch_ms=:now_plus_lease_ms,
    validation_attempt=validation_attempt+1,
    validation_started_at=:now_iso
WHERE id=:claim_id AND status='validating_reuse'
  AND validation_lease_expires_at_epoch_ms
      < (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
-- changes=1 才取得接管权；changes=0 → 未过期/已被并发接管/已终态 → 不接管
```

接管后新 validator 重新执行 exact artifact reader（不调用 provider）。
candidate 已删除 / metadata 漂移 / reader 失败 → 按 unusable 处理（不 fallback latest/default）。

### 3.3 Lease renewal（仅当前 owner 可续租；R9 ① DB_NOW_MS 比对）

```sql
UPDATE tts_synthesis_claims
SET validation_lease_expires_at_epoch_ms=:now_plus_lease_ms, updated_at=:now_iso
WHERE id=:claim_id AND status='validating_reuse'
  AND validation_owner_token=:token AND validation_attempt=:attempt
  AND validation_lease_expires_at_epoch_ms
      >= (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
-- 旧 owner / 错误 attempt / lease 已过期（未接管）→ changes=0（续租失败，零副作用）
```

**过期-未接管状态（R6-H 冻结 + R9 ①）**：`validation_lease_expires_at_epoch_ms < DB_NOW_MS` 且尚未被 takeover CAS 接管时，
旧 owner **不得 renewal**（WHERE 含 `>= DB_NOW_MS` → changes=0）、**不得 finalize**（§3.1 WHERE 已含 `>= DB_NOW_MS` →
changes=0 → `STALE_VALIDATION_OWNER`）、**不得执行新的外部副作用**；旧 owner 即使完成了过期期间的外部 I/O
（artifact reader / 文件校验），也不得提交数据库终局（fenced UPDATE 全部不命中）。**caller 不得回填**
`activated_at` / `validation_started_at` 等业务 evidence 时间冒充 lease 未过期——DB 当前时间由 trigger 内
SELECT 计算（julianday('now')），独立于任何 caller-supplied 时间。实证 IS-16/IS-16e。

### 3.4 三方竞争（validator A / takeover B / last-subscriber cancel）

三方操作各自是独立 `BEGIN IMMEDIATE`（cancel 事务、fenced finalize 事务、takeover CAS），
SQLite 写锁串行化，**最终只有一个数据库裁决**：

```text
1) cancel 先提交：active subscriber=0 → claim=cancelled（释放 active unique）。
   随后 A/B 的 fenced finalize WHERE status='validating_reuse' 不命中 → changes=0 → STALE_VALIDATION_OWNER 零副作用。
2) A finalize 先提交（usable → succeeded 并 fan-out）：
   B takeover WHERE lease 未过期不命中 → changes=0；cancel 到达时 envelope 已 succeeded → 终态不可取消（409/幂等）。
3) B takeover 先提交（A lease 已过期）：attempt+1、token 换主。
   A finalize WHERE token/attempt 不命中 → changes=0 → STALE_VALIDATION_OWNER 零副作用；
   B 重跑 reader 后 finalize；cancel 与 B finalize 按 1)/2) 裁决。
```

冻结结果不变量：

```text
零 subscriber            → claim=cancelled，无 job，释放 active unique
有 subscriber + usable   → claim=succeeded + result_artifact_id，全部未取消 envelope succeeded（reused）
有 subscriber + unusable → claim=generation_pending + 恰好一个 queued job（单一 atomic dispatch command，§2.2b）
stale validator          → 永远零副作用（无 claim/job/request 改动、无 job、无 fan-out、无文件写）
```

### 3.5 Phase 1（单 BEGIN IMMEDIATE，沿用 R4）

```text
1. request envelope-first 裁决（tts_audio_requests；同 requestId 异 identity → 409）
2. 查找 active synthesis claim（partial unique 命中）
   - 命中 validating_reuse → envelope 链接同一 claim；返回 waiting/in_progress；不重复创建 validator
   - 未命中 → INSERT claim status=validating_reuse（validation_owner_token=新 UUID、
     lease=now+VALIDATION_LEASE_MS、attempt=1、candidate 同步 DB 读（可 NULL）、validation_started_at=now）
3. subscriber 链接 claim
COMMIT
```

### 3.6 Worker claim、lease renewal 与 execution takeover（R11 ⑥：全部经 command）

**Worker claim（首次 ownership establishment）**：claim `generation_pending`（owner NULL）+ job `queued`
（claimed_by NULL）时，Scheduler/Worker 不直接 UPDATE 任何状态——只发一条 `worker_claim` execution
command（§2.2c）。command 提供 `worker_owner_token`（新 UUID）、`worker_attempt`（= 当前
`claim.validation_attempt`）、`worker_lease_expires_at_epoch_ms = DB_NOW_MS + EXECUTION_LEASE_MS`、
`claimed_at` / `heartbeat_at` / `activated_at` / `created_at`；trigger 验证双方无 owner、command
lease > DB_NOW_MS、attempt 一致后，同一 statement 内同步建立双侧 running + owner/lease/attempt。
并发两个 worker 同时 claim：第一条 command 提交后 job 已非 `queued`，第二条的 exact-old-state
复核（step 1）不命中 → ABORT，恰好一个 running owner（实证 JS-05）。

**Worker lease renewal（仅当前 owner；R11 改为 lease_renewal command，不再两条 fenced UPDATE）**：
worker 在执行中续租，只发一条 `lease_renewal` command（§2.2c；running→running 或
indeterminate→indeterminate）：command 提供当前 `worker_owner_token` / `worker_attempt`、
新 lease `= DB_NOW_MS + EXECUTION_LEASE_MS`（必须 > 当前 lease）、`heartbeat_at`；trigger 验证
`claim.owner_token = job.claimed_by = command.worker_owner_token`、双侧 attempt exact、
旧 lease >= DB_NOW_MS、新 lease > 旧 lease 且 > DB_NOW_MS、heartbeat 不早于旧 heartbeat 后，
同一 statement 原子更新 `claim.lease_expires_at_epoch_ms/updated_at` + `job.heartbeat_at`。
同一 attempt 可多次续租（同 `transition_request_id` 不重复；实证 JS-22/32）；旧 owner / 错误
attempt / lease 已过期 / heartbeat 倒退 → ABORT 整条回滚（实证 JS-16/23）。应用层不得再用
两条无 command 的 fenced UPDATE 模拟（per-column fence ABORT，实证 JS-20）。

**Execution takeover（running/indeterminate claim 的 lease 过期接管；R11 改为 execution_takeover
command，替代 R10 的两条 UPDATE CAS）**：worker 失联、lease 过期后，新 worker 只发一条
`execution_takeover` command（§2.2c；running→running 或 indeterminate→indeterminate）：command
提供新 `worker_owner_token`（必须 != 旧 owner）、`worker_attempt = 旧 attempt + 1`、
新 lease `= DB_NOW_MS + EXECUTION_LEASE_MS`、`claimed_at` / `heartbeat_at`；trigger 验证
`claim.owner_token = job.claimed_by`（旧 owner 双侧 exact 且非 NULL）、旧 claim lease < DB_NOW_MS、
新 owner 不同、attempt=旧+1、新 lease > DB_NOW_MS 后，同一 statement 原子更新
`claim.owner_token/lease/validation_attempt` + `job.claimed_by/claimed_at/heartbeat_at/attempt`。
**不得**用两条应用 UPDATE 模拟原子性（per-column fence 使 claim 侧先改、job 侧后改的结构上不可提交）。

接管后新 owner 以 `worker_attempt = validation_attempt`（已 +1）发 state_transition command
（含 indeterminate resolve）；旧 owner 的任何 renewal / takeover / state_transition command 因
token/attempt 不匹配一律 ABORT（`worker fencing mismatch`，实证 JS-26）。`indeterminate` 状态保留
owner/lease（§2.2 claim CHECK）正是为了 renewal / takeover / resolve 的 fence 比对。

**Prestart terminal（Worker claim 前终结；R11 新增可达边）**：dispatch 后、Worker claim 前，
`queued/generation_pending → failed/cancelled` 只经 `prestart_terminal` command（§2.2c）：
Scheduler 静态 preflight/config 失败、active subscriber=0（§4 裁决）、或明确取消不启动 Provider。
不得用于已 running 的 Worker / Provider 已调用 / indeterminate resolve（实证 JS-27/28/29）。

## 4. Validating 阶段取消语义与 zero-subscriber race（R5 冻结）

Phase 3 fenced 重读在同一事务内统计 active subscriber（`status IN ('waiting','running')`）：

```text
active subscriber = 0 → claim cancelled（fenced UPDATE §3.1）+ 不创建 tts_job + 释放 active unique
active subscriber > 0 + usable → succeeded + fan-out（同事务 UPDATE 全部未取消 envelope）
active subscriber > 0 + unusable → generation_pending + 恰好一个 queued job（单一 atomic dispatch command，§2.2b）
```

规则：

- 单 request cancel 仅取消该 envelope（`tts_audio_requests.status='cancelled'`，同事务检查）；
- **最后 subscriber 在 validating_reuse 阶段取消 → 直接取消 claim**（无 job 存在，不置 cancel_requested）；
- **最后 subscriber 在 generation_pending/running 阶段取消 → 才设置 `job.cancel_requested=1`**；
- **dispatch 后、Worker claim 前（claim generation_pending + job queued）的取消/失败一律经
  `prestart_terminal` command（§2.2c）双侧终结**：active subscriber=0（§4 裁决）、Scheduler 静态
  preflight/config 失败、或明确取消不启动 Provider——不再留下无合法 command 的状态边（R11 P0-B）；
  已 running 的 Worker / Provider 已调用 / indeterminate resolve 不得走 prestart；
- validator finalize 与最后 cancel 竞争由事务串行裁决（§3.4）：cancel 优先——finalize 事务重读时
  active subscriber=0 → 不 reused、不建 job、claim cancelled；
- **不允许创建 zero-subscriber provider job**。

---

## 5. Materialization 真正 single-flight + fencing（`voice_materialization_jobs`，R5 修复）

### 5.1 fenced finalization contract（与 §3.1 对称；R9 ① database-time fencing）

`validating_existing` 的 Phase 3 在同一 `BEGIN IMMEDIATE` 内 fencing 重读 +
单条 fenced UPDATE（`changes=1` 必须；`changes=0` → `STALE_VALIDATION_OWNER` 整事务回滚，零文件写）：

```text
status == 'validating_existing'
validation_owner_token == 本 validator token
validation_attempt == 本次 attempt
(SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    <= validation_lease_expires_at_epoch_ms   ← R9 ① DB_NOW_MS（trigger 内取数）
candidate_materialization_id IS 本次 candidate（NULL 用 IS）
candidate_materialization_metadata_hash IS 本次读取的 metadata hash（NULL 用 IS）
```

```sql
-- usable（existing projection 可用 → succeeded + 全部未取消 request reused，零文件写）：
UPDATE voice_materialization_jobs
SET status='succeeded',
    validation_owner_token=NULL, validation_lease_expires_at_epoch_ms=NULL,
    candidate_materialization_id=NULL, candidate_materialization_metadata_hash=NULL,
    updated_at=:now_iso
WHERE id=:job_id AND status='validating_existing'
  AND validation_owner_token=:token AND validation_attempt=:attempt
  AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      <= validation_lease_expires_at_epoch_ms
  AND candidate_materialization_id IS :candidate_id
  AND candidate_materialization_metadata_hash IS :candidate_hash;
-- changes=1 必须；同事务：UPDATE requests SET status='reused', materialization_id=:mid
--   WHERE job_id=:job_id AND status IN ('waiting','running')

-- unusable + 有 subscriber（→ queued，Scheduler 才可见）：
UPDATE voice_materialization_jobs
SET status='queued',
    validation_owner_token=NULL, validation_lease_expires_at_epoch_ms=NULL,
    candidate_materialization_id=NULL, candidate_materialization_metadata_hash=NULL,
    updated_at=:now_iso
WHERE id=:job_id AND status='validating_existing'
  AND validation_owner_token=:token AND validation_attempt=:attempt
  AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      <= validation_lease_expires_at_epoch_ms
  AND candidate_materialization_id IS :candidate_id
  AND candidate_materialization_metadata_hash IS :candidate_hash;
-- changes=1 必须

-- 零 subscriber（→ cancelled，释放 active unique）：同 WHERE 置 status='cancelled'
```

Takeover CAS 与 §3.2 同构（同表同列，`validating_existing`；R9 ① DB_NOW_MS 比对）：

```sql
UPDATE voice_materialization_jobs
SET validation_owner_token=:new_token,
    validation_lease_expires_at_epoch_ms=:now_plus_lease_ms,
    validation_attempt=validation_attempt+1
WHERE id=:job_id AND status='validating_existing'
  AND validation_lease_expires_at_epoch_ms
      < (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
-- changes=1 才取得接管权；changes=0 → 未过期/已被接管/已终态 → 不接管
```

Lease renewal（R9 ① DB_NOW_MS 比对）：

```sql
UPDATE voice_materialization_jobs
SET validation_lease_expires_at_epoch_ms=:now_plus_lease_ms, updated_at=:now_iso
WHERE id=:job_id AND status='validating_existing'
  AND validation_owner_token=:token AND validation_attempt=:attempt
  AND validation_lease_expires_at_epoch_ms
      >= (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
-- 旧 owner / 错误 attempt / lease 已过期（未接管）→ changes=0（续租失败，零副作用）
```

过期-未接管状态与 §3.3 相同（R6-H + R9 ①）：旧 validator 不得 renewal / 不得 fenced finalize（§5.1 WHERE 已含
`>= DB_NOW_MS` → changes=0 → `STALE_VALIDATION_OWNER`）/ 不得执行新的外部副作用；过期 I/O 结果不得提交 DB 终局。
**caller 不得回填**任何业务 evidence 时间冒充 lease 未过期。实证 IS-17/IS-17d。

### 5.2 正确算法（三阶段）

```text
BEGIN IMMEDIATE
1. request envelope-first（project 内幂等；异 identity → 409）
2. 查找 canonical projection（voice_materializations）+ 读取 metadata hash
3. 查找/创建 active materialization job = validating_existing
   （partial unique 保证同 profile+revision 只有一个；命中则链接，不重复创建 validator）
4. 多 request 链接同一 job
COMMIT

事务外 exact projection/file validator（existing projection 文件存在 + SHA/codec/size 一致）

BEGIN IMMEDIATE
5A. usable：fenced finalize（§5.1）→ 全部未取消 request reused + job succeeded，零文件写
5B. unusable：active subscriber=0 → fenced cancelled；否则 fenced → queued
COMMIT

随后 Worker 才执行 temp copy（claim queued → running，Worker owner/lease/heartbeat）
```

### 5.3 Worker 执行互斥

两个 Worker 同时 claim 同一 queued job：只有一条
`UPDATE ... SET status='running', owner_token=?, lease_expires_at=?, heartbeat_at=? WHERE id=? AND status='queued'`
命中（`changes=1`）；另一个 `changes=0` 不执行。`validating_existing` 永不被 Scheduler claim。

---

## 6. Materialization fan-out 与 durability（沿用 R4，补 fencing 重读）

文件 durable（temp copy → SHA/codec/size 校验 → rename → file fsync → dir fsync）后**单事务**：

```text
BEGIN IMMEDIATE
1. fenced 重读 job：status='running' AND owner_token=本 Worker AND lease 未过期
   （不命中 → 整事务回滚，文件按 exact profile/revision/SHA 留作 recoverable orphan）
2. 重读 exact Voice Revision（validateVoiceProfileRevisionExact usable）
3. 重读全部 active request subscriber + 验证 identity / Assignment / project 自洽
   （任一 mismatch → 整事务回滚 + REQUEST_STATE_INCONSISTENT）
4. INSERT 或 UPDATE canonical projection = file_ready_unpublished
   （UNIQUE(profile, revision) upsert：同 voice 复用既有 projection 行）
5. job → succeeded（清 Worker owner/lease/heartbeat）
6. 全部未取消 request → succeeded + materialization_id
COMMIT
```

任一步失败：整事务回滚；不允许 projection/job/request 部分成功；cleanup 不删除 DB 正在引用或可恢复的文件。

---

## 7. Global registry publication journal + crash-safe cutover protocol（R7 重写）

### 7.1 双 view 分离 + publication journal（R7-A）

```text
stable emitted registry view（adapter 当前加载的 registry 重建源）：
  mapping_status = unmapped / mapped_verified / mapping_pending → legacy entry
  mapping_status = mapped_active                                → TTS-A voice_materialization
  mapping_status = retired                                      → 不输出
  已发布 key（voice_materializations.status='published_usable'）→ TTS-A projection

candidate registry view（publication 期间 publisher 构建的候选）：
  与 stable 完全相同，仅对本 publication 的 frozen subject key
  （materialization_publish：未发布 projection；legacy_cutover：mapping_pending 的 exact key）
  改用新 candidate source；其余 key 由 stable view 确定性复制
```

- **`mapping_pending` 不再是"普通 registry 仍按 legacy"的模糊态**：它持久化了 candidate 意图标记
  （`candidate_source_selector='tts_a'`）与 **`pending_publication_id` 权威引用**（指向 active
  `voice_registry_publications`，§2.8）——**candidate generation/SHA/manifest 的单一权威是 publication 行
  （R8-B），legacy 行不再复制**；**cutover 所有权（owner/token/lease/attempt）移入 publication 表**
  （§2.9，T1-T5 共用同一 global owner）；stable view 仍输出 legacy（旧 voice 不丢），
  candidate view 对该 key 使用 TTS-A；publication failed/cancelled → legacy rollback 回 mapped_verified
  并清 pending link（R8-A），重试引用新 publication.id；
- **每个 canonical key 在任一 registry（stable 或 candidate）中恰好一个 source**：
  由 `UNIQUE(voice_profile_key, voice_revision_key)` + **DB 级 global active single-flight**
  （`uq_voice_registry_publication_active`，§2.9）+ 上表确定性选择规则共同保证
  （冲突 = 构建失败 fail-closed，不写文件）；
- **第 10 表不可替代（R7-A 推翻 R6 的"保持 9 表"论证）**：per-projection/per-key candidate evidence
  不能完整表达全局 registry publication（两个 legacy row 可能分别持有互不相同的 active candidate SHA、
  任意 per-key row 不能裁决全局 active SHA 的 reconciliation）——registry 激活的唯一 journal 是
  `voice_registry_publications`。禁止用进程内状态伪装闭环。

### 7.2 Mapping 等价性（`unmapped → mapped_verified` 前置，沿用 R4 + R8-C）

canonical voice key、reference SHA-256、speaker identity/name policy、adapter compatibility key、
reference file containment、codec/sample-rate/channels——全项一致才允许 mapped_verified
（同事务设置 `mapped_voice_materialization_id`）。
**R8-C 前置**：mapped materialization 必须 `status='file_ready_unpublished'`（`trg_lve_mapped_verified`）——
legacy_cutover publication 本身同时发布目标 projection（单一模型），不接受已发布 projection。

### 7.3 Crash-safe cutover 协议（R8：publication journal + atomic activation command 版本；R9 ① database-time fencing + ④⑤ dual-mode cutover）

```text
T1 BEGIN IMMEDIATE（global reservation + subject 冻结）：
   先 INSERT voice_registry_publications（status='building', generation（BEGIN IMMEDIATE 下
     SELECT COALESCE(MAX(generation),0)+1 单调分配；UNIQUE 强制，重复直接 ABORT）,
     subject_type, subject_id, subject_mode, stable_registry_sha256, publisher_schema_version,
     owner_token=新 UUID, lease_expires_at_epoch_ms=DB_NOW_MS+PUBLICATION_LEASE_MS, attempt=1）
   —— global active single-flight 保证全系统最多一个 active publication（第二个 T1 → UNIQUE ABORT）；
      §2.9 trg_vrp_subject 验证 exact subject（materialization_publish + publish_and_cutover →
        file_ready_unpublished materialization 且**未被** legacy 引用；legacy_cutover_publish +
        publish_and_cutover → mapped_verified legacy entry 且 mapping_mode='publish_and_cutover'
        且 mapped projection=file_ready_unpublished；
        legacy_cutover_existing + cutover_existing → mapped_verified legacy entry 且
        mapping_mode='cutover_existing' 且 mapped projection=published_usable 且
        published_by_publication_id IS NOT NULL；
        registry_rebuild + none → subject_id='global'）
   R10 ④⑤ 双路径可达协议（修复 R9 P0-3）：
     **路径 A（publish_and_cutover）**：legacy entry unmapped → mapped_verified（写入
       mapping_mode='publish_and_cutover'；前置 projection=file_ready_unpublished 且无
       active-flight materialization_publish 在飞，否则 ABORT 待完成后改走路径 B）→
       T1 创建 legacy_cutover_publish publication（此时 entry 为 mapped_verified）→
       同事务 entry mapped_verified → mapping_pending（pending=本 publication）→ T5 activation
       原子完成 projection 发布 + entry mapped_active + publication active；
     **路径 B（cutover_existing）**：legacy entry unmapped → mapped_verified（写入
       mapping_mode='cutover_existing'；前置 projection=published_usable 且
       published_by_publication_id 非 NULL）→ T1 创建 legacy_cutover_existing publication →
       同事务 entry → mapping_pending → T5 activation 原子完成 entry mapped_active +
       publication active（**projection 保持 published_usable，publication evidence 零修改**）；
     mapping_mode 在 unmapped→mapped_verified 时选定并 write-once，rollback 不清，retired 保留历史值。
   R9 ⑤：materialization_publish + legacy 引用 ⇒ `materialization_publish blocked by legacy mapping` ABORT；
        legacy 必须走 legacy_cutover_publish 或 legacy_cutover_existing
   如 subject 是 legacy_cutover_publish 或 legacy_cutover_existing：
     同事务 UPDATE legacy_adapter_voice_entries mapping_status='mapping_pending',
     pending_publication_id=:publication_id, candidate_source_selector='tts_a'
     （candidate generation/SHA/manifest 由确定性构建算法计算后只写入 publication 行（R8-B 单一权威），
       legacy 行不再复制；§2.8 trg_lve_publication_link + trg_lve_alias 校验）
T1.5 fenced verify/renew lease（每个外部副作用步骤前必须；R9 ① DB_NOW_MS 比对）：
   UPDATE voice_registry_publications
   SET lease_expires_at_epoch_ms=:now_plus_lease_ms, updated_at=:now_iso
   WHERE id=:publication_id AND status IN ('building','candidate_persisted','file_durable','activation_pending')
     AND owner_token=:token AND attempt=:attempt
     AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
         <= lease_expires_at_epoch_ms;
   -- changes=1 必须；changes=0（过期未接管 / 已被接管 / 旧 owner）→ 立即停止，不执行 T2/T3/T4 任何外部副作用
T2 publisher 写 candidate registry：temp 写 → fsync → rename → dir fsync（全局发布锁；
   先 UPDATE publication → candidate_persisted（candidate_registry_sha256 + candidate_manifest_json +
   candidate_manifest_sha256 一次写入），再写文件；仅 T1.5 changes=1 的当前 owner 可执行）
T3 adapter reload（mtime/inode/size 检测 → 原子加载 → swap；失败保持 LKG；
   文件 durable 后 UPDATE publication → file_durable（file_durable_at）；仅当前 owner 可执行）
T4 poll /health：activeRegistrySha256 == persisted candidate_registry_sha256
   （轮询前 UPDATE publication → activation_pending（activation_requested_at）；仅当前 owner 可执行）
T5（R8-D + R9 ①③ 单一 atomic activation command；不再允许应用依次 UPDATE publication/projection/legacy）：
   -- normal finalize（activation_pending 在飞）：owner_token/attempt 非 NULL
   INSERT INTO voice_registry_publication_activations
     (id, publication_id, owner_token, attempt, observed_active_registry_sha256,
      activation_mode, activated_at, created_at)
   VALUES (:activation_id, :publication_id, :token, :attempt, :observed_active_sha,
     'normal_owner_finalize', :now_iso, :now_iso);
   -- 或 indeterminate resolve（activation_indeterminate from activation_pending）：
   --   owner_token NULL, attempt = publication.attempt 精确匹配,
   --   resolution_evidence + resolution_evidence_hash 必填
   INSERT INTO voice_registry_publication_activations
     (id, publication_id, owner_token, attempt, observed_active_registry_sha256,
      activation_mode, resolution_evidence, resolution_evidence_hash, activated_at, created_at)
   VALUES (:activation_id, :publication_id, NULL, (SELECT attempt FROM voice_registry_publications
     WHERE id=:publication_id), :observed_active_sha,
     'indeterminate_reconciliation', :resolution_evidence, :resolution_evidence_hash,
     :now_iso, :now_iso);
   -- §2.10 AFTER INSERT trigger 在同一 SQLite statement 内原子完成：
   --   1) fenced 验证（DB_NOW_MS 比对 / activation_mode 与 status 匹配 / attempt 精确匹配）
   --   2) 按 subject_type + subject_mode 验证 exact subject 并更新：
   --      materialization_publish + publish_and_cutover → projection published_usable
   --      legacy_cutover_publish + publish_and_cutover → mapped projection published_usable +
   --        legacy entry mapped_active
   --      legacy_cutover_existing + cutover_existing → projection **保持** published_usable（不 UPDATE 状态）
   --        + legacy entry mapped_active
   --      registry_rebuild + none → 无 subject 更新，仅 publication→active
   --   3) publication → active（清 owner/lease，activated_at）
   -- 任一步失败（fencing 不命中 / subject mismatch / changes=0 / trigger ABORT）
   --   → 整条 INSERT statement 回滚：publication 保持 activation_pending/indeterminate，
   --     projection/legacy 零变化，按 §7.4 case 3/5 处理；不存在可独立提交的 publication active 状态
```

**Publication lease renewal（仅当前 owner 可续租；R9 ① DB_NOW_MS 比对）**：

```sql
UPDATE voice_registry_publications
SET lease_expires_at_epoch_ms=:now_plus_lease_ms, updated_at=:now_iso
WHERE id=:publication_id AND status IN ('building','candidate_persisted','file_durable','activation_pending')
  AND owner_token=:token AND attempt=:attempt
  AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      <= lease_expires_at_epoch_ms;
-- 旧 owner / 错误 attempt / 过期未接管 → changes=0（续租失败，零副作用）
```

**stale owner external-side-effect 规则（R6-H + R8-D + R9 ①）**：lease 已过期但尚未 takeover → 旧 owner 不得
renewal（changes=0）、不得执行 T2/T3/T4 任何新的外部副作用（registry 写 / adapter reload / health poll）、
不得 T5——旧 owner 的 activation command INSERT 必因 fenced 验证不命中（owner_token/attempt 不匹配或
`DB_NOW_MS <= lease_expires_at_epoch_ms` 不成立）整条 ABORT；旧 owner 即使完成了过期期间的 registry 写 /
reload / poll I/O，也不得提交数据库终局。caller 不得回填 `activated_at` / `file_durable_at` 等业务 evidence
时间冒充 lease 未过期——DB 当前时间由 trigger 内 SELECT 计算（julianday('now')），独立于 caller-supplied 时间。
实证 RP-11/RP-12。

### 7.4 Crash reconciliation（publisher/Worker 启动或接管时执行；按 publication journal 完成整个 subject）

```text
case 1  publication 处于 building/candidate_persisted，registry 尚未写：
        磁盘 registry SHA != candidate SHA 且 adapter active == stable SHA
        → 重新确定性构建同一 candidate（同 DB 状态 → 同 SHA）→ 续 T2；或 fenced cancelled 后新 row 重试。
case 2  registry durable（candidate_persisted/file_durable），adapter 尚未 reload：
        磁盘 registry SHA == persisted candidate SHA、active SHA == stable SHA
        → 触发 reload，续 T3；不重建、不改 DB。
case 3  adapter active SHA == persisted candidate SHA，publication 尚未 active（DB 未 T5）：
        → 按 publication journal 完成**整个 subject** 的 T5 原子 reconciliation——INSERT 同一条
          activation command（observed SHA = persisted candidate SHA；lease 过期先按 case 6 takeover）：
          command trigger 同一 statement 内 publication → active + projection → published_usable +
          legacy → mapped_active；不得只根据任意一个 per-key row 猜测——journal 的 subject 是唯一裁决源；
          activation 已在飞但 DB 未提交（activation_indeterminate）→ 以 owner_token=NULL 的 resolve
          command 使用**已存在的** candidate 证据完成（R8-E，不得补写 candidate 证据）。
case 4  T5 事务已提交（publication active）：
        → 无需动作（active + published_usable + mapped_active 已持久；重启幂等；重复 activation
          command 因 fencing 不命中 ABORT）。
case 5  candidate reload 失败，adapter 保持 LKG（active SHA != candidate SHA）：
        → stable legacy 不丢（stable view 未变）；projection 保持 file_ready_unpublished；
          publication 保留 candidate 证据按指数退避重试 T3，或 fenced failed/cancelled 后：
          legacy_cutover subject → legacy entry rollback 回 mapped_verified（清 pending link +
          candidate 标记，R8-A `trg_lve_rollback` 验证 publication failed/cancelled），
          再以**新的 publication row** 重试 T1（legacy 重新 mapping_pending 引用新 publication.id）。
case 6  publication owner lease 过期：
        → 新 owner fenced CAS 接管：
          UPDATE voice_registry_publications
          SET owner_token=:new_token, lease_expires_at=:now_plus_lease,
              attempt=attempt+1, updated_at=:now
          WHERE id=:publication_id AND status IN ('building','candidate_persisted','file_durable','activation_pending')
            AND lease_expires_at < :now;
          -- changes=1 才接管；接管后按 case 1-5 重估继续；
          -- 旧 owner 的 renewal（changes=0）/ T2-T4 外部副作用 / T5 activation command
          -- （fencing 不命中整条 ABORT）全部失效（R8，见 §7.3）
```

**crash reconciliation 期间的 lease 纪律**：publisher/Worker 在 case 1-5 的每个外部副作用步骤
（重建 candidate registry / 触发 reload / poll health）前都必须执行 T1.5 fenced verify/renew（changes=1），
否则立即停止；恢复流程不得假设旧 owner 的 lease 仍有效。

**fail-closed 规则**：active SHA 既不等于 persisted candidate SHA 也不等于 stable SHA（未知 SHA），
或 publication journal 自相矛盾（generation/manifest/SHA/selector 不一致）→
**不 retire legacy、不标 published_usable、不修改任何状态**，仅上报 `REGISTRY_STATE_UNKNOWN` 等待人工裁决。

---

## 8. Artifact fan-in provenance 闭包 + 原子成功终局顺序（R5 冻结）

### 8.1 闭包保证（§2.4 三层强制重述）

```text
artifact.job_id 属于 artifact.claim_id            → composite FK (job_id, claim_id) → tts_jobs(id, claim_id)
successful_attempt_id 属于 artifact.job_id        → composite FK (successful_attempt_id, job_id) → tts_generation_attempts(id, job_id)
attempt 是该 job 的 exact successful attempt      → trigger：execution_phase IS 'succeeded'
project/unit/fingerprint/variant 与 claim/job 一致 → trigger 逐项 IS 比较
narration plan 与 job 冻结 identity 一致           → trigger：= tts_jobs.narration_plan_artifact_id
assignment/performance/narration artifact 真实有效 → FK + trigger（kind + project_id）
voice profile/revision exact pair                  → trigger（不触碰 TTS-A FROZEN 表）
content hash 一致性                                → 应用层 fenced 重读（同事务；SQL 不可表达，§2.4 边界）
```

### 8.2 原子成功终局（单 BEGIN IMMEDIATE，顺序冻结；R6-C 逐项 fenced reread）

```text
BEGIN IMMEDIATE
1. fenced 重读 claim（status='running' + owner_token/lease）/ job（status='running' + claimed_by）/
   attempt（execution_phase='file_durable'）/ 全部 subscriber（active 数与 identity 一致性）
   —— cancel 优先：active subscriber=0 → 整事务放弃终局（不 INSERT artifact，job/claim 走 cancel 路径）
2. attempt：file_durable → succeeded（fenced UPDATE ... WHERE id=? AND execution_phase='file_durable'；changes=1 必须；
   同 UPDATE 不得再写任何证据字段——usage_record_id 必须在 file_durable 之前写入，§2.3 phase window）
3. **exact fenced reread + 逐项比较（R6-C，同事务内、INSERT artifact 前，全部 fail-closed）**：
   a. exact artifact reader（validateSentenceAudioArtifactExact 同款）fenced reread 目标文件：
      resolve/realpath/regular-file/非 symlink/root containment → file SHA-256 == attempt.audio_sha256
      → output_size == attempt.output_size → ffprobe codec/sample_rate/channels/duration
      == attempt.codec/sample_rate/channels/ffprobe_duration_ms → 任一不符 → 整事务回滚（attempt 恢复 file_durable）；
   b. attempt 行 fenced reread：execution_phase='succeeded'（步骤 2 已置）且
      final_relative_path / audio_sha256 / output_size / codec / sample_rate / channels / ffprobe_duration_ms
      == a 的实测值（逐项）；
   c. 三个 source artifact 行 exact reread（narration_plan_v2 / project_voice_assignment /
      narration_performance_plan）：按 exact artifact ID 重读 content_json → canonical JSON sha256
      == artifact 待写入的 narration_plan_content_hash / assignment_content_hash / performance_plan_content_hash
      （逐项；kind + project_id 由 §2.4 trigger 强制）；
   d. exact Voice Revision fenced reread（validateVoiceProfileRevisionExact）：行字段
      canonical_audio_sha256 / adapter_compatibility_key / provider 与 artifact 待写入的
      canonical_audio_sha256 / 派生 adapter key / provider 一致 + canonical 文件 SHA 一致（逐项）；
   e. fingerprint 语义重算：由冻结输入（project/unit/source artifacts+hash/voice revision/capability/payload）
      重算 exact_source_fingerprint / synthesis_payload_fingerprint / final_tts_input_fingerprint /
      generation_variant_id，与 claim/job 列逐项 `IS` 一致（DB trigger 只比较相等性，此处重算规范构成）；
   —— 任一步不符 → REQUEST_STATE_INCONSISTENT / SOURCE_STALE 类错误 → 整事务回滚（attempt 恢复 file_durable）
4. INSERT immutable sentence_audio_artifact（§2.4 provenance trigger 全检；字节证据与 attempt 逐项一致）
5. **一条 `state_transition` execution command（§2.2c；running→succeeded，双侧 result_artifact_id=
   同一 artifact，transition_request_id=新 UUID）**——AFTER INSERT trigger 在同一 statement 内完成
   owner fencing（claim.owner_token=job.claimed_by=command.worker_owner_token + claim lease >=
   DB_NOW_MS + 双侧 attempt exact）+ claim → succeeded（清 owner/lease）+ job → succeeded
   （清 claimed_by/claimed_at/heartbeat_at，finished_at）+ result artifact identity 双绑定复核；
   **command 是本事务内的一条 statement，不是另一个独立事务**（R10 ⑥：原子成功终局不为 command 表
   拆分 attempt/artifact/job/claim/requests 的成功事务）
6. 全部未取消 request → succeeded + result_artifact_id
   （UPDATE tts_audio_requests SET status='succeeded', result_artifact_id=?
     WHERE claim_id=? AND status IN ('waiting','running')；result-link trigger 校验 identity）
COMMIT
```

失败终局（`running→failed/cancelled`）与 `running→indeterminate` 同样只经一条 state_transition
command 完成双侧同步（不带 result_artifact_id；failed/cancelled 清双侧 owner/lease，indeterminate
保留）；indeterminate 的显式 resolve（`indeterminate→succeeded/failed/cancelled`）同样是一条
state_transition command（owner fencing 依赖 indeterminate 保留的 owner/lease；lease 已过期时先经
§3.6 execution_takeover command 换新 owner）。

任何一步失败（含 trigger ABORT / FK / CHECK / changes=0）→ **整事务回滚，attempt 恢复到 file_durable**；
文件按 exact identity 留作 recoverable orphan（下轮可从 file_durable 本地恢复，不重调 provider）。
**不变量**：不存在指向非 succeeded attempt 的 artifact；不存在跨 execution chain 的 attempt/job/claim 组合；
不存在部分成功（artifact 落库但 request 未 fan-out 等）。

---

## 9. 完整状态机冻结（每表 old → new 全矩阵；trigger SQL 见 §2；R7 更新）

### 9.1 `tts_audio_requests`

```text
initializing  → waiting | cancelled | failed        # R7-G：initializing→waiting 同一事务完成 exact link
waiting       → running | succeeded | failed | cancelled | indeterminate
running       → succeeded | failed | cancelled | indeterminate
indeterminate → succeeded | failed | cancelled      # 显式 resolve
succeeded / failed / cancelled → （终态，无出边）
```

`initializing` 只占用 (project_id, request_id)；claim/job/result 链接必须 NULL；不计 active subscriber（只统计
waiting/running）；Scheduler 不可见；推荐不允许长期 committed initializing（清理走 cancelled/failed）。
**R8-H**：`initializing → waiting` 必须 `claim_id` 非 NULL（trigger + CHECK 双强制；job_id 可 NULL）。

### 9.2 `tts_synthesis_claims`

```text
validating_reuse   → succeeded | generation_pending | cancelled | failed
generation_pending → running | cancelled | failed      # preflight 失败 → failed；不允许 indeterminate（无执行在飞）
running            → succeeded | failed | cancelled | indeterminate
indeterminate      → succeeded | failed | cancelled    # 显式 resolve
succeeded / failed / cancelled → （终态，无出边）
```

queued/preflight failure 传播：job `queued → failed/cancelled` 时同事务 claim `generation_pending → failed/cancelled`。
**R7-D**：`running` 必须已有 job（`trg_tsc_running_job`，`SELECT * FROM tts_jobs WHERE claim_id=?` 恒最多一个）。
**R8-F**：`validating_reuse → generation_pending` 只能经 `tts_claim_generation_dispatches` atomic dispatch command
（同一 statement 建恰好一个 queued job + 转 claim；无 command 行直接转换一律 ABORT；同 claim 第二次 dispatch
UNIQUE ABORT）。
**R11 ⑥**：`generation_pending → running` 必须经 **worker_claim** command（首次 ownership
establishment：双侧同步 running + `claim.owner_token/lease` 与 `job.claimed_by/claimed_at/
heartbeat_at/attempt/started_at` 一次写入）；`generation_pending → failed/cancelled` 必须经
**prestart_terminal** command（Worker claim 前终结：双侧无 owner、attempt=claim.validation_attempt、
failed 必带 error_code、cancelled 必带 reason/error_code）；`running / indeterminate →
succeeded / failed / cancelled / indeterminate` 必须经 **state_transition** command（owner fencing：
双侧 token/attempt exact + claim lease >= DB_NOW_MS；`→indeterminate` 保留双侧 owner/lease，
终态清空；无精确匹配（from,to）command 行的直接 UPDATE 一律 ABORT）。
**R11 ⑥**：`indeterminate` **不是终态**——保留 Worker owner/lease（CHECK 强制非 NULL），可
`lease_renewal` 续租、lease 过期可 `execution_takeover`（attempt+1 换 owner）、exact owner 可
state_transition resolve；只有 `succeeded / failed / cancelled` 三个终态清 owner/lease。
**R11 ⑥ 直接修改 fence**：执行期（generation_pending/running/indeterminate）claim 的
`owner_token / lease_expires_at_epoch_ms / validation_attempt` 任何直接 UPDATE（无精确匹配
command 行）一律 ABORT（`trg_tsc_owner_command` / `trg_tsc_lease_command` /
`trg_tsc_attempt_command`；实证 JS-18/20）。

### 9.3 `tts_jobs`（仅 TTS-C 行，`claim_id IS NOT NULL`；legacy 行不受限）

```text
queued        → running | failed | cancelled
running       → succeeded | failed | cancelled | indeterminate
indeterminate → succeeded | failed | cancelled
succeeded / failed / cancelled → （终态，无出边）
```

TTS-C **无 running → queued requeue**（stale running → indeterminate → 显式 resolve；与 legacy `recoverStaleTtsJobs` 隔离）。
**R8-G**：TTS-C job INSERT 初始状态只能 `queued`；**result row-state invariant 对 INSERT 与所有 UPDATE 生效**——
`succeeded ⇔ result_artifact_id IS NOT NULL`、非 succeeded ⇒ result IS NULL（running/queued/failed 单独写 result
一律 ABORT）；`result_artifact_id` 首次非 NULL 后不可改；TTS-C 行 DELETE 禁。
**R8-I**：`narration_plan_artifact_id / narration_plan_version / payload_json / provider / voice_profile_id` 创建后不可改。
**R11 ⑥**：`queued → running` 必须经 worker_claim command；`queued → failed/cancelled` 必须经
prestart_terminal command；`running / indeterminate → succeeded / failed / cancelled / indeterminate`
必须经 state_transition command（`trg_tjs_command_required` 对全部 TTS-C 状态迁移强制精确匹配
（from,to）的 command 行，直接 UPDATE ABORT）。
**R11 ⑥ 直接修改 fence**：TTS-C job 的 `claimed_by / claimed_at / heartbeat_at / attempt /
started_at / finished_at / error_code / error_message` 任何直接 UPDATE（无精确匹配 command 行）
一律 ABORT（`trg_tjs_claimedby_command` 等 8 个 per-column fence；实证 JS-19/21）；终态
（succeeded/failed/cancelled）后重新写 claimed_by/heartbeat 等被 fence + `trg_tjs_terminal_shape`
双拒绝。
**R12 ⑥ execution head**：`last_execution_command_id` + `execution_command_seq` 双侧恒等，
每应用一条 command 同时 +1；head 直接修改必须精确推进到唯一 command e（`trg_tjs_head_command`）；
任何历史 command 值不能授权直接 UPDATE（HR-01…20 实证）。
**R9 ⑦**：`voice_profile_revision`（legacy 兼容通道）创建后不可改；
`voice_profile_revision_id ↔ voice_profile_revision` 经 `trg_tts_jobs_revision_compat` 双 trigger 双向冻结。

### 9.4 `tts_generation_attempts`

```text
created             → provider_in_flight | transport_failed
provider_in_flight  → response_persisted | transport_failed | indeterminate
response_persisted  → file_validated | validation_failed | indeterminate
file_validated      → file_durable | validation_failed | indeterminate
file_durable        → succeeded | indeterminate
succeeded / transport_failed / validation_failed / indeterminate → （attempt 终态，无出边；重试=新 attempt 行）
```

**R7-H/I**：INSERT 初始状态只能 `created`；`provider == job.provider`。

### 9.5 `voice_materialization_requests`

```text
initializing  → waiting | cancelled | failed        # R7-G（与 §9.1 对称）
waiting       → running | succeeded | reused | failed | cancelled | indeterminate
running       → succeeded | failed | cancelled | indeterminate
indeterminate → succeeded | failed | cancelled
succeeded / reused / failed / cancelled → （终态，无出边）
```

`reused` 仅来自 waiting（existing projection）；`succeeded` 仅表示新复制成功（含共享 job fan-out waiting→succeeded）；禁止混写。
**R8-H**：`initializing → waiting` 必须 `job_id` 非 NULL 且 job profile/revision identity 通过（trigger + CHECK 双强制）。

### 9.6 `voice_materialization_jobs`

```text
validating_existing → queued | succeeded | cancelled | indeterminate
queued              → running | failed | cancelled
running             → succeeded | failed | cancelled | indeterminate
indeterminate       → succeeded | failed | cancelled
succeeded / failed / cancelled → （终态，无出边）
```

**R7-H**：INSERT 初始状态只能 `validating_existing`。

### 9.7 `voice_materializations`（R7-B：删 registry_pending）

```text
file_ready_unpublished → published_usable | failed | indeterminate
failed                 → file_ready_unpublished   # repair（新 materialization job 成功后 fenced 修复）
indeterminate          → file_ready_unpublished | failed
published_usable       → （不可逆，无出边；文件损坏经 repair job 恢复 exact SHA，不转移状态；
                           已发布 projection 不被重新发布，新 generation 从已发布状态确定性复制）
```

registry 激活意图/证据全部移入 `voice_registry_publications`（§9.10）；`published_usable` 必须由
`published_by_publication_id` 指向 active publication 激活。

### 9.8 `legacy_adapter_voice_entries.mapping_status`

```text
unmapped        → mapped_verified | retired
mapped_verified → mapping_pending | retired
mapping_pending → mapped_active | mapped_verified   # 后者=referenced publication failed/cancelled 后
                                                    # 清 pending link + candidate 标记回退（R8-A），允许安全重试
mapped_active   → retired
retired         → （终态，无出边）
```

**R7-C + R8-A/B/D + R10 ④⑤**：`mapping_pending` 必须 `pending_publication_id` 指向 active
`legacy_cutover_publish` 或 `legacy_cutover_existing` publication（§2.8）；cutover 所有权
（owner/lease/attempt）在 publication 表（§9.10），本行不再有 owner 列；candidate generation/SHA
单一权威 = publication 行（本行不复制）；`pending_publication_id` 仅 T1 fill / rollback clear
（id→id 替换 ABORT）；`mapped_active` 只能经 atomic activation command 进入，并保留 `pending_publication_id`
指向激活它的 active publication；`unmapped → mapped_verified` 前置按 `mapping_mode` 分流（写后不可改）：
- `publish_and_cutover`：mapped materialization = `file_ready_unpublished`，且无 active-flight
  `materialization_publish` publication 在飞（否则 ABORT，待完成后改用 `cutover_existing`）；
- `cutover_existing`：mapped materialization = `published_usable` 且 `published_by_publication_id`
  非 NULL（activation 不重写 projection 任何 evidence）。
**R10 ④⑤ 活跃一对一卡片性**：`uq_lve_active_mapped_materialization`（partial：
`mapped_voice_materialization_id IS NOT NULL AND mapping_status <> 'retired'`）——同一 projection
至多一个**活跃** legacy entry 引用（禁止多个 legacy key alias 到同一 projection）；**retired entry
永久保留历史 mapped ID 但不占活跃唯一位**，新 entry 可按 projection 当前状态以匹配 mapping_mode
重新映射（LC-11/LC-12）。该 UNIQUE 的真实含义：一个 materialization 至多被一个活跃 legacy entry
引用（entry→materialization 的多对一被禁止，形成一对一）。

### 9.9 所有权语义汇总（CHECK 强制；R5 冻结）

| 状态 | validation owner | Worker owner/lease/heartbeat | 备注 |
|---|---|---|---|
| validating_reuse / validating_existing | **有效**（token+lease+attempt≥1） | 必须 NULL | Scheduler 不可见 |
| generation_pending / queued | 必须清空 | 必须 NULL | 可被 Scheduler worker_claim |
| running | 必须清空 | **有效** | 单 Worker |
| succeeded / failed / cancelled | 必须清空 | 必须清空 | 终态 |
| indeterminate | 必须清空 | **保留**（R11 ⑥：供 renewal / takeover / resolve fence） | 待显式 resolve（非终态） |

### 9.10 `voice_registry_publications`（R7-A 新增；R8-D/E 强化）

```text
building            → candidate_persisted | failed | cancelled | indeterminate
candidate_persisted → file_durable | failed | cancelled | indeterminate
file_durable        → activation_pending | failed | cancelled | indeterminate
activation_pending  → active | failed | cancelled | indeterminate
indeterminate       → active | failed | cancelled     # 显式 resolve；resolve 前占住 global active single-flight
failed / cancelled → （终态 immutable evidence；重试 = 新 row）
active             → （终态，无出边；activation evidence 全冻结）
```

global active single-flight 覆盖 building/candidate_persisted/file_durable/activation_pending/indeterminate
（`uq_voice_registry_publication_active`）——任意时刻全系统最多一个 active publication。
**R8-D**：`active` 入边必须存在匹配 `voice_registry_publication_activations` command 行（直接 UPDATE 一律 ABORT）。
**R8-E**：进入 indeterminate 必须写 `indeterminate_from_status`；indeterminate 期间 candidate/manifest/file/activation
证据冻结；`indeterminate → active` 仅允许 from=`activation_pending` 且经 resolve command（owner_token=NULL）。
**R8-I + R9 ⑧**：`generation` UNIQUE，**DB 仅保证唯一性**；单调性由应用层 `BEGIN IMMEDIATE` 序列化协议
保证（`SELECT COALESCE(MAX(generation),0)+1`）；schema 注释明确不维护 sequence，不混称。
**R9 ①**：lease 列 `lease_expires_at_epoch_ms INTEGER`；fencing 比较统一使用 trigger 内 SELECT 计算
`DB_NOW_MS = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`；不再使用 caller-supplied 时间
作为权限判定基准；evidence 时间（`file_durable_at` / `activation_requested_at` / `activated_at` /
`failed_at` / `updated_at`）保持 ISO 8601 文本但由 `trg_vrp_evidence_time_*` 冻结不得明显晚于
`DB_NOW_ISO = strftime('%Y-%m-%dT%H:%M:%fZ','now')`。
**R9 ②**：进入 indeterminate 的同一次 UPDATE 不得增删 evidence（`trg_vrp_indeterminate_seal`）；
OLD evidence shape 必须与来源状态匹配（`trg_vrp_indeterminate_shape`）。
**R10 ④⑤ subject_type + subject_mode + mapping_mode 三方联合判定**：
- `materialization_publish` + `publish_and_cutover`：projection 独立发布，**未被** legacy 引用；
- `legacy_cutover_publish` + `publish_and_cutover`：entry `mapped_verified` 且
  `mapping_mode='publish_and_cutover'`，projection 在前为 `file_ready_unpublished`，activation
  同时发布 projection；
- `legacy_cutover_existing` + `cutover_existing`：entry `mapped_verified` 且
  `mapping_mode='cutover_existing'`，projection 已是 `published_usable`，activation
  仅切 legacy → mapped_active（projection 零更新）；
- `registry_rebuild` + `none`：subject_id=`global`。

---

## 10. 未来测试矩阵冻结（R5；名称/前置/并发步骤/断言，runtime 实现时逐项落地）

### 10.1 Validation fencing（`scripts/test-tts-c-validation-fencing.ts`）

| 测试 | 前置 | 并发步骤 | 断言 |
|---|---|---|---|
| VF-1 A lease expires → B takeover → A finalize rejected | claim=validating_reuse(A, attempt=1)，candidate usable | B takeover CAS；A fenced finalize | takeover changes=1；A finalize changes=0 → STALE_VALIDATION_OWNER；claim/job/request/文件零变化 |
| VF-2 A renew after B takeover → changes=0 | 同 VF-1 接管后 | A renewal（旧 token/attempt） | renewal changes=0；lease 不被旧 owner 延长 |
| VF-3 B finalize usable → exactly one reuse result | B 持有（attempt=2） | B fenced finalize | changes=1；claim=succeeded；零新 job；全部未取消 envelope succeeded 且指向同一 artifact |
| VF-4 B finalize unusable → exactly one queued job | B 持有，candidate damaged | B atomic dispatch command INSERT（§2.2b） | 恰好一个 queued job；claim=generation_pending（同一 statement 原子）；partial unique 不冲突 |
| VF-5 A/B/last-cancel 三方竞争 | A validating、B takeover、最后 subscriber cancel 并发 | 三事务交错全序排列 | §3.4 不变量：零 subscriber→cancelled 无 job；有 subscriber+usable→reused；有 subscriber+unusable→恰好一个 queued job；stale 零副作用；无 orphan job |

### 10.2 Materialization fencing（`scripts/test-tts-c-materialization-fencing.ts`）

| 测试 | 前置 | 并发步骤 | 断言 |
|---|---|---|---|
| MF-1 A validating_existing expires → B takeover | job=validating_existing(A) | B takeover CAS | changes=1；attempt+1；token 换主 |
| MF-2 A transitions queued → rejected | B 已接管 | A fenced → queued | changes=0 → STALE_VALIDATION_OWNER；job 仍 validating_existing；零文件写 |
| MF-3 B usable → reused, zero file writes | B 持有，projection 文件/SHA 一致 | B fenced finalize | job=succeeded；全部未取消 request=reused+materialization_id；文件写计数=0 |
| MF-4 B unusable → exactly one queued job | B 持有，projection 缺失/损坏 | B fenced → queued | 恰好一个 queued；partial unique 生效 |
| MF-5 two Worker claims → only one running owner | job=queued | 两 Worker 并发 claim | 恰好一个 changes=1（running owner）；另一个 changes=0 不执行 |
| MF-6 零 subscriber during validating | 全部 envelope cancelled | B fenced finalize | job=cancelled；释放 active unique；无文件写 |

### 10.3 Provenance constraints（`scripts/test-tts-c-provenance-constraints.ts`）

| 测试 | mutation | 断言 |
|---|---|---|
| PC-1 | artifact attempt 属于另一 job | composite FK ABORT（非零退出） |
| PC-2 | artifact job 属于另一 claim | composite FK/provenance trigger ABORT |
| PC-3 | attempt phase != succeeded | trigger `attempt not in succeeded phase` ABORT |
| PC-4 | profile/revision pair mismatch | trigger `voice revision pair mismatch` ABORT |
| PC-5 | Assignment project mismatch | trigger `assignment artifact invalid` ABORT |
| PC-6 | 非法 status/NULL 组合（如 running 无 owner） | CHECK ABORT |
| PC-7 | fingerprint/variant 与 claim 不一致 | trigger `fingerprint/variant mismatch` ABORT |

### 10.4 Cutover crash matrix（`scripts/test-tts-c-cutover-crash.ts`；R7 publication journal 版）

| 测试 | crash 点 | 断言 |
|---|---|---|
| CC-1 | publication building/candidate_persisted 后、registry 写入前 | 恢复重发布同 SHA candidate 或 fenced cancelled 后新 row 重试；legacy voice 不丢；key 恰好一个 source |
| CC-2 | candidate registry fsync 后、adapter reload 前 | 磁盘 SHA==persisted candidate → 续 reload；不重建；legacy 不丢 |
| CC-3 | adapter activation 后、T5 DB commit 前 | active SHA==candidate → 按 publication journal INSERT 同一条 activation command 完成整个 subject 的原子 reconciliation（command trigger 同一 statement：publication active + projection published_usable + legacy mapped_active；重启幂等，重复 command fencing ABORT） |
| CC-4 | T5 事务进行中（注入回滚/崩溃） | 整事务回滚：不得半 mapped_active；legacy 不丢；projection 不错误标 published_usable |
| CC-5 | reload 失败，adapter LKG | active SHA!=candidate → stable legacy 保持 emitted；projection 保持 file_ready_unpublished；publication 证据保留可重试 |
| CC-6 | publication owner lease 过期 | fenced CAS 接管（changes=1）；旧 owner renewal/finalize changes=0；状态可 reconciliation |

每个 CC 测试必须断言：legacy voice 不丢失；canonical key 恰好一个 source；active SHA 与 DB state 可 reconciliation；
不得错误标 published_usable；reconciliation 以 publication journal（subject）为唯一裁决源，不凭任意 per-key row 猜测。

### 10.5 SQLite contract validation（R12 已执行的 docs-only 验证；runner 与原始输出入库；runtime 阶段纳入 gate）

**方法（R12 证据口径，继承 R10/R11 并强化）**：可复跑 runner 入库 `docs/evidence/tts-c-r12/`——
`extract_contract.py` 只从本文档 §2 逐字提取全部可执行 SQL（不维护手写 schema 副本；
既有基座表按 §0 基座前提以最小 fixture 提供）→ 双引擎（sqlite3 CLI 3.45.1 + 当前 Python sqlite3）
各自重建临时 DB → schema apply → `PRAGMA foreign_key_check`（空）→ `PRAGMA integrity_check`（ok）
→ 对象计数（13 contract 表 = 12 CREATE + `tts_jobs` 迁移；**110 triggers**；**7 unique indexes +
2 表级 UNIQUE(job_id,command_seq)/(claim_id,command_seq)**；**10 ALTER ADD COLUMN**）→
逐测试执行并输出机器可读计数；任一 FAIL → 非零 exit。真实事务能力（`Harness.tx()`，双引擎
BEGIN IMMEDIATE）保持 R11。原始输出：`results-sqlite-3.45.1.txt` 与
`results-python-sqlite.txt`（含 git HEAD、design doc sha256、extracted §2 sql sha256、
逐 test PASS/FAIL、总数）——结果文件来自 final commit 前最后一次成功运行；EA-05 对 final 文档
再提取验证 hash 一致。**checked-in snapshot 记录的是其生成时的 base HEAD；final HEAD 的权威绑定
由 GitHub CI artifact（final checkout 重新生成）提供，两者明确区分、不伪造。**

**计数（两引擎一致；逐项见 runner 原始输出）**：

| 类别 | 枚举数 | 实际执行 | PASS | FAIL | NOT EXECUTED |
|---|---|---|---|---|---|
| R12 本轮实际执行总数 | 130 | 130 | 130 | 0 | 0 |
| 其中：R12 新增矩阵（HR-01…20 historical replay seal 20 项） | 20 | 20 | 20 | 0 | 0 |
| 其中：R11 全矩阵重跑（JS-01…35、LC、TF、IE、VI、PA/CJ/JR/EN/SM/ET/GN/LR/PE/RP） | 110 | 110 | 110 | 0 | 0 |
| 历史 R5/R6/R7/R8 其余矩阵 | 见下 | 0 | 0 | 0 | 全部 NOT EXECUTED |
| 未来 runtime 计划（§10.1–10.4/§10.6/§10.7） | 见各节 | 0 | 0 | 0 | 全部 NOT EXECUTED |

- **PASS+FAIL+SKIP=总数** 恒成立（runner 内 EA-03 校验）；未执行项一律不计入 PASS。
- **历史回归 NOT EXECUTED 清单**（本轮未重跑，不得引用为已通过）：R6 的 IS/SM/DEL/PC/CHK/PAIR/
  UNIQ/INIT 全族；R7 的 RP-02…RP-10b、CJ-01…08、SL-01…08b、VI-01…04b；R8 的 PA-02/03/05/08、
  PE-01/02/04、LR-02/03/04/05/05b、EN-05b、JR-04。这些在 runtime 阶段纳入 gate 时逐项落地。
- **R11/R10/R9 口径**：R11 的 130 项矩阵中除 JS-17 外全部逐 test 保留并重跑；R11 的 110 项结果
  被覆盖；R10 的 91 项、R9 的 360/23-29 不再引用。R11 独立 Review = FAIL（P0-C historical
  command replay），本轮关闭。
- **R12 关闭的 P0-C 实证**：历史 command 值重放（HR-01…05：真实历史 token/lease/heartbeat/attempt
  重放全 ABORT；HR-06/07：terminal owner/证据复活全拒；HR-08：error evidence 回旧值全拒）、
  head 回退/跳号/单侧推进/复用（HR-09…13）、chain 断裂与 seq 冲突（HR-14/15）、有效 renewal/
  takeover/state_transition 链推进（HR-16/17/18）、第二侧失败整事务回滚（HR-19）、
  历史多行全量重放（HR-20，含当前 head 行重放=零变化 no-op 的精确语义）。
- 同表多 trigger 按创建逆序触发（实证 3.45.1）：terminal shape trigger 可先于 per-column fence 报
  `terminal owner shape violated`；UNIQUE(job_id,command_seq) 与 UNIQUE(claim_id,command_seq)
  冲突时 SQLite 报告其一——均为合法拒绝，runner 用消息集合断言。

### 10.5.1 R12 关闭 R11 FAIL 时顺带发现并已修复的 contract 缺陷

- **D1/D2/D3（R10/R11 已修复，保留）**：immutable 终态收窄 / resolve 清 error / prestart 写
  finished_at。
- **D4（R12 设计注记）**：当前 head command 的"完整重放"（目标值与现值完全相同）在 SQL 层不可与
  command 自身应用区分，但它是**零变化 no-op**（不构成 split-brain 或证据篡改）；任何改值变体
  （借当前 head 行 id 写不同 owner/head/evidence）被 chain fence 拒绝（HR-20 实证）。此语义在
  §2.2c 文档中明确冻结。

### 10.5.1 R11 关闭 R10 FAIL 时顺带发现并已修复的 contract 缺陷

- **D1（R10 已修复，保留）**：`trg_tts_jobs_immutable` 误将 indeterminate 当终态冻结——R10 收窄为
  真终态（succeeded/failed/cancelled）；R11 全文统一"只有三终态清 owner/lease"。
- **D2（R11 新增修复）**：state_transition `→succeeded`（indeterminate resolve）时 job 侧 error 证据
  应清空（否则 succeeded 残留旧 error_code）；R11 在 job UPDATE 中 succeeded 分支清 error 字段，
  并同步 fence（error_code/error_message 允许 succeeded 清理分支）。
- **D3（R11 冻结）**：prestart_terminal 终结也必须写 `finished_at`（fence 允许 prestart 分支），
  否则 queued→failed 的 job 无完成时间证据。

### 10.5.1 R10 修复 R9 时顺带发现并已修复的 contract 缺陷

- **D1（已修复）**：`trg_tts_jobs_immutable` 把 `indeterminate` 当终态冻结 status 出边，与
  `trg_tts_jobs_transition` 允许的 `indeterminate→succeeded/failed/cancelled` 直接矛盾——
  R9 下 job 一旦 indeterminate 即锁死（JS-10 实证发现）；R10 将终态冻结收窄为
  `('succeeded','failed','cancelled')`，resolve 仍由 command_required 强制唯一入口。

### 10.6 R7 新增验证矩阵（runtime 阶段纳入 gate）

| 测试 | mutation / 步骤 | 断言 |
|---|---|---|
| RP-01 | publication A failed 后同 subject 新 attempt B | A evidence 保留（failed/error/candidate SHA 不可改）；B 可创建并激活成功；projection 重新 published_usable（published_by=B） |
| RP-02 | failed attempt 改 error_code/candidate | immutable ABORT（evidence 保留） |
| RP-03 | 两个并发 T1（同/异 subject） | 恰好一个 active publication（UNIQUE ABORT）；global single-flight |
| RP-04 | 第一个 publication active 时第二个 key 进 mapping_pending | publication link mismatch ABORT；一个 active publication 最多一个 mapping_pending subject |
| RP-05 | crash after candidate fsync（file_durable） | journal 恢复：fenced → activation_pending → 单条 activation command → active |
| RP-06 | crash after adapter activation before T5 | journal 原子 reconciliation：单条 activation command 同一 statement 完成 publication active + projection published_usable |
| RP-07 | active registry 不得含 DB stable view 未提交的第二个 key | candidate manifest 只含 frozen subject；第二个 key 无法并发发布（RP-03/04 覆盖） |
| RP-08 | 新 global generation（registry_rebuild） | 旧 published projection evidence（generation/SHA/published_by）保留不变 |
| CJ-01 | validating_reuse claim 下 INSERT queued job（无 dispatch 行） | dispatch command required ABORT（R8-F 取代 R7 的 generation-state 检查） |
| CJ-02 | 同一 claim 第二个 job | uq_tts_jobs_claim UNIQUE ABORT |
| CJ-03 | generated claim（generation_pending/running/succeeded） | 恰好一个 job（`WHERE claim_id=?` count=1） |
| CJ-04 | reuse succeeded claim | 无 job（count=0）；claim 无 job_id 列 |
| CJ-05 | succeeded job result NULL | result status invariant violated ABORT（R8-G row-state invariant） |
| CJ-06 | succeeded job 替换 result artifact | result link / immutable ABORT |
| CJ-07 | 删除 TTS-C job | tts-c delete forbidden ABORT |
| CJ-08 | legacy job delete/requeue | 兼容不受影响（claim_id NULL 行） |
| SL-01/02/03 | request→claim 跨 project/unit/fingerprint | claim identity mismatch ABORT（cross 无法落库） |
| SL-04 | request.job_id 属其他 claim | job identity mismatch ABORT |
| SL-05 | 错误 request 尝试 | active subscriber count 不被污染 |
| SL-06 | direct INSERT succeeded request | initial state initializing required ABORT |
| SL-07 | INSERT 带 result_artifact_id（bypass） | CHECK 拦截（initializing 链接必须 NULL） |
| SL-08 | initializing 行 | 不计 active subscriber（count 只统计 waiting/running）；链接必须 NULL；Scheduler 不可见 |
| VI-01/02 | job profile/revision pair、provider 与 revision 不同 | voice revision pair mismatch ABORT |
| VI-02b | dispatch voice_profile_revision_id 缺失 | NOT NULL constraint ABORT（结构不可提交） |
| VI-03 | attempt provider 与 job 不同 | provider mismatch ABORT |
| VI-04 | artifact voice/provider 与 job/attempt/revision 不同 | job voice profile mismatch / job provider mismatch ABORT |

### 10.7 R8 新增验证矩阵（runtime 阶段纳入 gate）

**Legacy retry（R8-A）**

| 测试 | mutation / 步骤 | 断言 |
|---|---|---|
| LR-01 | publication failed → legacy mapping_pending → mapped_verified rollback（清 pending_publication_id + candidate_source_selector） | rollback 成功；entry=mapped_verified；pending/selector 全 NULL |
| LR-02 | referenced publication 非 failed/cancelled（building/active/indeterminate）时 rollback | `rollback publication not failed` ABORT；entry 保持 mapping_pending |
| LR-03 | rollback 后同 entry 新 publication → mapped_verified → mapping_pending（写入新 publication.id）→ 全流程激活 | T1 fill 允许（NULL→新 id）；最终 mapped_active；两次 publication evidence 均在 journal |
| LR-04 | rollback + 重试全程 | 旧 failed publication evidence（status/error/candidate SHA）不变（immutable） |
| LR-05 | mapping_pending 内 pending_publication_id → 其他 publication id（不清 NULL 直接替换） | `immutable field` ABORT（仅允许 T1 fill 与 rollback clear） |

**Publication atomic activation（R8-D/C）**

| 测试 | mutation / 步骤 | 断言 |
|---|---|---|
| PA-01 | publication 单独 UPDATE activation_pending→active（无 command 行） | `invalid transition` ABORT；不存在可独立提交的 active |
| PA-02 | materialization_publish：一条 activation command INSERT | 同一 statement 原子完成 publication=active + projection=published_usable（generation/SHA/published_by 一次写入） |
| PA-03 | legacy_cutover：一条 activation command INSERT | 同一 statement 原子完成 publication=active + mapped projection=published_usable + legacy=mapped_active（candidate_activated_at） |
| PA-04 | activation command 的 subject 已被抢占（projection 非 file_ready_unpublished / legacy 非 mapping_pending） | subject mismatch ABORT；整条 statement 回滚：publication/projection/legacy 全不变 |
| PA-05 | legacy_cutover publication 尝试激活非 mapped 的其他 projection | `trg_vmat_publish` link mismatch ABORT（legacy 只能激活 entry.mapped_voice_materialization_id） |
| PA-06 | publication INSERT 引用不存在的 subject（materialization/legacy id 不存在） | `subject invalid` ABORT（INSERT 即拒） |
| PA-07 | registry_rebuild 的 subject_id != 'global' | `subject invalid` ABORT |
| PA-08 | 两个 publication 相同 generation | `UNIQUE` ABORT（generation UNIQUE） |

**Evidence closure（R8-E/B）**

| 测试 | mutation / 步骤 | 断言 |
|---|---|---|
| PE-01 | legacy 行写入与 publication 不同的 candidate 证据（试图复制 generation/SHA 列） | 列不存在（`no such column`）——单一权威 = publication 行，无跨表同步面 |
| PE-02 | publication indeterminate 期间首次补写 candidate_registry_sha256 / manifest / file_durable_at | `immutable field` ABORT（indeterminate 证据冻结，禁止事后补造） |
| PE-03 | building 阶段（candidate 未持久化）进入 indeterminate → resolve active | `invalid transition` ABORT（from != activation_pending；只能 failed/cancelled） |
| PE-04 | activation_indeterminate 用已存在 candidate 证据 + resolve command（owner_token=NULL）→ active | PASS：publication=active + projection/legacy 同步激活；仅新增 activated_at/resolution_evidence |

**Claim/job exact-one（R8-F）**

| 测试 | mutation / 步骤 | 断言 |
|---|---|---|
| CJ-09 | 只把 claim UPDATE 成 generation_pending 后 COMMIT（无 dispatch 行） | `generation_pending requires dispatch command` ABORT（结构上不可能） |
| CJ-10 | atomic dispatch command INSERT | 同一 statement：claim=generation_pending + 恰好一个 queued job + validation owner/candidate 清空 |
| CJ-11 | dispatch 内 job INSERT 失败（job id 冲突） | 整条 statement 回滚：claim 保持 validating_reuse、无 job、无 dispatch 行 |
| CJ-12 | 同 claim 第二次 dispatch command | `UNIQUE(claim_id)` ABORT |
| CJ-13 | generated claim 走到 succeeded/failed/cancelled/indeterminate | 仍恰好一个 job（`WHERE claim_id=?` count=1；job DELETE 禁） |

**Envelope closure（R8-H）**

| 测试 | mutation / 步骤 | 断言 |
|---|---|---|
| EN-01 | tar initializing→waiting 无 claim_id | `waiting requires claim link` ABORT |
| EN-02 | tar initializing→waiting + exact claim（同事务链接） | PASS；waiting 行 claim_id 非 NULL |
| EN-03 | vmr initializing→waiting 无 job_id | `waiting requires job link` ABORT |
| EN-04 | vmr initializing→waiting + exact job（同事务链接） | PASS；waiting 行 job_id 非 NULL |
| EN-05 | waiting envelope 清掉 claim/job 链接（制造无 authoritative dependency 的 waiting） | CHECK/immutable ABORT——waiting/running/indeterminate 必须持 claim_id（tar）/ job_id（vmr） |

**Job result row-state invariant（R8-G）**

| 测试 | mutation / 步骤 | 断言 |
|---|---|---|
| JR-01 | running job 单独 SET result_artifact_id | `result status invariant violated` ABORT |
| JR-02 | queued job 单独 SET result_artifact_id | `result status invariant violated` ABORT |
| JR-03 | failed job 单独 SET result_artifact_id | `result status invariant violated` ABORT |
| JR-04 | running→succeeded 同一 UPDATE 携带 exact result artifact | PASS（result artifact job/claim identity trigger 同步通过） |
| JR-05 | succeeded 后替换 result_artifact_id | `immutable field` ABORT（result write-once） |

全部 R5/R6/R7 mutation（IS/SM/DEL/PC/CHK/PAIR/UNIQ/INIT/RP/CJ-01…08/SL/VI）必须在新 contract 上回归。

### 10.8 R12 新增验证矩阵（本轮已由 runner 实际执行；runtime 阶段纳入 gate）

**Historical command replay seal（R12 P0-C；`docs/evidence/tts-c-r12/test_hr.py` 实跑，
全部使用真实历史值）**

| 测试 | mutation / 步骤 | 断言（实跑结果 PASS） |
|---|---|---|
| HR-01 | worker_claim w1 → takeover w2 → direct UPDATE claim.owner_token='w1'（真实历史 token） | `owner requires execution command` ABORT；owner 保持 w2 |
| HR-02 | 同场景 direct UPDATE job.claimed_by='w1' | `claimed_by requires execution command` ABORT |
| HR-03 | 同场景 direct UPDATE claim lease=历史 worker_claim lease | `lease requires execution command` ABORT |
| HR-04 | 同场景 direct UPDATE job heartbeat=历史 heartbeat | `heartbeat_at requires execution command` ABORT |
| HR-05 | takeover 后 direct UPDATE job.attempt=历史 attempt | `attempt requires execution command` ABORT；attempt 保持 2 |
| HR-06 | worker_claim w1 → succeeded → direct UPDATE terminal job.claimed_by='w1' | fence + `terminal owner shape violated` 双拒 |
| HR-07 | terminal job 恢复历史 claimed_at/heartbeat/attempt | 逐项 ABORT（attempt 伪造新值同样被拒） |
| HR-08 | running→indeterminate → takeover → indeterminate→failed(E2) → error 回旧值 | `error_code/error_message requires execution command` ABORT；evidence 保持 E2/confirmed |
| HR-09 | head 回历史 command id/seq（先推进 seq2 再回退 seq1） | `execution head requires command` ABORT；head 保持 seq2 |
| HR-10 | head 跳 seq | `execution head requires command` ABORT |
| HR-11 | 历史 command id + 全字段复制（head/seq/owner） | ABORT；状态零变化 |
| HR-12 | claim 单侧推进 head | ABORT；双侧 head 仍一致 |
| HR-13 | job 单侧推进 head | ABORT |
| HR-14 | command.previous_command_id ≠ 当前双侧 head | `chain mismatch` ABORT；command 行零残留 |
| HR-15 | command_seq 跳号 / 同 seq 重复 | `chain mismatch` / `UNIQUE(job_id|claim_id, command_seq)` ABORT |
| HR-16 | 有效 lease_renewal | 双侧 head 同时 seq+1、command id exact |
| HR-17 | 有效 execution_takeover（真实时序过期） | 双侧 head seq+1、owner/attempt exact |
| HR-18 | 有效 state_transition→succeeded | 双侧 head 推进、terminal shape（claimed_* NULL）正确 |
| HR-19 | 第二侧故障（真实 BEGIN IMMEDIATE 事务第二条失败） | command 行 + claim head/status/owner + job head/status/owner 全回滚 |
| HR-20 | 历史 worker_claim+renewal+takeover 三条旧行全量重放 | 非当前行重放全 ABORT；当前 head 行重放=零变化 no-op；改值变体 ABORT |

**执行期 head 不变量（R12）**：`claim.last_execution_command_id = job.last_execution_command_id`、
`claim.execution_command_seq = job.execution_command_seq`（每应用一条 command 双侧同时 +1）；
head 不可回退、不可跳号、不可单侧推进、不可重复消费（§2.2c head fence + chain 校验实证）。

**CI contract gate（R12）**：`.github/workflows/m7-quality-gate.yml` 的 `TTS-C Contract Gate` job
指向 `docs/evidence/tts-c-r12/`；**sqlite3 CLI 版本 fail-closed pin**（`test "$(sqlite3 --version |
awk '{print $1}')" = "3.45.1"`，不匹配即 workflow failure）；Python sqlite3 版本记录并报告
（CLI = authoritative compatibility engine）；在 final HEAD 重新生成双引擎结果，两引擎 test ID 与
TOTAL/PASS/FAIL/SKIP 完全一致（`verify_engines.py`），design/SQL SHA 与 current checkout 一致，
FAIL>0 → workflow failure，artifact + summary。runtime gate 与 contract gate 分别报告。

R5/R6/R7/R8/R9/R10/R11 保留矩阵本轮实跑子集见 §10.5 计数表与 runner 原始输出；未实跑项一律
NOT EXECUTED，runtime 阶段纳入 gate 时逐项落地。

## 11. 并行开发规则（见实施计划；此处为设计依据）

- R12 PASS 后：1A 与 1C 可并行开发（不同本地 worktree/local branch）；1B 的 adapter parser/reloader 测试骨架可并行准备；
  1B publisher integration 等 1A PASS；C.2 等 1A+1B+1C 全部 PASS；C.2 PASS 后 C.3→C.4→C.5 runtime 串行。
  1A/1B/C.2 schema 边界采用 R10 contract（epoch_ms lease + DB_NOW_MS fence + indeterminate entry evidence seal +
  activation_mode + resolution_evidence_hash + mapping_mode/subject_mode 双路径 +
  execution_transitions 双 command 语义（worker_claim / state_transition）+ 全生命周期多 transition +
  voice_revision compat closure）。
- Git：不推阶段 remote branch；单一 integrator 拥有 m7；agent 返回独立 commit SHA；integrator 按序 cherry-pick；
  **每个 exact SHA 单独 typecheck/build/tests/Review/deploy**；禁止一次合并多个未 Review lane。

---

## 12. Fingerprint / capability / manifest-master / stale（R1-R3 结论保留）

- fingerprint 三分离 + generationVariantId = 候选生成身份；materialization transport 不入 fingerprint；
- capability neutral matrix（neutral → supported no-op；非 neutral 无通道 → explicit unsupported）；
- `narration_audio_selection_manifest@2.0` + `narration_master_audio@1.0`（masterInputFingerprint 非循环）；
- downstream stale 图；Security（API 不输出路径、Web 无 voice 挂载、attempt journal 只存安全投影）。

---

## 13. Unresolved decisions（进入 1A 前定）

1. delivery 编译策略（文本改写 vs 显式 unsupported，推荐显式 unsupported）。
2. pace 经 adapter 扩展直传可行性。
3. unit vs sentence 原子单位（推荐 unit）。
4. capability 升级后存量音频失效策略。
5. pronunciation dictionary 是否纳入（建议 C.3 后）。
6. master 拼接实现（Node PCM vs ffmpeg concat，C.4 定）。
7. VALIDATION_LEASE_MS 取值（与 generation lease 15min 对齐或更短；1A/C.2 定）。
8. EXECUTION_LEASE_MS 取值（§3.6 worker claim lease；C.2 定）。

## 14. Recommended first implementation stage

**TTS-C.1A**（materialization requests/jobs/projection + `validating_existing` fenced single-flight，止于
`file_ready_unpublished`）——零音频风险、解锁 materialization；1C（capability compiler）可并行；
随后 1B（legacy single-source crash-safe cutover + global publisher + activation ack）；
C.2（audio claim/job/attempt/artifact + reclaimable fenced validation）依赖 1A/1B/1C 齐备。
