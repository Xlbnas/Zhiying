# TTS-C Incremental Narration 架构设计（TTS-C.0.R3 修订，只读审计，未实现）

> 状态：**TTS-C.0.R3 architecture closure completed；pending independent Review PASS；
> TTS-C runtime implementation not started；TTS-C.1A not started**。
> 本文档是只读架构审计产物（R3 修订）：不修改 runtime code / schema / config / migration / compose。
> 运行时真相以真实代码为准（审计基线 m7 @ `f94e60d`；TTS-B final code `86f7f52…` 已 FROZEN）。
> 本修订关闭 ChatGPT 独立 Review FAIL 发现：① unschedulable reuse reservation（`tts_synthesis_claims`）；
> ② 共享 request fan-in（many-to-one + fan-out + per-request cancellation）；③ persisted execution phases；
> ④ 原子 claim/job/request/artifact 成功终局；⑤ materialization request/job/projection 三层拆分；
> ⑥ legacy registry shadow + publisher source union；⑦ adapter activation acknowledgement；
> ⑧ **自包含最终 schema**（9 张表完整定义，实施者不得跨历史 commit 拼接）。

---

## 0. 本文档是唯一权威 schema 契约

R3 起，**历史 commit 不是权威 contract 的一部分**。以下 §2–§8 完整写出当前最终 schema（PK/FK、
UNIQUE/partial UNIQUE、CHECK、UPDATE/DELETE triggers、状态机、exact reader、authoritative source、
file/DB durability、API path redaction、migration/legacy compatibility）。实施者以此为准，不得跨 commit 拼接。

---

## 1. 现有真实状态（TTS-C 起点）

### 1.1 Voice Library（TTS-A，FROZEN `1460efd…`）

- `voice_profiles`：`id / schema_version('voice-profile@1.0') / display_name / provider('indextts2') / status(active|archived) / created_at / updated_at`。
- `voice_profile_revisions`（trigger ABORT 不可变）：`id / schema_version / voice_profile_id / revision_number / request_id / provider / adapter_compatibility_key / original_audio_sha256 / canonical_audio_sha256 / original_filename_display / canonical_audio_path / codec / sample_rate / channels / duration_ms / transcript / language / metadata_json / request_fingerprint / created_at`，`UNIQUE(voice_profile_id, revision_number)` + `UNIQUE(voice_profile_id, request_id)`。
- canonical 文件：`voice-library/<pid>/<rid>/reference.wav`；canonical 参数冻结：WAV / pcm_s16le / mono / 48000Hz；`validateVoiceProfileRevisionExact` 单一真相源。

### 1.2 TTS-B（FROZEN `86f7f52…`）

- `voice_assignment_requests` envelope；`project_voice_assignment` artifact（exact 双 ID）；`narration_performance_plan` artifact（三层 source 自洽 + items）；`generation_runs/attempts/dispatch_jobs`。

### 1.3 现有 TTS job 体系（M3-B / M7.1；TTS-C 中降级）

- `tts_jobs`（现有列）含 `output_path/duration_ms/audio_sha256/result_json`（legacy 兼容，非 TTS-C authoritative）；worker `tts-executor.ts`（claim + GPU lease + heartbeat + `finalizeTtsJobSuccess`）；`recoverStaleTtsJobs`（**不得用于 TTS-C 无条件 requeue**）。

### 1.4 IndexTTS2 Adapter（`server.py`）

- `/v1/synthesize` 仅 `text + voiceProfile@voiceRevision + useRandom=false + emotion='none'`；registry 启动加载一次；拒绝 `voices=[]`；containment + `_check_voice`；materialization API 不存在。

---

## 2. 最终 schema（9 表，自包含）

### 2.1 `tts_audio_requests`（request envelope；many-to-one 到 claim/job）

```sql
CREATE TABLE tts_audio_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  request_id TEXT NOT NULL,               -- canonicalizeRequestId（8–128，[A-Za-z0-9._:-]）
  exact_source_fingerprint TEXT NOT NULL,
  synthesis_payload_fingerprint TEXT NOT NULL,
  final_tts_input_fingerprint TEXT NOT NULL,
  generation_variant_id TEXT NOT NULL DEFAULT 'default',
  claim_id TEXT,                          -- tts_synthesis_claims.id（fan-in 链接）
  job_id TEXT,                            -- tts_jobs.id（可能 NULL：reuse 路径无 job）
  result_artifact_id TEXT,                -- sentence_audio_artifacts.id（成功时）
  status TEXT NOT NULL,                   -- waiting/running/succeeded/failed/cancelled/indeterminate
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, request_id)
);
```

