# TTS-C Incremental Narration 架构设计（TTS-C.0.R1 修订，只读审计，未实现）

> 状态：**TTS-C.0.R1 architecture closure completed；pending independent Review PASS；
> TTS-C runtime implementation not started；TTS-C.1 not started**。
> 本文档是只读架构审计产物（R1 修订）：不修改 runtime code / schema / config / migration / compose。
> 运行时真相以真实代码为准（审计基线 m7 @ `c012b40`；TTS-B final code `86f7f52…` 已 FROZEN）。
> 本修订关闭 ChatGPT 独立 Review FAIL 发现：① mutable job 与 immutable artifact 分离；
> ② requestId/single-flight/attempt/indeterminate；③ manifest/master 非循环身份；
> ④ materialization 真实 production 拓扑；⑤ fingerprint 三分离；⑥ capability neutral matrix；
> ⑦ OSS exact-SHA 审计；⑧ milestone 拆分。

---

## 1. 现有真实状态（TTS-C 起点的精确事实）

### 1.1 Voice Library（TTS-A，FROZEN `1460efd…`）

- 表 `voice_profiles`：`id / schema_version('voice-profile@1.0') / display_name / provider('indextts2') / status(active|archived) / created_at / updated_at`。
- 表 `voice_profile_revisions`（**DB trigger ABORT 禁止 UPDATE/DELETE，不可变**）：`id / schema_version / voice_profile_id / revision_number / request_id / provider / adapter_compatibility_key / original_audio_sha256 / canonical_audio_sha256 / original_filename_display / canonical_audio_path / codec / sample_rate / channels / duration_ms / transcript / language / metadata_json / request_fingerprint / created_at`，`UNIQUE(voice_profile_id, revision_number)` + `UNIQUE(voice_profile_id, request_id)`。
- canonical 文件：`voice-library/<profileId>/<revisionId>/reference.wav`（相对 dataDir；`VOICE_LIBRARY_ROOT`）；canonical 参数冻结：WAV / pcm_s16le / mono / 48000Hz。
- metadata_json strict：`{canonicalizationVersion:'voice-canonical@1.0', adapterCompatibilityKey:'indextts2-adapter-registry@1', ingestedAt}`。
- `validateVoiceProfileRevisionExact(pid, rid)` 是单一真相源（hash/contract/path/symlink 全检，返回 `usable` + `unusableReason` 或 null）。

### 1.2 TTS-B（FROZEN `86f7f52…`）

- 表 `voice_assignment_requests`：`id / project_id / request_id / voice_profile_id / voice_profile_revision_id / artifact_id / created_at`，`UNIQUE(project_id, request_id)`。
- artifact `project_voice_assignment`（`project-voice-assignment@1.0`）：exact `voiceProfileId + voiceProfileRevisionId`；requestId envelope-first；BEGIN IMMEDIATE commit fence。
- artifact `narration_performance_plan`（`narration-performance-plan@1.0`）：`source` 三层逐项一致 + `generation{requestId, provider, model, attemptCount}` + `items`。
- `PerformanceItemV1`：`{unitId: Nddd, deliveryOverride: null|enum, pace: slow|normal|fast, energy: low|normal|high, emotion: {mode:'none'}|{mode:'semantic', label}}`。
- generation 控制面：`generation_runs`（`UNIQUE(project_id, stage, request_id)`，stage `m7_narration_performance_plan`）+ `generation_attempts` + `generation_dispatch_jobs`。

### 1.3 现有 TTS job 体系（M3-B / M7.1；**TTS-C.0.R1 决定其不再作为 authoritative result**）

- 表 `tts_jobs`：`id / project_id / narration_plan_artifact_id / narration_plan_version / unit_id / provider / voice_profile_id / voice_profile_revision / status / payload_json / output_path / duration_ms / audio_sha256 / result_json / queued_at / started_at / finished_at / claimed_by / claimed_at / heartbeat_at / attempt / max_attempts / progress / error_code / error_message / cancel_requested`。
  - R1 定位：**mutable execution state machine**。`output_path / duration_ms / audio_sha256 / result_json` 作为 legacy 兼容字段保留，**不再作为 TTS-C authoritative result**（见 §6.4）。
