# TTS-C Incremental Narration 架构设计（TTS-C.0.R4 修订，只读审计，未实现）

> 状态：**TTS-C.0.R4 architecture closure completed；pending independent Review PASS；
> TTS-C runtime implementation not started；TTS-C.1A not started**。
> 本文档是只读架构审计产物（R4 修订）：不修改 runtime code / schema / config / migration / compose。
> 运行时真相以真实代码为准（审计基线 m7 @ `43a152d`；TTS-B final code `86f7f52…` 已 FROZEN）。
> 本修订关闭 ChatGPT 独立 Review FAIL 发现：① `validating_reuse` reservation 可回收（owner/lease/CAS stale recovery）；
> ② validating 阶段零 subscriber 取消语义；③ materialization 真正 single-flight（`validating_existing` + partial unique）；
> ④ materialization project-scoped envelope + fan-out/durability；⑤ legacy single-source mapping cutover（5 态）；
> ⑥ sentence audio artifact fan-in provenance 修正；⑦ 完整 request/claim 状态机与 trigger；
> ⑧ **schema 真实 contract**（REFERENCES+ON DELETE/CHECK/partial unique/immutable-field trigger/invalid-transition trigger/DELETE trigger/NULL 语义/authoritative reader/API redaction/legacy compat 全部显式，不以注释代替）。

---

## 0. 本文档是唯一权威 schema contract（R4 起可执行）

最终表 9 张（保持 9 表：`tts_audio_requests`、`tts_synthesis_claims`、`tts_jobs`、`tts_generation_attempts`、`sentence_audio_artifacts`、`voice_materialization_requests`、`voice_materialization_jobs`、`voice_materializations`、`legacy_adapter_voice_entries`）。
以下每个表给出**可执行 DDL 级约束**：REFERENCES + ON DELETE、CHECK、partial unique、immutable-field trigger（ABORT）、invalid-transition trigger（ABORT）、DELETE trigger、NULL/NOT NULL。实施者以此为准，不得跨历史 commit 拼接。

**通用 trigger 约定**：
- 每个表 `UPDATE/DELETE` trigger 在 `CREATE TABLE` 时同迁移内创建；
- immutable-field trigger：更新保护字段 → RAISE(ABORT, '<table>.<field> immutable')；
- invalid-transition trigger：状态回退/非法跳转 → RAISE(ABORT, '<table> invalid transition: <from> → <to>')；
- DELETE trigger：受保护表 → RAISE(ABORT, '<table> delete forbidden')。

---

## 1. 现有真实状态（TTS-C 起点）

### 1.1 Voice Library（TTS-A，FROZEN `1460efd…`）

- `voice_profiles`：`id / schema_version('voice-profile@1.0') / display_name / provider('indextts2') / status(active|archived) / created_at / updated_at`。
- `voice_profile_revisions`（trigger ABORT 不可变）：`id / schema_version / voice_profile_id / revision_number / request_id / provider / adapter_compatibility_key / original_audio_sha256 / canonical_audio_sha256 / original_filename_display / canonical_audio_path / codec / sample_rate / channels / duration_ms / transcript / language / metadata_json / request_fingerprint / created_at`，`UNIQUE(voice_profile_id, revision_number)` + `UNIQUE(voice_profile_id, request_id)`。
- canonical 文件：`voice-library/<pid>/<rid>/reference.wav`；canonical 参数冻结：WAV / pcm_s16le / mono / 48000Hz；`validateVoiceProfileRevisionExact` 单一真相源。

### 1.2 TTS-B（FROZEN `86f7f52…`）

- `voice_assignment_requests` envelope；`project_voice_assignment` artifact（exact 双 ID）；`narration_performance_plan` artifact（三层 source 自洽）；`generation_runs/attempts/dispatch_jobs`。

### 1.3 现有 TTS job 体系（M3-B / M7.1；TTS-C 中降级）

- `tts_jobs`（现有列）含 `output_path/duration_ms/audio_sha256/result_json`（legacy 兼容）；worker `tts-executor.ts`；`recoverStaleTtsJobs`（不得用于 TTS-C 无条件 requeue）。

