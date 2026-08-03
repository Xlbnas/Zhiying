# TTS-C Incremental Narration 架构设计（TTS-C.0.R2 修订，只读审计，未实现）

> 状态：**TTS-C.0.R2 architecture closure completed；pending independent Review PASS；
> TTS-C runtime implementation not started；TTS-C.1A not started**。
> 本文档是只读架构审计产物（R2 修订）：不修改 runtime code / schema / config / migration / compose。
> 运行时真相以真实代码为准（审计基线 m7 @ `a4428dc`；TTS-B final code `86f7f52…` 已 FROZEN）。
> 本修订关闭 ChatGPT 独立 Review FAIL 发现：① 不同 requestId 的 synthesis single-flight（active unique）；
> ② phase-aware crash recovery；③ 原子成功终局事务；④ attempt journal 定义修正；
> ⑤ fingerprint vs generation variant 修正（materialization transport 不入 fingerprint）；
> ⑥ registry legacy cutover / empty registry / LKG health；⑦ 1A unpublished 状态边界；
> ⑧ OpenMontage 真实代码审计修正。

---

## 1. 现有真实状态（TTS-C 起点，R1 结论保留）

### 1.1 Voice Library（TTS-A，FROZEN `1460efd…`）

- 表 `voice_profiles`：`id / schema_version('voice-profile@1.0') / display_name / provider('indextts2') / status(active|archived) / created_at / updated_at`。
- 表 `voice_profile_revisions`（**DB trigger ABORT 禁 UPDATE/DELETE，不可变**）：`id / schema_version / voice_profile_id / revision_number / request_id / provider / adapter_compatibility_key / original_audio_sha256 / canonical_audio_sha256 / original_filename_display / canonical_audio_path / codec / sample_rate / channels / duration_ms / transcript / language / metadata_json / request_fingerprint / created_at`，`UNIQUE(voice_profile_id, revision_number)` + `UNIQUE(voice_profile_id, request_id)`。
- canonical 文件：`voice-library/<profileId>/<revisionId>/reference.wav`；canonical 参数冻结：WAV / pcm_s16le / mono / 48000Hz。
- `validateVoiceProfileRevisionExact(pid, rid)` 单一真相源（usable + unusableReason 或 null）。

### 1.2 TTS-B（FROZEN `86f7f52…`）

- `voice_assignment_requests` envelope；`project_voice_assignment` artifact（exact 双 ID，envelope-first，BEGIN IMMEDIATE fence）；`narration_performance_plan` artifact（三层 source 自洽 + items `deliveryOverride/pace/energy/emotion`）；`generation_runs/attempts/dispatch_jobs`（stage `m7_narration_performance_plan`）。

### 1.3 现有 TTS job 体系（M3-B / M7.1；TTS-C 中降级为 mutable execution）

- 表 `tts_jobs`（现有列）：`id / project_id / narration_plan_artifact_id / narration_plan_version / unit_id / provider / voice_profile_id / voice_profile_revision / status / payload_json / output_path / duration_ms / audio_sha256 / result_json / queued_at / started_at / finished_at / claimed_by / claimed_at / heartbeat_at / attempt / max_attempts / progress / error_code / error_message / cancel_requested`。R2：`output_path/duration_ms/audio_sha256/result_json` 为 **legacy 兼容字段**，非 TTS-C authoritative result。
- worker `tts-executor.ts`：claim（scheduler + `production_gpu` lease）+ 5s heartbeat + Gate C leakage + provider 快照解析 + 写盘 `projects/{pid}/audio/units/{planVersion}/{unitId}-{job.id}.wav` + `finalizeTtsJobSuccess`（BEGIN IMMEDIATE，cancel 优先）+ `failTtsJob`（retryable<2）+ `recoverStaleTtsJobs`（heartbeat 2min，**无条件 requeue/cancel——R2 废弃其对 TTS-C 的复用，见 §4**）。
- v2 复用机制（`audio-v2.ts`，已实现未接 API/UI）：`fingerprintForUnit` / `planTtsReuseDecisions`（读 succeeded tts_jobs 行——R2 改为读 immutable `sentence_audio_artifacts`）/ `enqueueNarrationAudioJobsV2`。

### 1.4 IndexTTS2 Adapter（`server.py`）

