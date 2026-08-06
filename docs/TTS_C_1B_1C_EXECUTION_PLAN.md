# TTS-C.1B / TTS-C.1C 执行计划（代码入口审计 + 最小实施计划）

> 状态（2026-08-06 update）：**TTS-C.1B.1 = FROZEN**（Independent Review PASS + R1 blocker-specific
> Review PASS + Integrated exact-SHA Review PASS + Production deployment PASS + Deployment Evidence
> Review PASS，deployment evidence：`docs/evidence/tts-c-r17/deployment-c1b1-c1c1.md`）；
> **TTS-C.1C.1 = FROZEN**（Independent Review PASS + Integrated exact-SHA Review PASS + Production
> deployment PASS + Deployment Evidence Review PASS）；deployed production SHA
> `01f8536b4bac1661aa86ad57f90985ec56c8aaa5`；TTS-C.0 / TTS-C.1A = FROZEN；production POST remains
> disabled；**TTS-C.1B.2 = FROZEN**（审计链：initial Independent Review = FAIL
> `08be813…` → TTS-C.1B.2.R1 blocker-specific Review = PASS `bcfd29b…` → all identified blockers
> closed → merged to m7（fast-forward）→ Integrated exact-SHA Review = PASS → production
> deployment PASS（§15.17）→ **Deployment Evidence Review = PASS（2026-08-06）**；frozen
> production runtime = `6874f51c717ebab1c282ee29e9301f27627deaf7`；测试 138 PASS；combined gate
> suite 55）；**TTS-C.1B.3 implemented on work branch `work/tts-c1b3-activation-recovery`（Independent Review FAIL → **TTS-C.1B.3.R1 blocker repair implemented**；pending blocker-specific Review；not merged；not deployed；测试 149 PASS；combined gate suite 56）**；
> TTS-C.1C.2 not started；TTS-C.2 not authorized；**Deployment Evidence Review = PASS**。
> TTS-C.1C.2 not started；TTS-C.2 not authorized；**Deployment Evidence Review = PASS**。
> 本文件是 1B/1C 的唯一实施计划入口，基于 frozen contract（`docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md`
> R13）与当前代码只读审计写成。历史基线：上一 production runtime SHA
> `37eaac6c8c8969239cab00848f6291454615a912`（runtime code 内容
> `17d40787ce70c025d7daa012c04a76bc69c10a2b`），其 deployment evidence commit
> `c29801b3b313a41560e4e0547033c2a409ed244c`（`docs/evidence/tts-c-r17/deployment.md`）。

## 0. 边界与前提订正

复杂度边界（AGENTS.md「工程复杂度、验证强度与威胁模型」）：不新增 SHA/checksum 层；不新增
capability/WeakMap authority；不新增 mutation workflow；不重新设计 frozen schema；不新增数据库表或
trigger；不防恶意内部模块；不追求形式化证明。现有 frozen 表、trigger、publication journal 与
activation command 是**约束**，不是待重新设计对象。优先复用现有服务、现有 adapter API、现有 DB
transaction、普通 integration test，保持实现路径短而可维护。

**前提订正 1（1B subject_type）**：frozen `voice_registry_publications.subject_type` 是**四态**——
`materialization_publish / legacy_cutover_publish / legacy_cutover_existing / registry_rebuild`
（设计文档 :2526-2527），配套 `subject_mode` 三态 `publish_and_cutover / cutover_existing / none`
（:2530-2531）。实施时以 frozen CHECK 为准。

**前提订正 2（1C 输入面）**：TTS-B 已冻结 Performance Plan **不含** emotionAlpha、八维情绪向量、
情绪参考音频字段——`src/lib/tts-b/performance-schema.ts:72-80` 的实际冻结输入为
`deliveryOverride / pace / energy / emotion{none|semantic label}`（§A.4）。全仓 grep
`emo_vector|emoAlpha|emotionVector|情绪向量|八维|情绪参考` 在 `src/` 与 `docs/` 零匹配。上述三字段
不作为 1C 输入；compiler 接口保留扩展位，未来出现时按 explicit unsupported 处理，不静默丢弃。

---

## A. 当前代码入口

### A.1 adapter registry 现状（1B）

- 实现：`services/indextts2-api-adapter/server.py`（362 行，FastAPI）。
- registry 加载：`_load_registry()`（`server.py:129-178`），**仅模块 import 时调用一次**
  （`REGISTRY = _load_registry()`，`server.py:181`）；进程内不重读。
- 路径 env：`ADAPTER_VOICE_REGISTRY_PATH`（`server.py:46`，空 → `VOICE_REGISTRY_NOT_CONFIGURED`）；
  containment root `ADAPTER_VOICE_ROOT` 默认 `/voices`（`server.py:48`）。
- registry JSON schema（`voice-registry.example.json`；校验 `server.py:143-177`）：
  `{schemaVersion:"1.0", voices:[{voiceProfile, voiceRevision, speakerName, referenceAssetPath,
  referenceSha256}]}`；key = `profile@revision`（`server.py:170,177`）；`referenceAssetPath` 必须绝对
  路径且 realpath 落在 `ADAPTER_VOICE_ROOT` 内（`:165,173-176`）；`referenceSha256` 64 位小写 hex
  （`:168`）。**无 generation / publisherSchemaVersion / 文档级 sha 字段**。
- HTTP endpoint 仅两个：`GET /health`（`server.py:212-242`，返回 `{ready, provider:'indextts2',
  model:'IndexTTS-2'}` + 未 ready 时 `detail` 错误码）；`POST /v1/synthesize`（`server.py:312-362`）。
  **无 reload endpoint；无 LKG；/health 不暴露 active registry sha / generation / speaker count**。
- 既有 fail-closed 先例：`_check_voice()` 按 `(mtime_ns, size)` 缓存失效重算 reference WAV 的
  SHA-256/MD5，不符 → `REFERENCE_SHA256_MISMATCH`（`server.py:184-206`）——是校验，不是 registry
  变更检测。
- compose 拓扑（`docker-compose.production.yml:132-151`）：registry 为宿主单文件
  `${ZHIYING_HOST_VOICE_REGISTRY}` → `/config/voice-registry.json` **:ro**（`:139,143`）；
  `${ZHIYING_HOST_VOICES_DIR}` → `/voices:ro`（`:144`）；容器 `read_only: true` + tmpfs `/tmp`
  （`:132-134`）；**adapter 不挂载 `/app/data`，不挂载 voice-materializations**。
- 当前 stable registry 写入：**无代码路径**，production 靠管理员手工写宿主 JSON
  （`docs/M4_生产部署.md:79-87`）；`src/` 全树 grep `voice-registry|referenceSha256|voiceRegistry`
  零匹配；`scripts/` 中仅测试 fixture（`scripts/test-m4b-adapter.ts:152-169`、
  `scripts/test-m3f-adapter.ts:177`）。