### 1.4 IndexTTS2 Adapter（`server.py`）

- `/v1/synthesize` 仅 `text + voiceProfile@voiceRevision + useRandom=false + emotion='none'`；registry 启动加载一次；拒绝 `voices=[]`；containment + `_check_voice`；materialization API 不存在。

---

## 2. 最终 schema（9 表，真实 contract）

### 2.1 `tts_audio_requests`（request envelope；many-to-one → claim）

```sql
CREATE TABLE tts_audio_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  exact_source_fingerprint TEXT NOT NULL,
  synthesis_payload_fingerprint TEXT NOT NULL,
  final_tts_input_fingerprint TEXT NOT NULL,
  generation_variant_id TEXT NOT NULL DEFAULT 'default',
  claim_id TEXT REFERENCES tts_synthesis_claims(id) ON DELETE SET NULL,
  job_id TEXT REFERENCES tts_jobs(id) ON DELETE SET NULL,
  result_artifact_id TEXT REFERENCES sentence_audio_artifacts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN
    ('waiting','running','succeeded','failed','cancelled','indeterminate')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, request_id)
);
```

- **CHECK**：`status` 枚举如上。
- **状态机（完整，含 reuse 路径）**：`waiting → succeeded`（artifact reuse，无 running）；`waiting → running → succeeded`；`waiting/running → cancelled`；`waiting/running → failed`；`waiting/running → indeterminate`。
- **invalid-transition trigger**：禁止 `succeeded/failed/cancelled → *`（终态不可逆）；禁止 `running → waiting` 等回退；禁止 `succeeded → running`。
- **DELETE trigger**：禁止 DELETE（append-only 请求历史）。
- **immutable**：`id/project_id/request_id/*_fingerprint/generation_variant_id/claim_id`（claim 链接后禁改）。
- **authoritative reader**：`getTtsAudioRequestExact(projectId, requestId)`（exact request identity 返回，无 latest fallback）。
- **API redaction**：序列化出口不含任何 path。
- **legacy compat**：新表，无历史兼容问题。

### 2.2 `tts_synthesis_claims`（唯一 synthesis reservation；可回收）

```sql
CREATE TABLE tts_synthesis_claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  unit_id TEXT NOT NULL CHECK (unit_id GLOB 'N[0-9][0-9][0-9]'),
  final_tts_input_fingerprint TEXT NOT NULL,
  generation_variant_id TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL CHECK (status IN
    ('validating_reuse','generation_pending','running','succeeded','failed','cancelled','indeterminate')),
  job_id TEXT REFERENCES tts_jobs(id) ON DELETE SET NULL,
  result_artifact_id TEXT REFERENCES sentence_audio_artifacts(id) ON DELETE RESTRICT,
  -- 所有权（各阶段语义显式，禁止模糊复用）：
  owner_token TEXT,              -- generation_pending/running：job 执行 owner（复用 tts_jobs claim 语义）
  lease_expires_at TEXT,         -- 同上
  validation_owner_token TEXT,   -- validating_reuse：当前 validator 持有者（独立于 owner_token）
  validation_lease_expires_at TEXT,
  validation_attempt INTEGER NOT NULL DEFAULT 0,
  candidate_artifact_id TEXT,    -- validating_reuse：被校验候选 artifact
  candidate_artifact_metadata_hash TEXT,  -- 候选元数据 hash（DB 行 + 路径等，不含文件内容）
  validation_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX uq_tts_synthesis_claim_active
ON tts_synthesis_claims (project_id, unit_id, final_tts_input_fingerprint, generation_variant_id)
WHERE status IN ('validating_reuse','generation_pending','running','indeterminate');
```

- **所有权语义（各阶段显式）**：
  - `validating_reuse`：`validation_owner_token/validation_lease_expires_at/validation_attempt` 有效；`owner_token/lease_expires_at` NULL；
  - `generation_pending/running`：`owner_token/lease_expires_at` 有效（job 执行所有权，与 `tts_jobs` claim 同步）；`validation_*` 清空；
  - `succeeded/failed/cancelled/indeterminate`：所有权字段全清（终态）。