- payload：`tts-payload@1.0`（`unitText`）/ `tts-payload@1.1`（`spokenText + delivery + ttsInputFingerprint`）union。
- 执行：worker `tts-executor.ts`（claim + GPU lease + 5s heartbeat + Gate C leakage + provider 快照解析 + 写盘 `projects/{pid}/audio/units/{planVersion}/{unitId}-{job.id}.wav` + `finalizeTtsJobSuccess` BEGIN IMMEDIATE + cancel 优先；失败 retryable<2 requeue；`recoverStaleTtsJobs`）。
- v2 复用机制（`src/lib/narration/audio-v2.ts`，已实现未接 API/UI）：`fingerprintForUnit` / `planTtsReuseDecisions`（v2 fingerprint 精确匹配 reuse；legacy 受控等价）/ `enqueueNarrationAudioJobsV2`（payload@1.1，eligible plan gate + leakage gate）。**注意：当前复用候选池读 tts_jobs 行（`listSucceededTtsJobs`）——R1 改为读 immutable `sentence_audio_artifacts`（§6）**。

### 1.4 IndexTTS2 Adapter（M4-B production registry 版，`server.py`）

- 对 Zhiying 暴露：`GET /health`、`POST /v1/synthesize` → audio/wav bytes。
- **`/v1/synthesize` 仅支持**：`text` + `voiceProfile@voiceRevision` + `useRandom=false` + `emotion='none'`；无 delivery/pace/energy/emotion/prosody/duration 通道。
- voice 身份：SHA-256（Zhiying SoT）+ MD5（upstream cache 兼容 id）；per-voice single-flight。
- registry：`ADAPTER_VOICE_REGISTRY_PATH`（`{schemaVersion:'1.0', voices:[{voiceProfile, voiceRevision, speakerName, referenceAssetPath(绝对), referenceSha256}]}`）**仅进程启动时 `REGISTRY = _load_registry()` 加载一次**（R1 要求 adapter hot reload，见 §4.4）；containment：`ADAPTER_VOICE_ROOT` realpath + commonpath。
- **voice materialization API 不存在**；`ZHIYING_HOST_VOICES_DIR:/voices:ro` + `ZHIYING_HOST_VOICE_REGISTRY:/config/voice-registry.json:ro` 为部署时手工配置（R1 修订 mount 模型，见 §4.2）。

### 1.5 TTS Provider 抽象（`src/lib/tts/`）

- `TtsRequest`：`{text, voiceProfile:{id,revision}, unitId, style?:{directive?}, emotion?:{mode:'none'|'text'|'vector'}}`；`TtsResult`：`{audio, format:'wav', provider, model, providerVersion?, providerCommit?, settings}`；Provider 不宣称 duration（时长真相 = ffprobe 实测）。
- fingerprint（M7.1 REVIEW 1.3 冻结）：`computeTtsInputFingerprint` 8 字段 length-prefixed（normalizedSpokenText/voiceIdentity/referenceAudioHash/ttsModelVersion/delivery/speed/synthesisParameters/normalizationVersion）。

### 1.6 v1 音频管线（已闭环，**不是 TTS-C 目标产物，但提供成熟模式**）

`tts_jobs`（每 speech unit 一 job）→ `narration/audio.ts tryFinalizeNarrationAudio` → `narration_audio_manifest`（kind=`narration_audio_manifest`）+ master（`Buffer.concat` + wrapPcmAsWav）→ `subtitle_timing`（`subtitle-timing@1.0`，unit 边界=ffprobe 实测、句内=文本权重估算）→ `timing_reconciliation`（`timing-reconciliation@1.0`）→ final-render bridge。
v2 半成品：`narration_audio_manifest_v2` 只有 schema；`subtitle_timing_v2` 只有 schema+compiler；`timing-reconciliation@2.0` 不存在。

---

## 2. Exact input chain（§6.1 保留，增强）

单句 TTS 的 exact input（全显式 ID，禁 current/latest/default）：

