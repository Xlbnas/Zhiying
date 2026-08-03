# TTS-B Assignment + Performance 设计文档（Project Voice Assignment + Narration Performance Plan）

> 本文件记录 TTS-B 前置审计结论与最终设计决策。运行时真相以代码为准。
> TTS-A 已 FROZEN（final code/runtime `1460efd12c9f4bbb3fa4188757deeff3c8566c99`，
> deployment evidence docs `2fc7ffb460dc36cd44fdcb3c5b98e9e09e9e392f`，冻结语义见
> `docs/M7_IMPLEMENTATION_STATUS.md` §7）。
> TTS-B 只建立两个 immutable candidate：Project Voice Assignment 与
> Narration Performance Plan。TTS-B 不生成音频；TTS-C 才负责 TTS payload / job。

## 1. 现有边界审计（编码前结论）

### 1.1 Typed Narration / Narration Plan V2（`src/lib/narration/schema-v2.ts`，M7.1 冻结）

- `NarrationUnitV2` 是 discriminated union：`SpeechUnit {id: Nddd, kind:'speech', chapter,
  spokenText, subtitleText|null, delivery, evidenceIds, sourceText}` 与
  `SilenceUnit {id: Nddd, kind:'silence', chapter, durationMs, reason, sourceText}`。
- `delivery` enum（语义 baseline）：`normal | slow | fast | soft | firm | emphasis`。
- unit ID 严格 `N001…N00N` 连续；`needsReview` 非空 plan 是 candidate 但不可 current/lock。
- `NARRATION_PLAN_V2_SCHEMA_VERSION='narration-plan@2.0'`、`NARRATION_V2_COMPILER_VERSION='2.0'`、
  kind `narration_plan_v2`；`source {scriptV2VersionId, scriptV2Version, scriptV2PromptVersion, scriptV2ContentHash}`。
- 读取：`getNarrationPlanV2Artifact(projectId, artifactId)`（跨项目/kind 非法 → null）。

### 1.2 TTS payload（`src/lib/tts-jobs.ts`）

- v1.0 `{schemaVersion:'1.0', narrationPlanArtifactId, narrationPlanArtifactVersion,
  scriptV2Version, compilerVersion, unitId: Nddd, unitText}`。
- v1.1 `{schemaVersion:'tts-payload@1.1', …, spokenText, delivery: enum,
  ttsInputFingerprint: sha256:hex}`；`anyTtsJobPayloadSchema = union`。
- `ttsInputFingerprint` 公式（`src/lib/tts/fingerprint.ts`，M7.1 REVIEW 1.3 冻结）：
  `sha256(lengthPrefixed(normalizedSpokenText, voiceIdentity, referenceAudioHash,
  ttsModelVersion, delivery, speed, synthesisParameters, normalizationVersion))`。
  字段：`TTS_TEXT_NORMALIZATION_VERSION='tts-text-norm@1.0'`、`voiceIdentity='profileId@revision'`。
- **TTS-B 不得生成最终 `ttsInputFingerprint`**：`ttsModelVersion` / provider-specific speed /
  resolved synthesis parameters / normalization version / materialized adapter registry
  identity 均未确定——这些留给 TTS-C。TTS-B 只提供 `buildPerformanceInputIdentity`
  （见 §10）。

### 1.3 tts_jobs 边界（TTS-B 不得触碰）

- 表 `tts_jobs`；活跃去重 `getActiveTtsJob(projectId, planArtifactId, unitId, provider,
  voiceProfileId, voiceProfileRevision)`（非 fingerprint，status IN queued/running）。
- `enqueueTtsJobTx` 是事务内 helper；`voice_profile_id/voice_profile_revision` 作为列写入。
- TTS-B 不 enqueue tts_jobs、不调用 executor、不生成音频。

### 1.4 TTS executor（`src/worker/tts-executor.ts`）

- payload v1.1 的 `delivery` 接通 `TtsRequest.style = {directive: delivery}`（`normal` 不传）；
- `TtsRequest.emotion` 仅 `{mode:'none'|'text'|'vector'}`；当前 adapter 固定 `emotion='none'`。

### 1.5 IndexTTS2 adapter（`services/indextts2-api-adapter/server.py`，M4-B frozen）

- `/v1/synthesize` 请求字段：`text`、`voiceProfile`、`voiceRevision`（可选）、
  `useRandom`（仅 false）、`emotion`（仅 'none'）。
- **当前 adapter 实际不消费 style/speed/pace/energy**：upstream `/tts_cached` 只传
  `{text, speaker_id}`；`emotion != 'none'` → 422 UNSUPPORTED_EMOTION；
  `useRandom != false` → 422 UNSUPPORTED_USE_RANDOM。