- **状态机**：`validating_reuse → succeeded`（reuse）；`validating_reuse → generation_pending`（repair，claim 保护下建 job）；`validating_reuse → cancelled`（零 subscriber）；`generation_pending → running`；`running → succeeded/failed/cancelled/indeterminate`；`indeterminate → succeeded/failed/cancelled`（显式 resolve）。
- **invalid-transition trigger**：禁止 `succeeded → *`；禁止 `generation_pending → validating_reuse`（回退）；禁止 `running → validating_reuse/generation_pending`；禁止 `indeterminate → running/generation_pending`（必须显式 resolve 到终态）。
- **DELETE trigger**：禁止 DELETE。
- **immutable**：`id/project_id/unit_id/final_tts_input_fingerprint/generation_variant_id`。
- **authoritative**：active synthesis identity 唯一真相（partial unique 覆盖 validating/generation_pending/running/indeterminate）。

### 2.3 `tts_jobs`（mutable execution；TTS-C 新列）

```sql
ALTER TABLE tts_jobs ADD COLUMN claim_id TEXT REFERENCES tts_synthesis_claims(id) ON DELETE SET NULL;
ALTER TABLE tts_jobs ADD COLUMN originating_request_id TEXT;   -- 仅审计 provenance（非 subscriber 真相）
ALTER TABLE tts_jobs ADD COLUMN exact_source_fingerprint TEXT;
ALTER TABLE tts_jobs ADD COLUMN synthesis_payload_fingerprint TEXT;
ALTER TABLE tts_jobs ADD COLUMN final_tts_input_fingerprint TEXT;
ALTER TABLE tts_jobs ADD COLUMN generation_variant_id TEXT;
ALTER TABLE tts_jobs ADD COLUMN result_artifact_id TEXT REFERENCES sentence_audio_artifacts(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX uq_tts_jobs_active_synthesis
ON tts_jobs (project_id, unit_id, final_tts_input_fingerprint, generation_variant_id)
WHERE status IN ('queued','running','indeterminate');
```

- 现有列保留；`output_path/duration_ms/audio_sha256/result_json` legacy 兼容（TTS-C 不写不读为 authoritative）。
- 状态机沿用：`queued → running → succeeded`；`queued → failed/cancelled`；`running → indeterminate`（保守）等；invalid-transition trigger 同现有 job 语义扩展。
- Scheduler 只 claim `status='queued'` 且 `claim.status IN ('generation_pending','running')` 的 job；**`validating_reuse` 阶段无 queued job**。