```
Narration Plan V2 artifact（exact artifactId → content_hash / schemaVersion / compilerVersion / scriptV2VersionId / scriptV2Version / scriptV2ContentHash）
├── exact SpeechUnit（unitId Nddd + exact spokenText + subtitleText + delivery + sourceText）
├── Project Voice Assignment artifact（exact artifactId → content_hash）
│   └── exact Voice Profile + Revision descriptor（voiceProfileId + voiceProfileRevisionId + canonicalAudioSha256 + adapterCompatibilityKey + provider）
├── Narration Performance Plan artifact（exact artifactId → content_hash）
│   └── exact PerformanceItem（unitId → deliveryOverride / pace / energy / emotion）
├── provider capability snapshot（provider / model / providerVersion / providerCommit / capabilityCompilerVersion）
├── pronunciation dictionary revision（TTS-C.3 后评估；未启用时用 'none'）
├── emotion reference identity（adapter 通道就绪后；当前 emotion='none'）
└── generation variant（generationVariantId + provider seed / override artifact；A/B 或显式 regeneration 时）
```

**进入最终输入身份的字段**分三层（§7）：exactSourceFingerprint（source identity）+ synthesisPayloadFingerprint（声学 payload）+ finalTtsInputFingerprint（两者组合）。

---

## 3. 四表分离：mutable job 与 immutable audio artifact（§三 P0 修复）

**废弃结论：「tts_jobs 行即 sentence audio artifact」。** 职责分离为：

```
tts_audio_requests          = durable requestId envelope / replay / conflict（不可变请求记录）
tts_jobs                    = mutable execution state machine（状态可更新）
tts_generation_attempts     = append-only provider attempt journal
sentence_audio_artifacts    = immutable successful audio result（DB trigger ABORT 禁 UPDATE/DELETE）
```

### 3.1 `tts_audio_requests`（durable request envelope，TTS-C.2 建表）

```sql
CREATE TABLE tts_audio_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  request_id TEXT NOT NULL,               -- canonicalizeRequestId（8–128，[A-Za-z0-9._:-]）
  exact_source_fingerprint TEXT NOT NULL,
  synthesis_payload_fingerprint TEXT NOT NULL,
  generation_variant_id TEXT NOT NULL DEFAULT 'default',
  job_id TEXT,                            -- mutable job 引用（终态后可置空？不——保留历史）
  result_artifact_id TEXT,                -- 成功时指向 sentence_audio_artifacts.id
  created_at TEXT NOT NULL,
  UNIQUE(project_id, request_id)
);
```

语义：
- **same requestId + same exact request identity（source + payload + variant 三项全同）**：
  - running → 返回 running（in_progress + retryAfter）；
  - succeeded + artifact usable（exact reader 通过）→ reused（返回 artifact）；
  - failed/cancelled/indeterminate → 原终态返回（不自动重试）。
- **same requestId + different source/fingerprint/variant** → `REQUEST_ID_CONFLICT`。
- **envelope 的 job/artifact 缺失或契约非法** → `REQUEST_STATE_INCONSISTENT`（fail-closed，不 fallback latest job/artifact）。

### 3.2 `tts_jobs`（mutable execution state machine；现有表 + TTS-C.2 ALTER）

只负责：

```
status: queued/running/failed/cancelled/succeeded/indeterminate
claim / owner / lease / heartbeat
attempt count / max_attempts
cancel / retry
request envelope link（tts_audio_request_id）
result artifact link（result_artifact_id → sentence_audio_artifacts.id）
```

状态允许更新（mutable）。`output_path / duration_ms / audio_sha256 / result_json` 保留为 **legacy 兼容字段**（v1 管线与历史数据仍读它们），TTS-C 新路径**不写入也不依赖**它们作为 authoritative result。