- PK：`id`；FK：`project_id → projects`、`claim_id → tts_synthesis_claims(id)`（SET NULL 允许 reuse 无 claim 之外不变）、`job_id → tts_jobs(id)`、`result_artifact_id → sentence_audio_artifacts(id)`。
- UNIQUE：`(project_id, request_id)`（request idempotency）。
- CHECK：`status IN ('waiting','running','succeeded','failed','cancelled','indeterminate')`。
- UPDATE/DELETE：允许 UPDATE（status/result/error 生命周期）；DELETE 禁（append-only 请求历史；trigger ABORT）。
- 状态机：`waiting → running → succeeded`；`waiting/running → failed/cancelled`；`waiting/running → indeterminate`。
- **authoritative source**：request identity 的持久真相（`exact_source_fingerprint/synthesis_payload_fingerprint/final_tts_input_fingerprint/generation_variant_id`）。
- 注意：**不设 `tts_jobs.tts_audio_request_id` 单数 FK 作为唯一 owner**——若保留该列，仅命名为 `originating_request_id`（创建者），不承担 subscriber 真相；subscriber 真相由 `tts_audio_requests.claim_id` 反向查询。

### 2.2 `tts_synthesis_claims`（唯一 synthesis reservation；unschedulable）

```sql
CREATE TABLE tts_synthesis_claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  unit_id TEXT NOT NULL,                  -- N\d{3}
  final_tts_input_fingerprint TEXT NOT NULL,
  generation_variant_id TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL,                   -- validating_reuse/generation_pending/running/succeeded/failed/cancelled/indeterminate
  job_id TEXT,                            -- tts_jobs.id（generation_pending 起）
  result_artifact_id TEXT,                -- sentence_audio_artifacts.id（succeeded）
  owner_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX uq_tts_synthesis_claim_active
ON tts_synthesis_claims (
  project_id, unit_id, final_tts_input_fingerprint, generation_variant_id
)
WHERE status IN ('validating_reuse', 'generation_pending', 'running', 'indeterminate');
```

- **一个 active synthesis identity 的唯一 reservation**；**不等于 provider execution job**（可处于 `validating_reuse`——Scheduler 永不 claim）。
- UNIQUE（partial）：active claim 唯一；`indeterminate` 继续占用。
- 状态机：`validating_reuse → generation_pending → running → succeeded`；`validating_reuse → succeeded`（reuse 路径，无 job）；`* → failed/cancelled/indeterminate`。
- **Scheduler 只 claim `tts_jobs.status='queued'` 且 `tts_synthesis_claims.status='generation_pending'/'running'` 的 job；`validating_reuse` 阶段无 queued job 存在**（见 §3.2 算法——这是修复的核心）。

### 2.3 `tts_jobs`（mutable execution；TTS-C 新列）

```sql
ALTER TABLE tts_jobs ADD COLUMN claim_id TEXT;                -- tts_synthesis_claims.id
ALTER TABLE tts_jobs ADD COLUMN originating_request_id TEXT;  -- 仅创建者 envelope（非 subscriber 真相）
ALTER TABLE tts_jobs ADD COLUMN exact_source_fingerprint TEXT;
ALTER TABLE tts_jobs ADD COLUMN synthesis_payload_fingerprint TEXT;
ALTER TABLE tts_jobs ADD COLUMN final_tts_input_fingerprint TEXT;
ALTER TABLE tts_jobs ADD COLUMN generation_variant_id TEXT;
ALTER TABLE tts_jobs ADD COLUMN result_artifact_id TEXT;      -- sentence_audio_artifacts.id

CREATE UNIQUE INDEX uq_tts_jobs_active_synthesis
ON tts_jobs (project_id, unit_id, final_tts_input_fingerprint, generation_variant_id)
WHERE status IN ('queued', 'running', 'indeterminate');
```

