# TTS-C Incremental Narration 架构设计（TTS-C.0 只读审计，未实现）

> 状态：**TTS-C.0 architecture audit completed；TTS-C runtime implementation not started**。
> 本文档是只读架构审计产物：不修改 runtime code / schema / config / migration / compose。
> 运行时真相以代码为准（本审计基于 m7 @ `8833393`；TTS-B final code `86f7f52…` 已 FROZEN）。
> 所有 schema/表/路径描述来自真实代码（`src/lib/db.ts`、`src/lib/tts-jobs.ts`、
> `src/lib/tts/fingerprint.ts`、`src/lib/narration/audio*.ts`、`src/lib/subtitles/*`、
> `services/indextts2-api-adapter/server.py` 等）。

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
- artifact `narration_performance_plan`（`narration-performance-plan@1.0`，compiler `1.0`，prompt `narration-performance-plan@1.0`）：`source` 三层（Narration Plan exact / Assignment exact / voice descriptor 逐项一致）+ `generation{requestId, provider, model, attemptCount}` + `items`。
- `PerformanceItemV1`：`{unitId: Nddd, deliveryOverride: null|enum, pace: slow|normal|fast, energy: low|normal|high, emotion: {mode:'none'}|{mode:'semantic', label}}` —— **provider-neutral synthesis intent**，adapter 当前不消费。
- generation 控制面：`generation_runs`（`UNIQUE(project_id, stage, request_id)`，stage `m7_narration_performance_plan`）+ `generation_attempts` + `generation_dispatch_jobs`（Web enqueue-only，202；worker `dispatch-executor` 执行）。

### 1.3 现有 TTS job 体系（M3-B / M7.1，frozen 语义，**不是** TTS-C 产物）

- 表 `tts_jobs`：`id / project_id / narration_plan_artifact_id / narration_plan_version / unit_id / provider / voice_profile_id / voice_profile_revision / status(queued|running|succeeded|failed|cancelled) / payload_json / output_path / duration_ms / audio_sha256 / result_json / queued_at / started_at / finished_at / claimed_by / claimed_at / heartbeat_at / attempt / max_attempts(=2) / progress / error_code / error_message / cancel_requested`，索引 `(project_id, unit_id, status)`。
- payload：`tts-payload@1.0`（`unitText`）与 `tts-payload@1.1`（`spokenText + delivery + ttsInputFingerprint`）union；`parseTtsJobPayload` fail-closed。
- 幂等键：`getActiveTtsJob(project_id, narration_plan_artifact_id, unit_id, provider, voice_profile_id, voice_profile_revision)`；`getLatestSucceededTtsJob` 同键 status=succeeded 最新。
- 执行：worker `tts-executor.ts` —— claim（scheduler，GPU lease `production_gpu`）→ Gate C leakage → provider 按 `job.provider` 快照解析 → 5s heartbeat（job + GPU lease）→ `synthesize` → 写盘 `projects/{pid}/audio/units/{planVersion}/{unitId}-{job.id}.wav`（`.tmp` → ffprobe/sha256 校验 → `renameSync`）→ `finalizeTtsJobSuccess`（BEGIN IMMEDIATE：cancel 优先）→ 非 SUCCEEDED 删已 rename WAV；失败 `failTtsJob`（retryable + attempt<2 → requeue）；`recoverStaleTtsJobs`（heartbeat 2min 超时 → cancel/requeue + 释放 lease）。
- 消费方：`src/lib/narration/audio.ts`（v1 管线）—— `tryFinalizeNarrationAudio` 组装 `narration_audio_manifest`（kind=`narration_audio_manifest`）+ master WAV（`projects/{pid}/audio/narration-master-v{planVersion}-{provider}-{voice}.wav`，Node `Buffer.concat` + wrapPcmAsWav，非 ffmpeg concat）→ `subtitle_timing`（`subtitle-timing@1.0`）→ `timing_reconciliation`（`timing-reconciliation@1.0`）→ final-render bridge。
- **v2 管线半成品**：`narration_audio_manifest_v2` 只有 schema（`src/lib/narration/audio-v2-manifest.ts`）；`enqueueNarrationAudioJobsV2` + `planTtsReuseDecisions`（`audio-v2.ts`）未接 API/UI；`subtitle_timing_v2` 只有 schema + 纯函数 compiler（无 artifact 层/API）；`timing-reconciliation@2.0` **不存在**。
- 时长唯一真相：`tts_jobs.duration_ms`（worker `probeAudio` ffprobe 实测）；master 时长由 PCM 字节长度计算；subtitle 容差 `AUDIO_TIMELINE_TOLERANCE_MS=100`。

