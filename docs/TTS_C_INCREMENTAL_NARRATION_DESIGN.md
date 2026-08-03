# TTS-C Incremental Narration 架构设计（TTS-C.0.R6 修订，只读审计，未实现）

> 状态：**TTS-C.0.R6 architecture closure completed；pending independent Review PASS；
> TTS-C runtime implementation not started；TTS-C.1A not started**。
> 本文档是只读架构审计产物（R6 修订）：不修改 runtime code / schema / config / migration / compose。
> 运行时真相以真实代码为准（审计基线 m7 @ `7f86322`；TTS-A final code `1460efd…`、TTS-B final code `86f7f52…` 均已 FROZEN）。
> R6 关闭 ChatGPT 独立 Review 对 R5 的 FAIL 发现（全部 docs-only，零 runtime/零 migration/零 schema 变更）：
> ① **tts_jobs legacy downgrade bypass 封死**（`claim_id` 写后不可 NULL/不可换/不可凭空获得：`trg_tts_jobs_immutable`
> 守卫扩为 `OLD.claim_id IS NOT NULL OR NEW.claim_id IS NOT NULL`；TTS-C 行 `running→queued` 永远 ABORT；
> 新增 INSERT/UPDATE validation trigger 强制 TTS-C 身份字段 NOT NULL 并校验 claim 同 project/unit/final fingerprint/variant，
> **NULL 无法绕过 `uq_tts_jobs_active_synthesis`**；claim↔job 双向一致性由 job 侧 + claim 侧 trigger 闭环）；
> ② **attempt 证据 phase-aware、write-once、terminal immutable**（`trg_tga_evidence`：任何已写证据字段不可改写 +
> 终态（succeeded/transport_failed/validation_failed/indeterminate）全部证据字段不可增改删 + 每个证据字段仅允许
> 在其指定 phase 窗口首次写入——`file_durable` 后 `final_relative_path/audio_sha256/output_size/codec/sample_rate/
> channels/ffprobe_duration_ms/response_hash/provider_request_id/usage_record_id` 全部不可改，不限于 phase 转移）；
> ③ **artifact↔attempt 字节证据全闭包**（`trg_saa_provenance` 新增 15 项逐项 `IS` 比较：exact/synthesis fingerprint 与 job、
> output path/SHA/size/codec/sr/ch/duration 与 attempt、provider/model 与 attempt、canonical SHA 与 Voice Revision；
> 内容 hash 一致性在 final success transaction 中列出 exact fenced reread 与逐项比较）；
> ④ **request/claim 终态链接封存**（request `job_id/result_artifact_id` 与 claim `job_id/result_artifact_id` 首次非 NULL 后
> 不可改 + `succeeded` 后 linkage 全冻结；result 链接 trigger 校验 artifact 与 request/claim 的 project/fingerprint/variant
> 一致，unit 经 linked claim 传递；reuse 语义下 `artifact.claim_id`（producing）≠ reuse claim.id 合法，consumer 真相统一为
> `SELECT * FROM tts_audio_requests WHERE result_artifact_id = ?`，不再声称经 producing claim_id 可查全部 reuse consumer）；
> ⑤ **materialization execution identity 完整且不可变**（`voice_materialization_jobs.source_canonical_sha256 /
> adapter_compatibility_key` 升为 NOT NULL 且 write-once，与 exact Voice Revision 的 canonical SHA / adapter key 自洽，
> destination 路径格式 `<pid>/<rid>/reference.wav` 冻结；request 的 `job_id/materialization_id` 链接校验 identity）；
> ⑥ **projection activation evidence 封存**（`voice_materializations` 的 `adapter_compatibility_key` 与
> `published_registry_generation/sha256` write-once：file_ready_unpublished 必 NULL、registry_pending 只能首次写入一次、
> registry_pending→published_usable 必须同 generation/SHA、published_usable 全证据不可变；新 candidate 必须经新的发布
> attempt/state，不得原地覆盖 registry proof）；
> ⑦ **legacy cutover journal 不可变**（`trg_lve_cutover_evidence`：import 字段/speaker_name/reference path 不可变；
> mapped target write-once；candidate evidence 仅允许 T1 fill（mapped_verified→mapping_pending）与 rollback clear
> （mapping_pending→mapped_verified）；`candidate_activated_at` 仅允许 T5 fill；mapped_active 全冻结；旧 owner 不得原地
> 改 candidate evidence；cutover_attempt 不允许回退）；
> ⑧ **lease-expiry fencing 全量补齐**（validation renewal 与 materialization renewal 必须 `AND validation_lease_expires_at >= :now`；
> cutover renewal 与 T5 必须 `AND cutover_lease_expires_at >= :now`；T2/T3/T4 外部副作用前 fenced verify/renew（changes=1）；
> 过期未接管 → 旧 owner 不得 renewal/finalize/新外部副作用，已完成过期 I/O 也不得提交 DB 终局）；
> ⑨ **可执行 SQLite contract 实证**（§2 全部为可直接转 migration 的真实 SQL，已在临时目录 sqlite3 3.45.1 实证：
> schema apply / foreign_key_check（空）/ integrity_check（ok）/ happy path 全链 / **115 项验证：111 项非法 mutation 全部按预期
> ABORT 或 fencing changes=0 + 4 项正向控制（IS-20 consumer 查询 ×3、legacy requeue ×1），FAIL=0**；临时 SQL/DB 不入仓库）。
> R5 的 ① validation finalization fencing ② 可执行 contract ③ relational provenance 闭包 ④ crash-safe cutover ⑤ 状态机冻结
> ⑥ DAG 化 由 R6 继承并强化；R5 被独立 Review 判 FAIL 的 8 项阻断全部关闭。

---

## 0. 本文档是唯一权威 schema contract（R6 起完全可执行）

最终表 9 张：`tts_audio_requests`、`tts_synthesis_claims`、`tts_jobs`（现有表纯增量迁移）、
`tts_generation_attempts`、`sentence_audio_artifacts`、`voice_materialization_requests`、
`voice_materialization_jobs`、`voice_materializations`、`legacy_adapter_voice_entries`。
§2 每个表给出**可直接转成 migration 的完整 SQL**（实施者逐字转写，不得跨历史 commit 拼接、不得改写约束语义）。

**SQLite 执行规则（实证于 sqlite3 3.45.1，临时目录验证，不入仓库）**：

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

---

## 2. 最终 schema（9 表，可执行 contract）

> 以下 SQL 已在临时目录（sqlite3 3.45.1）完整套用 + `PRAGMA foreign_key_check` / `integrity_check` 通过，
> 并经 **111 项非法 mutation 实证**（每项触发预期 CHECK/trigger/FK/UNIQUE 失败或 fencing `changes=0`，FAIL=0）
> + 4 项正向控制（IS-20 reuse consumer 查询 ×3、legacy requeue ×1）——详见 §10.5。验证副本与临时 DB 不入仓库。

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

-- 2) composite provenance FK 父键 + TTS-C active 唯一
CREATE UNIQUE INDEX uq_tts_jobs_id_claim ON tts_jobs (id, claim_id);
CREATE UNIQUE INDEX uq_tts_jobs_active_synthesis
ON tts_jobs (project_id, unit_id, final_tts_input_fingerprint, generation_variant_id)
WHERE status IN ('queued','running','indeterminate');

-- 3) TTS-C 不可变字段 trigger（WHEN 守卫含 OLD 侧：legacy 行双向 NULL 不受影响；
--    TTS-C 行 claim_id 写后不可 NULL、不可换、不可从 legacy 反向获得；身份字段不可改）
CREATE TRIGGER trg_tts_jobs_immutable BEFORE UPDATE ON tts_jobs
WHEN (OLD.claim_id IS NOT NULL OR NEW.claim_id IS NOT NULL) AND (
     OLD.claim_id IS NOT NEW.claim_id
  OR OLD.originating_request_id IS NOT NEW.originating_request_id
  OR OLD.exact_source_fingerprint IS NOT NEW.exact_source_fingerprint
  OR OLD.synthesis_payload_fingerprint IS NOT NEW.synthesis_payload_fingerprint
  OR OLD.final_tts_input_fingerprint IS NOT NEW.final_tts_input_fingerprint
  OR OLD.generation_variant_id IS NOT NEW.generation_variant_id)
BEGIN SELECT RAISE(ABORT,'tts_jobs immutable field'); END;