- app 侧 client：`src/lib/tts/indextts2.ts`——baseUrl 注入（`:24-25,40-47`，env
  `INDEXTTS2_BASE_URL`，`src/lib/tts/index.ts:16,37,77`）；仅调用 `GET /health`（`:52`）与
  `POST /v1/synthesize`（`:100`，synthesize 前强制 health gate `:84-87`）；**无 reload 调用**
  （全仓 grep `reload` 零匹配）。voice 以 `voiceProfile` + `voiceRevision` 字段指定
  （`indextts2.ts:105-106`；类型 `src/lib/tts/types.ts:9-12`）。
- `services/indextts2-bridge/server.py`（132 行）为旧 in-process GPU sidecar 设计，**production
  不使用**（production compose 无 bridge 服务）。
- 相关既有测试：`scripts/test-m4b-adapter.ts`（registry 加载/校验全矩阵）、
  `scripts/test-m3f-adapter.ts`、`scripts/test-m4b-compose.ts`、`scripts/test-m4b-container.ts`、
  `scripts/test-tts-c1a-compose-mounts.ts`（断言 adapter registry mount 保持 `:ro` 不变，`:37`）、
  `scripts/test-m4c1-secret-boundary.ts`。

### A.2 1B 可复用的 runtime 入口（已存在）

- 四张 1B 目标表已随 1A migration 入库（`src/lib/tts-c/migration.generated.ts`；
  应用入口 `applyTtsC1aMigration`，`src/lib/tts-c/migration.ts:29-35`，由 `getDb()` 调用，
  `src/lib/db.ts:496`）——**1B 零 DDL**。
- DB 访问：`better-sqlite3`（`src/lib/db.ts:3,13`）；`getDb()` WAL + busy_timeout=5000 +
  foreign_keys=ON + synchronous=NORMAL（`:483-493`）；事务写法
  `db.transaction(fn).immediate()`（实例 `src/lib/tts-c/materialization.ts:444,961,1257,1293`）。
- DB 时间与工具：`dbNowMs(db)`（`materialization.ts:144`）、`nowIso()/nowEpochMs()/sha256Text()`
  （`:151-159`）——publisher fencing 必须用同款 DB 时间。
- fenced lease 续租精确模式（owner_token + attempt + `DB_NOW_MS <= lease`，changes≠1 →
  ownershipLost）：`src/worker/materialization-executor.ts:83-104`——即 §7.3 T1.5 要复制的写法。
- 文件 durability 范式：`src/lib/tts-c/paths.ts` `stagingTempPath()`（`:59`，同目录 temp→rename）、
  `OPEN_FLAGS`（`:177`）；projection 文件验证复用
  `src/lib/tts-c/materialized-file-validator.ts` `validateMaterializedFileSnapshot()`（`:954`）。
- 周期 recovery 骨架：`src/lib/tts-c/recovery-controller.ts`
  `MaterializationRecoveryController`（`:21-92`，周期 sweep + inFlight 不重入 + 异常隔离 +
  shutdown settle）；Worker 启动挂载点 `src/worker/index.ts:715-721`。
- Scheduler 三点集成模式（若 publisher 走 job kind）：`src/lib/scheduler.ts:151`（候选 UNION）+
  `:225-263`（cancel 裁决→fenced claim→exact handle）；`src/worker/job-runner.ts:114-119`；
  resource class `src/lib/workflow/resource-classes.ts:31,45,99,115`。
- API 路由：`src/app/api/projects/[id]/voice-materializations/route.ts`（feature gate
  `TTS_C1A_MATERIALIZATION_POST_ENABLED==='true'`，`:16-18`；响应占位 `adapterReady:false,
  registryPublished:false`，`:54-55`）——1B 上线后这两个字段语义需重新定义。

### A.3 legacy registry 来源（1B import 数据源）

- production adapter 的 voice 数据 = **宿主机单个 JSON 文件**：host `${ZHIYING_HOST_VOICE_REGISTRY}`
  （`.env.example:70-71`）→ 容器 `/config/voice-registry.json`；reference WAV 目录
  `${ZHIYING_HOST_VOICES_DIR}` → `/voices:ro`。仓库内**没有**真实 production registry 文件（仅
  example 与测试 fixture `data/test-m3f-adapter/voice-registry.json`）；宿主路径按部署文档推断为
  `/vol1/1000/docker/zhiying/voice-registry.json`（`docs/M4_生产部署.md:82-86`），**实际值由宿主机
  `.env.production` 决定——import 实施前必须在宿主机只读核实**。
- registry 条目字段与 `legacy_adapter_voice_entries` 列一一对应（§F）。
- 现有 legacy TTS 的 voice 标识：`tts_jobs.voice_profile_id` + `voice_profile_revision`
  （`src/lib/db.ts:197-198`），executor 以 `id@revision` 传给 provider
  （`src/worker/tts-executor.ts:163-168`）——即 registry 的 `profile@revision` key。历史 351 行
  的具体 voice 值不在本仓库（在 production DB），同样需宿主机只读核实。

### A.4 provider payload 与 capability 现状（1C）

- TTS job enqueue：`enqueueTtsJobTx`（`src/lib/tts-jobs.ts:185-231`，事务内 helper，同
  (plan, unit, provider, voice) 去重）；当前调用方 `enqueueNarrationAudioJobsV2`
  （`src/lib/narration/audio-v2.ts:292-374`）。
- payload_json union（`tts-jobs.ts`）：v1.0（`:45-53`）与 v1.1 `'tts-payload@1.1'`（`:61-71`，
  含 `delivery` enum 与 `ttsInputFingerprint`）；union 解析 `:76`——**payload 版本演进机制已存在**。
- fingerprint：现仅 `computeTtsInputFingerprint`（`src/lib/tts/fingerprint.ts:46-58`，8 个
  length-prefixed 字段：normalizedSpokenText / voiceIdentity / referenceAudioHash /
  ttsModelVersion / delivery / speed / synthesisParameters / normalizationVersion）；调用方当前
  固定 `speed='1.0'`、`synthesisParameters='{}'`（`audio-v2.ts:88-89`）——**表现力参数占位键已预留
  但未启用**。设计文档的三分离 fingerprint（exact / synthesis_payload / final）属 C.2，未实现。
- provider / model / version 记录：`provider` 在 `tts_jobs.provider` 列（`src/lib/db.ts:196`，
  `mock | indextts2`，enqueue 时快照）；`model / providerVersion / providerCommit` 仅在
  `result_json`（`tts-jobs.ts:101-116`；executor 成功时持久化，`src/worker/tts-executor.ts:238-249,
  262-267`）。
- adapter 合成请求字段（`server.py:248-253`，共 5 个）：`text` / `voiceProfile` / `voiceRevision` /
  `useRandom(false)` / `emotion('none')`；非默认 `useRandom`/`emotion` → **显式 422**
  （`UNSUPPORTED_USE_RANDOM` / `UNSUPPORTED_EMOTION`，`:325-328`）；**无任何 pace / speed /
  delivery / emo_vector / emo_alpha / emotion 参考音频字段**；upstream 仅传 `{text, speaker_id}`
  （`:345-348`）。唯一静默丢弃面：pydantic 未配 `extra='forbid'`，未声明的额外键被忽略。