### 1.4 IndexTTS2 Adapter（M4-B production registry 版，`server.py` @ `22ab6b2e…` 镜像）

- 对 Zhiying 暴露：`GET /health`、`POST /v1/synthesize` → audio/wav bytes；无 GPU、无 torch。
- **`/v1/synthesize` 仅支持**：`text`（非空）+ `voiceProfile@voiceRevision`（registry 键）+ `useRandom=false`（否则 422 `UNSUPPORTED_USE_RANDOM`）+ `emotion='none'`（否则 422 `UNSUPPORTED_EMOTION`）。
- **无 delivery/pace/energy/emotion/prosody 传递通道**；无 duration 控制；无 pronunciation 输入。
- voice 身份：SHA-256（Zhiying immutable source of truth）+ MD5（upstream speaker cache 兼容 id）；`speaker_id` 不进入 Zhiying contract；per-voice single-flight（进程内 lock）。
- registry：`ADAPTER_VOICE_REGISTRY_PATH`（JSON `{schemaVersion:'1.0', voices:[{voiceProfile, voiceRevision, speakerName, referenceAssetPath(绝对路径), referenceSha256}]}`），启动即校验 + 运行时 `_check_voice`（mtime+size 缓存 SHA-256）；registry 未配置/非法 → ready=false。
- containment：`ADAPTER_VOICE_ROOT` realpath + `commonpath` 校验，拒绝相对路径/`../`/symlink 逃逸。
- **voice materialization API 不存在**：无代码从 voice-library 生成 registry JSON 或同步 `/voices`；`ZHIYING_HOST_VOICES_DIR:/voices:ro` 与 `ZHIYING_HOST_VOICE_REGISTRY:/config/voice-registry.json:ro` 是部署时手工配置。

### 1.5 TTS Provider 抽象（`src/lib/tts/`）

- `TtsRequest`：`{text, voiceProfile:{id,revision}, unitId, style?:{directive?}, emotion?:{mode:'none'|'text'|'vector'}}`；**无 prosody/delivery 顶层字段**；v1.1 的 delivery 由 executor 映射 `style.directive`，但 indextts2 实现 body 未发送该字段（`indextts2.ts:103-109` 只发 text/voiceProfile/voiceRevision/useRandom/emotion）。
- `TtsResult`：`{audio, format:'wav', provider, model, providerVersion?, providerCommit?, settings:{voiceProfileId, voiceProfileRevision, useRandom}}`；**Provider 不宣称 duration**。
- `TtsErrorCode`：`CONFIG_ERROR / PROVIDER_UNAVAILABLE / PROVIDER_TIMEOUT / PROVIDER_HTTP_ERROR / PROVIDER_INVALID_RESPONSE / INVALID_AUDIO / CANCELLED`。

### 1.6 现有 fingerprint（M7.1 REVIEW 1.3 冻结，**复用旧音频唯一合法依据**）

`computeTtsInputFingerprint`（`src/lib/tts/fingerprint.ts`）：length-prefixed 拼接
`normalizedSpokenText + voiceIdentity(pid@rid) + referenceAudioHash + ttsModelVersion(provider/model/providerVersion/providerCommit) + delivery + speed('1.0') + synthesisParameters('{}') + normalizationVersion('tts-text-norm@1.0')` → `sha256:…`。
已有 `ttsInputFingerprint` 出现在 `tts-payload@1.1` 中。**该公式不含**：narration plan artifact id/hash、assignment artifact id/hash、performance plan artifact id/hash、unitId、compiled pace/energy/emotion、provider capability version、pronunciation revision。→ TTS-C 必须扩展（§3）。

---

## 2. Exact input chain（§6.1）

单句 TTS 的 exact input（全部显式 ID，禁止 current/latest/default 解析）：