- `/v1/synthesize` 仅支持 `text + voiceProfile@voiceRevision + useRandom=false + emotion='none'`；无 delivery/pace/energy/emotion/prosody/duration 通道。
- registry `{schemaVersion:'1.0', voices:[…]}` **启动时加载一次**（`REGISTRY = _load_registry()`）；**当前实现拒绝 `voices=[]`**（`len(voices)==0 → VOICE_REGISTRY_INVALID`）——影响 empty registry 语义（§8.2）。
- containment：`ADAPTER_VOICE_ROOT` realpath + commonpath；`_check_voice` mtime+size 缓存 SHA-256。
- materialization API 不存在；`ZHIYING_HOST_VOICES_DIR:/voices:ro` + `ZHIYING_HOST_VOICE_REGISTRY:/config/voice-registry.json:ro` 部署时手工配置。

### 1.5 TTS Provider 抽象

- `TtsRequest`：`{text, voiceProfile, unitId, style?{directive?}, emotion?}`；`TtsResult`：`{audio, format:'wav', provider, model, providerVersion?, providerCommit?, settings}`；Provider 不宣称 duration（时长真相 = ffprobe 实测）。
- fingerprint（M7.1 冻结）：`computeTtsInputFingerprint` 8 字段 length-prefixed。

### 1.6 v1 音频管线（已闭环，模式参考）

`tts_jobs` → `narration_audio_manifest` + master（Buffer.concat）→ `subtitle_timing` → `timing_reconciliation` → final-render bridge。v2 半成品：`narration_audio_manifest_v2` 只有 schema；`subtitle_timing_v2` 无 artifact 层；`timing-reconciliation@2.0` 不存在。

---

## 2. 四表分离（R1 冻结，保留）

```
tts_audio_requests          = durable requestId envelope / replay / conflict（UNIQUE(project_id, request_id)）
tts_jobs                    = mutable execution state machine（含 active synthesis claim）
tts_generation_attempts     = append-one-row-per-provider-call journal（§6）
sentence_audio_artifacts    = immutable successful audio result（trigger ABORT；exact reader）
```

- `tts_jobs` 新列（TTS-C.2 ALTER，R2 冻结）：`tts_audio_request_id`、`exact_source_fingerprint`、`synthesis_payload_fingerprint`、`final_tts_input_fingerprint`、`generation_variant_id`、`result_artifact_id`。
- `sentence_audio_artifacts`（R1 schema 保留；**R2 明确不设 fingerprint UNIQUE**，见 §3.2）。

---

## 3. 不同 requestId 的 synthesis single-flight（§三 P0 修复）

### 3.1 Mandatory active synthesis constraint（强制，非可选）

`tts_audio_requests.UNIQUE(project_id, request_id)` 只解决 request idempotency，不能解决：

```
requestId A + synthesis identity F
requestId B + synthesis identity F
```

**冻结强制 partial unique index**：

```sql
CREATE UNIQUE INDEX uq_tts_jobs_active_synthesis
ON tts_jobs (
  project_id,
  unit_id,
  final_tts_input_fingerprint,
  generation_variant_id
)
WHERE status IN ('queued', 'running', 'indeterminate');
```

语义：
- **indeterminate 继续占用 claim**（不释放 active unique，防止并发双开 provider）；
- 不同 requestId、同 synthesis key → **必须链接同一个 active job**（第二个 request envelope 不创建第二个 job）；
- active job 终态（succeeded/failed/cancelled）后释放 active unique；
- succeeded artifact usable 时直接 reused；
- damaged artifact **不得 reused**，但允许显式 repair 创建新 job（repair = 新 request + 显式 generation variant，见 §3.2）。

### 3.2 不要对 immutable artifact 设置阻断 repair 的 UNIQUE

**删除** R1 文档中 `sentence_audio_artifacts UNIQUE(…fingerprint…, generation_variant_id) 可选防重` 或明确不得把它作为唯一性依赖。

同一 final input fingerprint 可以存在**多个 immutable candidate**：
- 历史 artifact 文件损坏后的 replacement（exact reader fail-closed，新 job 重生成新 artifact）；
- 显式重复生成（repeat generation）；
- provider 非 byte-deterministic 的新 candidate。

**single-flight 必须由 active job/claim（partial unique）控制，不由 successful artifact 的 UNIQUE 控制。** selection/reuse 按 exact reader usable + 最新可读 candidate 裁决，不依赖唯一性。