- client 侧：`indextts2.ts:103-109` 实发 `text/voiceProfile/voiceRevision/useRandom:false/
  emotion: request.emotion?.mode ?? 'none'`；`TtsRequest.style.directive` 在 client 层被丢弃
  （executor 于 `tts-executor.ts:171-173` 组装）；`TtsRequest.emotion` 契约允许
  `'none'|'text'|'vector'`（`src/lib/tts/types.ts:23-25`），但 executor 固定 `{mode:'none'}`
  （`tts-executor.ts:174`）。
- TTS-B 冻结输入（Performance Plan item，`src/lib/tts-b/performance-schema.ts:72-80`，`.strict()`）：
  `unitId`；`deliveryOverride`（`normal|slow|fast|soft|firm|emphasis` | null，`:15-23`）；
  `pace`（`slow|normal|fast`，`:25`）；`energy`（`low|normal|high`，`:28`）；
  `emotion`（`{mode:'none'}` | `{mode:'semantic', label: neutral|warm|serious|reflective|
  empathetic|urgent|authoritative}`，`:31-53`）。neutral 默认 = `pace/energy:'normal'` +
  `emotion:{mode:'none'}` + `deliveryOverride:null`。
- artifact 身份：kind `'narration_performance_plan'`（`src/lib/tts-b/constants.ts:8`），
  `schemaVersion='narration-performance-plan@1.0'`、`compilerVersion='1.0'`（`:13-14`）。
- 下游消费：**TTS 执行链当前无人消费 Performance Plan**（enqueue 只用 `SpeechUnit.delivery`；
  `tts-executor.ts` 无引用）——1C/C.2 首次消费。预留错误码
  `PERFORMANCE_PROVIDER_CAPABILITY_UNRESOLVED`（`src/lib/tts-b/performance-validate.ts:24-25`）。
- capability 现状：`src/` 无任何 provider capability snapshot/compiler（grep 零匹配；
  `materialized-file-validator.ts` 的 "capability" 是 object-capability 安全模式，语义无关）。
- provenance 先例：artifacts 表（`src/lib/db.ts:39-47`，**无 content_hash 列**；应用层 canonical
  JSON sha256 先例 `src/lib/tts-b/performance.ts:710-714`；kind + `MAX(version)+1` 写入
  `:733-746`）；`assets.provenance_json` 三态严格解析（`src/lib/assets/model.ts:38-46,76-114`）。
- frozen 要求：§12 capability neutral matrix（设计文档 `:4069-4074`）；1C scope
  （`docs/TTS_C_IMPLEMENTATION_PLAN.md:158-168`）——snapshot 固化与执行前比对；compiler 纯函数；
  编译结果进 provenance + `synthesisPayloadFingerprint`（后者载体 `tts_jobs` 列与
  `sentence_audio_artifacts.capability_*` 列属 §2.0/§2.4，**C.2 migration，不在 1C**）。

---

## B. 冻结数据模型复用（1B 零 DDL）

四张表结构/trigger/索引已随 1A migration 入库，1B 只写行、不改 schema。

| 表 | 状态机 | 1B 写入点 |
|---|---|---|
| `voice_registry_publications`（§2.9） | 8 态：`building / candidate_persisted / file_durable / activation_pending / active / failed / indeterminate / cancelled`；转换由 `trg_vrp_transition` 强制；**active 仅两个入边**（activation_pending→active 或 indeterminate(from=activation_pending)→active）且必须存在匹配 activation command 行；`uq_voice_registry_publication_active` partial unique（building/candidate_persisted/file_durable/activation_pending/indeterminate 占 global 单飞位）；indeterminate seal/shape 三 trigger | publisher T1-T4 状态推进、T5 经 activation command 到 active、takeover CAS |
| `voice_registry_publication_activations`（§2.10） | append-only command；`UNIQUE(publication_id)`；`activation_mode` 双态形状（`normal_owner_finalize`：owner_token NOT NULL + resolution_evidence NULL；`indeterminate_reconciliation`：owner NULL + evidence/hash NOT NULL + attempt 精确等于 publication.attempt）；`trg_vrpa_activate` AFTER INSERT 同一 statement 原子完成 fencing→subject 验证→projection 更新→legacy 更新→publication→active，任一步 `changes()=0` 整体 ABORT | T5 唯一写入：单条 INSERT |
| `legacy_adapter_voice_entries`（§2.8） | 5 态：`unmapped / mapped_verified / mapping_pending / mapped_active / retired`；`mapping_mode` 双路径 write-once（`publish_and_cutover` 前置 projection=file_ready_unpublished 且无在飞 publication；`cutover_existing` 前置 projection=published_usable 且 published_by 非 NULL）；`pending_publication_id` 仅 T1 fill / rollback clear；`uq_lve_active_mapped_materialization` 活跃一对一 | import（unmapped）；T1（mapping_pending）；T5 trigger（mapped_active）；rollback（mapped_verified） |
| `voice_materializations`（§2.7） | 4 态：`file_ready_unpublished / published_usable / failed / indeterminate`；`published_usable` 无出边；`trg_vmat_publish` 三种 subject 接受路径（materialization_publish / legacy_cutover_publish / legacy_cutover_existing）；published evidence write-once | 仅 T5 trigger 经 activation command 置 `published_usable` |

关键列（publisher 直接读写）：`generation INTEGER NOT NULL UNIQUE`；`stable_registry_sha256`
NOT NULL / `candidate_registry_sha256` 可 NULL（64 位小写 hex CHECK）；`candidate_manifest_json` +
`candidate_manifest_sha256`；`publisher_schema_version`；`owner_token / lease_expires_at_epoch_ms
（epoch ms）/ attempt`；`file_durable_at / activation_requested_at / activated_at / failed_at`；
`error_code / error_message`；`indeterminate_from_status`。**registry SHA 是 frozen contract 已有
列，直接使用，不新增任何 hash 层。**

cutover 协议 T1-T5（设计文档 §7.3 :3360-3462）与 crash 矩阵 CC-1…CC-6（§10.4 :3828-3837）为
frozen 语义，§C/§D 是它们的代码落地规划，不重述设计。

---

## C. 1B 最小正常路径（publisher）