-- 4) TTS-C 状态机 trigger（守卫含 OLD/NEW 任一侧：legacy 双向 NULL 行 running→queued requeue 仍允许；
--    TTS-C 行 running→queued 永远 ABORT；status+claim_id 联合 downgrade 被 3)+4)+5) 多重拦截）
CREATE TRIGGER trg_tts_jobs_transition BEFORE UPDATE OF status ON tts_jobs
WHEN (OLD.claim_id IS NOT NULL OR NEW.claim_id IS NOT NULL)
  AND OLD.status IS NOT NEW.status AND NOT (
     (OLD.status='queued'        AND NEW.status IN ('running','failed','cancelled'))
  OR (OLD.status='running'       AND NEW.status IN ('succeeded','failed','cancelled','indeterminate'))
  OR (OLD.status='indeterminate' AND NEW.status IN ('succeeded','failed','cancelled')))
BEGIN SELECT RAISE(ABORT,'tts_jobs invalid transition'); END;

-- 5) TTS-C 行 INSERT/UPDATE validation（R6-A：claim_id 指向同 project/unit/final fingerprint/variant 的 claim；
--    身份字段 NULL 一律 ABORT——不得用 NULL 绕过 uq_tts_jobs_active_synthesis；
--    legacy 行（claim_id 双向 NULL）不受影响；legacy→TTS-C 转换被 3)+5) 双拦截）
CREATE TRIGGER trg_tts_jobs_claim_validation BEFORE INSERT ON tts_jobs
WHEN NEW.claim_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'tts_jobs claim identity required')
    WHERE NEW.exact_source_fingerprint IS NULL
       OR NEW.synthesis_payload_fingerprint IS NULL
       OR NEW.final_tts_input_fingerprint IS NULL
       OR NEW.generation_variant_id IS NULL
       OR NEW.project_id IS NULL OR NEW.unit_id IS NULL
       OR NEW.narration_plan_artifact_id IS NULL;
  SELECT RAISE(ABORT,'tts_jobs claim identity mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM tts_synthesis_claims c
                      WHERE c.id=NEW.claim_id
                        AND c.project_id=NEW.project_id
                        AND c.unit_id=NEW.unit_id
                        AND c.final_tts_input_fingerprint=NEW.final_tts_input_fingerprint
                        AND c.generation_variant_id=NEW.generation_variant_id);
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
       OR NEW.narration_plan_artifact_id IS NULL;
  SELECT RAISE(ABORT,'tts_jobs claim identity mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM tts_synthesis_claims c
                      WHERE c.id=NEW.claim_id
                        AND c.project_id=NEW.project_id
                        AND c.unit_id=NEW.unit_id
                        AND c.final_tts_input_fingerprint=NEW.final_tts_input_fingerprint
                        AND c.generation_variant_id=NEW.generation_variant_id);