```
Narration Plan V2 artifact（exact artifactId → content_hash / schemaVersion / compilerVersion / scriptV2VersionId / scriptV2Version / scriptV2ContentHash）
├── exact SpeechUnit（unitId Nddd + exact spokenText + subtitleText + delivery + sourceText）
├── Project Voice Assignment artifact（exact artifactId → content_hash）
│   └── exact Voice Profile + Voice Profile Revision descriptor
│       （voiceProfileId + voiceProfileRevisionId + canonicalAudioSha256 + adapterCompatibilityKey + provider）
├── Narration Performance Plan artifact（exact artifactId → content_hash）
│   └── exact PerformanceItem（unitId → deliveryOverride / pace / energy / emotion）
├── provider capability snapshot（provider / model / providerVersion / providerCommit / capabilityCompilerVersion）
├── pronunciation dictionary revision（如启用；TTS-C.2 设计）
└── emotion reference identity（adapter 能力就绪后；当前 emotion='none'）
```

**进入最终输入身份（fingerprint）的字段**必须覆盖声学相关全部输入（M7.0 §1.2 冻结：`normalizedSpokenText, voiceIdentity, referenceAudioHash, ttsModelVersion, delivery, speed, synthesisParameters, normalizationVersion`）+ TTS-C 新增的 exact source 身份。**不进入声学身份的字段**（如 artifact id 本身仅作 provenance）与**进入身份但属 source identity 的字段**区分见 §3。

---

## 3. Final `ttsInputFingerprint` 提案（§6.2）

### 3.1 两段式结构（TTS-C.2 实现，canonical + versioned）

**Segment A — exact source identity（复用/失效判定）**，length-prefixed：

```
narrationPlanArtifactId
narrationPlanContentHash
unitId
exact spokenText（normalizeSpokenText 后）
assignmentArtifactId
assignmentContentHash
performancePlanArtifactId
performancePlanContentHash
voiceProfileId
voiceProfileRevisionId
canonicalAudioSha256
adapterCompatibilityKey
```

**Segment B — compiled provider payload（声学参数）**，即现有 M7.1 冻结公式的 8 字段：

```
normalizedSpokenText
voiceIdentity（voiceProfileId@voiceProfileRevisionId）
referenceAudioHash（= canonicalAudioSha256）
ttsModelVersion（provider/model/providerVersion/providerCommit 组合）
compiledDelivery（deliveryOverride ?? plan.delivery）
compiledSpeed（pace 编译结果，canonical 字符串）
compiledSynthesisParameters（energy/emotion 编译结果，canonical JSON 键序固定）
normalizationVersion（TTS_TEXT_NORMALIZATION_VERSION）
```

**v2 公式**（版本化）：

```
sha256(lengthPrefixed(A) + '|' + lengthPrefixed(B))
```

- **source identity 字段**（Segment A）：决定"这条 exact source 链是否变化"——任一变化 → 旧音频不可复用（fail-closed，除非证明声学等价）。
- **compiled provider payload 字段**（Segment B）：决定"同一 source 链下实际送到 provider 的声学输入是否变化"。
- **生成时机**：**materialization 后、enqueue 前**生成——enqueue 时 snapshot 进 tts_jobs（新列 `tts_input_fingerprint`），执行期与 worker 重算比对（fail-closed：不一致 → 不合成，`INPUT_FINGERPRINT_MISMATCH`）。
- **防序列化漂移**：全部字段先归一化（NFC + 空白折叠 + trim 用于文本；枚举用 canonical 字面量；JSON 用固定键序 `JSON.stringify` 前递归排序）；length-prefixed 杜绝边界歧义。
- **provider capability 升级**：capability snapshot（providerVersion/providerCommit/capabilityCompilerVersion）进入 Segment B 的 `ttsModelVersion` → 升级即 fingerprint 变化 → 旧音频 stale（只影响未来复用判定，不自动删除旧 artifact）。
- **pronunciation revision 改变**：若实现发音词典（TTS-C.2 可选），发音 revision id 进入 Segment A（source identity）——变化只失效**受影响的 unit**（按发音词典影响范围 index 定位），非全量失效；未受影响 unit 复用旧音频。
- **compat 说明**：现有 `tts-payload@1.1` 的 fingerprint 是 Segment B 的旧版（无 Segment A）；TTS-C 引入 `tts-payload@2.0`（`ttsInputFingerprintV2` + 完整 source 引用），旧 payload 保持可读（union 解析），**不改写历史 tts_jobs**。