> **1B.2 已实现（2026-08-06，work branch `work/tts-c1b2-publisher-candidate`；pending independent
> Review；not merged；not deployed）**：步骤 1-3 落地于 `src/lib/tts-c/registry-publisher.ts`——
> `claimPublication`（T1：BEGIN IMMEDIATE + generation=MAX+1 + subject 四态冻结 + owner/lease/attempt=1 +
> legacy_cutover 同事务 entry→mapping_pending；同 subject 已 active → `already_in_flight` 复用；
> 异 subject 在飞 → `PUBLICATION_CONFLICT`）、`renewPublicationLease`（T1.5 fenced verify/renew）、
> `buildRegistryCandidate`（stable view 投影 + subject key 换入；全量 1.1 文档 canonical JSON；
> manifest 逐 key emitted source/sourceRowId/referenceSHA/adapterKey；candidate 引用文件复算 SHA；
> key 冲突 fail-closed）、`markCandidatePersisted`（Tx A fenced）、`persistCandidateFile`
> （temp O_EXCL→write→fsync→rename→dir fsync→reread 复算 SHA + JSON/generation 复核；同 generation
> 同 bytes 复用 / 异 bytes fail-closed）、`markFileDurable`（Tx B fenced）、`publishRegistryCandidate`
> （T1→T1.5→build→Tx A→file→Tx B 幂等编排）、`failPublication`（fenced failed 终态，recovery 复用）。
> 常量：`PUBLICATION_LEASE_MS=15min`（与 1A generation lease 对齐）；candidate 文件约定
> `<dataDir>/voice-registries/candidate-<generation>.json`（temp 同目录 stagingTempPath 范式；
> registry 目录挂载拓扑变更属 1B 部署 gate 独立 review，本轮未实施）。**1B.2 结束点 = publication
> `file_durable` + candidate 文件 durable；不 reload adapter（T3）、不 activation（T4/T5）、
> 不 recovery（§D，1B.3）。**
>
> **TTS-C.1B.2.R1 blocker repair（2026-08-06；R1 blocker-specific Review = PASS；merged to m7；
> Integrated exact-SHA Review = PASS；deployed production；Deployment Evidence Review = PASS；
> TTS-C.1B.2 = FROZEN）**：① P0-A
> same-subject loser 分流——`publishRegistryCandidate` 按 `claim.kind` 分流；`already_in_flight`
> 公开返回收窄为无 owner_token 的 `PublicationStatusDto`；loser 不 renew/build/写文件/推进 DB/
> failPublication；file_durable → 只读 durable verification → `already_file_durable`；
> 编排返回 union（completed / already_in_flight / already_file_durable）。② P0-B
> existing-final 重建立 durability——统一 `durabilizeAndVerifyCandidate` acceptance（新文件与
> existing 共用；O_NOFOLLOW + fstat + fd 读取 + length/SHA + parse 1.1 三字段 + final fsync +
> parent dir fsync），同 SHA 不得直接 return。③ P1-A reference containment——
> `verifyReferenceFile(rootDir)`（root realpath 固定 + 逐级 parent 无 symlink + O_NOFOLLOW +
> fd 读取 + SHA）；resolver 只做 path translation；materialization projection 复用
> `validateMaterializedFileSnapshot`。④ P2 final bytes 语义校验在 persist/acceptance 内部。
> ⑤ exact-HEAD 55-suite gate（`QUALITY_GATE_SHA=bcfd29b…` == reviewed final HEAD；agentvm 本地执行，
> 无 GitHub Actions run/status，非 GitHub-hosted independent CI evidence）。测试 138 PASS ×2。

一条清晰正常路径，严格映射 frozen T1-T5；publisher 运行于 **Worker**（唯一文件 writer，同 1A
边界）；全部 DB 写走 `db.transaction(fn).immediate()`；每个外部副作用前 fenced verify/renew
（T1.5，复用 `materialization-executor.ts:83-104` 模式）。

1. **T1 claim（BEGIN IMMEDIATE）**：INSERT publication `building`——`generation =
   SELECT COALESCE(MAX(generation),0)+1`（BEGIN IMMEDIATE 串行 + UNIQUE 兜底）、新 owner_token
   （UUID）、lease = `dbNowMs + PUBLICATION_LEASE_MS`、attempt=1、`stable_registry_sha256` = 当前
   stable registry 内容 hash、`publisher_schema_version` 常量；`trg_vrp_subject` 冻结 subject
   验证。legacy subject 同事务 entry `mapped_verified→mapping_pending`（pending=本 publication，
   `candidate_source_selector='tts_a'`）。
2. **读 stable + 构建 candidate（事务外，纯计算）**：stable view = legacy 集合按 mapping 状态
   投影（unmapped/mapped_verified/mapping_pending → legacy 条目；mapped_active → TTS-A source；
   retired → 不输出；每个 canonical key 恰好一个 source，冲突 fail-closed）；candidate = stable
   全量确定性重建 + 本 subject 的 TTS-A 条目换入；registry 文档含 `registryGeneration`（=
   publication.generation）+ `publisherSchemaVersion`；manifest 逐 key 记录 emitted source /
   source row id / reference SHA / adapter key（frozen manifest 语义）。对 candidate 引用的每个
   reference 文件复算 SHA-256 并比对（含 materialized projection 文件，复用
   `validateMaterializedFileSnapshot`）。
3. **T2 persist candidate（先 DB 后文件）**：UPDATE → `candidate_persisted`（candidate SHA +
   manifest json + manifest SHA 一次写入）→ 写 candidate temp 文件（同目录，`stagingTempPath`
   范式）→ 校验 JSON + 必要引用 → fsync → rename → fsync(final) → fsync(dir) → UPDATE →
   `file_durable`（`file_durable_at`）。
4. **T3 adapter reload candidate**：调用 adapter reload（§E）；reload 失败 → adapter 保持 LKG，
   publication 证据保留，按 §D 退避重试或 fenced failed/cancelled。
5. **T4 activation acknowledgment**：UPDATE → `activation_pending`（`activation_requested_at`）→
   poll adapter status，直到 loaded registry identity（active sha + generation）== persisted
   candidate SHA；超时/不匹配 → §D。
6. **T5 atomic activation（单条 command）**：INSERT `voice_registry_publication_activations`
   （`normal_owner_finalize`：owner_token + attempt + `observed_active_registry_sha256` =
   candidate SHA）→ trigger 同一 statement 原子完成 projection→`published_usable`（或
   legacy_cutover_existing 零改写）+ legacy→`mapped_active` + publication→`active`。

subject 为 `registry_rebuild`（subject_id=`'global'`）时跳过 projection/legacy 更新（trigger 内
建语义）；`materialization_publish` 与 legacy 双路径的互斥/竞争由 frozen trigger 裁决，publisher
不自行实现第二套判定。

---

## D. 1B 恢复路径（crash reconciliation）

不重造恢复状态机——frozen 8 态 + CC-1…CC-6 即为状态机。reconciler 复用
`MaterializationRecoveryController` 骨架（周期 sweep + 不重入 + shutdown settle，挂
`src/worker/index.ts` 同 1A recovery），每轮只读 journal + 磁盘 + adapter status，按下表行动：