### 3.3 两阶段事务算法（完整 BEGIN IMMEDIATE 流程）

涉及文件 SHA 的 exact reader 是异步/文件 I/O，**不能放进 better-sqlite3 transaction**。冻结两阶段裁决：

**Phase 1 — 同步 DB 裁决（单 BEGIN IMMEDIATE）**：

```text
BEGIN IMMEDIATE

1. envelope-first：
   - same requestId + same exact request identity（source+payload+variant 全同）
     → adjudicate existing（读 envelope → 按状态返回 running/reused/终态）
   - same requestId + different identity → REQUEST_ID_CONFLICT

2. 查找 exact final_tts_input_fingerprint 的 usable artifact metadata candidate
   （同步 DB：status 元数据 + 文件元数据，不读文件内容）

3. 查找 active synthesis job（uq_tts_jobs_active_synthesis 覆盖）

4. 若 active job 存在：
   - 新 request envelope 指向 existing job（INSERT envelope + job_id = existing job id）
   - 返回 running / indeterminate（不创建第二个 job）

5. 若无 active job：
   - INSERT request envelope
   - INSERT queued job（满足 active unique）
   - 两者建立 exact link（job.tts_audio_request_id = envelope.id）

COMMIT
```

**Phase 2 — 事务外 exact file validator（异步 SHA/文件检查）**：对 Phase 1 找到的 candidate artifact 执行 `validateSentenceAudioArtifactExact`（文件存在、非 symlink、SHA/size/codec/duration 一致）。

**Phase 3 — 复用/repair 最终裁决（重新进入 BEGIN IMMEDIATE）**：

```text
BEGIN IMMEDIATE
- Phase 2 通过且 active unique 无冲突 → 复用该 artifact（envelope/job 标记 reused）
- Phase 2 失败（damaged）→ fail-closed 不复用；显式 repair：新 request + explicit
  generation variant → INSERT 新 job（若原 active job 已终态，active unique 已释放）
COMMIT
```

并发期间**不得双开 job**：Phase 1 的 active unique + Phase 3 重入时再查 active（防 Phase 1 与 Phase 3 之间另一请求抢先）。

---

## 4. Phase-aware crash recovery（§四 P0 修复）

废弃 TTS-C 对旧 `recoverStaleTtsJobs` 的无条件 requeue 复用（旧逻辑只看 `status='running' + heartbeat 超时`）。

### 4.1 执行阶段（冻结）

```
queued
claimed_pre_provider     （claim 完成、provider 调用前）
provider_in_flight       （provider 请求已发出、响应未收齐）
response_received        （provider 响应已收到，未完成文件校验）
file_validated           （ffprobe/SHA/size/codec 通过，final 未 rename）
file_durable             （final rename + fsync 完成，DB 未完成）
db_completed             （原子完成事务已提交）
```

阶段由 `tts_generation_attempts` latest attempt 状态 + `tts_jobs` 字段推导（job 表不单独存 phase 列；attempt 是阶段真相）。

### 4.2 Recovery matrix（冻结）

| 阶段 | 恢复行为 |
|---|---|
| `queued` / `claimed_pre_provider` | **可安全 requeue**（无 provider 调用发生，零副作用） |
| `provider_in_flight` | **indeterminate**（请求已发出，无法证明 upstream 是否完成；**禁止自动再次调用 provider**） |
| `response_received` + durable candidate 文件可读 | **继续 probe/hash/DB finalize**（不再次调用 provider） |
| `response_received` 但 response/file 无法恢复 | **indeterminate** |
| `file_validated` / `file_durable` + DB 未完成 | **校验 exact job/attempt/file → 仅恢复 DB finalize**（不再次调用 provider） |
| `db_completed` | exact artifact reader 验证（usable / damaged fail-closed） |

### 4.3 Heartbeat stale（新规则）

新的 recovery **必须读取 latest attempt phase**，不得仅凭 `tts_jobs.status='running'` 就 requeue：

- 无 provider attempt → requeue（安全）；
- attempt `in_flight` → indeterminate；
- attempt `response_received` → 尝试本地恢复（probe/hash/finalize）；
- attempt `transport_failed`（已终态）→ job 转 failed 或按 retry 规则。

### 4.4 Indeterminate resolution（冻结）