---

## 4. Adapter Voice Materialization（§6.3；TTS-C.1）

现状：`ZHIYING_HOST_VOICES_DIR:/voices:ro` + `ZHIYING_HOST_VOICE_REGISTRY:/config/voice-registry.json:ro` 是部署时手工配置；无 materialization 代码。

### 4.1 目标设计（实现方案，TTS-C.1 执行）

新增服务端 materialization API（如 `POST /api/voice-profiles/[profileId]/revisions/[revisionId]/materialize`，requestId 幂等）：

1. **source file**：`voice-library/<pid>/<rid>/reference.wav`（TTS-A exact validator 已保证 canonical + SHA 一致）。
2. **destination**：宿主 `/voices` 目录（或可配置的 voice root）下的确定性路径，如 `<VOICE_ROOT>/<pid>/<rid>/reference.wav`；**registry JSON** 的 `referenceAssetPath` 必须绝对路径且 realpath containment 校验（复用 adapter 现有规则）。
3. **registry schema**：保持 adapter `{schemaVersion:'1.0', voices:[{voiceProfile, voiceRevision, speakerName, referenceAssetPath, referenceSha256}]}`；`speakerName` 用确定性可读 label（`pid-rid-前8位` 或 display_name slug），**不作内容证明**；`referenceSha256 = canonicalAudioSha256`（DB 权威）。
4. **原子写**：temp 写（同目录 `.tmp-<uuid>`）→ fsync → `renameSync` → fsync 父目录（复用 TTS-A durability 模式）；registry JSON 同样 temp 写 + rename（文件级原子发布）。
5. **registry publish 与并发 single-flight**：per `pid@rid` 的 DB/进程内锁；同 requestId 幂等（已 materialized 且 SHA 一致 → 200 reused）；并发两个 materialize 恰好一个写。
6. **crash recovery / orphan cleanup**：materialize 是幂等重放（DB 记 `materialization_state` 行或复用 registry 声明）；temp 文件 best-effort cleanup；orphan（已写文件但未发布 registry）下次重放时覆盖；**cleanup 不得删除 DB 已引用文件**（TTS-A 不变量迁移）。
7. **historical revision reuse**：materialize 以 `pid@rid` 精确键——新 revision 是新文件/新 registry 条目，不覆盖旧 revision；archive 后**已 materialized voice 仍可用**（adapter registry 不因 archive 删除；archive 只禁止新 materialize/新合成入口的创建语义由 TTS-C 定义——倾向：archive 后已 materialized 条目保留，新 materialize 拒绝 409）。
8. **file missing / hash mismatch**：adapter `_check_voice` 已 fail-closed（`REFERENCE_VOICE_MISSING` / `REFERENCE_SHA256_MISMATCH` → 503）；Zhiying 侧 TTS-C 在 enqueue 前也重新 `validateVoiceProfileRevisionExact` + 可选的 materialize 状态校验。
9. **container restart/redeploy**：adapter 启动即加载 registry 并校验；registry 文件/`/voices` 内容持久于宿主——重启无状态丢失；redeploy 仅重新挂载同一路径。
10. **路径安全**：Zhiying 侧**不暴露**宿主绝对路径（API 响应不含 path，沿用 TTS-A 序列化纪律）；**不信任客户端 path**（materialize 请求只接受 profileId/revisionId，目标路径全部服务端构造）；adapter 侧 containment 已冻结。
11. **幂等 request identity**：materialize 表 `UNIQUE(voice_profile_id, voice_profile_revision_id, request_id)` + `artifact/state` 快照（沿用 assignment envelope 模式，TTS-C.1 定义）。

---

## 5. Provider Capability Compile（§6.4；TTS-C.1 实现 capability snapshot + compile 纯函数）

### 5.1 三层区分（禁止静默丢弃已锁定表演参数）