| 重启时 publication 状态 | 读取的 persisted evidence | 下一步 | 何时 rollback | 何时人工 |
|---|---|---|---|---|
| `building` | journal 行（owner/lease/attempt；candidate 证据全 NULL 由 CHECK 保证） | 确定性重建同 candidate 续 T2；或 fenced → `cancelled` | 无需（尚无文件副作用）；legacy subject 按 `trg_lve_rollback` 清 pending | 不需要 |
| `candidate_persisted` | candidate SHA + manifest（journal） | 磁盘无 final 文件 → 重建同 SHA candidate 续 T2 文件写（CC-1） | 可 fenced `failed/cancelled` 后新 row 重试 | 不需要 |
| `file_durable` | candidate SHA + file_durable_at | 磁盘 SHA == persisted candidate → 续 T3 reload（CC-2）；reload 持续失败 → 退避；adapter 保持 LKG，stable legacy 保持 emitted（CC-5） | 放弃时 fenced `failed/cancelled` + legacy rollback 回 `mapped_verified`，新 row 重试 | 不需要 |
| `activation_pending` | candidate SHA + activation_requested_at | adapter active identity == candidate → 补 T5 command（CC-3，重启幂等，重复 command fencing ABORT）；!= candidate → 重 reload 或按失败处理 | owner lease 过期 → 新 owner fenced CAS 接管（attempt+1，CC-6） | 不需要 |
| `indeterminate` | `indeterminate_from_status` + 全部已持久证据（seal 保证进入时不可增删） | 显式 resolve：adapter active == candidate 且 from=activation_pending → INSERT reconciliation command（`indeterminate_reconciliation` + resolution_evidence）；否则 fenced `failed` | indeterminate 占 global 单飞位，必须 resolve 才能新 publication | **无法确定 adapter active identity 时（既非 candidate 也非 stable）→ 仅上报 `REGISTRY_STATE_UNKNOWN`，不动任何状态，人工处理** |
| `active` / `failed` / `cancelled` | 终态证据（immutable） | 无动作；重试 = 新 publication row（新 generation） | failed/cancelled 是 legacy rollback 的前提 | 不需要 |

---

## E. adapter contract（1B.1，已实现；R1 blocker-specific Review PASS；Integrated exact-SHA Review PASS；已部署；FROZEN）

1B.1 已按本节实施（`services/indextts2-api-adapter/server.py`，app version 1.2.0），最终落地形态：

- **registry schema 双支持**：`"1.0"` legacy（production 现状；内部状态
  `generation/publisherSchemaVersion=null`）与 `"1.1"` publisher（`registryGeneration` 必须
  positive integer（bool 显式排除）、`publisherSchemaVersion` 必须精确等于
  `tts-c-registry-publisher@1`；voices 复用既有严格校验链）。未知 schemaVersion →
  `VOICE_REGISTRY_UNSUPPORTED_SCHEMA`；1.1 字段缺失/非法 → `VOICE_REGISTRY_INVALID`。
  adapter 绝不自动改写 registry 文件。
- **runtime state**：`RegistryState` 不可变整体替换——`status / voices /
  loadedRegistrySha256（当前加载文件原始 bytes 的单一 SHA-256，frozen registry identity，
  无额外 hash 层）/ loadedRegistryGeneration / publisherSchemaVersion / schemaVersion /
  lastReloadError / degraded`；swap = 单引用赋值 + `threading.Lock`，reader（health/synthesize/
  status）只持一次快照引用，绝不看到半构造状态。无 capability/WeakMap/token/形式化状态机。
- **`POST /reload`**：只读取 `ADAPTER_VOICE_REGISTRY_PATH` 固定配置路径（不接受 caller 任何
  路径/内容），完整验证后一次性原子替换并返回新 registry status（200）。失败有 LKG →
  保持旧 state/旧 voices + `degraded=true` + `lastReloadError`，返回
  `500 VOICE_REGISTRY_RELOAD_FAILED`（body message 含底层 `VOICE_REGISTRY_*` 码）；
  失败无 LKG → 维持 `ready=false`、synthesize 503。
- **reference 文件验证前置（TTS-C.1B.1.R1 blocker fixed）**：`_load_registry_file()` 在给出
  任何 OK/ack 前，对每个 voice 的 reference 文件做完整验证（存在 + 普通文件 + 可读 +
  实际 SHA-256 == registry `referenceSha256`），统一走 `_validate_reference_file()` helper
  （带 `(mtime_ns, size)` 缓存，通过时填充 `_sig/_actual_sha256/expected_md5`，成功 reload
  后首次 synthesize 不重复读同一文件）。任一 reference 失败 → 本次加载非 OK：有 LKG →
  reload 非 2xx + degraded + `lastReloadError` 精确到
  `REFERENCE_VOICE_MISSING`（缺失/非普通文件/不可读）或 `REFERENCE_SHA256_MISMATCH`，
  旧 voice 继续 synthesize；无 LKG（冷启动）→ `ready=false`（registry-status 与 /health
  detail 同码）+ synthesize 503 原码透传。错误码**复用既有 frozen 语义**（m4b T09/T10
  锁定 `REFERENCE_VOICE_MISSING` / `REFERENCE_SHA256_MISMATCH`；不引入新码，避免
  ack/health/synthesize 三处错误码面漂移）；synthesize 对 `REFERENCE_*` 状态透传原码，
  对 `VOICE_REGISTRY_*` 保持既有 `VOICE_REGISTRY_INVALID` 聚合码。
- **`GET /registry-status`**（唯一 activation acknowledgment endpoint，始终 200）：
  `ready / degraded / schemaVersion / loadedRegistrySha256 / loadedRegistryGeneration /
  publisherSchemaVersion / speakerCount / detail / lastReloadError`。
- **`GET /health`**：保持 `{ready, provider, model, detail}` 兼容，仅增加 `degraded`；
  LKG degraded 视为 healthy（`ready=true + degraded=true + detail=最近 reload 失败码`）。
  registry 完整 status 不复制进 `/health`，activation 用 `/registry-status`。
- **`POST /v1/synthesize`**：请求/响应语义不变（Pydantic extra-field 行为未触碰）。

ack identity = registry **文件字节的单一 SHA-256**（frozen 列 `observed_active_registry_sha256`
的对应物）——这是 frozen contract 已有 registry SHA 语义，不新增 hash 层。不新增签名、token、
auth（内部受控网络，同现有 client 威胁模型）。

测试：`scripts/test-tts-c1b1-adapter-registry.ts`（34 PASS，六场景 + R1 reference 验证前置
R01-R05，mock upstream + 临时目录，独立运行 ×2 无进程/端口泄漏），已并入
`scripts/run-m7-quality-gate.sh`（combined gate suite 54）；venv bootstrap 由
`scripts/run-tts-c1b1-adapter-registry.sh` 管理（gitignored 本地环境，缺失时按 ci.yml 同款
方式现场创建，bootstrap 失败 → 标准 FAILED_SUITE/FAILED_COMMAND/QUALITY_GATE_RESULT=FAIL，
fail-closed 不静默跳过）。
**1B.1 未实现**：publisher、legacy import、DB publication 写入、activation、recovery、
production 拓扑变更；未部署（无 production build / compose up / registry 修改 / /reload 调用）。

**部署拓扑记录项（本计划只记录，不在现阶段实施）**：
1. 当前 registry 是**单文件 bind mount**——publisher 的 temp→rename 原子替换在单文件 mount 上会
   `EBUSY`；1B 部署时必须把 registry 改为**目录挂载**（宿主目录 → 容器目录，publisher/Worker 侧
   rw、adapter 侧 ro）。
2. candidate registry 若引用 materialized voice（`dataDir/voice-materializations/...`），当前
   adapter 无该路径挂载——1B 部署时需为 adapter 增加 voice-materializations 的 **:ro** 挂载
   （或等价的安全投影目录），containment root 相应扩展。
3. 两项均为部署结构变更，属 1B deployment gate 的独立 review 对象；`scripts/test-tts-c1a-compose-
   mounts.ts` 对 adapter 现有 mount 的断言届时需同步更新。