- registry identity：`voiceProfile@voiceRevision` → `{speakerName, referenceAssetPath,
  referenceSha256}`；reference 文件存在性 + SHA-256 fail-closed（REFERENCE_SHA256_MISMATCH）；
  `/voices` 是 adapter 容器内 registry 挂载（`ADAPTER_VOICE_REGISTRY_PATH` /
  `ADAPTER_VOICE_ROOT`），**TTS-B 不 materialize / 不发布**。
- 结论：**pace/energy/emotion(semantic)/delivery 当前均未声称 IndexTTS2 已支持**。
  TTS-B 把它们作为 **provider-neutral synthesis intent** 保存（performance item 字段）；
  文档明确「未声称已生效」；TTS-C 做 provider capability compile，
  不支持且非默认的控制在 TTS-C fail-closed。TTS-B 不得伪造已生效。

### 1.6 复用基础设施（M7.2.1 / M7.3B frozen，TTS-B 原样复用）

- `generation_runs`：`UNIQUE(project_id, stage, request_id)` durable single-flight；
  `claimGenerationRun` / `completeGenerationRunSuccess/Failure` / `refreshRunLease` /
  `findGenerationRun` / `RequestIdConflictError`；stage 现值：
  `m7_narrative_beats` / `m7_visual_intent` / `m7_visual_sequences` / `m7_shots`。
- `generation_dispatch_jobs`：Web enqueue-only 信封（`enqueueGenerationDispatch`，
  source 双持久状态 fail-closed）；worker `dispatch-executor.ts` 按 stage if-chain 分发；
  `recoverStaleDispatchJobs` 启动回收。
- `generation_attempts`：append-only attempt journal（in_flight → response_received →
  validation_failed / succeeded / transport_failed / indeterminate）。
- artifacts 表：append-only，`version = MAX(version)+1` 同事务；kind 精确。
- LLM 生成模式（visual-sequences 模板）：proposal → zod → deterministic semantic
  validation → ≤2 次 repair → final validation → commit-time source fence（单事务内
  重读 source 行核对 hash）→ 原子写 artifact + run succeeded；任何失败 → run failed
  终态，零 partial artifact。
- Web 不持 LLM secret：POST 只 validation + precheck + 幂等查询 + enqueue（202），
  Worker claim 后执行。

### 1.7 M7.0 Review Decision（最终 fingerprint 维度）

final TTS fingerprint 必须包括：`normalizedSpokenText, voiceIdentity,
referenceAudioHash, ttsModelVersion, delivery, speed, synthesisParameters,
normalizationVersion`（见 §1.2）。不得因为当前 executor 只消费 delivery 就丢弃
未来维度——TTS-B 的 performance items 保留完整 synthesis intent 字段
（deliveryOverride/pace/energy/emotion），TTS-C 负责 compile。

## 2. 概念分层（单一权威所有者）

| 概念 | 所有者 | 说明 |
|---|---|---|
| Narration Plan `SpeechUnit.delivery` | Narration Plan V2 | 语义 baseline（正文朗读基调） |
| `deliveryOverride` | Performance Plan | `null` = 使用 source delivery；非 null = Performance 覆盖 |
| `pace` / `energy` / `emotion` | Performance Plan | provider-neutral synthesis intent（未声称 adapter 已支持） |
| resolvedDelivery / resolvedSpeed / resolvedSynthesisParameters | **TTS-C** | provider-specific compile（capability gate，fail-closed） |

同一字段绝无两个权威所有者：TTS-B 不改写 Narration Plan artifact；TTS-C 从
(exact assignment + performance plan + provider snapshot) 编译最终参数。

## 3. Project Voice Assignment 契约

- artifact kind：`project_voice_assignment`；schemaVersion：`project-voice-assignment@1.0`；
  compilerVersion：`1.0`。immutable candidate——不 current/active/locked/default，
  不更新 projects 表指针，不创建 M7 snapshot，不使用 latest revision。
- content（zod strict，只允许稳定身份字段）：

```ts
{
  schemaVersion: 'project-voice-assignment@1.0',
  compilerVersion: '1.0',
  projectId: string,
  source: {
    voiceProfileId: string,
    voiceProfileRevisionId: string,
    revisionSchemaVersion: 'voice-profile-revision@1.0',
    provider: 'indextts2',
    canonicalAudioSha256: /^[0-9a-f]{64}$/,
    adapterCompatibilityKey: 'indextts2-adapter-registry@1',
  },
}
```