| 层 | 内容 | 来源 | 失效语义 |
|---|---|---|---|
| authorial intent | Narration Plan `delivery`（semantic baseline）+ Performance `deliveryOverride / pace / energy / emotion`（provider-neutral） | 冻结 artifact | locked 漂移 → stale |
| compiled capability | 将 intent 编译为 adapter 可表达的控制：`compiledDelivery / compiledSpeed / compiledSynthesisParameters` + `unsupportedFlags[]` | capability compiler（版本化） | capability/compiler 版本变化 → fingerprint 变 |
| provider payload | 实际发往 adapter 的字段：`text / voiceProfile / voiceRevision / useRandom=false / emotion`（当前 adapter 仅此） | adapter contract | provider 升级 → capability 重编译 |

### 5.2 当前 adapter 实际支持（`server.py` 实证）

- **可直传**：`text`、voice 身份、`useRandom=false`、`emotion='none'`。
- **不可直传**：delivery/pace/energy/emotion(semantic) 全部**无通道**。
- **fallback/degradation 规则（TTS-C.1 设计，必须显式）**：
  - `delivery`/`deliveryOverride`：可编译为**文本级处理候选**（如轻声/强调的标点与引导词改写）或**标记 unsupported**；**不得静默丢弃**。TTS-C.1 决策点：倾向 `unsupported` 显式标记 + `capability compiler version` 记录，进入 review/block 而非静默降级（延续 TTS-B `PROVIDER_CAPABILITY_UNRESOLVED` issue 语义）。
  - `pace`：IndexTTS-2 upstream 若支持 duration/speed 控制（IndexTTS-2 官方宣称 precise duration control），需 adapter 扩展字段（如 `speed`）；扩展前 `pace` 标记 unsupported。
  - `energy`：无通道 → unsupported。
  - `emotion.semantic`：upstream `emo_vector`/`emo_alpha` 存在但**当前 adapter 显式拒绝**（`UNSUPPORTED_EMOTION`，注释"不传 emo_vector/emo_alpha/emotion random/text"）→ 保持 unsupported，TTS-C 不绕过。
- **capability/compiler version 进入 provenance 与 fingerprint**：capability snapshot（provider/model/providerVersion/providerCommit + capabilityCompilerVersion + compiled 字段）写入 tts_jobs result_json 与 sentence audio artifact provenance；compiled 结果进入 fingerprint Segment B。

---

## 6. Sentence Audio Artifact 与 Durable Job（§6.5 / §6.6；TTS-C.2）

### 6.1 决策：复用 `tts_jobs` 表 + 扩展列，不新建 job 表

现有 `tts_jobs` 已具备完整生命周期（queued/running/succeeded/failed/cancelled、heartbeat、stale recovery、cancel、retry、claim、lease、output_path/duration_ms/audio_sha256/result_json、幂等键）。TTS-C 不需要 Redis/BullMQ。

**新增列（TTS-C.2 migration，append-only ALTER，禁止手工 sqlite3）**：

```sql
ALTER TABLE tts_jobs ADD COLUMN tts_input_fingerprint TEXT;       -- fingerprint v2
ALTER TABLE tts_jobs ADD COLUMN assignment_artifact_id TEXT;
ALTER TABLE tts_jobs ADD COLUMN performance_plan_artifact_id TEXT;
ALTER TABLE tts_jobs ADD COLUMN capability_compiler_version TEXT;
ALTER TABLE tts_jobs ADD COLUMN capability_snapshot_json TEXT;    -- provider snapshot 入队时固化
-- 新 payload 版本 tts-payload@2.0（含完整 source 引用 + fingerprintV2），旧 v1.0/v1.1 union 保持可读
```

**不新建 envelope 表**：`tts_jobs` 即 durable envelope + artifact 行（每 unit 一 job，延续现有语义）；如需 sentence 级 preview（unit 内单句），新增 `sentence_audio_jobs`（TTS-C.3）或复用 unit job 产物——**TTS-C.2 决策点**：正式音频以 **unit 为原子**（subtitle v1 已按 unit 时长推进，v2 的 subtitleText 才是句级 cue 源），sentence 级 preview 在 TTS-C.3 单独评估。

### 6.2 幂等身份升级