---

## F. legacy import（1B.2）

> **已实现（2026-08-06；R1 blocker repair 后 blocker-specific Review = PASS；merged to m7；
> Integrated exact-SHA Review = PASS；deployed production）**：`src/lib/tts-c/legacy-import.ts`
> `importLegacyRegistry(db, {registryFilePath, voiceRootDir, resolveReferencePath})`——单 BEGIN IMMEDIATE
> 事务（任一冲突整批回滚零写入）；确定性身份 = frozen `UNIQUE(voice_profile_key, voice_revision_key)`
> （不依赖数组顺序/时间）；同 key 同内容（speaker/path/SHA 全等）→ no-op 复用（保留首次 imported_at 与
> source_registry_sha256 provenance）；同 key 异内容 → `LEGACY_IMPORT_CONFLICT` fail-closed；
> **R1 P1-A**：reference 文件前置验证升级为 `verifyReferenceFile(localPath, sha, rootDir)`——
> root realpath 固定 + 逐级 parent 无 symlink + O_NOFOLLOW + fd 读取 + SHA 精确比对
> （错误码复用 frozen `REFERENCE_VOICE_MISSING`/`REFERENCE_SHA256_MISMATCH`）；resolver 只做 path
> translation 无 containment 例外；registry 文件与 reference 文件零修改；只 INSERT
> `mapping_status='unmapped'` 行。registry 路径（容器形态如 `/voices/x.wav`）→ 本机文件的映射由调用方
> `resolveReferencePath` 提供。测试见 §J（138 PASS）。

- **数据源**：宿主机 registry JSON（§A.3；实施前宿主机只读核实实际路径与内容）+ 每个条目
  reference 文件字节（只读重算 SHA-256）。
- **字段映射**（直接来自 legacy registry 文件）：`voice_profile_key`←`voiceProfile`；
  `voice_revision_key`←`voiceRevision`；`speaker_name`←`speakerName`；
  `reference_asset_path_or_safe_projection`←`referenceAssetPath`；`reference_sha256`←
  `referenceSha256`（与文件重算值比对，不符 fail-closed）；`source_registry_sha256`←源 registry
  文件内容 SHA-256；`imported_at`←DB 时间。初始 `mapping_status='unmapped'`，全部
  mapping/cutover 列 NULL（frozen CHECK 初始形状）。
- **不由 import 设置**（保持 unmapped）：`mapped_voice_materialization_id / mapping_mode /
  pending_publication_id / candidate_*`——与 TTS-A projection 的映射只能经 frozen 6 项等价验证
  走到 `mapped_verified`（后续显式步骤/阶段决策），import 绝不伪造 TTS-A 数据。
- **幂等**：`UNIQUE(voice_profile_key, voice_revision_key)`——同 key 同内容重复导入 = no-op；
  同 key 异内容（speaker/path/SHA 任一项漂移）= **冲突 fail-closed**，明确错误，不更新。
- **副作用边界**：import 只 INSERT `legacy_adapter_voice_entries`（unmapped）；不改变 active
  registry；不创建 publication；不触碰 adapter；不触碰 `voice_materializations`。
- 形态：Worker/lib 侧普通函数 + 显式操作入口（script 或 gated API），非自动后台任务；
  本轮实现为 lib 函数 + 测试入口（`scripts/lib/tts-c1b2-child.ts` 供真实双进程并发测试），
  未挂 worker/API，未新增 public POST。

---

## G. 1C capability snapshot

普通 TypeScript 常量 + zod schema（`src/lib/tts-c/provider-capability.ts`），**不新建数据库
表**——frozen 契约未要求 1C 落库，现有 artifact/payload 机制足以承载（§I）。已实现
（TTS-C.1C.1，Independent Review PASS，已集成到 m7）。

```text
ProviderCapabilitySnapshotV1 = {
  provider: 'indextts2';                        // 与 tts_jobs.provider 取值一致
  adapterCompatibilityKey: 'indextts2-adapter-registry@1';
  snapshotVersion: 'indextts2-capability@1';    // 版本化常量，变更即新版
  controls: {                                   // v1 仅 4 项，逐项声明支持面
    deliveryOverride: { supported: false },
    pace:             { supported: false },
    energy:           { supported: false },
    emotionSemantic:  { supported: false },
  };
  // 未来某 control 转 supported 时在此补 ranges/enums（如 pace: {enum:[...]} 或 {min,max}）
}
```

v1 **不含** emotionVector / emotionAlpha / emotionReferenceAudio / useRandom——它们是后续
产品增强需求（见 §G.1），不是 v1 schema 的扩展位。controls 对象 `.strict()`：v1 中出现这些
control 键即显式拒绝，杜绝静默未知键。

snapshot v1 内容**如实反映 adapter 现状**（§A.4：`SynthesizeRequest` 仅 5 字段，非默认
useRandom/emotion 显式 422）——当前全部表现力 control 为 unsupported。snapshot 的「固化」=
版本化 TS 常量 + 随编译结果进 provenance 字段；「执行前比对」在 C.2 执行链首次消费时落地
（执行时 snapshot version 必须与编译时记录一致，不一致 fail-closed）。

### G.1 Future requirements retained（TTS-C.1C.1 记录）

- 当前代码 schema（TTS-B frozen `src/lib/tts-b/performance-schema.ts` 与 v1 snapshot）**不含**
  emotionAlpha / 八维情绪向量 / emotion text / emotion reference audio / useRandom。
- 它们仍是**后续产品增强需求**，TTS-C.1C.1 **未取消**这些需求；等真实 schema 引入时，通过
  **新的 snapshotVersion / compilerVersion** 扩展（v1 保持冻结不变）。
- 不得把当前实现缺失解释为永久取消。

## H. 1C compiler

纯函数模块 `src/lib/tts-c/capability-compiler.ts`，零 DB、零 IO、零时钟、零环境变量、
零随机数依赖（TTS-C.1C.1 已实现，Independent Review PASS，已集成到 m7）：

```text
compilePerformanceToProvider(input: CapabilityCompileInput, snapshot: ProviderCapabilitySnapshotV1)
  → { providerParams: Record<string,unknown>,   // 仅含 supported 且 non-neutral 的编译结果
      unsupportedFlags: UnsupportedControl[],   // 每个 non-neutral 但无通道的输入一项
      compilerVersion: '1.0',
      snapshotVersion: string }
```

规则（frozen §12 + 1C scope）：

1. **neutral → supported no-op**：`deliveryOverride:null`、`pace:'normal'`、`energy:'normal'`、
   `emotion:{mode:'none'}` 不进 providerParams、不进 unsupportedFlags。
2. **supported non-neutral → 编译为 provider 参数**：按 snapshot 声明的 ranges/enums 映射；
   越界/非法枚举 → 显式错误（与 unsupported 区分：这是输入非法，不是能力缺失）。
3. **unsupported non-neutral → explicit unsupported**：记入 `unsupportedFlags`（control 名 +
   输入值 + snapshotVersion），**不静默丢弃**；调用方按预留错误码
   `PERFORMANCE_PROVIDER_CAPABILITY_UNRESOLVED` 决定是否 fail（C.2 执行链 fail-closed；
   规划/预览路径可展示）。