- 禁止保存：canonicalAudioPath / absolute path / transcript / original filename /
  audio bytes / latest·current·default / pace / energy / emotion / TTS model runtime
  handle / adapter URL / project secret / ttsJobId / timing。
- 创建前调用 TTS-A exact validator（`validateVoiceProfileRevisionExact`）：
  Profile 存在且 active（archived → 409 禁止新建）、Revision 属于该 Profile、
  usable=true、provider=indextts2、canonical hash 与 descriptor 一致、
  adapterCompatibilityKey 一致。source 只保存 descriptor 内已核对的值。
- 规则：
  - archived Profile 不允许新建 assignment；已存在 assignment 的 historical exact
    read 仍有效（分类不检查 profile.status）；
  - Profile 新增 revision 不 stale 旧 assignment（exact revisionId 固定）；
  - exact revision 文件丢失/hash 漂移 → assignment 分类 `invalid_source`；
    下游 Performance Plan blocked/invalid；**禁止 fallback 到 latest revision**；
  - Profile 删除不在本轮支持。

## 4. Assignment durable idempotency（最小 request envelope）

- deterministic（无 LLM、无 provider）→ **不**使用 generation_runs（其 owner_token/
  lease/indeterminate 语义为 LLM 运行设计，纯 DB 工作不适用——见 §1.6 理由）。
  新增最小 request envelope 表（append-only、幂等、old DB 可升级）：

```sql
CREATE TABLE IF NOT EXISTS voice_assignment_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  request_id TEXT NOT NULL,
  voice_profile_id TEXT NOT NULL,
  voice_profile_revision_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, request_id)
);
```

- POST `{requestId, voiceProfileId, voiceProfileRevisionId}`：
  单 BEGIN IMMEDIATE 事务：SELECT envelope → 存在且 (profile, revision) 相同 →
  复用同一 artifact（200 reused）；存在但不同 → 409 REQUEST_ID_CONFLICT；
  不存在 → INSERT envelope + INSERT artifact（201 created）。
  `UNIQUE(project_id, request_id)` + 单事务 = 原子唯一性，**无 check-then-insert 竞态**；
  **禁止仅 JSON 搜索 requestId 后声称幂等**。
- 并发相同 requestId → 恰好一个 artifact，其余 reused。
- 已有 artifact 内容含该 requestId 的 legacy 复用不做（新表首建）。

## 5. Narration Performance Plan 契约

- artifact kind：`narration_performance_plan`；schemaVersion：
  `narration-performance-plan@1.0`；compilerVersion：`1.0`；promptVersion：
  `narration-performance-plan@1.0`。
- source（全部服务端构造，**禁止 LLM 输出 source**）：

```ts
{
  narrationPlanArtifactId,
  narrationPlanContentHash,          // sha256Text(content_json)
  narrationPlanSchemaVersion: 'narration-plan@2.0',
  narrationPlanCompilerVersion: '2.0',
  scriptV2VersionId,
  scriptV2Version,
  scriptV2ContentHash,
  projectVoiceAssignmentArtifactId,
  projectVoiceAssignmentContentHash, // sha256Text(content_json)
  voiceProfileId,
  voiceProfileRevisionId,
  canonicalAudioSha256,
  adapterCompatibilityKey,
}
```

- performance item（zod strict）：

```ts
{
  unitId: /^N\d{3}$/,
  deliveryOverride: 'normal'|'slow'|'fast'|'soft'|'firm'|'emphasis' | null,
  pace: 'slow'|'normal'|'fast',
  energy: 'low'|'normal'|'high',
  emotion: {mode:'none'} | {mode:'semantic', label:'neutral'|'warm'|'serious'|'reflective'|'empathetic'|'urgent'|'authoritative'},
}
```

- 枚举在 adapter/TTS audit 后最终确认（§1.5）：adapter 当前不消费 pace/energy/emotion；
  作为 provider-neutral synthesis intent 保存，文档明示「未声称 IndexTTS2 当前已支持」，
  TTS-C 做 provider capability compile，不支持且非默认的控制 fail-closed。
- delivery ownership：`SpeechUnit.delivery` 是语义 baseline；
  `deliveryOverride=null` 表示使用 source delivery；非 null 才表示 Performance 覆盖；
  TTS-C 得到 `resolvedDelivery`。不得改写 Narration Plan artifact。
- 禁止保存：spokenText / subtitleText / sourceText / evidenceIds / pause duration /
  final resolved provider payload / audio path / ttsJobId / output hash /
  startMs·endMs / frames / narration master timing。

## 6. Performance semantic validation（deterministic）

校验器输入：exact Narration Plan V2 + exact Assignment descriptor + items。
错误码（稳定集合）：