现有幂等键（plan, unit, provider, voice）→ 升级为**fingerprint 级**：同 `(project_id, narration_plan_artifact_id, unit_id, tts_input_fingerprint)` 已有 succeeded job → 直接复用产物（`fingerprint 一致 = 复用唯一合法依据`，M7.1 冻结）；active job → 202 running；fingerprint 不同 → 新 job（不覆盖旧）。

### 6.3 状态机（沿用 + 扩展）

```
queued → running（claim + GPU lease + attempt+1）
running → succeeded（finalizeTtsJobSuccess：cancel 优先；写 output/duration/sha256/result+capability+provenance）
running → queued（retryable && attempt < max_attempts）→ failed（达上限）
running → cancelled（cancel_requested）
running → queued/cancelled（recoverStaleTtsJobs heartbeat 超时；lease lost → requeue）
```

- **crash window**：文件写盘在 `finalizeTtsJobSuccess` 之前完成（`.tmp` → 校验 → rename）；rename 后、DB commit 前 crash → orphan WAV（DB 无引用，启动时 best-effort 清扫或幂等重放覆盖）；DB succeeded 但文件缺失/hash 漂移 → exact reader 返回 unusable（fail-closed，不得当作可用音频）。
- **cancel**：cancel_requested 优先于 success/failure（现有原子裁决已冻结）。
- **provider timeout**：`PROVIDER_TIMEOUT` → retryable；`PROVIDER_INVALID_RESPONSE / INVALID_AUDIO / PAYLOAD_INVALID / PAYLOAD_CONTAMINATED / CONFIG_ERROR` 非重试。
- **usage/cost**：`project_usage_events`（kind='tts'）已有记录路径（`recordJobComputeUsage`），TTS-C 沿用。
- **GPU lease**：`production_gpu` lease 与心跳已有；TTS-C 不改资源模型。
- **exact result artifact**：`tts_jobs` 行即 artifact 行（append-only：每次 regeneration 新 job 新行，**绝不 UPDATE 旧行产物字段**——同 unit 新 fingerprint → 新 job → 新 output file `{unitId}-{job.id}.wav`）。
- **输出路径防穿越**：`{unitId}-{job.id}.wav` 服务端构造（unitId 严格 `N\d{3}` + job UUID），不信任外部；沿用 TTS-A symlink/realpath 防护模式。

---

## 7. Incremental Regeneration 与 A/B Review（§6.7 / §6.10；TTS-C.3）

### 7.1 失效规则（只失效受影响 unit，禁 full regeneration）

| source 变化 | 失效范围 |
|---|---|
| locked Script V2 变化（文本变） | 受影响 unit（diff 定位）+ 依赖其 Performance 的 unit 全链 |
| Voice Profile/Revision 变化（新 revision 或原 revision 损坏） | **该 voice 的所有 unit**（voice 是全局声学身份）——但若新 revision 与旧 canonicalAudioSha256 相同则声学等价可复用 |
| Performance item 变化（deliveryOverride/pace/energy/emotion） | 该 unit |
| pronunciation dictionary revision 变化 | 受影响 unit（按影响范围 index） |
| provider capability 升级 | fingerprint 变 → 旧音频不可复用（未来合成用新 capability），存量成功音频是否失效由 TTS-C.2 策略决定（倾向：**不自动删**，由 review 决定重生成） |
| 仅 provider metadata（providerVersion 同模型 patch） | 若 capability compiler 判定声学等价 → 不失效；否则失效 |

### 7.2 Selection（A/B）

- 新增 selection 概念（TTS-C.3）：`selected_sentence_audio` 或 manifest 内 per-unit 引用（§8）。
- **不可 UPDATE 旧音频**：每次 regeneration 新 artifact（新 tts_jobs 行 + 新 WAV），selection 指针切换到新 artifact；旧 artifact 保留（candidate 历史）。
- **override provenance**：每个 unit 的 selection 记录 `selected tts_job_id / fingerprint / overrideRequestId / reviewedBy / reviewedAt / source`（bulk approve / unit override / 自动 selection 区分）。
- **preview 与正式生成共用 artifact**：preview 调用同一合成路径（provider + 校验 + 写盘 + DB 行），只是 status/selection 标记不同（`preview` 状态或 selection=null）；不引入第二套合成通道。