### 3.3 `sentence_audio_artifacts`（immutable result artifact，TTS-C.2 建表）

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
  compiled_payload_json TEXT NOT NULL,    -- compiledDelivery/Speed/SynthesisParameters + unsupportedFlags

  request_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  successful_attempt_id TEXT,

  output_relative_path TEXT NOT NULL,     -- 仅 data-relative path（如 projects/<pid>/audio/units/<v>/<unitId>-<jobId>.wav）
  audio_sha256 TEXT NOT NULL,
  output_size INTEGER NOT NULL,
  codec TEXT NOT NULL,
  sample_rate INTEGER NOT NULL,
  channels INTEGER NOT NULL,
  ffprobe_duration_ms INTEGER NOT NULL,

  generation_variant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL
);
-- DB trigger ABORT 禁止 UPDATE/DELETE（沿用 voice_profile_revisions 不可变模式）
-- UNIQUE(project_id, unit_id, final_tts_input_fingerprint, generation_variant_id) 可选防重
```

要求（延续 TTS-A 纪律）：
- **DB trigger ABORT 禁止 UPDATE/DELETE**（immutable）；
- 文件路径只存 **data-relative path**；
- **API 不输出路径**（序列化出口不含 output_relative_path）；
- **exact reader**（`validateSentenceAudioArtifactExact`，单一真相源）校验：schema 可解析、路径 containment（realpath 不越界）、regular file、非 symlink、audio_sha256、output_size、codec/sample_rate/channels、ffprobe_duration_ms 与 DB 一致；
- **damaged artifact fail-closed**（hash 漂移/文件缺失 → 不可用，绝不返回成功）；
- **regeneration = 新 job + 新 artifact + 新文件**；旧成功 artifact 永不覆盖；
- `tts_jobs.result_artifact_id` 指向 exact artifact；
- **selection 只能引用 `sentence_audio_artifact_id`，不得引用 mutable job 作为音频真相**。

### 3.4 `tts_generation_attempts`（append-only attempt journal，TTS-C.2 建表）

```sql
CREATE TABLE tts_generation_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES tts_jobs(id),
  attempt_number INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  request_hash TEXT NOT NULL,             -- 安全 request 投影 hash（无 header/secret）
  request_json TEXT NOT NULL,             -- 安全投影
  provider_request_id TEXT,
  started_at TEXT NOT NULL,
  response_hash TEXT,
  response_metadata TEXT,
  status TEXT NOT NULL,                   -- in_flight/response_received/validation_failed/succeeded/transport_failed/indeterminate
  error_classification TEXT,
  usage_record_id TEXT,
  finished_at TEXT
);
```

状态至少支持：`in_flight / response_received / validation_failed / succeeded / transport_failed / indeterminate`（沿用 generation_attempts 既有枚举扩展）。

---

## 4. requestId / single-flight / attempt / indeterminate（§四 P0）

### 4.1 DB 级 single-flight（不允许 read-before-insert）

三个概念严格区分：

| 概念 | 载体 | 约束 |
|---|---|---|
| request idempotency | `tts_audio_requests.UNIQUE(project_id, request_id)` | 同 requestId 同 exact request identity 幂等；异 → 409 |
| synthesis identity | `sentence_audio_artifacts.UNIQUE(project_id, unit_id, final_tts_input_fingerprint, generation_variant_id)` + 同键 active job 检查 | 同 synthesis 最多一个 active job |
| generation variation | `generation_variant_id`（'default' 或显式 variant）+ 可选 provider seed / override artifact | variant 进入 request identity、compiled payload provenance 与 fingerprint |

- **普通生成**：同 exact source + same synthesis payload + same variant identity 最多一个 active job（claim 时 `BEGIN IMMEDIATE` 内 INSERT envelope → 再 INSERT job → running；并发第二个请求在 envelope 阶段即命中 running → 返回 in_progress，绝不双开 provider）。
- **A/B 或显式 regeneration**：必须携带明确 `generationVariantId`（和/或 provider seed / override artifact）；variant 必须进入 request identity、compiled payload provenance 与 fingerprint。
- **adapter 不支持 variation 时**：**不允许用两个完全相同请求伪造 A/B**（无 seed 通道 → variant 只能来自 override artifact 或文本/参数的真实差异；否则 409 `VARIANT_UNSUPPORTED`）。

### 4.2 Attempt journal 与 indeterminate

- provider 请求**已发出后** timeout/连接中断 → 无法证明 upstream 是否完成 → attempt `indeterminate`，job 转 `indeterminate` 终态（沿用 generation_runs 租约过期保守语义）。
- **indeterminate 默认禁止自动再次调用 provider**（无服务端幂等键）；管理员/用户显式 retry 必须创建新 request/variant 或显式 override。
- **worker crash recovery**：
  - 文件已生成但 artifact DB 未提交 → orphan WAV（启动清扫或幂等重放覆盖；DB 无引用即不是 artifact）；
  - artifact DB 已提交但文件损坏 → exact reader fail-closed（不得当作可用音频）；
  - job running 但 heartbeat 过期 → `recoverStaleTtsJobs`（cancel 优先 / requeue）+ 释放 GPU lease；
  - in_flight attempt → indeterminate（沿 generation_attempts 既有模式）。
- **usage/cost 与 attempt 对账**：每次 provider 调用一行 attempt + `llm_usage`/`project_usage_events`（kind='tts'）关联；indeterminate attempt 也保留 usage 记录（cost 不可回滚，对账可解释）。

---

## 5. Voice materialization 真实 production 拓扑（§六 P0 修复）

### 5.1 Writer ownership（目标拓扑，TTS-C.1 生效）

```
Web
- 只验证/enqueue materialization request（校验 exact Assignment/source 授权）
- 不挂载 voice root、不挂载 registry、不执行任何文件写入