```
PERFORMANCE_UNIT_COVERAGE_GAP       // SpeechUnit 缺 item
PERFORMANCE_UNIT_DUPLICATE          // unitId 重复
PERFORMANCE_UNIT_ORDER_MISMATCH     // items 顺序 ≠ SpeechUnit 顺序
PERFORMANCE_NON_SPEECH_UNIT         // SilenceUnit 出现在 items
PERFORMANCE_UNIT_NOT_FOUND          // items 引用不存在 unit
PERFORMANCE_DELIVERY_INVALID        // deliveryOverride 非闭集/非 null（zod 层兜底）
PERFORMANCE_PACE_INVALID            // pace 非闭集（zod 层兜底）
PERFORMANCE_ENERGY_INVALID          // energy 非闭集（zod 层兜底）
PERFORMANCE_EMOTION_INVALID         // emotion 非 discriminated union（zod 层兜底）
PERFORMANCE_FORBIDDEN_FIELD         // spokenText/subtitleText/sourceText/evidenceIds/
                                    // pause/timing/audio/job/path 字段
PERFORMANCE_SOURCE_MISMATCH         // narration/assignment source 漂移或身份不一致
PERFORMANCE_VOICE_UNUSABLE          // exact voice 不可用
PERFORMANCE_PROVIDER_CAPABILITY_UNRESOLVED  // 预留（TTS-C provider compile）
PERFORMANCE_NEEDS_REVIEW            // 预留非阻断（本轮不自动 emit）
```

规则：只允许 SpeechUnit；每个 exact SpeechUnit 恰好一个 item；SilenceUnit 不得出现；
不得遗漏/重复；顺序与 exact SpeechUnit 顺序逐项一致；unitId `Nddd` 严格；
枚举闭集由 zod strict 强制；forbidden 字段 hard-fail（zod unknown-key 拒绝 +
语义层显式检查）；assignment source exact/current-candidate；assignment revision
usable；Narration Plan source hash 漂移 → stale；assignment artifact/hash 漂移 →
stale；Profile 新增其他 revision 不影响该 plan；Profile archive 不使已有 exact plan
stale；exact reference 文件/hash 损坏 → invalid_source；unresolved provider capability
可标 needs_review 但不得自动静默降级（本轮不 emit）。validator 不自动排序、不自动改写枚举。

## 7. LLM proposal 与 Worker dispatch（Performance Plan）

- 复用：generation_runs（stage `m7_narration_performance_plan`）+ generation_dispatch_jobs
  + Worker-side LLM dispatch + requestId single-flight + resourceClass `llm_api` +
  preflight/commit source fence + repair 上限 2。
- Web 不直接调用 LLM：POST 只 validation + precheck + enqueue（202）。
- LLM 输入：exact SpeechUnit spokenText + source delivery + chapter + 邻接 speech
  上下文 + exact voice descriptor 的非路径元数据（profileId/revisionId/duration/
  sha256 摘要/compatibility——无路径）。
- LLM 输出契约（zod strict）：`{items: PerformanceItemV1[]}`。
  LLM 禁止输出：source / hashes / artifact IDs / profile·revision path / spokenText
  副本 / provider payload / timing / job IDs / model runtime metadata。
- 服务端负责：source wrapper、hash、schema/compiler/prompt version、generation metadata、
  artifact commit。
- repair：只传机器可读 validator issues；attemptCount 真实；有限次数；达上限 failed；
  不删除坏 item；不把 invalid artifact 标 ready。
- commit-time fence（单 BEGIN IMMEDIATE）：重读 Narration Plan + Assignment artifact
  行核对 hash + 重新调用 exact voice validator；任一 ID/hash/usability 漂移 →
  `SOURCE_STALE` 或 `VOICE_SOURCE_INVALID`；零 partial artifact。

## 8. 分类与 DAG（独立于 M7.3B frozen DAG）

- 两个 artifact 的分类（classify，deterministic 纯读）：
  - Assignment：parse 失败 → `invalid_source`；compilerVersion 不符 → `stale_source`；
    exact voice validator null/usable=false → `invalid_source`（reason 带具体原因）；
    否则 `current_candidate`。（archive 后 historical exact read 仍 current。）
  - Performance：parse 失败 → `invalid_source`；narration plan artifact 缺失/
    hash 漂移/compiler 不符 → `stale_source`；assignment artifact 缺失/hash 漂移/
    分类非 current_candidate → `stale_source`；assignment invalid（voice unusable）→
    `invalid_source`；semantic validation 重新运行有 blocking issue → `invalid_source`；
    否则 `current_candidate`。