- 现有列保留（status/claim/heartbeat/attempt/cancel 等）；`output_path/duration_ms/audio_sha256/result_json` 为 legacy 兼容（TTS-C 路径不写不读为 authoritative）。
- `uq_tts_jobs_active_synthesis` 与 `uq_tts_synthesis_claim_active` 双保险（claim 先占，job 后入；极端不一致时唯一索引兜底）。
- 状态机沿用：`queued → running → succeeded`；`queued → failed/cancelled`；`running → indeterminate`（保守）等。

### 2.4 `tts_generation_attempts`（persisted execution phase；append-one-row-per-provider-call）

```sql
CREATE TABLE tts_generation_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES tts_jobs(id),
  attempt_number INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  request_hash TEXT NOT NULL,             -- 安全 request 投影 hash
  request_json TEXT NOT NULL,             -- 安全投影（无 header/secret）
  execution_phase TEXT NOT NULL,          -- created/provider_in_flight/response_persisted/file_validated/file_durable/succeeded/transport_failed/validation_failed/indeterminate
  recovery_temp_relative_path TEXT,       -- attempt-specific recovery temp（data-relative）
  final_relative_path TEXT,               -- final output（data-relative；file_durable 起）
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
  UNIQUE(job_id, attempt_number)
);
```

- **immutable**（trigger ABORT 禁改）：`job_id / attempt_number / provider / model / request_hash / request_json`；
- **mutable lifecycle**（受控更新）：`execution_phase / recovery_temp_relative_path / final_relative_path / response_hash / audio_sha256 / output_size / codec / sample_rate / channels / ffprobe_duration_ms / provider_request_id / error_classification / usage_record_id / finished_at`；
- 禁 DELETE；状态机禁倒退（trigger 检查：`created → provider_in_flight → response_persisted → file_validated → file_durable → succeeded`，或 `→ transport_failed / validation_failed / indeterminate`，不得回退）；
- `execution_phase` 是 **crash recovery 的持久化真相**（不是推导值，见 §5）。

### 2.5 `sentence_audio_artifacts`（immutable successful result）

```sql
CREATE TABLE sentence_audio_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  schema_version TEXT NOT NULL DEFAULT 'sentence-audio-artifact@1.0',
  unit_id TEXT NOT NULL,                  -- N\d{3}
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
  request_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  successful_attempt_id TEXT,
  output_relative_path TEXT NOT NULL,     -- 仅 data-relative
  audio_sha256 TEXT NOT NULL,
  output_size INTEGER NOT NULL,
  codec TEXT NOT NULL,
  sample_rate INTEGER NOT NULL,
  channels INTEGER NOT NULL,
  ffprobe_duration_ms INTEGER NOT NULL,
  generation_variant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL
);
```

- **DB trigger ABORT 禁止 UPDATE/DELETE**（immutable）；
- **无 fingerprint UNIQUE**（多 immutable candidate 合法共存：损坏 replacement / 显式重复生成 / provider 非 byte-deterministic）；
- exact reader `validateSentenceAudioArtifactExact`（单一真相源）：schema 可解析、路径 containment（realpath 不越界）、regular file、非 symlink、audio_sha256、output_size、codec/sample_rate/channels、ffprobe_duration_ms 全检；damaged → fail-closed；
- **API 不输出 `output_relative_path`**（序列化出口 redaction）；
- `job_id` 引用可指向已终态 job（immutable 快照，不因 job 变化失效）。

### 2.6 `voice_materialization_requests`（materialization request envelope）

```sql
CREATE TABLE voice_materialization_requests (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,               -- 幂等键（scope：见下）
  voice_profile_id TEXT NOT NULL,
  voice_profile_revision_id TEXT NOT NULL,
  assignment_artifact_id TEXT NOT NULL,   -- exact Assignment 授权（archive 后历史 Assignment 仍可 materialize）
  request_fingerprint TEXT NOT NULL,      -- hash(profile, revision, assignment, source_canonical_sha256)
  job_id TEXT,                            -- voice_materialization_jobs.id
  materialization_id TEXT,                -- voice_materializations.id（canonical projection）
  status TEXT NOT NULL,                   -- waiting/running/succeeded/failed/cancelled/indeterminate
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(voice_profile_id, voice_profile_revision_id, request_id)
);
```