### 2.4 `tts_generation_attempts`（persisted execution phase）

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
  audio_sha256 TEXT,
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
  UNIQUE (job_id, attempt_number)
);
```

- **immutable-field trigger（ABORT）**：`job_id/attempt_number/provider/model/request_hash/request_json` 禁改。
- **invalid-transition trigger**：`created → provider_in_flight → response_persisted → file_validated → file_durable → succeeded` 单向；`* → transport_failed/validation_failed/indeterminate`；**禁止任何回退**（如 `succeeded → response_persisted`、`file_durable → file_validated`）。
- **DELETE trigger**：禁止 DELETE。
- **authoritative**：execution phase 持久化真相（recovery 依据）。

### 2.5 `sentence_audio_artifacts`（immutable result；fan-in provenance）

```sql
CREATE TABLE sentence_audio_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL DEFAULT 'sentence-audio-artifact@1.0',
  unit_id TEXT NOT NULL CHECK (unit_id GLOB 'N[0-9][0-9][0-9]'),
  narration_plan_artifact_id TEXT NOT NULL,
  narration_plan_content_hash TEXT NOT NULL,
  assignment_artifact_id TEXT NOT NULL,
  assignment_content_hash TEXT NOT NULL,
  performance_plan_artifact_id TEXT NOT NULL,
  performance_plan_content_hash TEXT NOT NULL,
  voice_profile_id TEXT NOT NULL,
  voice_profile_revision_id TEXT NOT NULL,
  canonical_audio_sha256 TEXT NOT NULL,
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
  claim_id TEXT NOT NULL REFERENCES tts_synthesis_claims(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL REFERENCES tts_jobs(id) ON DELETE RESTRICT,
  successful_attempt_id TEXT NOT NULL REFERENCES tts_generation_attempts(id) ON DELETE RESTRICT,
  originating_request_id TEXT,       -- 仅审计 provenance；subscriber 真相经 claim_id 查询
  output_relative_path TEXT NOT NULL CHECK (output_relative_path NOT LIKE '..%' AND output_relative_path NOT LIKE '/%'),
  audio_sha256 TEXT NOT NULL CHECK (length(audio_sha256) = 64),
  output_size INTEGER NOT NULL CHECK (output_size > 0),
  codec TEXT NOT NULL,
  sample_rate INTEGER NOT NULL CHECK (sample_rate > 0),
  channels INTEGER NOT NULL CHECK (channels > 0),
  ffprobe_duration_ms INTEGER NOT NULL CHECK (ffprobe_duration_ms >= 0),
  generation_variant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL
);
```

- **不可变**：`UPDATE/DELETE` 全禁（trigger ABORT）——**无任何可更新字段**；
- **无 fingerprint UNIQUE**（多 immutable candidate 合法共存）；
- `claim_id/job_id/successful_attempt_id` NOT NULL：成功 artifact 必须有 exact successful attempt；`originating_request_id` 仅审计（artifact **不声称只属于一个 request**；subscriber 真相 = `SELECT * FROM tts_audio_requests WHERE claim_id = ?`）；
- **CHECK**：unit_id 形状、output_relative_path 防 traversal（非 `..`/绝对路径）、sha256 64 hex、size>0、sr/ch>0、duration≥0；
- **authoritative reader**：`validateSentenceAudioArtifactExact`（schema 可解析、路径 containment realpath、regular file、非 symlink、audio_sha256、output_size、codec/sr/ch、duration 全检；damaged → fail-closed）；
- **API redaction**：`output_relative_path` 永不序列化输出。

### 2.6 `voice_materialization_requests`（project-scoped envelope）

```sql
CREATE TABLE voice_materialization_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  voice_profile_id TEXT NOT NULL,
  voice_profile_revision_id TEXT NOT NULL,
  assignment_artifact_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  job_id TEXT REFERENCES voice_materialization_jobs(id) ON DELETE SET NULL,
  materialization_id TEXT REFERENCES voice_materializations(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN
    ('waiting','running','succeeded','reused','failed','cancelled','indeterminate')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, request_id)
);
```

- **requestId scope = (project_id, request_id)**；同 scope 同 requestId：same exact profile/revision/assignment/source → replay；different identity → 409 `REQUEST_ID_CONFLICT`；
- **Assignment artifact 必须属于同一 `project_id`**（CHECK 外由裁决校验：`SELECT project_id FROM artifacts WHERE id = ?` 等于 envelope.project_id）；
- 状态机：`waiting → running → succeeded`；`waiting → reused`（existing projection）；`waiting/running → cancelled/failed/indeterminate`；
- DELETE 禁（append-only）。

### 2.7 `voice_materialization_jobs`（mutable Worker execution；真正 single-flight）

```sql
CREATE TABLE voice_materialization_jobs (
  id TEXT PRIMARY KEY,
  voice_profile_id TEXT NOT NULL,
  voice_profile_revision_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('validating_existing','queued','running','succeeded','failed','cancelled','indeterminate')),
  owner_token TEXT,              -- running：Worker 执行所有权
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  validation_owner_token TEXT,   -- validating_existing：validator 所有权
  validation_lease_expires_at TEXT,
  validation_attempt INTEGER NOT NULL DEFAULT 0,
  candidate_materialization_id TEXT,   -- validating_existing：候选 projection
  source_canonical_sha256 TEXT,
  adapter_compatibility_key TEXT,
  destination_voice_root_relative_path TEXT NOT NULL
    CHECK (destination_voice_root_relative_path NOT LIKE '../%' AND destination_voice_root_relative_path NOT LIKE '/%'),
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX uq_voice_materialization_jobs_active
ON voice_materialization_jobs (voice_profile_id, voice_profile_revision_id)
WHERE status IN ('validating_existing','queued','running','indeterminate');
```

- **Scheduler 只领取 `status='queued'`**；`validating_existing` unschedulable（校验 existing projection，不执行 copy）；
- **partial unique**：同 profile+revision 最多一个 active job（validating_existing/queued/running/indeterminate）；
- 状态机：`validating_existing → queued/succeeded/cancelled`；`queued → running`；`running → succeeded/failed/cancelled/indeterminate`；`indeterminate → succeeded/failed/cancelled`（显式 resolve）；
- 所有权：`validating_existing` 用 `validation_owner_token/validation_lease_expires_at/validation_attempt`；`running` 用 `owner_token/lease_expires_at/heartbeat_at`；语义显式分离；
- **DELETE 禁**（append-only 执行历史）。

### 2.8 `voice_materializations`（canonical projection；每 exact voice 唯一）

```sql
CREATE TABLE voice_materializations (
  id TEXT PRIMARY KEY,
  voice_profile_id TEXT NOT NULL,
  voice_profile_revision_id TEXT NOT NULL,
  source_canonical_sha256 TEXT NOT NULL CHECK (length(source_canonical_sha256) = 64),
  adapter_compatibility_key TEXT NOT NULL,
  destination_voice_root_relative_path TEXT NOT NULL
    CHECK (destination_voice_root_relative_path NOT LIKE '../%' AND destination_voice_root_relative_path NOT LIKE '/%'),
  status TEXT NOT NULL CHECK (status IN
    ('file_ready_unpublished','registry_pending','published_usable','failed','indeterminate')),
  published_registry_generation INTEGER,
  published_registry_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (voice_profile_id, voice_profile_revision_id)
);
```

- `UNIQUE(profile, revision)`：canonical projection 每 exact voice 唯一（single-flight 的第二道防线，主防线 = job partial unique）；
- 状态机：`file_ready_unpublished → registry_pending → published_usable`；`* → failed/indeterminate`；**published_usable 不可逆**（trigger）；
- 目标路径固定 `<voice_profile_id>/<voice_profile_revision_id>/reference.wav`（voice-root-relative）；
- DELETE 禁（canonical 历史保留）。

### 2.9 `legacy_adapter_voice_entries`（legacy shadow；single-source mapping）

```sql
CREATE TABLE legacy_adapter_voice_entries (
  id TEXT PRIMARY KEY,
  voice_profile_key TEXT NOT NULL,
  voice_revision_key TEXT NOT NULL,
  speaker_name TEXT NOT NULL,
  reference_asset_path_or_safe_projection TEXT NOT NULL,
  reference_sha256 TEXT NOT NULL CHECK (length(reference_sha256) = 64),
  source_registry_sha256 TEXT NOT NULL CHECK (length(source_registry_sha256) = 64),
  imported_at TEXT NOT NULL,
  mapping_status TEXT NOT NULL CHECK (mapping_status IN
    ('unmapped','mapping_pending','mapped_verified','mapped_active','retired')),
  mapped_voice_materialization_id TEXT REFERENCES voice_materializations(id) ON DELETE SET NULL,
  retired_at TEXT,
  UNIQUE (voice_profile_key, voice_revision_key)
);
```

- **输出规则（single source）**：
  - `unmapped / mapping_pending / mapped_verified` → emitted registry **使用 legacy entry**；
  - `mapped_active` → emitted registry **使用 TTS-A voice_materialization**（legacy row 只保留 provenance，不参与输出）；
  - `retired` → 不参与输出；
  - **每个 canonical key 在任一 candidate registry 中恰好一个 source**（冲突 fail-closed）；
- 映射等价性验证（转 `mapped_verified` 前）：canonical voice key、reference SHA-256、speaker identity/name policy、adapter compatibility key、reference file containment、codec/sample-rate/channels；
- 不伪造 TTS-A 数据（不写 voice_profiles/revisions）。

---

## 3. Reclaimable synthesis validation（§三 P0 修复）

### 3.1 validating_reuse 完整语义

`tts_synthesis_claims` 在 `validating_reuse` 阶段持有：`validation_owner_token / validation_lease_expires_at / validation_attempt / candidate_artifact_id / candidate_artifact_metadata_hash / validation_started_at`（§2.2）。所有权字段在各阶段显式（validating 用 validation_*；generation/running 用 owner_token/lease；终态清空）。

### 3.2 Phase 1（单 BEGIN IMMEDIATE）

```text
1. request envelope-first 裁决（tts_audio_requests）
2. 查找 active synthesis claim（partial unique 命中）
   - 命中 validating_reuse → request 链接同一 claim；返回 waiting/in_progress；不重复创建 validator
   - 未命中 → INSERT claim status=validating_reuse
     · validation_owner_token = 新 UUID
     · validation_lease_expires_at = now + VALIDATION_LEASE_MS
     · candidate_artifact_id + candidate_artifact_metadata_hash（同步 DB 读）
     · validation_attempt = 1