4. **不静默丢任何字段**：输入对象的每个键必须落入 providerParams 或 unsupportedFlags 之一；
   schema 外未知键 → 显式拒绝（zod strict，同 Performance Plan `.strict()` 先例）。
5. **确定性**：同 input + 同 snapshot → 逐字节同输出（canonical JSON 序列化后比较）。

输入面 = TTS-B 冻结字段（§A.4：`deliveryOverride / pace / energy / emotion{none|semantic×6}`），
接口类型为 `Pick<PerformanceItemV1, 'deliveryOverride'|'pace'|'energy'|'emotion'>`，输入 schema
`.strict()`：**未知字段显式拒绝**（含 unitId 及任何 v1 之外的键）。`TtsRequest.emotion` 的
`'text'|'vector'` mode 与 emotionAlpha / 向量 / 参考音频**不属于 v1 输入**——它们仍是后续
产品增强需求（§G.1），真实 schema 引入时 bump snapshot/compiler version，compiler 届时按新
版本扩展。delivery 编译策略采用冻结计划的推荐
（`docs/TTS_C_IMPLEMENTATION_PLAN.md:312` 未决事项①）：**显式 unsupported**，不做文本改写。
对 snapshot v1（全 control unsupported）：所有 non-neutral 输入 → explicit unsupported；neutral
输入 → no-op——这正是 1C.1 测试矩阵的实际期望值。

## I. provenance 复用

- **1C 不新增 DB 表/列**。编译结果的权威载体（`tts_jobs.synthesis_payload_fingerprint` 列、
  `sentence_audio_artifacts.capability_snapshot_json / compiled_payload_json /
  capability_compiler_version` 列）是 frozen §2.0/§2.4 的 **C.2 migration** 内容，与 1C scope
  「不调用真实 synthesis」及 DAG（C.2 依赖 1A+1B+1C）一致。
- 1C 阶段 provenance = 编译输出的普通 TS 字段（`snapshotVersion / compilerVersion /
  providerParams / unsupportedFlags`），由 1C.2 交给 C.2 payload builder 消费。
- 需要持久化时的既有机制（复用，不新建）：artifacts 表 `kind + content_json +
  MAX(version)+1`（`src/lib/tts-b/performance.ts:733-746`）+ 应用层 canonical JSON sha256
  （`performance.ts:710-714`）；payload_json union 版本演进先例（`tts-jobs.ts:76`）；
  三态严格 provenance 解析先例（`src/lib/assets/model.ts:76-114`）。
- fingerprint：1C 不动现有 `ttsInputFingerprint`；`synthesisPayloadFingerprint`（含 capability
  输入）由 C.2 按 frozen 定义实现。1C 只保证编译输出确定性（§H 规则 5），为 C.2 fingerprint
  提供稳定输入。

---

## J. 测试计划（最小充分；普通 unit/integration；零真实 provider）

> **1B.2 测试已实现（2026-08-06；R1 后 138 PASS ×2 独立运行；已并入 m7，Integrated exact-SHA Review = PASS，deployed production）**：`scripts/test-tts-c1b2-publisher-candidate.ts`
> **106 PASS ×2**（零进程/fd/temp/端口泄漏；真实双进程并发 via `scripts/lib/tts-c1b2-child.ts`）+ **R1 新增 32
> 断言**：R1-01 双进程完整 orchestrator（同 subject 恰好一个 completed winner，另一个 already_in_flight /
> already_file_durable；publication row 1；generation 1；无 temp 残留；DB evidence == candidate SHA）；
> R1-02/03 subscriber 零副作用（already_in_flight 结果无 owner token、不续租（lease 不变）、不写文件、
> 不推进 DB、不新建 publication row）；R1-04/05 dir-fsync 失败 → existing-final 重跑重新 fsync final +
> parent dir（计数器证明）→ 成功后 file_durable；重跑 fsync 仍失败 → 保持 candidate_persisted；
> R1-06 existing final generation 语义校验拒绝（方案 A）；R1-07 resolver 越出 root 拒绝；
> R1-08 voice root 内 parent symlink 拒绝；R1-09 materialization parent symlink 拒绝
> （validateMaterializedFileSnapshot CONTAINMENT）；R1-10 final symlink reference 拒绝。
> A legacy import 10 场景（首次导入/重跑幂等/双进程单权威/一致复用/内容冲突整批回滚/reference
> 缺失/SHA 不符/未知 schema/重复 key/registry+reference 零修改）；B T1 claim 10 场景
> （materialization_publish、legacy_cutover_publish、legacy_cutover_existing frozen gate、
> registry_rebuild、非法 subject 组合、重放复用、双进程唯一 winner、异 subject 单飞冲突 +
> 终态后串行、projection 状态 fail-closed、冲突零新行）；C candidate 确定性 10 场景（重复构建
> 逐字节一致/manifest 排序/key 冲突 fail-closed/generation MAX+1/1.1 字段完整/publisherSchemaVersion
> 精确/SHA==bytes/无多余字段/legacy+materialization 合并裁决/输入对象零修改）；D durable file
> 15 场景（正常 temp→fsync→rename→dir fsync、文件 SHA==DB evidence、fsync/fsyncDir/rename/
> reread/SHA-mismatch 故障注入、symlink root/final 拒绝、escape 拒绝、DB 不先于文件、
> 文件 durable 后 DB finalize 失败留 recoverable evidence、重跑复用、同 generation 异 bytes
> fail-closed、无残留）。combined gate suite **55**。`legacy_cutover_existing` 的合法前置
> （projection published_usable）只能经 T5 activation command 产生（1B.3），1B.2 断言 frozen
> gate ABORT（`SQLITE_CONSTRAINT_TRIGGER` subject invalid）——合法路径由 1B.3 测试覆盖。

形态：临时 registry 目录 + Mock adapter（Node 起 HTTP server 模拟 /reload、/health、
/registry-status）+ 临时 SQLite DB（复用 1A 测试的 temp DB 模式）。新 suites 按既有纪律并入
`scripts/run-m7-quality-gate.sh`（suite 数真实增加）。禁止：mutation workflow、多层 checksum
evidence、大量理论 corner case、production 真实 IndexTTS2 调用。

**1B 核心测试（6 项）**：

1. **candidate 不影响 stable**：T1-T3 期间 stable view 与 adapter 当前 active registry 不变。
2. **reload 失败不 activation**：mock reload 失败 → publication 不到 active、projection 不
   published_usable、legacy 不 mapped_active、adapter 保持 LKG。
3. **ack 不匹配不 activation**：mock status 返回 identity ≠ candidate SHA → 不产生 activation
   command，状态不越过 activation_pending。
4. **activation 成功原子更新**：单条 command → projection `published_usable` + legacy
   `mapped_active` + publication `active` 同 statement 完成；任一前置破坏（owner/attempt/lease/
   observed SHA）→ 整体 ABORT 零变化。