- requestId 作用域：**per (voice_profile_id, voice_profile_revision_id)**；同 profile+revision 内同 requestId 幂等；跨 profile/revision 不同 requestId 独立；冲突语义 = 同 scope 同 requestId 不同 source → 409 `REQUEST_ID_CONFLICT`。
- **authoritative authorization**：`assignment_artifact_id` 必须存在 + source 自洽 + exact voice usable（**不按 Profile active 状态**）。

### 2.7 `voice_materialization_jobs`（mutable Worker execution）

```sql
CREATE TABLE voice_materialization_jobs (
  id TEXT PRIMARY KEY,
  voice_profile_id TEXT NOT NULL,
  voice_profile_revision_id TEXT NOT NULL,
  status TEXT NOT NULL,                   -- queued/running/succeeded/failed/cancelled/indeterminate
  owner_token TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  destination_voice_root_relative_path TEXT NOT NULL,  -- voice-root-relative（固定，非 data-relative 二选一）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- mutable；Worker 唯一 writer；claim/lease/heartbeat/retry/cancel 沿用 tts_jobs 模式。

### 2.8 `voice_materializations`（canonical projection；每 exact profile+revision 唯一）

```sql
CREATE TABLE voice_materializations (
  id TEXT PRIMARY KEY,
  voice_profile_id TEXT NOT NULL,
  voice_profile_revision_id TEXT NOT NULL,
  source_canonical_sha256 TEXT NOT NULL,  -- = voice_profile_revisions.canonical_audio_sha256（声学身份）
  adapter_compatibility_key TEXT NOT NULL,
  destination_voice_root_relative_path TEXT NOT NULL,
  status TEXT NOT NULL,                   -- file_ready_unpublished/registry_pending/published_usable/failed/indeterminate
  published_registry_generation INTEGER,
  published_registry_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(voice_profile_id, voice_profile_revision_id)
);
```

- **UNIQUE(profile, revision)**：canonical projection 每 exact voice 唯一；多个 requestId 复用同一 projection/job；
- 状态机：`file_ready_unpublished → registry_pending → published_usable`；`* → failed/indeterminate`；
- 1A 止于 `file_ready_unpublished`（§7.2）。

### 2.9 `legacy_adapter_voice_entries`（legacy registry shadow，独立于 TTS-A）

```sql
CREATE TABLE legacy_adapter_voice_entries (
  id TEXT PRIMARY KEY,
  voice_profile_key TEXT NOT NULL,        -- legacy registry voiceProfile 值（可能非 UUID）
  voice_revision_key TEXT NOT NULL,       -- legacy registry voiceRevision 值
  speaker_name TEXT NOT NULL,
  reference_asset_path_or_safe_projection TEXT NOT NULL,
  reference_sha256 TEXT NOT NULL,
  source_registry_sha256 TEXT NOT NULL,   -- 来源 registry 文件 SHA
  imported_at TEXT NOT NULL,
  mapping_status TEXT NOT NULL,           -- unmapped/mapped/retired
  mapped_voice_materialization_id TEXT,
  retired_at TEXT,
  UNIQUE(voice_profile_key, voice_revision_key)
);
```

- **不伪造 TTS-A 数据**：legacy entry 不要求存在 Voice Profile/Revision 或 Assignment；不写 `voice_profiles/voice_profile_revisions`；
- `mapping_status`：`unmapped`（publisher 可原样保留，**不得用于新 TTS-C exact source**）→ `mapped`（链接 canonical projection）→ `retired`（显式弃用）。

---

## 3. Unschedulable reuse reservation（§三 P0 修复）

### 3.1 模型

**修复目标**：Phase 1 INSERT queued job → COMMIT → Phase 2 校验 artifact 的竞态（queued job 可能在校验完成前被 Scheduler claim → 重复 provider 调用）。

**冻结方案**：新增 `tts_synthesis_claims`（§2.2）作为 active synthesis identity 的唯一 reservation：
- `validating_reuse`：Scheduler **永不 claim**（无 queued job 存在）；
- artifact usable → 直接 reused，**不创建 tts_job**；
- artifact unusable → 原子转为 `generation_pending` 并 INSERT queued tts_job（claim 保护下）；
- **不能在 artifact 校验前产生可执行 queued job**。

### 3.2 正确算法（两阶段）

```text
BEGIN IMMEDIATE                                     -- Phase 1（同步 DB）
1. envelope-first requestId 裁决（tts_audio_requests）
2. 取得/创建 synthesis claim（status=validating_reuse；
   partial unique 保证同一 synthesis 只有一个 claim）