3. subscriber 链接 claim
COMMIT
```

### 3.3 Stale recovery（CAS 接管；不调用 provider）

```text
validating_reuse lease 未过期 → 不接管（返回 in_progress）

lease 过期 → BEGIN IMMEDIATE 原子 CAS：
  UPDATE tts_synthesis_claims
  SET validation_owner_token = ?,
      validation_lease_expires_at = now + VALIDATION_LEASE_MS,
      validation_attempt = validation_attempt + 1,
      validation_started_at = now
  WHERE id = ?
    AND status = 'validating_reuse'
    AND validation_lease_expires_at < now
  → changes=1 才取得接管权
→ 新 validator 重新执行 exact artifact reader（validateSentenceAudioArtifactExact）
→ 不调用 provider
```

candidate 已删除 / metadata 漂移 / exact reader 失败 → 按 **unusable** 处理（不 fallback latest/default）→ 重新进入 claim 保护下的 Phase 3（5B repair）。

**必须测试**：Phase 1 后 crash → stale validator 接管 → 最终 reused 或恰好一个 queued job → 不永久阻塞。

---

## 4. Validating 阶段取消语义（§四 P0 修复）

Phase 3 在**同一 BEGIN IMMEDIATE** 中重读所有 subscriber：

```text
active subscriber count = 0（全部 cancelled/detached）
→ claim = cancelled
→ clear validation_owner_token / validation_lease_expires_at / owner_token / lease_expires_at
→ 不创建 tts_job
→ 释放 active unique
```

规则：
- 单 request cancel 仅取消该 envelope（`tts_audio_requests.status='cancelled'`）；
- **最后 subscriber 在 validating_reuse 阶段取消 → 直接取消 claim**（无 job 存在）；
- **最后 subscriber 在 generation_pending/running 阶段取消 → 才设置 `job.cancel_requested=1`**；
- validator 完成与最后 cancel 竞争由同一事务裁决（cancel 优先：事务重读时 active subscriber=0 → 不 reused、不建 job、claim cancelled）；
- **不允许创建 zero-subscriber provider job**。

**必须测试**：
```
A+B validating；A cancel → B remains（继续 validating）
A+B both cancel before Phase 3 → no job
last cancel 与 Phase 3 并发 → 原子结果（无孤儿 job、无 reused 到已取消 envelope）
```

---

## 5. Materialization 真正 single-flight（§五 P0 修复）

### 5.1 状态与约束（§2.7）

`voice_materialization_jobs` 增 `validating_existing`（unschedulable；Scheduler 只领取 `queued`）；partial unique `uq_voice_materialization_jobs_active`（validating_existing/queued/running/indeterminate）——**不得只依赖 projection 的 `UNIQUE(profile, revision)`**。

### 5.2 Envelope（§2.6）

`voice_materialization_requests` 增 `project_id` + `UNIQUE(project_id, request_id)`；Assignment artifact 必须属于同一 project_id；同 requestId 同 identity → replay；异 → 409。

### 5.3 正确算法

```text
BEGIN IMMEDIATE
1. request envelope-first（project 内幂等）
2. 查找 canonical projection（voice_materializations）
3. 查找/创建 active materialization job = validating_existing
   （partial unique 保证同 profile+revision 只有一个）