- TTS-B 节点状态（新模块 `src/lib/tts-b/dag.ts`，**不修改** M7.3B frozen `m7-dag/dag.ts`）：
  节点 `project_voice_assignment`、`narration_performance_plan`；状态
  `not_generated | generation_running | generation_failed | ready | needs_review |
  blocked | stale_source | invalid_source`。
  - 无 usable exact revision → Assignment invalid/blocked；
  - archived Profile：不能新建 Assignment；已有 exact Assignment 仍可用；
  - 新 revision 上传：不 stale 旧 Assignment；
  - Narration Plan 漂移 → Performance stale；Assignment artifact/hash 漂移 →
    Performance stale；exact voice 文件/hash 损坏 → Assignment invalid + Performance
    invalid/blocked；
  - **Voice Assignment / Performance Plan 变化不 stale Narrative Beats / Visual Intent /
    Sequence / Shot**（M7.3B §7.6 兼容边界）；
  - 不形成反向边、不形成 cycle。
- 逻辑依赖：exact Voice Revision → project_voice_assignment；
  (Narration Plan V2 + Project Voice Assignment) → narration_performance_plan。

## 9. API

- `GET /api/projects/[id]/voice-assignments`（列表：candidates + runs 无 + dispatch 无）
- `POST /api/projects/[id]/voice-assignments`（同步 deterministic：200 reused / 201 created）
- `GET /api/projects/[id]/voice-assignments/[artifactId]`（exact，404 fail-closed）
- `GET /api/projects/[id]/narration-performance-plans`（列表：candidates + runs + dispatch）
- `POST /api/projects/[id]/narration-performance-plans`（enqueue-only：200 reused / 202 queued·running / 409 terminal·conflict）
- `GET /api/projects/[id]/narration-performance-plans/[artifactId]`（exact，404 fail-closed）
- strict JSON（unknown fields 422）；project exact ownership；source artifact 必须属于
  project（cross-project 404/409 fail-closed）；same requestId same source 幂等；
  different source 409；list 不隐式选择 latest；exact GET 不 fallback；
  Web 不调用 LLM；不 enqueue TTS。
- 不提供：set-default / set-current / activate / apply-to-all-projects / regenerate-audio。

## 10. TTS fingerprint 边界

- TTS-B **不**生成最终 `ttsInputFingerprint`。新增纯函数
  `buildPerformanceInputIdentity({narrationPlanArtifactId, narrationPlanContentHash,
  unitId, assignmentArtifactId, assignmentContentHash, performancePlanArtifactId,
  performancePlanContentHash})` 计算稳定 identity（供对账/缓存 key 分析），
  **不得命名为 ttsInputFingerprint**。
- 最终 fingerprint 留给 TTS-C，且满足冻结公式（§1.2）——禁止仅按文本、unitId 或
  voiceProfileId 复用。

## 11. UI（项目 Workspace 独立区域）

- `WorkflowWorkspace` 挂载 `VoiceAssignmentPanel` + `PerformancePlanPanel`。
- VoiceAssignmentPanel：浏览 active Voice Profiles（GET /api/voice-profiles）、
  展开 revisions（GET /api/voice-profiles/[id]/revisions）、显示 revision number /
  duration / SHA 短摘要 / compatibility / usable；显式选择 exact revision →
  POST assignment；显示历史 Assignment candidates + 状态（current_candidate /
  stale_source / invalid_source）。
- PerformancePlanPanel：显式选择 exact Assignment → POST performance（enqueue →
  轮询 202 状态）；展示每个 SpeechUnit：unitId / 原 Narration delivery /
  deliveryOverride / pace / energy / emotion；needs_review / stale / invalid 显示；
  修改计划 = 新 immutable candidate（不 PATCH artifact）。
- 页面明示：声音尚未触发 TTS；Assignment/Performance 是 candidate；无
  default/current/active；TTS-C 才生成音频。
- 禁止按钮：立即重生成全片 / 替换所有项目 / 设为全局默认 / 生成 narration master /
  Final Render。

## 12. 明确不做（TTS-C 边界）

TTS-C 才负责：exact assignment + performance plan → TTS payload compile（含 provider
capability gate）、逐 unit tts_jobs、试听、增量重生成、narration audio manifest。
本轮禁止：enqueue tts_jobs、调用 IndexTTS2、上传 production voice、narration master、
ffprobe master、subtitle timing、timing-reconciliation@2.0、Voice Library →
adapter `/voices` materialization、adapter registry 发布、project m7 activation、
M7 snapshot、Freud pilot、Storyboard/Animatic/Render。