5. **重启可从 persisted 状态继续**：在每个 T 阶段后注入崩溃 → reconciler 按 §D 表续跑/回退
   （含 lease 过期 takeover、indeterminate 显式 resolve、未知 identity 仅上报）。
6. **legacy import 幂等**：重复导入零变化；同 key 异内容 fail-closed；import 后 active
   registry / publication / projection 零变化。

**1C 核心测试（TTS-C.1C.1 已实现，`scripts/test-tts-c1c1-capability.ts`，53 PASS）**：

1. **neutral no-op**：全 neutral 输入 → providerParams 空、unsupportedFlags 空（不因
   supported:false 报 unsupported）。
2. **supported 编译正确**：构造 synthetic snapshot 打开部分 control → 参数直接映射正确、
   不进入 unsupportedFlags。
3. **unsupported 明确失败**：每个 control non-neutral 无通道 → 对应 flag
   {control, inputValue, snapshotVersion} 逐项齐全、不错进 params。
4. **固定顺序**：多个 unsupported → flags 按 deliveryOverride/pace/energy/emotionSemantic
   固定顺序、无遗漏。
5. **编译结果稳定**：同输入同 snapshot 重复编译逐字节一致（JSON 序列化）。
6. **schema 外字段显式拒绝**：unitId / 未知键 / 非法枚举 / 非法 snapshot → ZodError。
7. **输入不被修改**：深冻结输入与 snapshot 编译后原对象逐字节不变。

---

## K. 阶段拆分与依赖

| 子阶段 | 内容 | 依赖 |
|---|---|---|
| **TTS-C.1B.1** | adapter registry/status/reload contract（§E：POST /reload + LKG + /health 扩展 + registry-status ack 面 + registry JSON 1.0/1.1 双 schema）+ mock integration tests；**不触碰 production active registry**。**FROZEN（R1 blocker-specific Review PASS + Integrated exact-SHA Review PASS + Production deployment PASS + Deployment Evidence Review PASS；已部署）** | 无（可与 1C.1 并行） |
| **TTS-C.1B.2** | legacy import（§F）+ publisher candidate creation（§C 步骤 1-3：T1 claim、candidate 构建、T2 persist 到 file_durable）+ publication 状态推进；**不 reload adapter**。**= FROZEN（审计链：initial Independent Review FAIL `08be813…` → R1 blocker-specific Review PASS `bcfd29b…` → Integrated exact-SHA Review PASS → production deployment PASS → Deployment Evidence Review PASS；测试 138 PASS；combined gate suite 55）** | 依赖 1B.1 contract（registry JSON schema 与 ack 字段冻结） |
| **TTS-C.1B.3** | adapter reload 接入（§C 步骤 4）+ activation acknowledgment（步骤 5）+ atomic activation（步骤 6）+ recovery/reconciler（§D）。**implemented on work branch `work/tts-c1b3-activation-recovery`（Independent Review FAIL → R1 blocker repair implemented：fenced indeterminate / uncertainty 闭环 / stable rollback / legacy rollback / per-HTTP renew / path containment / adapter error contract；pending blocker-specific Review；not merged；not deployed；测试 149 PASS；combined gate suite 56）** | 依赖 1B.2 |
| **TTS-C.1C.1** | capability snapshot（§G）+ pure compiler（§H）+ tests（§J 1C 七项）——**FROZEN（Independent Review PASS + Integrated exact-SHA Review PASS + Production deployment PASS + Deployment Evidence Review PASS；已部署）** | 无（可与 1B.1 并行） |
| **TTS-C.1C.2** | 编译结果接入未来 C.2 payload builder（provenance 字段交接，§I）；**当前阶段不调用真实 synthesis** | 等待 C.2 authorized |

并行关系：**1B.1 ∥ 1C.1**；1B.2 依赖 1B.1 contract；1B.3 依赖 1B.2；1C.2 等待 C.2。
每个子阶段：独立 tests、独立 Review、独立 deployment gate、不产生半成品 active 状态（同
`docs/TTS_C_IMPLEMENTATION_PLAN.md` 阶段门禁表）。Git 纪律沿用：单一 integrator 拥有 `m7`、
精确暂存、每 exact SHA 独立验证。

**部署边界（1B 未来部署同样遵守）**：部署后业务入口保持关闭（publisher 无自动触发、import 人工
触发、POST gate 不变），经独立 smoke 后再单独决定是否启用；§E 的两项 compose 拓扑变更（registry
目录挂载、adapter voice-materializations :ro 挂载）随 1B 部署独立 review。

---

## L. 明确不实施项

- 不修改 frozen schema / trigger / migration；不新增数据库表或列（含
  `sentence_audio_artifacts.capability_*` —— C.2）。
- 不新增任何 SHA/checksum/hash 层（仅用 frozen 已有 registry SHA 与文件 SHA-256 语义）。
- 不新增 object-capability / WeakMap authority 模式；publisher 用普通函数 + DB fencing。
- 不新增 mutation workflow / CI gate / 形式化验证。
- 不实现 TTS-C.2（request envelope / synthesis claim / durable job / attempt journal /
  sentence audio artifact / 三分离 fingerprint / execution transitions）——**not authorized**。
- 不调用真实 IndexTTS2 synthesis；不做 TTS 合成相关任何代码路径。
- 本规划轮及 1B/1C 实施期间：不 enable production POST gate；不向 production 发布 registry；
  不 reload production adapter；不创建 production publication / legacy mapping 行；不修改
  production 任何配置与数据。
- 不改变 adapter `/v1/synthesize` 行为；不新增 auth/token/签名机制。
- 不做 UI（后续出现真实 UI 需求时另行评审）。
- 不自动迁移/改写 351 行历史 `tts_jobs`；不自动重新生成任何音频；不切换任何项目到 m7。
- 不实现 emotionAlpha / 八维情绪向量 / emotion text / 情绪参考音频 / useRandom 通道（TTS-B
  frozen 输入面与 v1 snapshot 均不含，前提订正 2 + §G.1）——**仍是后续产品增强需求，1C.1
  未取消**；真实 schema 引入时必须 bump snapshotVersion / compilerVersion。
- delivery 不做文本改写（采用显式 unsupported，冻结计划未决事项①的推荐）。
- 1B.1 不触碰 production active registry；1B.2 不 reload adapter；1C.2 不调用真实 synthesis。
- compose/部署拓扑变更（§E 记录项）不在本计划实施，仅随 1B 部署 gate 独立评审。

## M. 推荐模型分工

| 子阶段 | 推荐模型 | 原因 |
|---|---|---|
| TTS-C.1B.1 / 1B.2 / 1B.3 | GPT-5.6 Thinking 或强 Coding Agent | 全局 registry publication、legacy cutover、activation 原子性与 crash recovery 直接影响 production；需要强事务/状态机推理 |
| TTS-C.1C.1 | DeepSeek | 纯函数 + 快照常量，低风险、易回归、测试矩阵清晰 |
| 视觉 / UI Review | Kimi（仅后续出现真实 UI 时） | 本轮及 1B/1C 无 UI 工作 |

---

> 本计划经 Review 通过后，各子阶段按 §K 顺序独立立项实施；任何超出 §L 的变更必须先修订本计划。