4. 多 request 链接同一 job
COMMIT

事务外 exact projection/file validator
（existing projection 文件存在 + SHA/codec/size 一致）

BEGIN IMMEDIATE
5A. existing projection usable：
    - 全部 active requests → succeeded/reused
    - job → succeeded
    - 不复制文件
5B. projection 不存在/不可用：
    - active subscriber = 0 → job cancelled（释放 active unique）
    - 否则 job validating_existing → queued
COMMIT

随后 Worker 才执行 temp copy（claim queued → running）
```

**必须测试**：两 requestId 并发只创建一个 job；validating_existing 时 Scheduler 不执行 copy；usable projection 零文件写；不可用 projection 恰好一个 queued job；不出现两个 Worker 同写同一路径（partial unique + claim）。

### 5.4 Stale validating recovery

与 synthesis reuse 相同：`validation_lease_expires_at` 过期 → BEGIN IMMEDIATE CAS 接管（validation_attempt+1）→ 重跑 exact validator。Materialization 本地复制无 provider 副作用，可在明确未进入文件写阶段时安全重新校验。

---

## 6. Materialization fan-out 与 durability（§六 P0 修复）

多个 `voice_materialization_requests` 共享同一 job/projection。文件 durable 后**单事务**：

```text
BEGIN IMMEDIATE