3. request envelope 链接 claim（claim_id）
4. 读取 candidate artifact metadata（同步 DB，不读文件内容）
COMMIT

事务外 exact artifact validator                    -- Phase 2（异步文件 I/O）
（validateSentenceAudioArtifactExact）

BEGIN IMMEDIATE                                     -- Phase 3（同步 DB）
5A. artifact usable：
    - request / 所有 subscriber 链接 artifact
    - claim → succeeded（result_artifact_id）
    - 不创建 tts_job
5B. artifact unusable 或不存在：
    - 在 claim 保护下 INSERT queued tts_job（claim_id 链接）
    - claim.job_id = job.id
    - claim → generation_pending
COMMIT
```

**必须测试**：
- Scheduler 在 Phase 1/Phase 2 之间运行，provider 调用仍为 0（validating_reuse 无 queued job）；
- candidate usable 时始终零新 job；
- candidate damaged 时恰好一个 queued job（claim 保护）；
- 两个不同 requestId 并发只创建一个 claim/job（partial unique + fan-in）。

---

## 4. Shared request fan-in（§四 P0 修复）

### 4.1 关系模型

```
tts_audio_requests（many）──claim_id──▶ tts_synthesis_claims（1）
                                        │
                                        └─job_id─▶ tts_jobs（0..1；reuse 路径无 job）
```

- **many-to-one**：多个 request envelope 共享同一 claim/job；
- `tts_jobs` **不设单数 `tts_audio_request_id` FK 作为唯一 owner**；若保留列仅命名 `originating_request_id`（创建者，不承担 subscriber 真相）；subscriber 真相 = `SELECT * FROM tts_audio_requests WHERE claim_id = ?`；
- 每个 envelope 存：`claim_id / job_id / result_artifact_id / status / error_code / error_message / created_at / updated_at`。

### 4.2 成功 fan-out（同一 BEGIN IMMEDIATE）

```sql
UPDATE tts_audio_requests
SET status = 'succeeded',
    result_artifact_id = ?,
    updated_at = ?
WHERE claim_id = ?
  AND status IN ('waiting', 'running');
```

- 更新**全部有效 subscriber**（waiting/running）；
- **每个 envelope 的 request identity 必须与 claim 完全一致**——发现一个 mismatch → 整事务回滚并 `REQUEST_STATE_INCONSISTENT`；
- same-request replay 从自己的 envelope 得到相同 result；
- failed / cancelled / indeterminate 同样 fan-out，**除非该 envelope 已单独取消**（见 4.3）。

### 4.3 Per-request cancellation

- 单个 envelope cancel = **仅该 subscriber 转 cancelled/detached**（`status='cancelled'`，claim/job 不受影响）；
- 还有其他 active subscriber → shared claim/job **继续**；
- **所有 subscriber 均 cancelled → 才允许设置 job-level `cancel_requested=1`**（claim 层检查）；
- 管理员显式 job cancel 可取消全体，但必须记录 provenance（error_message 注明 admin cancel + operator）；
- success 与最后一个 cancel 的竞争由同一 BEGIN IMMEDIATE 原子裁决（cancel 优先：进入事务时 `cancel_requested=1` → 不插 artifact，job cancelled，subscribers cancelled）。

**测试矩阵（必须）**：

```
A+B 共享 job
A cancel → B 仍 succeeds（fan-out 只到 B）
A+B 均 cancel → job cancelled（最后 cancel 置 cancel_requested=1）
A cancel 与 success 并发 → 原子结果，无悬空 envelope
```

---

## 5. Persisted recovery phases（§五 P0 修复）

### 5.1 `tts_generation_attempts.execution_phase`（持久化真相，非推导）

```
created
provider_in_flight
response_persisted
file_validated
file_durable
succeeded
transport_failed
validation_failed
indeterminate
```

`recovery_temp_relative_path / final_relative_path / response_hash / audio_sha256 / output_size / codec / sample_rate / channels / ffprobe_duration_ms` 随阶段逐步填充（§2.4）。

### 5.2 严格顺序（provider 调用前的持久化屏障）

```text
BEGIN IMMEDIATE
→ INSERT attempt（phase=provider_in_flight）
COMMIT
→ 才允许发送 provider request
```

- 即便 crash 发生在 commit 后、网络发送前，也**保守进入 indeterminate**（不能冒险自动重调——无法证明请求是否已计费）。

收到 provider response：

```text
写 attempt-specific recovery temp（recovery_temp_relative_path）
→ fsync temp
→ DB：phase=response_persisted + response_hash + temp path
```

随后：

```text
ffprobe / hash / size / codec 校验
→ phase=file_validated