- indeterminate **不自动重调** provider；
- indeterminate **保留 active synthesis claim**（partial unique 仍占用）；
- 用户显式 resolve 三选一：
  1. **接受可恢复结果**（artifact 可验证 → 完成 finalize）；
  2. **标记 failed**（释放 claim）；
  3. **创建新 request + explicit generation variant** 进行 retry（新 job，不抢原 claim）；
- **usage/cost 保留**，不能回滚或伪造成 0（attempt journal + usage 对账不可变）。

---

## 5. 成功终局原子事务（§五 P0 修复）

### 5.1 文件持久化顺序（先于 DB）

```text
provider response
→ attempt-specific temp file（.tmp-<uuid>）
→ ffprobe / SHA / size / codec validation
→ final rename（同目录）
→ final file fsync
→ parent directory fsync
```

### 5.2 单 BEGIN IMMEDIATE 原子完成（只允许一个）

```text
BEGIN IMMEDIATE

1. 重读 job：
   - exact owner/claim（owner_token 匹配）
   - status = running
   - cancel_requested = 0

2. 重读 request envelope：
   - request identity（source+payload+variant）与 job 完全一致

3. 重读 active synthesis identity（final fingerprint + variant 与 job 一致）

4. INSERT sentence_audio_artifacts（immutable）

5. UPDATE current tts_generation_attempt：
   - status = succeeded
   - result/audio evidence（response hash / probe 元数据）

6. UPDATE tts_jobs：
   - status = succeeded
   - result_artifact_id = artifact.id
   - clear owner / lease

7. UPDATE tts_audio_requests：
   - result_artifact_id = artifact.id

COMMIT
```

**任何一步失败 → SQLite 整事务回滚**；已 durable 文件属于 **orphan**（DB 无引用）；cleanup/recovery **不得触发第二次 provider 调用**；**不允许 artifact/job/request 三者出现部分成功**（同事务原子）。

### 5.3 Cancel 与 success 的裁决

进入该 BEGIN IMMEDIATE 的顺序决定结果（cancel 优先，沿用 M3-B 原子裁决语义）：

```text
cancel_requested = 1
→ 不插入 artifact
→ job 转 cancelled（finished_at + error_code）
→ attempt 转 cancelled/terminated
→ envelope 保留终态（cancelled）
```

---

## 6. Attempt journal 定义（§六 修正）

**选定一种并冻结**（不再称"严格 append-only row"）：

```
tts_generation_attempts
= append-one-row-per-provider-call
= mutable lifecycle fields（行内状态受控更新）
= immutable request identity（禁止修改）
= 禁止 DELETE
```

- 每行 = 一次 provider 调用（attempt_number 唯一于 job）；
- **immutable**：`job_id / attempt_number / request_hash / request_json / provider / model`（DB trigger ABORT 禁止修改）；
- **mutable lifecycle**：`status / response_hash / response_metadata / error_classification / usage_record_id / finished_at`（受控更新）；
- 状态机（冻结，禁倒退）：`in_flight → response_received → succeeded`；`in_flight → validation_failed → （repair 新 attempt 或终态）`；`in_flight → transport_failed`；`in_flight → indeterminate`；`response_received → indeterminate`（恢复失败）；
- **DB trigger** 限制非法字段更新与状态倒退（如 succeeded 后不得回 in_flight；immutable 字段 UPDATE 直接 ABORT）；
- usage/cost 与 attempt 一一对账（usage_record_id）。

---

## 7. Fingerprint 与 generation variant（§七 修正）

### 7.1 Materialization transport 不进入 TTS input fingerprint

**从 `exactSourceFingerprint` 删除**：

```
registry publish sequence
materialization publish sequence
transport destination path
global registry generation
```

**保留真正 source/acoustic identity**：

```
voiceProfileId
voiceProfileRevisionId
canonicalAudioSha256
adapterCompatibilityKey
provider
```

materialization row / registry generation **只用于**：provenance、execution readiness、exact preflight、incident diagnosis。

**以下操作不得改变 TTS fingerprint**：
- 同一 reference 文件重新 materialize；
- registry 原子重新发布；
- 新增其他 voice；
- registry entry canonical reorder；
- container restart。

### 7.2 三种身份重新划分（冻结）

```
exactSourceFingerprint       = exact artifact/provenance identity
synthesisPayloadFingerprint  = 实际送给 provider、可能影响声学输出的 canonical payload
finalTtsInputFingerprint     = hash(exactSourceFingerprint, synthesisPayloadFingerprint, version)
generationVariantId          = 候选生成身份，不是自动等同于声学参数
```