END;
```

- 现有列保留；`output_path/duration_ms/audio_sha256/result_json` legacy 兼容（TTS-C 不写不读为 authoritative）。
- **TTS-C 行语义（R6-A 冻结）**：`claim_id` 在 INSERT 时写入后**永不可变**（不可 NULL、不可换、legacy 行不可凭空获得）；
  `originating_request_id / exact_source_fingerprint / synthesis_payload_fingerprint / final_tts_input_fingerprint /
  generation_variant_id` 写后不可改；`project_id / unit_id / narration_plan_artifact_id` 必须完整（身份字段 NULL → ABORT）。
- **`claim_id` 与 `tts_synthesis_claims.job_id` 双向一致性（R6-A）**：`job.claim_id = C ⟺ claim(C).job_id = job.id`——
  job 侧由 5) 强制（claim 存在且 identity 一致）；claim 侧由 §2.2 `trg_tsc_job_link`/`trg_tsc_job_link_update` 强制
  （job 存在且 `job.claim_id = claim.id`）。§3.1 不可用 finalize 的顺序（先 INSERT job、后 UPDATE claim 置 job_id）保证双向成立。
- Scheduler 只 claim `status='queued'` 且 `claim.status IN ('generation_pending','running')` 的 job；**`validating_reuse` 阶段无 queued job**。
- 依赖顺序说明：`tts_jobs` 的 `claim_id`/`result_artifact_id` FK 指向后建表——SQLite 允许前向 FK 引用（运行时解析），
  但 migration 应先建新表再执行 §2.0（或同 migration 内先 CREATE 后 ALTER）。

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
  UNIQUE (project_id, request_id),
  CHECK (
       (status='succeeded' AND result_artifact_id IS NOT NULL)
    OR (status IN ('waiting','running','indeterminate') AND result_artifact_id IS NULL)
    OR (status IN ('failed','cancelled') AND result_artifact_id IS NULL))
);
CREATE TRIGGER trg_tar_immutable BEFORE UPDATE ON tts_audio_requests
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.request_id IS NOT NEW.request_id
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
     (OLD.status='waiting' AND NEW.status IN ('running','succeeded','failed','cancelled','indeterminate'))
  OR (OLD.status='running' AND NEW.status IN ('succeeded','failed','cancelled','indeterminate'))
  OR (OLD.status='indeterminate' AND NEW.status IN ('succeeded','failed','cancelled')))
BEGIN SELECT RAISE(ABORT,'tts_audio_requests invalid transition'); END;
CREATE TRIGGER trg_tar_delete_abort BEFORE DELETE ON tts_audio_requests
BEGIN SELECT RAISE(ABORT,'tts_audio_requests delete forbidden'); END;
-- R6-D：result 链接 identity 校验（result artifact 与 request 的 project/exact/synthesis/final fingerprint/variant 一致；
-- unit 经 linked claim 传递校验；reuse 语义下 artifact.claim_id（producing claim）不必等于 request.claim_id——合法）
CREATE TRIGGER trg_tar_result_link BEFORE UPDATE OF result_artifact_id ON tts_audio_requests
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

- `succeeded` 必须带 `result_artifact_id`；`failed/cancelled` **不得伪装成功 result**（CHECK 强制 NULL）。
- **终态链接封存（R6-D）**：`claim_id` / `job_id` / `result_artifact_id` 各自**首次非 NULL 后不可改**；`succeeded` 后
  claim/job/result/status linkage 全部不可改（替换 result / 从 NULL 写入 job / 替换 claim 一律 ABORT——实证见 IS-10/11/11b）。
- **成功链接校验（R6-D）**：`result_artifact_id` 写入时 trigger 校验 artifact 与 request 的
  project/exact/synthesis/final fingerprint/variant 一致；unit 经 linked claim 传递校验（reuse claim 下
  `artifact.claim_id` 是 producing claim，不等于 reuse claim.id 属合法语义，unit/fingerprint 仍必须一致）。
- **authoritative reader**：`getTtsAudioRequestExact(projectId, requestId)`（exact request identity，无 latest fallback）。
- **API redaction**：序列化出口不含任何 path。**legacy compat**：新表，无历史兼容问题。

### 2.2 `tts_synthesis_claims`（唯一 synthesis reservation；可回收；fenced）

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
  owner_token TEXT,
  lease_expires_at TEXT,
  validation_owner_token TEXT,
  validation_lease_expires_at TEXT,
  validation_attempt INTEGER NOT NULL DEFAULT 0,
  candidate_artifact_id TEXT REFERENCES sentence_audio_artifacts(id) ON DELETE RESTRICT,
  candidate_artifact_metadata_hash TEXT,
  validation_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
       (status='validating_reuse'
        AND validation_owner_token IS NOT NULL AND validation_lease_expires_at IS NOT NULL
        AND validation_attempt >= 1 AND validation_started_at IS NOT NULL
        AND owner_token IS NULL AND lease_expires_at IS NULL
        AND job_id IS NULL AND result_artifact_id IS NULL)
    OR (status='generation_pending'
        AND validation_owner_token IS NULL AND validation_lease_expires_at IS NULL
        AND owner_token IS NULL AND lease_expires_at IS NULL
        AND job_id IS NOT NULL AND result_artifact_id IS NULL
        AND candidate_artifact_id IS NULL AND candidate_artifact_metadata_hash IS NULL)
    OR (status='running'
        AND owner_token IS NOT NULL AND lease_expires_at IS NOT NULL
        AND validation_owner_token IS NULL AND validation_lease_expires_at IS NULL
        AND job_id IS NOT NULL AND result_artifact_id IS NULL)
    OR (status='succeeded' AND result_artifact_id IS NOT NULL
        AND owner_token IS NULL AND lease_expires_at IS NULL
        AND validation_owner_token IS NULL AND validation_lease_expires_at IS NULL)
    OR (status IN ('failed','cancelled','indeterminate') AND result_artifact_id IS NULL
        AND owner_token IS NULL AND lease_expires_at IS NULL
        AND validation_owner_token IS NULL AND validation_lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX uq_tts_synthesis_claim_active
ON tts_synthesis_claims (project_id, unit_id, final_tts_input_fingerprint, generation_variant_id)
WHERE status IN ('validating_reuse','generation_pending','running','indeterminate');

CREATE TRIGGER trg_tsc_immutable BEFORE UPDATE ON tts_synthesis_claims
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.unit_id IS NOT NEW.unit_id
  OR OLD.final_tts_input_fingerprint IS NOT NEW.final_tts_input_fingerprint
  OR OLD.generation_variant_id IS NOT NEW.generation_variant_id
  OR (OLD.job_id IS NOT NULL AND OLD.job_id IS NOT NEW.job_id)
  OR (OLD.result_artifact_id IS NOT NULL AND OLD.result_artifact_id IS NOT NEW.result_artifact_id)
  OR (OLD.status='succeeded' AND (
        NEW.job_id IS NOT OLD.job_id
     OR NEW.result_artifact_id IS NOT OLD.result_artifact_id
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
-- R6-A/D：claim.job_id 双向一致性（job 必须存在且 job.claim_id=claim.id；job_id 首次非 NULL 后不可改）
CREATE TRIGGER trg_tsc_job_link BEFORE INSERT ON tts_synthesis_claims
WHEN NEW.job_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'tts_synthesis_claims job link mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM tts_jobs j
                      WHERE j.id=NEW.job_id AND j.claim_id=NEW.id);
END;
CREATE TRIGGER trg_tsc_job_link_update BEFORE UPDATE OF job_id ON tts_synthesis_claims
WHEN NEW.job_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'tts_synthesis_claims job link mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM tts_jobs j
                      WHERE j.id=NEW.job_id AND j.claim_id=NEW.id);
END;
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
    `owner_token/lease_expires_at/job_id/result_artifact_id` 全 NULL；candidate 列可 NULL（无候选 → 直接按 unusable 走 generation_pending）；
  - `generation_pending`：validation owner **必须清空**；Worker owner 必须 NULL（job 尚未被 claim）；`job_id` NOT NULL；candidate 列清空；
  - `running`：Worker `owner_token/lease_expires_at` 有效；validation owner 清空；
  - `succeeded`：`result_artifact_id` NOT NULL；owner/lease/validation 全清；
  - `failed/cancelled/indeterminate`：owner/lease/validation 全清；result NULL。
- **状态机（R5 冻结，消除歧义）**：`validating_reuse → succeeded | generation_pending | cancelled | failed`；
  `generation_pending → running | cancelled | failed`（preflight/job 校验失败 → failed；**不允许 indeterminate**——尚无执行在飞）；
  `running → succeeded | failed | cancelled | indeterminate`；
  `indeterminate → succeeded | failed | cancelled`（显式 resolve，不回 generation_pending/running）。
- **终态链接封存（R6-D）**：`job_id` / `result_artifact_id` 各自**首次非 NULL 后不可改**（含 reuse claim 的 job_id
  保持 NULL 不可事后补写）；`succeeded` 后 job/result/status linkage 全部不可改（实证见 IS-12a/b/c）；
  `job_id` 写入时必须 `job.claim_id = claim.id`（双向一致性，§2.0）。
- **authoritative**：active synthesis identity 唯一真相（partial unique 覆盖 validating/generation_pending/running/indeterminate）。

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

### 2.5 `voice_materialization_requests`（project-scoped envelope）

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
    ('waiting','running','succeeded','reused','failed','cancelled','indeterminate')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, request_id),
  CHECK (
       (status IN ('succeeded','reused') AND materialization_id IS NOT NULL)
    OR (status IN ('waiting','running','failed','cancelled','indeterminate')
        AND materialization_id IS NULL))
);
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
     (OLD.status='waiting' AND NEW.status IN ('running','succeeded','reused','failed','cancelled','indeterminate'))
  OR (OLD.status='running' AND NEW.status IN ('succeeded','failed','cancelled','indeterminate'))
  OR (OLD.status='indeterminate' AND NEW.status IN ('succeeded','failed','cancelled')))
BEGIN SELECT RAISE(ABORT,'voice_materialization_requests invalid transition'); END;
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
- **终态语义（R5 冻结，禁止混写）**：existing projection 复用 → **`reused`**（`waiting → reused`，无 running）；
  新复制成功 → **`succeeded`**（`waiting/running → succeeded`，共享 job fan-out 时 envelope 可从 waiting 直接 succeeded）；
  两者都必须带 `materialization_id`；`failed/cancelled` 不得带 `materialization_id`（CHECK 强制，不得伪装成功）；
- **链接封存（R6-E）**：`job_id` / `materialization_id` 各自**首次非 NULL 后不可改**；`succeeded/reused` 终态
  job/materialization/status linkage 不可改；`job_id` 写入时 job 的 profile/revision 必须与 request 一致，
  `materialization_id` 写入时 projection 的 profile/revision 必须与 request 一致（identity link trigger）。
- Assignment artifact 必须属于同一 `project_id` 且 kind=`project_voice_assignment`（FK + pair trigger 双强制）。

### 2.6 `voice_materialization_jobs`（mutable Worker execution；fenced single-flight）

```sql
CREATE TABLE voice_materialization_jobs (
  id TEXT PRIMARY KEY,
  voice_profile_id TEXT NOT NULL REFERENCES voice_profiles(id) ON DELETE RESTRICT,
  voice_profile_revision_id TEXT NOT NULL REFERENCES voice_profile_revisions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN
    ('validating_existing','queued','running','succeeded','failed','cancelled','indeterminate')),
  owner_token TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  validation_owner_token TEXT,
  validation_lease_expires_at TEXT,
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
        AND validation_owner_token IS NOT NULL AND validation_lease_expires_at IS NOT NULL
        AND validation_attempt >= 1
        AND owner_token IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL)
    OR (status='queued'
        AND validation_owner_token IS NULL AND validation_lease_expires_at IS NULL
        AND owner_token IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL)
    OR (status='running'
        AND owner_token IS NOT NULL AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL
        AND validation_owner_token IS NULL AND validation_lease_expires_at IS NULL)
    OR (status IN ('succeeded','failed','cancelled','indeterminate')
        AND owner_token IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL
        AND validation_owner_token IS NULL AND validation_lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX uq_voice_materialization_jobs_active
ON voice_materialization_jobs (voice_profile_id, voice_profile_revision_id)
WHERE status IN ('validating_existing','queued','running','indeterminate');

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
    ('file_ready_unpublished','registry_pending','published_usable','failed','indeterminate')),
  published_registry_generation INTEGER,
  published_registry_sha256 TEXT CHECK (published_registry_sha256 IS NULL OR
    (length(published_registry_sha256)=64 AND published_registry_sha256 NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (voice_profile_id, voice_profile_revision_id),
  CHECK (
       (status='file_ready_unpublished'
        AND published_registry_generation IS NULL AND published_registry_sha256 IS NULL)
    OR (status IN ('registry_pending','published_usable')
        AND published_registry_generation IS NOT NULL AND published_registry_sha256 IS NOT NULL)
    OR (status IN ('failed','indeterminate')))
);
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
-- R6-F：execution identity + registry proof write-once；published_usable 全证据冻结
CREATE TRIGGER trg_vmat_immutable BEFORE UPDATE ON voice_materializations
WHEN OLD.voice_profile_id IS NOT NEW.voice_profile_id
  OR OLD.voice_profile_revision_id IS NOT NEW.voice_profile_revision_id
  OR OLD.source_canonical_sha256 IS NOT NEW.source_canonical_sha256
  OR OLD.destination_voice_root_relative_path IS NOT NEW.destination_voice_root_relative_path
  OR OLD.adapter_compatibility_key IS NOT NEW.adapter_compatibility_key
  OR (OLD.published_registry_generation IS NOT NULL AND NEW.published_registry_generation IS NOT OLD.published_registry_generation)
  OR (OLD.published_registry_sha256 IS NOT NULL AND NEW.published_registry_sha256 IS NOT OLD.published_registry_sha256)
  OR (OLD.status='published_usable' AND (
        NEW.source_canonical_sha256 IS NOT OLD.source_canonical_sha256
     OR NEW.adapter_compatibility_key IS NOT OLD.adapter_compatibility_key
     OR NEW.destination_voice_root_relative_path IS NOT OLD.destination_voice_root_relative_path
     OR NEW.published_registry_generation IS NOT OLD.published_registry_generation
     OR NEW.published_registry_sha256 IS NOT OLD.published_registry_sha256))
BEGIN SELECT RAISE(ABORT,'voice_materializations immutable field'); END;
CREATE TRIGGER trg_vmat_transition BEFORE UPDATE OF status ON voice_materializations
WHEN OLD.status IS NOT NEW.status AND NOT (
     (OLD.status='file_ready_unpublished' AND NEW.status IN ('registry_pending','failed','indeterminate'))
  OR (OLD.status='registry_pending'       AND NEW.status IN ('published_usable','failed','indeterminate'))
  OR (OLD.status='failed'                 AND NEW.status IN ('file_ready_unpublished'))
  OR (OLD.status='indeterminate'          AND NEW.status IN ('file_ready_unpublished','failed')))
BEGIN SELECT RAISE(ABORT,'voice_materializations invalid transition'); END;
CREATE TRIGGER trg_vmat_delete_abort BEFORE DELETE ON voice_materializations
BEGIN SELECT RAISE(ABORT,'voice_materializations delete forbidden'); END;
```

- **状态机（R5 冻结）**：`file_ready_unpublished → registry_pending | failed | indeterminate`；
  `registry_pending → published_usable | failed | indeterminate`；
  **`published_usable` 不可逆（trigger 无任何出边）——不再允许 `* → failed/indeterminate` 模糊写法**；
  repair 路径：`failed → file_ready_unpublished`（新 materialization job 重新复制成功后 fenced 修复）；
  `indeterminate → file_ready_unpublished | failed`（exact 重验后显式 resolve）；
- **activation evidence 封存（R6-F）**：`adapter_compatibility_key` 与 `published_registry_generation` /
  `published_registry_sha256` 全部 write-once——
  `file_ready_unpublished` 的 registry evidence 必须 NULL（CHECK）；
  `file_ready_unpublished → registry_pending` 只允许**首次写入一次** generation/SHA；
  `registry_pending` 内不得原地换成另一个 candidate（generation/SHA 改写 → ABORT）；
  `registry_pending → published_usable` 必须使用**相同** generation/SHA（write-once + T5 fenced WHERE 双保险）；
  `published_usable` 后 profile/revision/source SHA/path/compatibility/generation/SHA **全部不可变**。
  **任何新 candidate 必须经过新的、明确的发布 attempt/state（新 generation 的 registry_pending 流程），
  不得直接覆盖已有 registry proof**（实证 IS-14a/b/c/d）。
- **published_usable 的文件损坏 repair**：不转移状态——新 materialization job 的 validator 比对 DB 证据与文件，
  按 immutable source revision 重新复制恢复 exact SHA（DB 行与 registry 证据不变，SHA 由 immutable source 决定）；
- `registry_pending`/`published_usable` 必须有 `published_registry_generation + published_registry_sha256` 证据（CHECK 强制）；
- 目标路径固定 `<voice_profile_id>/<voice_profile_revision_id>/reference.wav`（voice-root-relative；pair trigger 冻结）；DELETE 禁。

### 2.8 `legacy_adapter_voice_entries`（legacy shadow；crash-safe cutover）

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
  mapped_voice_materialization_id TEXT REFERENCES voice_materializations(id) ON DELETE SET NULL,
  retired_at TEXT,
  cutover_owner_token TEXT,
  cutover_lease_expires_at TEXT,
  cutover_attempt INTEGER NOT NULL DEFAULT 0,
  candidate_registry_generation INTEGER,
  candidate_registry_sha256 TEXT CHECK (candidate_registry_sha256 IS NULL OR
    (length(candidate_registry_sha256)=64 AND candidate_registry_sha256 NOT GLOB '*[^0-9a-f]*')),
  candidate_source_selector TEXT CHECK (candidate_source_selector IS NULL OR
    candidate_source_selector IN ('legacy','tts_a')),
  candidate_created_at TEXT,
  candidate_activated_at TEXT,
  UNIQUE (voice_profile_key, voice_revision_key),
  CHECK (
       (mapping_status='unmapped'
        AND retired_at IS NULL AND mapped_voice_materialization_id IS NULL
        AND cutover_owner_token IS NULL AND cutover_lease_expires_at IS NULL
        AND candidate_registry_generation IS NULL AND candidate_registry_sha256 IS NULL
        AND candidate_source_selector IS NULL AND candidate_created_at IS NULL
        AND candidate_activated_at IS NULL)
    OR (mapping_status='mapped_verified'
        AND retired_at IS NULL AND mapped_voice_materialization_id IS NOT NULL
        AND cutover_owner_token IS NULL AND cutover_lease_expires_at IS NULL
        AND candidate_registry_generation IS NULL AND candidate_registry_sha256 IS NULL
        AND candidate_source_selector IS NULL AND candidate_created_at IS NULL
        AND candidate_activated_at IS NULL)
    OR (mapping_status='mapping_pending'
        AND retired_at IS NULL AND mapped_voice_materialization_id IS NOT NULL
        AND cutover_owner_token IS NOT NULL AND cutover_lease_expires_at IS NOT NULL
        AND cutover_attempt >= 1
        AND candidate_registry_generation IS NOT NULL AND candidate_registry_sha256 IS NOT NULL
        AND candidate_source_selector='tts_a' AND candidate_created_at IS NOT NULL
        AND candidate_activated_at IS NULL)
    OR (mapping_status='mapped_active'
        AND retired_at IS NULL AND mapped_voice_materialization_id IS NOT NULL
        AND candidate_registry_generation IS NOT NULL AND candidate_registry_sha256 IS NOT NULL
        AND candidate_source_selector='tts_a' AND candidate_created_at IS NOT NULL
        AND candidate_activated_at IS NOT NULL
        AND cutover_owner_token IS NULL AND cutover_lease_expires_at IS NULL)
    OR (mapping_status='retired'
        AND retired_at IS NOT NULL
        AND cutover_owner_token IS NULL AND cutover_lease_expires_at IS NULL))
);
CREATE TRIGGER trg_lve_immutable BEFORE UPDATE ON legacy_adapter_voice_entries
WHEN OLD.voice_profile_key IS NOT NEW.voice_profile_key
  OR OLD.voice_revision_key IS NOT NEW.voice_revision_key
  OR OLD.speaker_name IS NOT NEW.speaker_name
  OR OLD.reference_asset_path_or_safe_projection IS NOT NEW.reference_asset_path_or_safe_projection
  OR OLD.reference_sha256 IS NOT NEW.reference_sha256
  OR OLD.source_registry_sha256 IS NOT NEW.source_registry_sha256
  OR OLD.imported_at IS NOT NEW.imported_at
  OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT OLD.retired_at)
BEGIN SELECT RAISE(ABORT,'legacy_adapter_voice_entries immutable field'); END;
CREATE TRIGGER trg_lve_transition BEFORE UPDATE OF mapping_status ON legacy_adapter_voice_entries
WHEN OLD.mapping_status IS NOT NEW.mapping_status AND NOT (
     (OLD.mapping_status='unmapped'        AND NEW.mapping_status IN ('mapped_verified','retired'))
  OR (OLD.mapping_status='mapped_verified' AND NEW.mapping_status IN ('mapping_pending','retired'))
  OR (OLD.mapping_status='mapping_pending' AND NEW.mapping_status IN ('mapped_active','mapped_verified'))
  OR (OLD.mapping_status='mapped_active'   AND NEW.mapping_status IN ('retired')))
BEGIN SELECT RAISE(ABORT,'legacy_adapter_voice_entries invalid transition'); END;
CREATE TRIGGER trg_lve_delete_abort BEFORE DELETE ON legacy_adapter_voice_entries
BEGIN SELECT RAISE(ABORT,'legacy_adapter_voice_entries delete forbidden'); END;
-- R6-G：cutover journal 不可变（mapped target write-once；candidate evidence 仅允许
-- T1 fill（mapped_verified→mapping_pending）与 rollback clear（mapping_pending→mapped_verified）；
-- candidate_activated_at 仅允许 T5 fill（mapping_pending→mapped_active）；mapped_active 全冻结；
-- 旧 owner 不得原地改 candidate evidence；cutover_attempt 不允许回退）
CREATE TRIGGER trg_lve_cutover_evidence BEFORE UPDATE ON legacy_adapter_voice_entries
WHEN (
  -- mapped target write-once（一旦 set 不可换/不可清）
  (OLD.mapped_voice_materialization_id IS NOT NULL
   AND NEW.mapped_voice_materialization_id IS NOT OLD.mapped_voice_materialization_id)
  -- candidate evidence write-once：非 T1 fill / 非 rollback clear 的任意增改删一律 ABORT
  OR NOT (OLD.mapping_status='mapped_verified' AND NEW.mapping_status='mapping_pending')
     AND NOT (OLD.mapping_status='mapping_pending' AND NEW.mapping_status='mapped_verified')
     AND (
        (OLD.candidate_registry_generation IS NOT NULL AND NEW.candidate_registry_generation IS NOT OLD.candidate_registry_generation)
     OR (OLD.candidate_registry_sha256 IS NOT NULL AND NEW.candidate_registry_sha256 IS NOT OLD.candidate_registry_sha256)
     OR (OLD.candidate_source_selector IS NOT NULL AND NEW.candidate_source_selector IS NOT OLD.candidate_source_selector)
     OR (OLD.candidate_created_at IS NOT NULL AND NEW.candidate_created_at IS NOT OLD.candidate_created_at)
     OR (NEW.candidate_registry_generation IS NOT NULL AND OLD.candidate_registry_generation IS NULL)
     OR (NEW.candidate_registry_sha256 IS NOT NULL AND OLD.candidate_registry_sha256 IS NULL)
     OR (NEW.candidate_source_selector IS NOT NULL AND OLD.candidate_source_selector IS NULL)
     OR (NEW.candidate_created_at IS NOT NULL AND OLD.candidate_created_at IS NULL)
     )
  -- candidate_activated_at：仅允许 T5 fill（mapping_pending→mapped_active）与 rollback clear
  OR (NEW.candidate_activated_at IS NOT OLD.candidate_activated_at
      AND NOT (OLD.mapping_status='mapping_pending'
               AND NEW.mapping_status IN ('mapped_active','mapped_verified')))
  -- cutover_attempt 不允许回退
  OR NEW.cutover_attempt < OLD.cutover_attempt
  -- mapped_active 终态：mapping target 与全部 candidate evidence 冻结
  OR (OLD.mapping_status='mapped_active' AND (
        NEW.mapped_voice_materialization_id IS NOT OLD.mapped_voice_materialization_id
     OR NEW.candidate_registry_generation IS NOT OLD.candidate_registry_generation
     OR NEW.candidate_registry_sha256 IS NOT OLD.candidate_registry_sha256
     OR NEW.candidate_source_selector IS NOT OLD.candidate_source_selector
     OR NEW.candidate_created_at IS NOT OLD.candidate_created_at
     OR NEW.candidate_activated_at IS NOT OLD.candidate_activated_at))
)
BEGIN SELECT RAISE(ABORT,'legacy_adapter_voice_entries cutover evidence immutable'); END;
```

- **cutover 列（R5 新增，保持 9 表）**：candidate 意图与证据按 key 持久化在本行
  （`cutover_owner_token/cutover_lease_expires_at/cutover_attempt/candidate_registry_generation/
  candidate_registry_sha256/candidate_source_selector/candidate_created_at/candidate_activated_at`）；
- **mapping 状态机（R5 冻结）**：`unmapped → mapped_verified | retired`；
  `mapped_verified → mapping_pending | retired`；
  `mapping_pending → mapped_active | mapped_verified`（candidate 失败/过期 → 清证据回退，允许安全重试）；
  `mapped_active → retired`；`retired` 终态；
- **journal 字段写入权限（R6-G 冻结，`trg_lve_cutover_evidence` 逐状态强制）**：
  `speaker_name` / `reference_asset_path_or_safe_projection` 等 import 字段**一旦导入不可变**（immutable trigger）；
  `mapped_voice_materialization_id` **write-once**（一旦 set 不可换/不可清）；
  以下字段只允许在冻结的唯一状态转换中写入：

  | 转换 | 允许写入 |
  |---|---|
  | `unmapped → mapped_verified` | `mapped_voice_materialization_id`（首次） |
  | `mapped_verified → mapping_pending`（T1） | `cutover_owner_token/lease/attempt` + candidate generation/SHA/selector/created_at（首次） |
  | `mapping_pending → mapped_verified`（rollback） | 清理本次 candidate evidence + owner/lease |
  | `mapping_pending → mapped_active`（T5） | 仅 `candidate_activated_at`（保留其余 candidate evidence 不变） |
  | `mapped_active`（同状态/终态） | mapping target 与 candidate evidence 全不可变 |

  任何非上述转换的 candidate evidence 增改删（含 **mapping_pending 内旧 owner 原地改写**、mapped_active 内修改）
  一律 ABORT（实证 IS-15a/b/c/d/e/f/g/h）；`cutover_attempt` 不允许回退（takeover CAS 的 attempt+1 仍允许）。
- `mapped_active` 必须有 `mapped_voice_materialization_id` + candidate 证据 + `candidate_activated_at`（CHECK 强制）；
  `retired` 必须有 `retired_at`；非 retired 的 `retired_at` 必须 NULL；`retired_at` write-once；
- 不伪造 TTS-A 数据（不写 voice_profiles/revisions）；DELETE 禁（append-only provenance）。

---

## 3. Validation finalization fencing（`tts_synthesis_claims`，R5 修复）

### 3.1 fenced finalization contract（冻结旧 validator 无法提交）

validator 在事务外完成 exact artifact reader（`validateSentenceAudioArtifactExact`）后，
Phase 3 必须在**同一 `BEGIN IMMEDIATE`** 中先 fencing 重读、再单条 fenced UPDATE 完成终局。
重读项与 `UPDATE ... WHERE`  fencing 条件**逐项相同**：

```text
status == 'validating_reuse'
validation_owner_token == 本 validator token
validation_attempt == 本次 attempt
validation_lease_expires_at >= 事务 now
candidate_artifact_id IS 本次 candidate（NULL 用 IS）
candidate_artifact_metadata_hash IS 本次读取的 metadata hash（NULL 用 IS）
```

**usable（reuse → succeeded，不建 job）**：

```sql
UPDATE tts_synthesis_claims
SET status='succeeded', result_artifact_id=:artifact_id,
    validation_owner_token=NULL, validation_lease_expires_at=NULL,
    candidate_artifact_id=NULL, candidate_artifact_metadata_hash=NULL,
    updated_at=:now
WHERE id=:claim_id AND status='validating_reuse'
  AND validation_owner_token=:token AND validation_attempt=:attempt
  AND validation_lease_expires_at >= :now
  AND candidate_artifact_id IS :candidate_artifact_id
  AND candidate_artifact_metadata_hash IS :candidate_metadata_hash;
-- changes=1 必须；同事务内随后 fan-out 全部未取消 subscriber（§4）
```

**unusable（→ generation_pending + 恰好一个 queued job）**：

```sql
-- 同事务内先 INSERT tts_jobs（status='queued', claim_id=:claim_id, 冻结指纹/variant），再：
UPDATE tts_synthesis_claims
SET status='generation_pending', job_id=:job_id,
    validation_owner_token=NULL, validation_lease_expires_at=NULL,
    candidate_artifact_id=NULL, candidate_artifact_metadata_hash=NULL,
    updated_at=:now
WHERE id=:claim_id AND status='validating_reuse'
  AND validation_owner_token=:token AND validation_attempt=:attempt
  AND validation_lease_expires_at >= :now
  AND candidate_artifact_id IS :candidate_artifact_id
  AND candidate_artifact_metadata_hash IS :candidate_metadata_hash;
-- changes=1 必须
```

**零 subscriber（→ cancelled，无 job）**：同 WHERE 的 fenced UPDATE 置 `status='cancelled'` 并清空
validation owner/lease + candidate 列（`changes=1` 必须）。

**`changes=0` → 返回 `STALE_VALIDATION_OWNER`，整事务回滚**：不修改 claim/job/request/projection、
不创建 queued job、不 fan-out、不复用 artifact、不写文件（事务外 I/O 结果全部丢弃）。

### 3.2 Takeover CAS（lease 过期接管）

```sql
UPDATE tts_synthesis_claims
SET validation_owner_token=:new_token,
    validation_lease_expires_at=:now_plus_lease,
    validation_attempt=validation_attempt+1,
    validation_started_at=:now
WHERE id=:claim_id AND status='validating_reuse'
  AND validation_lease_expires_at < :now;
-- changes=1 才取得接管权；changes=0 → 未过期/已被并发接管/已终态 → 不接管
```

接管后新 validator 重新执行 exact artifact reader（不调用 provider）。
candidate 已删除 / metadata 漂移 / reader 失败 → 按 unusable 处理（不 fallback latest/default）。

### 3.3 Lease renewal（仅当前 owner 可续租；R6-H：必须 `validation_lease_expires_at >= :now`）

```sql
UPDATE tts_synthesis_claims
SET validation_lease_expires_at=:now_plus_lease, updated_at=:now
WHERE id=:claim_id AND status='validating_reuse'
  AND validation_owner_token=:token AND validation_attempt=:attempt
  AND validation_lease_expires_at >= :now;
-- 旧 owner / 错误 attempt / lease 已过期（未接管）→ changes=0（续租失败，零副作用）
```

**过期-未接管状态（R6-H 冻结）**：`validation_lease_expires_at < :now` 且尚未被 takeover CAS 接管时，
旧 owner **不得 renewal**（WHERE 含 `>= :now` → changes=0）、**不得 finalize**（§3.1 WHERE 已含 `>= :now` →
changes=0 → `STALE_VALIDATION_OWNER`）、**不得执行新的外部副作用**；旧 owner 即使完成了过期期间的外部 I/O
（artifact reader / 文件校验），也不得提交数据库终局（fenced UPDATE 全部不命中）。实证 IS-16/IS-16e。

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
有 subscriber + unusable → claim=generation_pending + 恰好一个 queued job
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

---

## 4. Validating 阶段取消语义与 zero-subscriber race（R5 冻结）

Phase 3 fenced 重读在同一事务内统计 active subscriber（`status IN ('waiting','running')`）：

```text
active subscriber = 0 → claim cancelled（fenced UPDATE §3.1）+ 不创建 tts_job + 释放 active unique
active subscriber > 0 + usable → succeeded + fan-out（同事务 UPDATE 全部未取消 envelope）
active subscriber > 0 + unusable → generation_pending + 恰好一个 queued job
```

规则：

- 单 request cancel 仅取消该 envelope（`tts_audio_requests.status='cancelled'`，同事务检查）；
- **最后 subscriber 在 validating_reuse 阶段取消 → 直接取消 claim**（无 job 存在，不置 cancel_requested）；
- **最后 subscriber 在 generation_pending/running 阶段取消 → 才设置 `job.cancel_requested=1`**；
- validator finalize 与最后 cancel 竞争由事务串行裁决（§3.4）：cancel 优先——finalize 事务重读时
  active subscriber=0 → 不 reused、不建 job、claim cancelled；
- **不允许创建 zero-subscriber provider job**。

---

## 5. Materialization 真正 single-flight + fencing（`voice_materialization_jobs`，R5 修复）

### 5.1 fenced finalization contract（与 §3.1 对称）

`validating_existing` 的 Phase 3 在同一 `BEGIN IMMEDIATE` 内 fencing 重读 +
单条 fenced UPDATE（`changes=1` 必须；`changes=0` → `STALE_VALIDATION_OWNER` 整事务回滚，零文件写）：

```text
status == 'validating_existing'
validation_owner_token == 本 validator token
validation_attempt == 本次 attempt
validation_lease_expires_at >= 事务 now
candidate_materialization_id IS 本次 candidate（NULL 用 IS）
candidate_materialization_metadata_hash IS 本次读取的 metadata hash（NULL 用 IS）
```

```sql
-- usable（existing projection 可用 → succeeded + 全部未取消 request reused，零文件写）：
UPDATE voice_materialization_jobs
SET status='succeeded',
    validation_owner_token=NULL, validation_lease_expires_at=NULL,
    candidate_materialization_id=NULL, candidate_materialization_metadata_hash=NULL,
    updated_at=:now
WHERE id=:job_id AND status='validating_existing'
  AND validation_owner_token=:token AND validation_attempt=:attempt
  AND validation_lease_expires_at >= :now
  AND candidate_materialization_id IS :candidate_id
  AND candidate_materialization_metadata_hash IS :candidate_hash;
-- changes=1 必须；同事务：UPDATE requests SET status='reused', materialization_id=:mid
--   WHERE job_id=:job_id AND status IN ('waiting','running')

-- unusable + 有 subscriber（→ queued，Scheduler 才可见）：
UPDATE voice_materialization_jobs
SET status='queued',
    validation_owner_token=NULL, validation_lease_expires_at=NULL,
    candidate_materialization_id=NULL, candidate_materialization_metadata_hash=NULL,
    updated_at=:now
WHERE id=:job_id AND status='validating_existing'
  AND validation_owner_token=:token AND validation_attempt=:attempt
  AND validation_lease_expires_at >= :now
  AND candidate_materialization_id IS :candidate_id
  AND candidate_materialization_metadata_hash IS :candidate_hash;
-- changes=1 必须

-- 零 subscriber（→ cancelled，释放 active unique）：同 WHERE 置 status='cancelled'
```

Takeover CAS 与 §3.2 同构（同表同列，`validating_existing`）：

```sql
UPDATE voice_materialization_jobs
SET validation_owner_token=:new_token,
    validation_lease_expires_at=:now_plus_lease,
    validation_attempt=validation_attempt+1
WHERE id=:job_id AND status='validating_existing'
  AND validation_lease_expires_at < :now;
-- changes=1 才取得接管权；changes=0 → 未过期/已被接管/已终态 → 不接管
```

Lease renewal（R6-H：必须 `validation_lease_expires_at >= :now`）：

```sql
UPDATE voice_materialization_jobs
SET validation_lease_expires_at=:now_plus_lease, updated_at=:now
WHERE id=:job_id AND status='validating_existing'
  AND validation_owner_token=:token AND validation_attempt=:attempt
  AND validation_lease_expires_at >= :now;
-- 旧 owner / 错误 attempt / lease 已过期（未接管）→ changes=0（续租失败，零副作用）
```

过期-未接管状态与 §3.3 相同（R6-H）：旧 validator 不得 renewal / 不得 fenced finalize（§5.1 WHERE 已含
`>= :now` → changes=0 → `STALE_VALIDATION_OWNER`）/ 不得执行新的外部副作用；过期 I/O 结果不得提交 DB 终局。
实证 IS-17/IS-17d。

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

## 7. Legacy stable/candidate source model + crash-safe cutover protocol（R5 修复）

### 7.1 双 view 分离（消除 R4 矛盾）

```text
stable emitted registry view（adapter 当前加载的 registry 重建源）：
  mapping_status = unmapped / mapped_verified / mapping_pending → legacy entry
  mapping_status = mapped_active                                → TTS-A voice_materialization
  mapping_status = retired                                      → 不输出

candidate registry view（cutover 期间 publisher 构建的候选）：
  与 stable 完全相同，仅对 cutover 中的 exact key
  （mapping_status='mapping_pending' 且 candidate_source_selector='tts_a'）
  改用 TTS-A voice_materialization
```

- **`mapping_pending` 不再是"普通 registry 仍按 legacy"的模糊态**：它持久化了 candidate 意图
  （`candidate_registry_generation/candidate_registry_sha256/candidate_source_selector/candidate_created_at`）
  与 cutover 所有权（`cutover_owner_token/cutover_lease_expires_at/cutover_attempt`）；
  stable view 仍输出 legacy（旧 voice 不丢），candidate view 对该 key 使用 TTS-A；
- **每个 canonical key 在任一 registry（stable 或 candidate）中恰好一个 source**：
  由 `UNIQUE(voice_profile_key, voice_revision_key)` + 单 publisher 全局锁 + 上表确定性选择规则共同保证
  （冲突 = 构建失败 fail-closed，不写文件）；
- **保持 9 表的论证**：candidate 意图/证据是 per-key 状态（存于本行）；publisher 的全量重建对 DB 状态确定；
  adapter active SHA 可经 /health 查询；磁盘 registry SHA 可重算——恢复不需要独立 durable journal，
  第 10 张表不可替代性不成立（见 §7.4 恢复算法覆盖全部 crash 点）。禁止用进程内状态伪装闭环。

### 7.2 Mapping 等价性（`unmapped → mapped_verified` 前置，沿用 R4）

canonical voice key、reference SHA-256、speaker identity/name policy、adapter compatibility key、
reference file containment、codec/sample-rate/channels——全项一致才允许 mapped_verified
（同事务设置 `mapped_voice_materialization_id`）。

### 7.3 Crash-safe cutover 协议（顺序冻结；R6-H 补 lease fencing）

```text
T1 BEGIN IMMEDIATE：mapped_verified → mapping_pending
   （持久化 cutover owner/lease/attempt + candidate_registry_generation（单调递增）
     + candidate_registry_sha256 + candidate_source_selector='tts_a' + candidate_created_at；
     candidate SHA 由确定性构建算法在写入前计算——先构建内存镜像、算 SHA、再持久化意图）
T1.5 fenced verify/renew lease（每个外部副作用步骤前必须，R6-H）：
   UPDATE legacy_adapter_voice_entries
   SET cutover_lease_expires_at=:now_plus_lease
   WHERE id=:id AND mapping_status='mapping_pending'
     AND cutover_owner_token=:token AND cutover_attempt=:attempt
     AND cutover_lease_expires_at >= :now;
   -- changes=1 必须；changes=0（过期未接管 / 已被接管 / 旧 owner）→ 立即停止，不执行 T2/T3/T4 任何外部副作用
T2 publisher 写 candidate registry：temp 写 → fsync → rename → dir fsync（全局发布锁；仅 T1.5 changes=1 的当前 owner 可执行）
T3 adapter reload（mtime/inode/size 检测 → 原子加载 → swap；失败保持 LKG；仅当前 owner 可执行）
T4 poll /health：activeRegistrySha256 == persisted candidate_registry_sha256（仅当前 owner 可执行）
T5 BEGIN IMMEDIATE（fenced；R6-H 含 `cutover_lease_expires_at >= :now`）：
   UPDATE legacy_adapter_voice_entries
   SET mapping_status='mapped_active', cutover_owner_token=NULL, cutover_lease_expires_at=NULL,
       candidate_activated_at=:now
   WHERE id=:id AND mapping_status='mapping_pending'
     AND cutover_owner_token=:token AND cutover_attempt=:attempt
     AND cutover_lease_expires_at >= :now
     AND candidate_registry_sha256=:observed_active_sha
     AND mapped_voice_materialization_id=:materialization_id;
   -- changes=1 必须
   UPDATE voice_materializations
   SET status='published_usable', updated_at=:now
   WHERE id=:materialization_id AND status='registry_pending'
     AND published_registry_generation=:generation
     AND published_registry_sha256=:observed_active_sha;
   -- changes=1 必须；任一 changes=0 → 整事务回滚，按 §7.4 case 3/5 处理
COMMIT
```

（projection 在 T1 前已由 publish 流程置 `registry_pending` + generation/SHA 证据。）

**Cutover lease renewal（R6-H；仅当前 owner 可续租）**：

```sql
UPDATE legacy_adapter_voice_entries
SET cutover_lease_expires_at=:now_plus_lease
WHERE id=:id AND mapping_status='mapping_pending'
  AND cutover_owner_token=:token AND cutover_attempt=:attempt
  AND cutover_lease_expires_at >= :now;
-- 旧 owner / 错误 attempt / 过期未接管 → changes=0（续租失败，零副作用）
```

**stale owner external-side-effect 规则（R6-H 冻结）**：lease 已过期但尚未 takeover → 旧 owner 不得 renewal
（changes=0）、不得执行 T2/T3/T4 任何新的外部副作用（registry 写 / adapter reload / health poll）、不得 T5
finalize（WHERE 含 `>= :now` → changes=0）；旧 owner 即使完成了过期期间的 registry 写 / reload / poll I/O，
也不得提交数据库终局（T5 双 changes=1 全部不命中）。实证 IS-18/IS-19/IS-19c。

### 7.4 Crash reconciliation（publisher/Worker 启动或接管时执行；6 点矩阵）

```text
case 1  candidate intent 已持久化，registry 尚未写：
        磁盘 registry SHA != candidate SHA 且 adapter active == stable SHA
        → 重新确定性构建同一 candidate（同 DB 状态 → 同 SHA）→ 续 T2；或清证据回退 mapped_verified 安全重试。
case 2  registry durable，adapter 尚未 reload：
        磁盘 registry SHA == persisted candidate SHA、active SHA == stable SHA
        → 触发 reload，续 T3；不重建、不改 DB。
case 3  adapter active SHA == persisted candidate SHA，DB 尚未 mapped_active：
        → 直接执行 T5 fenced 事务（幂等；changes=1 才生效）。
case 4  T5 事务已提交：
        → 无需动作（mapped_active + published_usable 已持久；重启幂等）。
case 5  candidate reload 失败，adapter 保持 LKG（active SHA != candidate SHA）：
        → stable legacy 不丢（stable view 未变）；projection 保持 registry_pending；
          保留 candidate 证据按指数退避重试 T3，或清证据回退 mapped_verified 后重试 T1。
case 6  cutover owner lease 过期：
        → 新 owner fenced CAS 接管：
          UPDATE legacy_adapter_voice_entries
          SET cutover_owner_token=:new_token, cutover_lease_expires_at=:now_plus_lease,
              cutover_attempt=cutover_attempt+1
          WHERE id=:id AND mapping_status='mapping_pending'
            AND cutover_lease_expires_at < :now;
          -- changes=1 才接管；接管后按 case 1-5 重估继续；
          -- 旧 owner 的 renewal / T2-T4 外部副作用 / T5 finalize 全部 changes=0（R6-H，见 §7.3）
```

**crash reconciliation 期间的 lease 纪律（R6-H）**：publisher/Worker 在 case 1-5 的每个外部副作用步骤
（重建 candidate registry / 触发 reload / poll health）前都必须执行 T1.5 fenced verify/renew（changes=1），
否则立即停止；恢复流程不得假设旧 owner 的 lease 仍有效。

**fail-closed 规则**：active SHA 既不等于 persisted candidate SHA 也不等于 stable SHA（未知 SHA），
或 candidate 证据自相矛盾（generation/SHA/selector 不一致）→
**不 retire legacy、不标 published_usable、不修改任何状态**，仅上报 `CUTOVER_STATE_UNKNOWN` 等待人工裁决。

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
5. job → succeeded + result_artifact_id（fenced WHERE status='running'；changes=1 必须；清 claimed_by/claimed_at/heartbeat_at）
6. claim → succeeded + result_artifact_id（fenced WHERE status='running'；changes=1 必须；清 owner_token/lease_expires_at）
7. 全部未取消 request → succeeded + result_artifact_id
   （UPDATE tts_audio_requests SET status='succeeded', result_artifact_id=?
     WHERE claim_id=? AND status IN ('waiting','running')；result-link trigger 校验 identity）
COMMIT
```

任何一步失败（含 trigger ABORT / FK / CHECK / changes=0）→ **整事务回滚，attempt 恢复到 file_durable**；
文件按 exact identity 留作 recoverable orphan（下轮可从 file_durable 本地恢复，不重调 provider）。
**不变量**：不存在指向非 succeeded attempt 的 artifact；不存在跨 execution chain 的 attempt/job/claim 组合；
不存在部分成功（artifact 落库但 request 未 fan-out 等）。

---

## 9. 完整状态机冻结（每表 old → new 全矩阵；trigger SQL 见 §2）

### 9.1 `tts_audio_requests`

```text
waiting       → running | succeeded | failed | cancelled | indeterminate
running       → succeeded | failed | cancelled | indeterminate
indeterminate → succeeded | failed | cancelled          # 显式 resolve
succeeded / failed / cancelled → （终态，无出边）
```

### 9.2 `tts_synthesis_claims`

```text
validating_reuse   → succeeded | generation_pending | cancelled | failed
generation_pending → running | cancelled | failed      # preflight 失败 → failed；不允许 indeterminate（无执行在飞）
running            → succeeded | failed | cancelled | indeterminate
indeterminate      → succeeded | failed | cancelled    # 显式 resolve
succeeded / failed / cancelled → （终态，无出边）
```

queued/preflight failure 传播：job `queued → failed/cancelled` 时同事务 claim `generation_pending → failed/cancelled`。

### 9.3 `tts_jobs`（仅 TTS-C 行，`claim_id IS NOT NULL`；legacy 行不受限）

```text
queued        → running | failed | cancelled
running       → succeeded | failed | cancelled | indeterminate
indeterminate → succeeded | failed | cancelled
succeeded / failed / cancelled → （终态，无出边）
```

TTS-C **无 running → queued requeue**（stale running → indeterminate → 显式 resolve；与 legacy `recoverStaleTtsJobs` 隔离）。

### 9.4 `tts_generation_attempts`

```text
created             → provider_in_flight | transport_failed
provider_in_flight  → response_persisted | transport_failed | indeterminate
response_persisted  → file_validated | validation_failed | indeterminate
file_validated      → file_durable | validation_failed | indeterminate
file_durable        → succeeded | indeterminate
succeeded / transport_failed / validation_failed / indeterminate → （attempt 终态，无出边；重试=新 attempt 行）
```

### 9.5 `voice_materialization_requests`

```text
waiting       → running | succeeded | reused | failed | cancelled | indeterminate
running       → succeeded | failed | cancelled | indeterminate
indeterminate → succeeded | failed | cancelled
succeeded / reused / failed / cancelled → （终态，无出边）
```

`reused` 仅来自 waiting（existing projection）；`succeeded` 仅表示新复制成功（含共享 job fan-out waiting→succeeded）；禁止混写。

### 9.6 `voice_materialization_jobs`

```text
validating_existing → queued | succeeded | cancelled | indeterminate
queued              → running | failed | cancelled
running             → succeeded | failed | cancelled | indeterminate
indeterminate       → succeeded | failed | cancelled
succeeded / failed / cancelled → （终态，无出边）
```

### 9.7 `voice_materializations`

```text
file_ready_unpublished → registry_pending | failed | indeterminate
registry_pending       → published_usable | failed | indeterminate
failed                 → file_ready_unpublished   # repair（新 materialization job 成功后 fenced 修复）
indeterminate          → file_ready_unpublished | failed
published_usable       → （不可逆，无出边；文件损坏经 repair job 恢复 exact SHA，不转移状态）
```

### 9.8 `legacy_adapter_voice_entries.mapping_status`

```text
unmapped        → mapped_verified | retired
mapped_verified → mapping_pending | retired
mapping_pending → mapped_active | mapped_verified   # 后者=candidate 失败/过期清证据回退，允许安全重试
mapped_active   → retired
retired         → （终态，无出边）
```

### 9.9 所有权语义汇总（CHECK 强制；R5 冻结）

| 状态 | validation owner | Worker owner/lease/heartbeat | 备注 |
|---|---|---|---|
| validating_reuse / validating_existing | **有效**（token+lease+attempt≥1） | 必须 NULL | Scheduler 不可见 |
| generation_pending / queued | 必须清空 | 必须 NULL | 可被 Scheduler claim |
| running | 必须清空 | **有效** | 单 Worker |
| succeeded / failed / cancelled / indeterminate | 必须清空 | 必须清空 | 终态/待 resolve |

---

## 10. 未来测试矩阵冻结（R5；名称/前置/并发步骤/断言，runtime 实现时逐项落地）

### 10.1 Validation fencing（`scripts/test-tts-c-validation-fencing.ts`）

| 测试 | 前置 | 并发步骤 | 断言 |
|---|---|---|---|
| VF-1 A lease expires → B takeover → A finalize rejected | claim=validating_reuse(A, attempt=1)，candidate usable | B takeover CAS；A fenced finalize | takeover changes=1；A finalize changes=0 → STALE_VALIDATION_OWNER；claim/job/request/文件零变化 |
| VF-2 A renew after B takeover → changes=0 | 同 VF-1 接管后 | A renewal（旧 token/attempt） | renewal changes=0；lease 不被旧 owner 延长 |
| VF-3 B finalize usable → exactly one reuse result | B 持有（attempt=2） | B fenced finalize | changes=1；claim=succeeded；零新 job；全部未取消 envelope succeeded 且指向同一 artifact |
| VF-4 B finalize unusable → exactly one queued job | B 持有，candidate damaged | B fenced finalize + INSERT job | 恰好一个 queued job；claim=generation_pending；partial unique 不冲突 |
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

### 10.4 Cutover crash matrix（`scripts/test-tts-c-cutover-crash.ts`）

| 测试 | crash 点 | 断言 |
|---|---|---|
| CC-1 | candidate intent 持久化后、registry 写入前 | 恢复重发布同 SHA candidate 或安全回退 mapped_verified；legacy voice 不丢；key 恰好一个 source |
| CC-2 | candidate registry fsync 后、adapter reload 前 | 磁盘 SHA==persisted candidate → 续 reload；不重建；legacy 不丢 |
| CC-3 | adapter activation 后、T5 DB commit 前 | active SHA==candidate → fenced 完成 mapped_active + published_usable（幂等） |
| CC-4 | T5 事务进行中（注入回滚/崩溃） | 整事务回滚：不得半 mapped_active；legacy 不丢；projection 不错误标 published_usable |
| CC-5 | reload 失败，adapter LKG | active SHA!=candidate → stable legacy 保持 emitted；projection 保持 registry_pending；可重试 |
| CC-6 | cutover owner lease 过期 | fenced CAS 接管（changes=1）；旧 owner finalize changes=0；状态可 reconciliation |

每个 CC 测试必须断言：legacy voice 不丢失；canonical key 恰好一个 source；active SHA 与 DB state 可 reconciliation；不得错误标 published_usable。

### 10.5 SQLite contract validation（本轮已执行的 docs-only 验证；runtime 阶段纳入 gate）

临时目录（sqlite3 3.45.1）：schema apply → `PRAGMA foreign_key_check`（空）→ `PRAGMA integrity_check`（ok）→
happy path（synthesis 全链 + reuse fan-in + materialization 全链 + cutover 全链 + legacy requeue 正向控制）→
**115 项验证全部按预期（FAIL=0）**：

- **111 项非法 mutation**：
  - **R6 新增 IS-01…19 共 72 项**：IS-01/01b claim_id 封死（nonnull→NULL ABORT；legacy 行 NULL→value ABORT）、
    IS-02/02b running+claim_id NULL+status queued 联合绕过（ABORT）、IS-03 NULL fingerprint/variant（ABORT）+ 同 identity
    第二个 active job（UNIQUE ABORT）、IS-04 身份字段 NULL/claim 缺失/identity 不匹配/job-link 双向一致性（4 ABORT）、
    IS-05 succeeded attempt 改 10 个证据字段（10 ABORT）、IS-06/07 artifact exact/synthesis fingerprint 与 job 不同（2 ABORT）、
    IS-08/09 artifact 字节证据与 attempt 不同（path/SHA/size/codec/sr/ch/duration/provider/model/canonical 共 9 ABORT）、
    IS-10/11/11b/12a/b/c/d/e 终态链接封存（替换 result/job/claim、NULL 补写、link identity 不匹配共 8 ABORT）、
    IS-13 源字段 NULL/自洽/路径格式（5 ABORT）、IS-14 registry proof 封存（6 ABORT）、IS-15 cutover journal 封存（8 ABORT）、
    IS-16/16b/c/d/e 过期 validation owner（renewal changes=0 / takeover changes=1 / 新 owner renewal changes=1 /
    未过期 takeover changes=0 / 过期 finalize changes=0）、IS-17/17b/c/d 同 materialization、IS-18/18b/c + IS-19/19b
    过期 cutover owner（T5 changes=0 / takeover changes=1 / 新 owner T5 changes=1 / renewal changes=0 / 新 owner renewal changes=1）；
  - **R5 回归 39 项**：状态机 8（8 表代表 old→new 非法转移）、不可变/DELETE 9、provenance/composite FK/pair 10
    （含 composite FK `(successful_attempt_id, job_id)` 与 `(job_id, claim_id)` 直接命中）、SHA/路径 CHECK 9、
    partial unique 3；
- **4 项正向控制**：IS-20 reuse consumer 真相查询 3（`WHERE result_artifact_id=:id` 得全部 2 个 consumer；
  producing `claim_id` 只得 1 个——证明 claim_id 不是全量真相）+ legacy requeue 1（claim_id NULL 行 running→queued 仍允许）。

每个反例的预期错误文本或 `changes=0` 已在本轮临时 runner 中逐一断言（错误文本为 trigger/CHECK/FK/UNIQUE 冻结消息）。
临时 SQL/DB 未入仓库。

---

## 11. 并行开发规则（见实施计划；此处为设计依据）

- R6 PASS 后：1A 与 1C 可并行开发（不同本地 worktree/local branch）；1B 的 adapter parser/reloader 测试骨架可并行准备；
  1B publisher integration 等 1A PASS；C.2 等 1A+1B+1C 全部 PASS；C.2 PASS 后 C.3→C.4→C.5 runtime 串行。
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

## 14. Recommended first implementation stage

**TTS-C.1A**（materialization requests/jobs/projection + `validating_existing` fenced single-flight，止于
`file_ready_unpublished`）——零音频风险、解锁 materialization；1C（capability compiler）可并行；
随后 1B（legacy single-source crash-safe cutover + global publisher + activation ack）；
C.2（audio claim/job/attempt/artifact + reclaimable fenced validation）依赖 1A/1B/1C 齐备。