### 7.3 Review nodes（正式 workflow 状态，TTS-C.5 接入 UI）

```
Voice Assignment Review（TTS-B 已有 current_candidate 分类；TTS-C 增加确认动作）
Performance Plan Review（TTS-B 已有；TTS-C 增加确认动作）
Sentence Audio Review（新：preview/A-B/accept/reject/exact selected revision/bulk）
Narration Master Review（TTS-C.4 后）
Timing Review（后续阶段）
```

- **lock**：review 通过后的 selection 可以被 lock（进入 master 构建的前提）；locked 后 source 漂移 → stale 提示 + 需要重新 review（fail-closed，不自动重选）。
- **failed/retry UI + cost/usage 展示**：tts_jobs 状态与 usage 数据已有，TTS-C.5 接入。

---

## 8. Narration Audio Manifest 与 Master（§6.8；TTS-C.4）

### 8.1 Manifest（immutable candidate，kind `narration_audio_manifest_v2`——复用现有 schema 并补 artifact 层）

```json
{
  "schemaVersion": "narration-audio-manifest@2.0",
  "compilerVersion": "2.0",
  "source": {
    "narrationPlanV2ArtifactId": "...", "narrationPlanV2ContentHash": "...",
    "assignmentArtifactId": "...", "assignmentContentHash": "...",
    "performancePlanArtifactId": "...", "performancePlanContentHash": "...",
    "masterSourceIdentity": "..."   // 见 8.2
  },
  "units": [
    {"unitId": "N001", "kind": "speech", "selectedJobId": "...", "outputPath": "...",
     "audioSha256": "...", "durationMs": 1234, "fingerprint": "sha256:...",
     "spokenText": "...", "delivery": "normal",
     "gapMs": 0, "gapReason": null},
    {"unitId": "N002", "kind": "silence", "durationMs": 500, "reason": "pause", "resolved": true}
  ],
  "master": {"outputPath": "...", "sha256": "...", "durationMs": 123456, "concatCompilerVersion": "2.0"}
}
```

- **顺序与 Narration Plan 完全一致**：按 plan.units 逐 index 对齐（unitId+kind 校验），缺失/重复 → `NARRATION_AUDIO_INVALID`（沿用 v1 compiler 校验模式）。
- **manifest 是 candidate 还是 selected**：candidate（同 TTS-A/B 纪律——candidate ≠ selected ≠ active）；**selected 由 downstream review lock 决定**；master 构建只接受 selected manifest。
- **gap/transition**：显式 silence unit（PCM 静音占位，沿用 `silencePcm` 模式）+ speech 间 gap 决策记录（gapMs/gapReason）；无时长项（未 resolved）→ 不进 master 时间轴（沿用 v1 cursor 语义）。
- **stale sentence artifact**：manifest 内 selectedJobId 引用的音频若 fingerprint 与当前 exact source 链不一致 → manifest 分类 stale（不自动替换）。
- **concat 失败 / master partial file**：master 构建 temp 写 + ffprobe 校验 + rename；失败 → 旧 master 不覆盖；partial temp best-effort cleanup。
- **manifest 与 master atomicity**：manifest artifact 行 + master 文件在同一提交序列中完成（文件先 durable 再 DB commit，复用 TTS-A durability 顺序：**final 文件/目录 fsync 全部先于 SQLite commit**）。

### 8.2 Master source identity

`masterSourceIdentity = sha256(lengthPrefixed([manifestArtifactId, manifestContentHash, concatCompilerVersion, orderedSelectedAudioSha256s, gapDecisions]))`——master 只依赖 manifest 内容，不依赖 plan/performance 的间接字段（避免链路混淆）。

---

## 9. Downstream Stale 传播图（§6.9）

```
sentence audio（tts_jobs 行 + selection）
  │  selection 变化（review 切换 selectedJobId）
  ▼
narration_audio_manifest_v2（candidate → selected）
  │  manifest 变化（顺序/时长/选择）
  ▼
narration master WAV（concatenation）
  │  master SHA 变化
  ▼
subtitle_timing_v2（编译器：unit 边界 = ffprobe 实测；句内 = 文本权重比例估算）
  │  时长变化（单句时长变化 → 该句 cue 区间变化 + 后续所有 cue 时间轴平移）
  ▼
timing-reconciliation@2.0（scenes + audio + subtitle 三源）
  ▼
storyboard → animatic → final render
```