- **只有 provider seed/override 真正进入 provider payload 时**，seed/override 才进入 `synthesisPayloadFingerprint`；
- 纯 opaque `generationVariantId`：
  - 进入 request identity；
  - 进入 active synthesis claim key（partial unique 含 generation_variant_id）；
  - 进入 artifact provenance；
  - **不得伪称为实际 provider payload**；
- 这允许：同一 final input fingerprint 下显式产生多个 immutable candidate（不依赖 artifact fingerprint UNIQUE）；A/B 精确区分 candidate；
- **adapter 不支持真实 variation 时**（当前 adapter 无 seed 通道）：UI 必须标注 **"repeat generation"**，**不得声称参数化 A/B**；variant 只能来自 override artifact 或文本/参数真实差异。

---

## 8. Registry cutover 与 last-known-good（§八 P0 修复）

### 8.1 Existing registry cutover（1B 首次启用 DB-authoritative publisher 前）

当前 production voice rows 0/0，但 adapter registry 必须非空才 healthy（`voices=[]` → invalid）。冻结迁移策略：

```text
1B 首次启用 DB-authoritative publisher 前：
1. 读取并严格验证现有 registry（adapter 校验规则：schema/path containment/reference SHA）
2. 将合法 entry 导入 legacy materialization rows（import provenance 记录来源 registry 文件 hash/时间）
3. 新 DB 全量重建结果与旧 registry entry 集合【完全一致】才允许切换 publisher
```

**不得**：
- 因 DB materialization rows 为空而发布空 registry；
- 首次 materialize 一个新 voice 时删除全部 legacy entries；
- 静默丢弃无法映射的旧 entry。

无法映射的 entry → **fail-closed 并要求人工裁决**（不进入新 registry，标记 `LEGACY_UNMAPPED_PENDING_REVIEW`）。

### 8.2 Empty registry（冻结）

- **cold start / DB 无 rows / 无 legacy import**：publisher 在空集合时**不得替换现有 registry**（保持 last-known-good；无 LKG 且无 legacy → adapter 维持启动时状态 + health 报告 `VOICE_REGISTRY_EMPTY`，ready=false）；
- registry schema 层面：adapter 当前拒绝 `voices=[]`——**保留该拒绝**（避免空 registry 伪装可用）；publisher 空集合 = 无发布动作；
- **production deployment 不得因 0/0 DB 让 adapter unhealthy**：部署顺序保证——先 legacy import（8.1）再切换 publisher；新部署环境（无 legacy）→ adapter 明确 `VOICE_REGISTRY_EMPTY` 状态，由运维 materialize 首个 voice 后进入可用。

### 8.3 Last-known-good health（冻结语义）

```text
candidate registry invalid + valid LKG 存在
→ 保持 LKG
→ ready = true
→ degraded = true
→ detail = VOICE_REGISTRY_PUBLISH_FAILURE
→ synthesize 只消费 LKG snapshot

candidate registry invalid + 无 LKG
→ ready = false
→ synthesize 503
```

配套定义：
- **Docker healthcheck**：`/health` ready 由 `upstream_ok && registry_ok && voices_ok` 决定；degraded（LKG）视为 **healthy**（容器不重启，detail 透传）；
- **worker depends_on**：依赖 adapter healthy（LKG 状态满足 healthy）；
- **/health body**：`{ready, degraded, detail, provider, model}`（degraded=true 时 detail=VOICE_REGISTRY_PUBLISH_FAILURE）；
- **synthesize 行为**：degraded（LKG）→ 正常服务（消费 LKG）；无 LKG + registry invalid → 503；
- **cold start**：见 8.2；
- **reload failure**：保持 LKG + 报告 publish failure（不 crash、不依赖 Docker restart）。

### 8.4 Materialization 状态机 + 1A 边界（冻结）

```
requested
→ file_writing
→ file_ready_unpublished
→ registry_pending
→ published_usable
→ failed / indeterminate（任意阶段可失败）
```

- **TTS-C.1A 只实现到 `file_ready_unpublished`**；
- 1A 阶段要求：API **不声称 adapter ready**；**TTS dispatch 不可使用**（未发布 voice 不可用于合成）；只有 1B registry publish 成功后才进入 `published_usable`；
- 不产生半成品 active 状态。