final rename + file fsync + dir fsync
→ phase=file_durable

最后执行 artifact/job/claim/requests 原子成功事务（§6）
```

### 5.3 Recovery（按 phase 精确恢复）

| phase | 恢复行为 |
|---|---|
| `created` / `provider_in_flight` | **indeterminate**（provider 调用已发生或可能已发生；禁自动重调） |
| `response_persisted` | 从 exact recovery temp 恢复（继续 probe/hash/finalize），**不调用 provider** |
| `file_validated` | 完成 final rename + fsync（不调用 provider） |
| `file_durable` | 只执行 DB finalize（§6） |
| `succeeded` | exact artifact reader 验证 |
| `transport_failed` / `validation_failed` | 按 retry 规则（retryable 且 attempt<max → 新 attempt；否则 failed） |

- recovery **必须校验** attempt/job/claim/source/fingerprint/owner 一致；任一证据不一致 → indeterminate；
- **cleanup 不能删除 DB 正在引用的 recovery temp/final 文件**（orphan 判定：DB 无引用才可清理）。

---

## 6. 原子成功终局（§六 P0 修复；含 claim 与全部 subscriber）

文件 durable 后，**唯一成功事务**：

```text
BEGIN IMMEDIATE

1. 重读 claim：
   - exact synthesis key（partial unique 命中）
   - status = running / generation_pending
   - owner/lease 合法

2. 重读 job：
   - claim_id 一致
   - status = running
   - cancel_requested = 0

3. 重读 current attempt：
   - execution_phase = file_durable
   - immutable request identity 一致

4. 重读所有 active request subscribers：
   - claim_id 一致
   - request identity 全部一致（任一 mismatch → 整事务回滚 + REQUEST_STATE_INCONSISTENT）

5. INSERT immutable sentence_audio_artifact

6. attempt → succeeded（execution_phase=succeeded + audio evidence）

7. job → succeeded + result_artifact_id（clear owner/lease）

8. claim → succeeded + result_artifact_id

9. 所有未取消 request envelope → succeeded + result_artifact_id

COMMIT
```

**任一步失败**：
- 整事务回滚；
- durable file 为 **recoverable orphan**（`file_durable` attempt 保留 → 可重新执行 DB finalize）；
- **不调用 provider**；
- **不允许 request/claim/job/artifact 部分成功**。

cancel 与 success：进入本事务顺序决定结果（`cancel_requested=1` → 不插 artifact，job cancelled，subscribers cancelled）。

---

## 7. Materialization 控制面三层拆分（§七 P0 修复）

### 7.1 三层（§2.6–2.8）

```
voice_materialization_requests   = requestId envelope / replay / conflict / authorization provenance
voice_materialization_jobs      = mutable Worker execution / owner / lease / heartbeat / attempt / recovery
voice_materializations          = 每 exact profile+revision 唯一 canonical projection
```

- 多个 requestId 复用同一 projection/job（`voice_materializations.UNIQUE(profile, revision)` + 请求 → 复用 job）；
- requestId scope：per (profile, revision)；同 scope 同 requestId 幂等；异 source → 409。

### 7.2 1A durability（冻结；目标路径固定 voice-root-relative）

```text
exact source validator（validateVoiceProfileRevisionExact usable）
→ materialization claim（voice_materialization_jobs，单 BEGIN IMMEDIATE claim）
→ temp copy（destination dir .tmp-<uuid>）
→ SHA / codec / size 校验
→ final rename + file fsync + dir fsync
→ BEGIN IMMEDIATE
   projection = file_ready_unpublished
   job = succeeded
   all linked requests = succeeded