**精确失效规则（禁止笼统"下游全部 stale"）**：

| 变化 | 影响 |
|---|---|
| 文本变化（spokenText） | 受影响 unit 音频 stale → manifest stale → master stale → subtitle 全链 stale（文本变了 cue 内容变） |
| 声音变化（voice revision 或同文本重合成） | 音频 SHA/时长可能变 → manifest/master stale；若 ffprobe 时长与旧一致且文本一致，subtitle **可复用**（时长真相不变）——由 reconciliation 决策，不自动全 stale |
| Performance 变化 | 仅受影响 unit 音频/时长变 → 同声音变化规则 |
| 单句时长变化 | 该句 cue 区间 + 其后 cue 全部平移（subtitle timing 依赖累计 cursor）→ subtitle_timing_v2 需重算该 unit 之后；**v2 编译器按 plan 顺序全局重算比局部增量更简单且确定**——决策点：TTS-C.4 采用"全量重算 + 复用未变 unit 的实测时长"（不重新生成音频，只重算时间轴），符合"局部失效音频、整体确定性重算时间轴" |
| 仅 provider metadata（capability patch） | 不自动失效；review 决定 |
| master SHA 变但时长相同 | subtitle timing v2：`masterSha256` provenance 变 → 需重新构建（v1 语义 `matchesCurrentSource` 已按 hash 匹配）；但时长数据相同 → 重算成本低 |

---

## 10. Security / 边界（贯穿 TTS-C）

- API 序列化出口**不含任何文件路径**（materialize/master/sentence audio 全部沿用 TTS-A 纪律）；音频下载走受控 route（如现有 narration-audio/master/route 模式）或不出 API。
- 客户端只提交 ID（profileId/revisionId/unitId/artifact id），路径全部服务端构造。
- 输出路径防 traversal/symlink（服务端构造 + realpath containment + final 非 symlink 校验）。
- 不引入新 secret；provider capability snapshot 不存 Authorization。
- materialize registry 是服务端生成物，**不信任客户端提供的 referenceAssetPath**。

---

## 11. Tests / Migrations / Deployment order（概要，详见 TTS_C_IMPLEMENTATION_PLAN.md）

- 测试：TTS-C 每阶段新测试脚本（`scripts/test-tts-c-*.ts`），沿用临时 DB + Mock provider + 零真实 IndexTTS2 门禁；全部纳入统一 `run-m7-quality-gate.sh`（suite 数随阶段递增）。
- migration：每阶段一个可回滚 migration（副本演练 + 幂等重跑 + integrity ok），禁止手工 sqlite3。
- deployment：每阶段 exact-SHA build + 镜像内 gate + production backup + compose up + invariants；TTS-C.0 无代码无部署。

---

## 12. Unresolved decisions（TTS-C.1 前需定）

1. delivery 编译策略：文本级改写 vs 显式 unsupported（推荐后者，TTS-C.1 定）。
2. pace 是否经 adapter 扩展字段直传（依赖 upstream IndexTTS-2 duration control 的 adapter 支持度评估）。
3. 正式音频原子单位：unit vs sentence（推荐 unit；sentence preview 独立评估）。
4. capability 升级后存量成功音频的失效策略（推荐不自动删，review 决定）。
5. pronunciation dictionary 是否纳入 TTS-C.2（推荐 TTS-C.3 后评估，先不做）。
6. master 拼接：延续 Node Buffer.concat + PCM（现状）vs ffmpeg concat filter（TTS-C.4 定，注意 ffmpeg 静态构建可用性）。

## 13. Recommended first implementation stage

**TTS-C.1**（Voice materialization + registry 发布 + capability compile 纯函数 + capability snapshot），理由：
- 无音频生成（零真实 provider 风险），可完整单测与 review；
- 解锁后续所有需要 exact voice materialization 的路径；
- capability compile 先行可避免 TTS-C.2 的 payload schema 返工。