Worker
- 唯一 materialization writer
- voice root rw
- voice-config 目录 rw
- durable materialization request/job 执行（DB rows 是 authoritative）

Adapter
- voice root ro
- voice-config 目录 ro
- rootfs read-only
```

**不得给 Web 宿主 voice 写权限**（Web 无文件写能力，杜绝路径注入面）。

### 5.2 Mount 模型（废弃"单 registry 文件 bind mount + 原地 rename"假设）

```yaml
# 目标（TTS-C.1 部署）：
#   ZHIYING_HOST_VOICE_CONFIG_DIR:/voice-config    # Worker rw / Adapter ro
#   ZHIYING_HOST_VOICES_DIR:/voices                # Worker rw / Adapter ro
# registry 文件：/voice-config/voice-registry.json（temp 与 final 同目录 → 安全 atomic rename + directory fsync）
```

- registry 从"单个 bind-mount 文件"改为 **`/voice-config` 目录挂载**：temp（`voice-registry.json.tmp-<uuid>`）与 final（`voice-registry.json`）位于同一目录，才能原子 rename + fsync 目录。
- 不做原地 modify；发布始终 = 全量重建 + 原子替换（§5.3）。

### 5.3 Global registry publisher（DB 是 authoritative source）

- **global registry publication lock**（单进程锁 + DB `materialization_state` 行双保险）；per-voice lock 不足（两个 voice 并发发布会互相丢 entry）。
- 每次发布在锁内从 DB **全量确定性重建**完整 registry：
  1. 读 `materialization_state`（或 voice 表投影）全部 rows；
  2. canonical ordering（按 voiceProfileId asc, revisionId asc）；
  3. 构造完整 registry JSON（仅含 reference 文件已 durable 的 entry）；
  4. temp write → fsync → rename → **directory fsync**；
- **不做并发 read-modify-write patch**；两个不同 voice 并发 materialize 不丢 entry；crash 后可从 DB 重建（幂等重放）。

### 5.4 Adapter reload（last-known-good；TTS-C.1 修改 server.py）

冻结方案：

```
mtime/inode/size 检测（每次 /health 与 /v1/synthesize 前轻量 stat）
→ 若变化：原子加载新 registry 到临时 RegistryState（完整 schema/path/reference SHA 校验）
→ 校验全部通过：一次性 swap 内存 REGISTRY（单线程 FastAPI event loop，无锁热换）
→ 任一校验失败：保持 last-known-good REGISTRY，health.detail 报告 'VOICE_REGISTRY_PUBLISH_FAILURE: <reason>'
```

- **health 与 synthesize 触发 reload**：两个入口都做 stat 检测（synthesize 前检测保证不消费过期 registry；health 报告 reload 状态）。
- **reload 与并发 synthesize**：FastAPI 单 event loop + 原子指针 swap（`REGISTRY = new_state`），天然串行；不引入额外锁。
- **registry entry 删除/增加语义**：DB 全量重建——删除 = DB 无该 entry → 重建后消失（引用它的 synthesize 404，health 不 ready 直到 entry 恢复或清理）；增加 = DB 有该 entry → 重建后可用。
- **reference 文件必须先 durable，再发布 registry**（§5.3 顺序保证：先文件后 registry）。
- **不依赖 Docker restart / 不需要 docker.sock**（文件检测即可）。
- **adapter reload 测试**：真实 Python parser/reloader + mock upstream（httpx MockTransport），**不复制 Node 版镜像 validator**（各自单测，契约对齐）。

### 5.5 Archive 语义（与 TTS-A/B frozen 一致）

- Materialization 是 **transport projection/cache**，不是创建新 Voice Revision 或新 Assignment。
- archived Profile：禁止新 revision、新 Assignment（TTS-A/B 冻结）；
- **但**已有合法历史 exact Assignment 引用的 revision，若尚未 materialize，**必须允许按 exact source materialize**（否则历史 Assignment 永久不可执行）；
- materialized historical revision 必须可复用；
- **materialize API 必须接受 exact valid Assignment/source 授权**（校验请求引用的 Assignment artifact 存在、source 自洽、exact voice usable），**而不是仅按 Profile active 状态裁决**。

---

## 6. fingerprint 三分离与复用规则（§七 P0 修复）

### 6.1 三个 fingerprint（全部 length-prefixed + 版本化）

**`exactSourceFingerprint`**（source identity，覆盖 exact provenance）：

```
narrationPlanArtifactId
narrationPlanContentHash
unitId
normalized spoken text
assignmentArtifactId
assignmentContentHash
performancePlanArtifactId
performancePlanContentHash
voiceProfileId
voiceProfileRevisionId
canonicalAudioSha256
pronunciation revision / impact identity（未启用 = 'none'）
emotion reference identity（未启用 = 'none'）
materialization descriptor/version（voice materialization 状态版本）
```

**`synthesisPayloadFingerprint`**（只覆盖实际送 provider、可能影响声学输出的 canonical payload）：

```
normalized text
voice content identity（canonicalAudioSha256）
provider / model / providerVersion / providerCommit
capability compiler version
compiled delivery
compiled speed
compiled energy/emotion parameters
provider seed / variation（generationVariantId + seed）
normalization version
```

**`finalTtsInputFingerprint`**：

```
sha256(lengthPrefixed([exactSourceFingerprint, synthesisPayloadFingerprint, fingerprintVersion]))
```

### 6.2 复用规则（唯一合法依据）

- **默认**：`finalTtsInputFingerprint` 完全一致才复用（与 M7.1 冻结一致，扩展到 source identity）。
- **`sentence_audio_artifacts` 的 exact reader usable 才允许 reused**（damaged → 不复用）。
- **新 revision ID + 相同 canonicalAudioSha256 的矛盾**：
  - exactSourceFingerprint 不同 → **默认不直接复用**；
  - 如允许跨 source 声学等价复用，必须有显式 **immutable `acoustic_equivalence_attestation`**：记录两条 source（sourceA/sourceB）、证明字段（canonicalAudioSha256 / adapterCompatibilityKey / provider / codec / sample_rate / channels / duration_ms 等）、证明 compiler version（`acoustic-equivalence@1.0`）、attestedAt；调用方**禁止仅比较 SHA 后静默跨 revision/assignment 复用**。
- **A/B variant 进入 fingerprint**：`generationVariantId`（+ provider seed 若有）进入 `synthesisPayloadFingerprint` 与 request identity → 两个 variant 是**不同 synthesis identity**（各自独立 artifact），不冲突复用。
- **provider capability 升级**：进入 `synthesisPayloadFingerprint`（providerVersion/Commit + capabilityCompilerVersion）→ 升级即指纹变 → 旧音频不可自动复用（存量 artifact 保留，review 决定）。
- **pronunciation revision 改变**：进入 `exactSourceFingerprint` → 仅按影响范围 index 局部失效。

### 6.3 materialization 与 fingerprint

- materialization descriptor/version（`voice-materialization@1.0` + 发布序号）进入 exactSourceFingerprint：materialize 状态变化（如重新发布）→ source fingerprint 变 → 默认不复用（除非 acoustic_equivalence_attestation 证明声学等价——materialization 只改变 transport 路径不改变 canonical 内容时，attestation 可证明 SHA 一致）。

---

## 7. Capability compile neutral matrix（§八 P0 修复）

### 7.1 Neutral 默认值 = supported no-op（不是 unsupported）

从真实 Narration Plan/Performance schema 冻结 neutral 基线：

| intent 字段 | neutral 值 | 编译结果 |
|---|---|---|
| delivery（Narration Plan） | `normal` | `supported no-op`（不改变文本/参数） |
| deliveryOverride（Performance） | `null`（继承 plan） | 同 delivery=normal → no-op |
| pace | `normal` | `supported no-op`（speed=1.0 已含于现有 synthesisParameters） |
| energy | `normal` | `supported no-op` |
| emotion | `{mode:'none'}` | `supported no-op`（adapter 接受 emotion='none'） |

**mandatory neutral 默认值不得导致所有 unit 被 block**：compiler 必须把 neutral 组合编译为"可执行 no-op"并记 `unsupportedFlags=[]`。

### 7.2 非 neutral 值

| intent 字段 | 非 neutral 值 | 编译规则 |
|---|---|---|
| delivery / deliveryOverride | `slow/fast/soft/firm/emphasis` | 有真实 adapter 通道 → compiled；无通道 → **explicit unsupported**（候选：文本级改写策略 TTS-C.1 决策，默认显式 unsupported） |
| pace | `slow/fast` | 有通道 → compiled（speed 参数）；无通道 → explicit unsupported |
| energy | `low/high` | 有通道 → compiled；无通道 → explicit unsupported |
| emotion | `{mode:'semantic', label}` / vector / reference | 有通道 → compiled（emotion 参数）；无通道 → explicit unsupported |

- **unsupportedFlags 精确**（每条 intent 独立 flag + 影响 unit 列表）。
- **block/review 语义精确**：unsupported 非 neutral → 该 unit `blocked`（或 needs_review 由项目策略定，**不得静默丢弃**）；文档与 TTS-B `PROVIDER_CAPABILITY_UNRESOLVED` issue 一致。
- **capability/compiler version** 进入 provenance + `synthesisPayloadFingerprint`。

---

## 8. Manifest/Master 非循环身份（§五 P0 修复）

### 8.1 Selection manifest（`narration_audio_selection_manifest@2.0`）

废弃"manifest 内含 masterSourceIdentity/master output"设计（循环：manifest 引用 master，master 又引用 manifest hash）。改为：

```json
{
  "schemaVersion": "narration-audio-selection-manifest@2.0",
  "compilerVersion": "2.0",
  "source": {
    "narrationPlanV2ArtifactId": "...", "narrationPlanV2ContentHash": "...",
    "assignmentArtifactId": "...", "assignmentContentHash": "...",
    "performancePlanArtifactId": "...", "performancePlanContentHash": "..."
  },
  "units": [
    {"unitId": "N001", "kind": "speech",
     "selectedAudioArtifactId": "<sentence_audio_artifacts.id>",
     "audioSha256": "...", "durationMs": 1234,
     "exactSourceFingerprint": "...", "finalTtsInputFingerprint": "...",
     "spokenText": "...", "delivery": "normal",
     "gapMs": 0, "gapReason": null},
    {"unitId": "N002", "kind": "silence", "durationMs": 500, "reason": "pause", "resolved": true}
  ],
  "reviewSource": {"requestId": "...", "reviewedBy": "...", "reviewedAt": "...", "lock": true}
}
```

**不包含**：master output path / master SHA / master duration / masterSourceIdentity。
- 顺序与 Narration Plan 逐 index 对齐（缺失/重复 → `NARRATION_AUDIO_INVALID`）；selection 只引用 immutable `sentence_audio_artifact_id`；stale artifact（fingerprint 与当前 exact source 链不一致）→ manifest 分类 stale，不自动替换。

### 8.2 Master artifact（`narration_master_audio@1.0`，独立 immutable artifact）

```json
{
  "schemaVersion": "narration-master-audio@1.0",
  "compilerVersion": "2.0",
  "source": {
    "selectionManifestArtifactId": "...",
    "selectionManifestContentHash": "...",
    "concatCompilerVersion": "2.0"
  },
  "output": {
    "outputRelativePath": "projects/<pid>/audio/narration-master-<manifestId>.wav",
    "sha256": "...", "size": 123456,
    "codec": "pcm_s16le", "sampleRate": 48000, "channels": 1,
    "ffprobeDurationMs": 123456
  },
  "createdAt": "..."
}
```

- **身份（非循环）**：

```
masterInputFingerprint = sha256(lengthPrefixed([
  selectionManifestArtifactId,
  selectionManifestContentHash,
  concatCompilerVersion
]))
```

- **顺序**（durability 先于 DB commit，TTS-A 模式）：

```
selected immutable manifest
→ durable master temp/write/probe/rename/fsync
→ immutable master artifact DB commit（trigger ABORT 禁 UPDATE/DELETE）
```

- master 只依赖 selection manifest 内容（间接引用 sentence artifacts），不依赖 plan/performance 直接字段——避免链路混淆与循环。

---

## 9. Downstream stale 传播图（保留并强化）

```
sentence audio（immutable artifact + selection）
  │  selection 变化（review 切换 selectedAudioArtifactId）
  ▼