→ COMMIT
```

- 1A **不写 registry、不声称 adapter ready**；
- 目标路径**固定为 voice-root-relative**（`<voice_profile_id>/<voice_profile_revision_id>/reference.wav`），**禁止"data-relative 或 voice-root-relative"二选一**。

---

## 8. Legacy registry cutover（§八 P0 修复）

### 8.1 独立 legacy shadow（`legacy_adapter_voice_entries`，§2.9）

- production TTS-A rows 0/0，**不能把手工 registry entry 伪装成 TTS-A materialization**；
- legacy entry 可被 publisher 原样保留（`mapping_status=unmapped`）；
- **unmapped legacy entry 不允许用于新 TTS-C exact source**；
- 不要求存在 TTS-A Voice Revision 或 Assignment；不伪造 TTS-A 数据；
- 可后续映射（mapped）或显式 retire（retired）。

### 8.2 Publisher source union（过渡期 registry 全量来源）

```text
validated non-retired legacy entries（legacy_adapter_voice_entries WHERE mapping_status IN ('unmapped','mapped') AND retired_at IS NULL）
+
published / registry_pending TTS-A voice_materializations（voice_materializations WHERE status IN ('published_usable','registry_pending')）
```

- **canonical key 唯一**（`voiceProfileKey@voiceRevisionKey`）；**key 冲突 fail-closed**（不静默覆盖，标记冲突待裁决）；
- 新 TTS-A voice 发布**不会删除 legacy entry**；
- cutover 前后 legacy entry 集合与 SHA **完全保持**（重建结果对比断言）；
- 无法映射**不阻止保留服务**，但阻止它进入 TTS-C 新业务引用（exact source 只认 voice_materializations）。

---

## 9. Adapter activation acknowledgement（§九 P0 修复）

仅 `ready=true/degraded=true` 不足以证明新 registry 已激活。Registry 文档增加：

```json
{"schemaVersion": "1.0",
 "registryGeneration": 12,
 "publisherSchemaVersion": "voice-registry-publisher@1.0",
 "voices": [...]}
```

Adapter `/health` 增加：

```json
{"ready": true, "degraded": false,
 "activeRegistrySha256": "...", "activeRegistryGeneration": 12,
 "candidateRegistrySha256": "...", "detail": ""}
```

Publisher 流程（1B）：

```text
atomic publish registry
→ projection = registry_pending
→ poll adapter /health
→ activeRegistrySha256 == published SHA
→ projection = published_usable
```

- adapter 保持 LKG（`ready=true/degraded=true/active SHA != candidate SHA`）→ projection **必须保持 registry_pending，不得标记 usable**；
- `registryGeneration` 单调递增（provenance，**不进 TTS fingerprint**——R2 已冻结）。

---

## 10. Fingerprint / capability / manifest-master / stale（R1/R2 结论保留）

- fingerprint 三分离（exactSourceFingerprint / synthesisPayloadFingerprint / finalTtsInputFingerprint）+ generationVariantId = 候选生成身份（R2 §7 冻结，本修订不变）；
- materialization transport 不入 fingerprint（R2 §7.1）；
- capability neutral matrix（neutral → supported no-op；非 neutral 无通道 → explicit unsupported，不静默丢弃）；
- `narration_audio_selection_manifest@2.0`（无 master 信息）+ `narration_master_audio@1.0`（masterInputFingerprint 非循环）；
- downstream stale 图（文本/声音/Performance/时长/仅 metadata 区分）；
- Security：API 不输出路径；Web 无 voice/registry 挂载；attempt journal 只存安全投影。

---

## 11. Unresolved decisions（进入 1A 前定）

1. delivery 编译策略（文本改写 vs 显式 unsupported，推荐显式 unsupported）。
2. pace 经 adapter 扩展直传可行性。
3. unit vs sentence 原子单位（推荐 unit）。
4. capability 升级后存量音频失效策略。
5. pronunciation dictionary 是否纳入（建议 C.3 后）。
6. master 拼接实现（Node PCM vs ffmpeg concat，C.4 定）。
7. `tts_synthesis_claims` 与 `tts_jobs` 的 claim/lease 双表实现细节（C.2 定；schema 已冻结）。

## 12. Recommended first implementation stage

**TTS-C.1A**（materialization requests/jobs/projection，止于 `file_ready_unpublished`）——零音频风险、解锁 materialization；随后 1B（legacy shadow + global publisher + adapter reload/activation ack）、1C（capability compiler）；C.2（audio request/claim/job/attempt/immutable artifact）依赖 1A/1B/1C 齐备。