1. 重读 active job owner/lease/status（running；owner_token 匹配）
2. 重读 exact Voice Revision（validateVoiceProfileRevisionExact usable）
3. 重读全部 active request subscriber（job 链接的全部 waiting/running envelope）
4. 验证全部 request identity / Assignment / project 自洽
   （任一 mismatch → 整事务回滚 + REQUEST_STATE_INCONSISTENT）
5. INSERT 或 UPDATE canonical projection = file_ready_unpublished
   （UNIQUE(profile, revision) upsert：同 voice 复用既有 projection 行）
6. job → succeeded
7. 所有未取消 request → succeeded + materialization_id

COMMIT
```

任一步失败：整事务回滚；durable final file 按 exact profile/revision/SHA 可安全恢复；不允许 projection/job/request 部分成功；cleanup 不删除 DB 正在引用或可恢复的文件。目标路径固定 `<voice_profile_id>/<voice_profile_revision_id>/reference.wav`（仅 voice-root-relative）。

---

## 7. Legacy single-source mapping cutover（§七 P0 修复）

### 7.1 Mapping 状态（5 态）

```
unmapped / mapping_pending / mapped_verified → emitted registry 使用 legacy entry
mapped_active → emitted registry 使用 TTS-A voice_materialization（legacy 行只保留 provenance）
retired → 不参与输出
```

**修复双来源冲突**：R3 的"legacy unmapped+mapped + TTS-A projection"union 会让正常 mapped key 重复——现改为**每个 canonical key 在任一 candidate registry 中恰好一个 source**（由 mapping_status 决定用 legacy 还是 TTS-A）。

### 7.2 Mapping 等价性（转 `mapped_verified` 前验证）

canonical voice key、reference SHA-256、speaker identity/name policy、adapter compatibility key、reference file containment、codec/sample-rate/channels——全项一致才允许 mapped_verified。

### 7.3 Atomic cutover

```text
publish candidate registry using TTS-A projection
→ adapter activeRegistrySha256 == candidate SHA
→ legacy row → mapped_active
→ projection → published_usable
```

失败/LKG（`active SHA != candidate SHA`）：
- legacy **remains emitted source**（不丢旧 voice）；
- projection 保持 `registry_pending`；
- 不删除 legacy entry；下轮重试。

---

## 8. Artifact fan-in provenance 修正（§八 P0 修复）

`sentence_audio_artifacts` **删除权威单数 `request_id`**，改为（§2.5）：

```text
claim_id TEXT NOT NULL REFERENCES tts_synthesis_claims(id)
job_id TEXT NOT NULL REFERENCES tts_jobs(id)
successful_attempt_id TEXT NOT NULL REFERENCES tts_generation_attempts(id)
originating_request_id TEXT        -- 仅审计 provenance
```

- `originating_request_id` 仅审计；subscriber 真相经 `claim_id` 查询（fan-in）；
- artifact **不声称只属于一个 request**；
- **成功 artifact 必须有 exact successful attempt**（successful_attempt_id NOT NULL + attempt execution_phase=succeeded 校验）。

---

## 9. 完整状态机与 trigger（§九）

### 9.1 `tts_audio_requests`

```
waiting → succeeded              # artifact reuse（无 running）
waiting → running → succeeded
waiting/running → cancelled
waiting/running → failed
waiting/running → indeterminate
```

### 9.2 `tts_synthesis_claims`

```
validating_reuse → succeeded | cancelled | generation_pending | failed
generation_pending → running | cancelled
running → succeeded | failed | cancelled | indeterminate
indeterminate → succeeded | failed | cancelled   # 显式 resolve
```

### 9.3 其他表状态机

- `voice_materialization_jobs`：`validating_existing → queued/succeeded/cancelled`；`queued → running`；`running → succeeded/failed/cancelled/indeterminate`；`indeterminate → succeeded/failed/cancelled`；
- `voice_materializations`：`file_ready_unpublished → registry_pending → published_usable`（published_usable 不可逆）；`* → failed/indeterminate`；
- `voice_materialization_requests`：`waiting → running → succeeded`；`waiting → reused`；`waiting/running → cancelled/failed/indeterminate`；
- `tts_generation_attempts`：`created → provider_in_flight → response_persisted → file_validated → file_durable → succeeded`；`* → transport_failed/validation_failed/indeterminate`。

**所有非法倒退由 invalid-transition trigger ABORT**（§0 通用约定）。

---

## 10. 并行开发规则（见实施计划 §0/§11；此处为设计依据）

- 1A 与 1C 可并行开发（不同本地 worktree/local branch）；1B 的 adapter parser/reloader 测试骨架可并行准备，publisher integration 等 1A schema PASS；C.2 等 1A/1B/1C 全部 PASS；C.3→C.5 runtime 串行，仅 schema/mock/test planning 提前并行。
- Git：不推阶段 remote branch；单一 integrator 拥有 m7；agent 返回独立 commit SHA；integrator 按序 cherry-pick；每 exact SHA 单独 typecheck/build/tests/Review/deploy；禁止一次合并多个未 Review lane。

---

## 11. Fingerprint / capability / manifest-master / stale（R1-R3 结论保留）

- fingerprint 三分离 + generationVariantId = 候选生成身份；materialization transport 不入 fingerprint；
- capability neutral matrix（neutral → supported no-op；非 neutral 无通道 → explicit unsupported）；
- `narration_audio_selection_manifest@2.0` + `narration_master_audio@1.0`（masterInputFingerprint 非循环）；
- downstream stale 图；Security（API 不输出路径、Web 无 voice 挂载、attempt journal 只存安全投影）。

---

## 12. Unresolved decisions（进入 1A 前定）

1. delivery 编译策略（文本改写 vs 显式 unsupported，推荐显式 unsupported）。
2. pace 经 adapter 扩展直传可行性。
3. unit vs sentence 原子单位（推荐 unit）。
4. capability 升级后存量音频失效策略。
5. pronunciation dictionary 是否纳入（建议 C.3 后）。
6. master 拼接实现（Node PCM vs ffmpeg concat，C.4 定）。
7. VALIDATION_LEASE_MS 取值（与 generation lease 15min 对齐或更短；1A/C.2 定）。

## 13. Recommended first implementation stage

**TTS-C.1A**（materialization requests/jobs/projection + `validating_existing` single-flight，止于 `file_ready_unpublished`）——零音频风险、解锁 materialization；随后 1B（legacy single-source cutover + global publisher + activation ack）、1C（capability compiler）；C.2（audio claim/job/attempt/artifact + reclaimable validation）依赖 1A/1B/1C 齐备。