### 8.5 `voice_materialization_state` 精确 schema（R2 冻结，不再留待 1A 决定）

```sql
CREATE TABLE voice_materialization_state (
  id TEXT PRIMARY KEY,
  voice_profile_id TEXT NOT NULL,
  voice_profile_revision_id TEXT NOT NULL,
  request_id TEXT NOT NULL,                 -- 幂等键
  assignment_artifact_id TEXT NOT NULL,     -- exact Assignment 授权（archive 后历史 Assignment 仍可用）
  status TEXT NOT NULL,                     -- requested/file_writing/file_ready_unpublished/registry_pending/published_usable/failed/indeterminate
  source_canonical_sha256 TEXT NOT NULL,    -- = voice_profile_revisions.canonical_audio_sha256（声学身份，进 fingerprint）
  destination_relative_path TEXT NOT NULL,  -- <VOICE_ROOT>/<pid>/<rid>/reference.wav（data-relative 或 voice-root-relative）
  published_registry_generation INTEGER,    -- 发布序号（provenance；不进 fingerprint）
  legacy_import_provenance TEXT,            -- legacy cutover 导入来源（registry 文件 hash + 时间）
  error_code TEXT, error_message TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(voice_profile_id, voice_profile_revision_id, request_id)
);
```

request envelope 形式：materialization 请求 = `{requestId, voiceProfileId, voiceProfileRevisionId, assignmentArtifactId}`；裁决 = exact Assignment artifact 存在 + source 自洽 + exact voice usable（**不按 Profile active 状态**；archive 后合法历史 Assignment 引用的 revision 允许 materialize）。

---

## 9. Exact input chain 与 capability matrix（R1 结论保留 + 更新）

- exact input chain 见 R1 §2（全显式 ID）；fingerprint 三分离按 §7 本修订执行。
- capability neutral matrix（R1 §7 保留）：neutral 默认值（delivery=normal/pace=normal/energy=normal/emotion=none/deliveryOverride=null）→ **supported no-op**；非 neutral 无通道 → explicit unsupported（不静默丢弃）。

---

## 10. Manifest/Master 非循环身份（R1 §8 保留）

- `narration_audio_selection_manifest@2.0`（无 master 信息）+ `narration_master_audio@1.0`（引用 manifest；`masterInputFingerprint = hash(selectionManifestArtifactId, selectionManifestContentHash, concatCompilerVersion)` 无自引用）；顺序：selected immutable manifest → durable master → immutable master artifact DB commit。

---

## 11. Downstream stale 传播（R1 §9 保留）

文本/声音/Performance/单句时长/仅 provider metadata/master SHA 同时长的区分规则不变；subtitle_timing_v2 全量确定性重算 + 复用未变 unit 实测时长。

---

## 12. Security / Tests / Migrations / Deployment（R1 §10-11 保留）

- API 不输出路径；客户端只提交 ID；Web 无 voice/registry 挂载；attempt journal 只存安全投影；registry 服务端生成。
- 每阶段 `scripts/test-tts-c-*.ts` + 临时 DB + Mock provider + 统一 gate；migration 可回滚 + 副本演练；exact-SHA 部署纪律。

---

## 13. Unresolved decisions（进入 1A 前定）

1. `voice_materialization_state` 与 TTS-C.2 的 `tts_audio_requests` 是否统一 envelope 模式（1A 定实现细节）。
2. delivery 编译策略（文本改写 vs 显式 unsupported，推荐显式 unsupported）。
3. pace 经 adapter 扩展直传可行性（upstream duration control 支持度）。
4. unit vs sentence 原子单位（推荐 unit）。
5. capability 升级后存量音频失效策略（推荐不自动删，review 决定）。
6. pronunciation dictionary 是否纳入（推荐 C.3 后评估）。
7. master 拼接：Node PCM concat（现状）vs ffmpeg concat filter（C.4 定）。

## 14. Recommended first implementation stage

**TTS-C.1A**（voice materialization durable requests/files/DB projection，实现到 `file_ready_unpublished`）——零音频风险、解锁 materialization；随后 1B（global registry publisher + adapter hot reload + **legacy cutover**）、1C（capability compiler）；C.2 依赖 1A/1B/1C 齐备（envelope + active synthesis constraint + fingerprint 三分离 + immutable artifact 需要 materialization 与 capability 支持）。