narration_audio_selection_manifest@2.0（candidate → selected/locked）
  │  manifest 变化（顺序/时长/选择）
  ▼
narration_master_audio@1.0（masterInputFingerprint 变化）
  │  master SHA 变化
  ▼
subtitle_timing_v2（unit 边界 = ffprobe 实测；句内 = 文本权重比例估算）
  │  时长变化 → 该句 cue 区间 + 其后 cue 平移
  ▼
timing-reconciliation@2.0（scenes + audio + subtitle 三源）
  ▼
storyboard → animatic → final render
```

**精确失效规则**（禁止笼统"下游全部 stale"）：

| 变化 | 影响 |
|---|---|
| 文本变化 | 受影响 unit 音频 stale → manifest stale → master stale → subtitle 全链 stale |
| 声音变化（voice revision 或同文本重合成） | 音频 SHA/时长可能变 → manifest/master stale；ffprobe 时长不变且文本不变 → subtitle 可复用（reconciliation 决策） |
| Performance 变化 | 仅受影响 unit → 同声音变化规则 |
| 单句时长变化 | 该句 cue + 其后 cue 平移 → subtitle_timing_v2 全量确定性重算（复用未变 unit 实测时长，不重新生成音频） |
| 仅 provider metadata | 不自动失效；review 决定 |
| master SHA 变但时长相同 | provenance 变 → 需重建 subtitle（v1 语义 matchesCurrentSource 按 hash 匹配），重算成本低 |

---

## 10. Security / 边界（贯穿 TTS-C）

- API 序列化出口不含任何文件路径（materialize/master/sentence audio 全部沿用 TTS-A 纪律）；音频下载走受控 route 或不出 API。
- 客户端只提交 ID；路径全部服务端构造；输出路径防 traversal/symlink（realpath containment + final 非 symlink）。
- Web 无 voice/registry 挂载、无文件写能力（§5.1）。
- 不引入新 secret；attempt journal 只存安全 request 投影（无 header/secret）。
- materialize registry 是服务端生成物，不信任客户端 path。

---

## 11. Tests / Migrations / Deployment order（概要）

- 测试：TTS-C 每阶段 `scripts/test-tts-c-*.ts`，临时 DB + Mock provider + 零真实 IndexTTS2；纳入统一 `run-m7-quality-gate.sh`。
- migration：每阶段一个可回滚 migration（副本演练 + 幂等重跑 + integrity ok），禁手工 sqlite3。
- deployment：每阶段 exact-SHA build + 镜像内 gate + backup + compose up + invariants + docs evidence commit；TTS-C.0.R1 无代码无部署。

---

## 12. Unresolved decisions（TTS-C.1 前定）

1. delivery 编译策略（文本改写 vs 显式 unsupported，推荐显式 unsupported）。
2. pace 经 adapter 扩展直传可行性（upstream duration control 支持度）。
3. unit vs sentence 原子单位（推荐 unit；sentence preview 独立评估）。
4. capability 升级后存量成功音频失效策略（推荐不自动删，review 决定）。
5. pronunciation dictionary 是否纳入（推荐 TTS-C.3 后评估）。
6. master 拼接：Node PCM concat（现状）vs ffmpeg concat filter（TTS-C.4 定）。
7. materialization_state 表结构（TTS-C.1 定：rows = authoritative source of registry）。

## 13. Recommended first implementation stage

**TTS-C.1A**（voice materialization durable requests/files/DB projection）——零音频风险、解锁全部 materialization 依赖；随后 1B（global registry + adapter reload）、1C（capability compiler）按序；C.2 依赖 1A/1B/1C 全部就绪（envelope + artifact + fingerprint 需要 materialization 与 capability 支持）。
