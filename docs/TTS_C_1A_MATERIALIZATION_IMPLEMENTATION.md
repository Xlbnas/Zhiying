# TTS-C.1A — Durable Voice Materialization Foundation（实施文档）

> 状态：TTS-C.0 = FROZEN（reviewed contract commit `ae7a93d…`、§2 SQL SHA `c88f64ac…`）；
> 本阶段只实现 **Durable Voice Materialization Foundation**，终点 = `voice_materializations.status =
> file_ready_unpublished`。不发布 registry、不激活 adapter、不 cutover、不合成 TTS。
> 1A schema 严格按 frozen §2 相关片段提取（migration SQL 与 frozen §2 片段 hash 绑定，见
> `scripts/build-tts-c1a-migration.ts` 与 `scripts/test-tts-c1a-migration.ts`）。

## 0. 官方/开源实现参考审计（只读）

编码前对照官方文档/官方仓库（不引入任何 runtime 依赖）：

| 来源 | 借鉴点 | 与知影不兼容 | 未采用原因 |
|---|---|---|---|
| SQLite 官方（[Transaction](https://www.sqlite.org/lang_transaction.html) / [CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html)） | `BEGIN IMMEDIATE` 单写者串行化（Phase 1/3 原子）；trigger `RAISE(ABORT)` 同 statement 原子性；FK/partial UNIQUE 在 DB 层强制 | 无（知影本就单机 SQLite） | 直接复用 |
| Node.js 官方 fs（[fsPromises.open/fsync/rename](https://nodejs.org/api/fs.html)） | `open` 显式 flags（'r' 源 / 'wx' temp 独占）；`filehandle.sync()` 对应 POSIX fsync；`rename` 同目录原子替换；`lstat` 非 symlink 校验；`realpath` 包含性 | `fsPromises.copyFile` 不保证原子性且不暴露 fsync——1A 用 open+read/write+sync 手工管线 | copyFile 无法满足 durability 顺序要求 |
| DVC 官方仓库（object store / cache / damaged object） | 内容寻址 + 写入后校验 hash 才视为有效；损坏对象视为缺失可重算 | DVC 用 .dvc 文件 + 远程缓存，超出单机 SQLite 范围 | 知影用 DB 引用 + 本地文件投影 |
| Git LFS 官方仓库（pointer/object 分离） | pointer（DB 行）与 object（文件）分离；object 内容不可变、身份=内容 | LFS 面向 Git 远端传输 | 知影无 Git 存储需求 |
| MLflow 官方仓库（artifact 元数据/本地仓库包含性） | artifact 元数据持久化；本地 artifact 目录 containment 校验 | MLflow 用 file:// URI + 独立 server | 知影投影路径固定 root-relative |
| Temporal / BullMQ 官方（lease renewal / stalled recovery / single-flight） | lease 续租 + 过期接管（attempt+1）；单飞 fan-in 恰好一个执行者 | 分布式锁/事件溯源 | 知影单机 `BEGIN IMMEDIATE` 原子多行更新天然单飞 |

**结论**：知影保持 SQLite + existing Worker + local durable filesystem；所有写入路径为
temp → fsync → validate → rename → fsync(final) → fsync(dir) → BEGIN IMMEDIATE DB commit。

## 1. 数据流与阶段边界

```
TTS-A exact Voice Revision（voice-library/<pid>/<rid>/reference.wav，不可变）
  → TTS-B exact Project Voice Assignment artifact（project-voice-assignment@1.0）
  → voice_materialization_requests（project-scoped envelope，initializing → waiting）
  → voice_materialization_jobs（single-flight，validating_existing → queued → running → 终态）
  → durable canonical file projection（<voice-root>/<profile_id>/<revision_id>/reference.wav）
  → voice_materializations.status = file_ready_unpublished
```

本阶段明确不做：registry publish/activation、adapter reload、legacy cutover、capability
compiler、TTS synthesis/job、narration audio、preview、master、subtitle timing、project m7
activation。

## 2. Migration（frozen §2 提取，hash 绑定）

- 来源：`docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md` §2 的六个块：
  `voice_materialization_requests` / `voice_materialization_jobs` / `voice_materializations` /
  `legacy_adapter_voice_entries` / `voice_registry_publications` /
  `voice_registry_publication_activations`（后三张为 1B 建立，本阶段零写入）。
- 生成器 `scripts/build-tts-c1a-migration.ts`：
  1. 从 frozen 文档 §2 逐字提取六块的 executable SQL；
  2. pass 1 = 全部 `CREATE TABLE`（按 §2 顺序；SQLite 前向 FK 引用合法）；
  3. pass 2 = 全部 `CREATE TRIGGER`/`CREATE UNIQUE INDEX`（块顺序 2.5→2.6→2.7→2.9→2.8→2.10，
     保证 trigger 引用的表已建）；
  4. 包装为幂等形式（`CREATE TABLE IF NOT EXISTS` / `CREATE TRIGGER IF NOT EXISTS` /
     `CREATE UNIQUE INDEX IF NOT EXISTS`），并在每个 CREATE 前记录 frozen 片段原文；
  5. 输出 `frozenFragmentsSha256`（frozen 原文拼接 hash）与 `appliedSqlSha256`（幂等包装后 hash）。
- 测试 `scripts/test-tts-c1a-migration.ts` 断言：frozen 片段 hash 与记录的基线一致（绑定
  c88f64ac… 派生值）、clean DB apply、production-like 旧 DB apply、重跑幂等、`foreign_key_check`
  空、`integrity_check` ok、`tts_jobs` 351 行 fixture hash 不变、六张表存在且 publication/
  activation/legacy 表 0 行。
- 不创建：`tts_audio_requests` / `tts_synthesis_claims` / `tts_claim_generation_dispatches` /
  `tts_job_execution_transitions` / `tts_generation_attempts` / `sentence_audio_artifacts` /
  `tts_jobs` TTS-C 列（属 C.2）。

## 3. 请求信封（project-scoped）

- `POST /api/projects/[id]/voice-materializations` body：`{requestId, projectVoiceAssignmentArtifactId}`。
- 服务端从 exact Assignment 派生的唯一权威身份：`projectId / voiceProfileId /
  voiceProfileRevisionId / canonicalAudioSha256 / adapterCompatibilityKey / provider`——不另设
  两套 identity。
- 校验链（fail-closed）：
  1. project 存在；assignment artifact 属于 project 且 kind=`project_voice_assignment`；
  2. `parseProjectVoiceAssignment` 契约通过；compilerVersion 匹配；
  3. 重新调用 TTS-A `validateVoiceProfileRevisionExact`（archive 后 historical exact read 仍可用，
     不要求 profile 当前 active）；
  4. `classifyProjectVoiceAssignment` source 自洽（ASSIGNMENT_SOURCE_MISMATCH → fail-closed）；
     仅 `current_candidate` 可 materialize。
  5. 任何 missing/hash drift/path invalid → 明确错误，禁止 latest revision fallback。
- `requestId`：`UNIQUE(project_id, request_id)`。同 requestId + 同 exact source（派生身份全等）→
  复用同一 envelope；同 requestId + 异 source → 409 `REQUEST_ID_CONFLICT`。
- 初始状态 `initializing`（不计 active subscriber）；完成 exact job link 后同一事务 → `waiting`。
  失败路径：frozen CHECK/trigger 允许的 cancelled/failed；不允许长期 committed initializing。

## 4. Single-flight job（validating_existing）

- 身份：`voiceProfileId + voiceProfileRevisionId`（exact）。
- 同 exact revision 的多 project 请求 fan-in 到同一 active job（
  `uq_voice_materialization_jobs_active` partial unique 强制）——恰好一个 Worker copy。
- 三阶段：
  - **Phase 1（BEGIN IMMEDIATE）**：envelope-first 裁决 → 建/复用 initializing request →
    exact source 验证（读 Assignment/Revision，不读文件字节）→ 查现有 projection → 查/建 active
    `validating_existing` job（validation_owner_token/lease/attempt）→ 链接 request→job →
    request→waiting → COMMIT。
  - **Phase 2（事务外）**：exact projection/file validator（只读，不写文件）：
    - existing projection 文件存在且 exact（SHA/codec/sr/ch/duration 与 Revision 一致）→ usable；
    - 缺失/漂移 → unusable。
  - **Phase 3（BEGIN IMMEDIATE fenced finalize）**：
    - usable：job→succeeded、active requests→reused + materialization_id、零文件写、不 enqueue；
    - unusable + active subscriber=0：job/request cancelled、不 queue；
    - unusable + active subscriber>0：fenced `validating_existing → queued`（Scheduler 才可见）。
  - fence WHERE：status + validation_owner_token + validation_attempt + `DB_NOW_MS <=
    validation_lease_expires_at_epoch_ms` + candidate metadata hash（IS 语义）+ 源身份；
    `changes=0` → `STALE_VALIDATION_OWNER` 整事务回滚零文件写。
- stale validating job：lease 过期 → fenced takeover CAS（validation_attempt+1、新 owner、新 lease）
  → 新 owner 重验；旧 owner finalize changes=0。

## 5. Worker materialization（唯一 writer）

- Worker 是唯一文件 writer；Web 无 materialization 文件写代码路径（API 不暴露任何文件操作；
  序列化不含路径）。容器挂载以实际 compose 审计为准：web/worker 同挂 data volume（TTS-A ingest
  需 Web 写 voice-library），materialization root 的文件写入仅存在于 Worker 代码。
- 目标路径固定：`<voice-root>/<profile_id>/<revision_id>/reference.wav`（root-relative 入库；
  `<voice-root>` = `dataDir/voice-materializations`，与 voice-library 同级且分离）。
- 路径安全：拒绝 absolute / `..` / symlink traversal / arbitrary extension / user-controlled
  filename；realpath 包含性；final 非 symlink 且 regular file。
- 执行顺序（frozen durability 协议）：
  1. fenced claim（queued→running，owner/lease/attempt/heartbeat）；
  2. exact Revision reread（TTS-A validator）；3. exact Assignment/source reread；
  4. open source no-follow（'r'）；5. mkdir 目标目录（recursive）；6. temp 同目录 'wx' 写入；
  7. copy bytes；8. fsync temp（filehandle.sync）；9. 校验 SHA256/size/regular/WAV/pcm_s16le/
     mono/48000/duration；10. rename temp→final；11. fsync final；12. fsync parent dir（open dir + sync）；
  13. BEGIN IMMEDIATE fenced reread（job owner/token/attempt/lease、subscriber 集合、
      Profile/Revision exact、Assignment exact、source SHA、path shape）；
  14. INSERT projection `file_ready_unpublished`；15. job→succeeded；16. active requests→succeeded
      + materialization_id；17. COMMIT。
- 任何 mismatch：DB success 不提交；不产生 published_usable；不创建 publication；不调用 adapter；
  orphan 文件仅由受控 cleanup 处理（cleanup 不删除 DB 已引用文件）。
- 不转码（输入已是 TTS-A canonical WAV）；不申请 GPU lease。

## 6. Durability 与 cleanup

- 故障注入面：source open / read / temp create / partial write / temp fsync / validator /
  rename / final fsync / dir fsync / DB final tx / cleanup。
- 规则：durability 关键步骤失败 → 不返回成功；cleanup best-effort 且失败不覆盖原始错误；
  committed projection 必有 usable final file；orphan 不得被 reader 视为 usable；cleanup 不得删除
  DB 已引用文件；symlink/path containment fail-closed。

## 7. Projection contract

- 本阶段唯一允许完成状态：`file_ready_unpublished`。禁止写 published_usable / registry_pending；
  禁止创建 `voice_registry_publications` / `voice_registry_publication_activations` 行。
- API 明确返回：materialized file durable、registry unpublished、adapter not ready、TTS
  unavailable（`adapterReady=false`）；不把 file_ready_unpublished 展示为 ready for synthesis。
- 序列化禁止输出 absolute path / internal relative path / staging path / host mount / source
  canonical path；可输出 profile/revision ID、SHA 短摘要、status、duration、codec/sr/ch、
  created/updated、request/job status。

## 8. Scheduler / Worker 集成

- 新增独立 job kind `voice_materialization`（第 6 队列，全局 FIFO）：
  - Scheduler 只 claim `queued`（`validating_existing` 不可见）；resource class 非 GPU（不占
    LLM/GPU lease）；claim 时 fenced owner/lease/attempt；运行期 heartbeat 续租；lease 丢失 →
    abort + 不提交 success（zero side effect）。
  - active subscriber=0 时 claim 前取消（Phase 3 已裁决 queued 前取消；claim 后 running 期间
    subscriber 全取消遵循 frozen cancellation：设置 cancel_requested，Worker 在 commit 前重读并
    走 cancel）。
  - 失联恢复（running + lease 过期）：`request.job_id` 为 frozen write-once（不可重链接），
    因此同事务 fenced `running → failed` + 该 job 的 waiting/running requests → `failed`
    （显式失败终态，无假成功）；后续新请求自带新 envelope → 新建 validating job → 重新
    Phase 2/3。恢复判定用数据库时间（`DB_NOW_MS`），与 frozen R9 fencing 一致。
  - 不修改现有 TTS worker 语义；不影响 render/resource lease 回归。

## 9. 测试（scripts/test-tts-c1a-*.ts，全部 temp DB + temp dirs + mock）

A migration（clean/production-like/幂等/FK/integrity/351-hash/0-row）、B request idempotency
（reuse/409/project scope/cross-project 拒/malformed/no fallback）、C fan-in（两 request 同
revision 恰好一个 job/同一 job/并发单飞/no duplicate copy）、D validation phase（validating 不可见/
usable reuse 零写/unusable+subscriber→queued/zero→cancelled/takeover/stale changes=0/三方竞争）、
E source validation（exact/archive 历史允许/missing/hash drift/pair/provider/adapter 不匹配/
metadata 非法/symlink/path escape）、F durability（全故障注入/no false success/no partial
fan-out/cleanup best-effort/orphan fail-closed/不删引用文件）、G projection（file_ready 唯一终态/
publication=0/activation=0/adapterReady=false/paths redacted）、H boundary（IndexTTS2=0/LLM=0/
TTS jobs=0/narration 不变/registry 未发布/adapter 未 reload/project m7 未激活）、
I frozen regressions（R13 contract 150/150、M7 gate、TTS-A/B frozen、resource leases、billing、
build/typecheck）。新 suites 并入 `scripts/run-m7-quality-gate.sh`（suite 数真实增加）。

## 10. TTS-C.1A.R1 加固（独立 Review FAIL 关闭项）

- **P0-1 validation ownership handle**：`ValidationLeaseHandle{jobId, validationOwnerToken, validationAttempt, validationLeaseExpiresAtEpochMs, candidateMaterializationId, candidateMaterializationMetadataHash}`。
  只有 Phase 1 创建 job 或 fenced takeover（changes=1）的赢家持有；`takeoverStaleValidatingJob` 返回
  `handle | null`（输家 null，不重读借用新 owner token）；`finalizeValidatingJob(handle, result)` 的
  fenced reread WHERE 只来自 handle（id/status/token/attempt/DB_NOW<=lease/candidate id+hash exact），
  禁止接受整行 fresh DB job 作为凭据；lease 有效时 subscriber 只 fan-in（waiting + inflight），
  不运行 validateExistingProjection、不 finalize（validator 实际调用恰好一次）。
- **P0-2 worker execution handle**：scheduler claim 返回 `MaterializationExecutionHandle{jobId, ownerToken, attempt, leaseExpiresAtEpochMs}`；
  `runMaterializationJob(handle)` 全程只用 handle；`workerFinalizeMaterialization` final WHERE
  `status='running' AND owner_token=handle.ownerToken AND attempt=handle.attempt AND DB_NOW<=lease`
  （禁止仅 owner_token IS NOT NULL）。
- **Heartbeat**：claim 后立即启动 loop（每 `MATERIALIZATION_HEARTBEAT_INTERVAL_MS` fenced 续租；
  changes=0 → ownershipLost + 停止后续文件副作用）；关键步骤前（source open / temp 写 / rename /
  final DB）显式 fenced verify；shutdown signal 中止；finally 停 timer；异常不静默。
- **Autonomous recovery**：`recoverExpiredMaterializationJobs(limit)` 在 Worker scheduler tick 前独立运行
  （不依赖新 HTTP request）：expired running + 无 durable final file → failed + requests failed
  （error_code=`RECOVERY_FILE_UNAVAILABLE`）；final file exact（SHA+WAV 契约）→ 完成
  projection/job/request（crash 窗口）；damaged → failed；无法确定 → indeterminate；每 job BEGIN
  IMMEDIATE fenced（多 Worker 恰一裁决）。确定性 executor 错误且仍持有 exact handle →
  立即 `failMaterializationJobFenced`（不等 lease 过期）。
- **Commit-time exact source fence**：final DB transaction 内逐项重读——job exact
  owner/token/attempt/lease、destination path shape、exact Revision DB metadata identity
  （sha/adapter/provider）、每个 active request 的 Assignment source 逐项
  （project/profile/revision/provider/sha/adapter）、final evidence 逐项
  （relative path/SHA/size/regular/codec/sr/ch/duration）——任一漂移 → SOURCE_STALE/
  REQUEST_STATE_INCONSISTENT，整事务回滚零副作用（mutation proof：owner/attempt/lease 条件
  任一移除测试 FAIL）。
- **P0-3 真实 no-follow 与 containment**：source/final `O_RDONLY|O_NOFOLLOW` + fstat regular
  （不依赖 lstat→open 两步）；temp `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`；root 必须真实目录非
  symlink；profile/revision 逐级 lstat（任一级 symlink → fail-closed）；parent realpath 必须位于
  root realpath 内；rename 前后 parent containment 复核；cleanup 只删自身路径。
- **Web/Worker mount 分离**：`ZHIYING_HOST_MATERIALIZATIONS_DIR`（:? 强制，缺失 fail-closed）——
  Web `:/app/data/voice-materializations:ro`、Worker `:rw`、adapter 无该 mount；TTS-A voice-library
  Web 写入不回退（/app/data 主挂载保留 rw）；registry mount 不变。
- **P1 requestId 并发幂等**：envelope-first BEGIN IMMEDIATE 事务内 SELECT→裁决→INSERT；
  UNIQUE race 事务内捕获重读裁决（不逃逸 500）；同 requestId+同 source 并发恰一 INSERT 两调用成功；
  异 source → 409；跨 project 互不冲突。
- **Existing request outcome 按真实状态映射**：succeeded/reused+usable projection→reused；
  waiting+validating/queued→inflight/queued（按 job 真实状态）；running→inflight；failed→failed；
  cancelled→cancelled；indeterminate→indeterminate；committed initializing→REQUEST_STATE_INCONSISTENT。
- **测试**：13 套件（原 7 + R1 新增 6：validation-ownership/worker-fencing/recovery/path-security/
  request-concurrency/compose-mounts），真实双进程并发（child 进程独立连接）、真实 symlink fs、
  mutation proof（5 项 fence 禁用验证均 FAIL）。

## 11. TTS-C.1A.R4 加固（独立 Review FAIL 关闭项；pending independent Review PASS；not frozen；未部署）

- **P0-A non-forgeable held capability**：`HeldMaterializedFileEvidence` 删除公开 `static create`；
  构造器由 module-private issue token（`HELD_ISSUE_TOKEN`，runtime secret，不导出）门控；
  合法实例由 `openHeldMaterializedFileEvidence` 经模块内唯一发行点登记入 module-private
  `WeakSet`；`assertHeldCapability`（runtime 检查，非 TypeScript 类型）为
  `assertHeldEvidenceCurrentSync` 与 `workerFinalizeMaterialization` 的第一道 fence——
  plain object / `Object.create(prototype)` / clone + arbitrary fd 一律 `SEAL_MISMATCH`。
- **P0-B exact destination binding**：commit seal 的目标路径一律从 frozen identity
  （`voiceProfileId/voiceProfileRevisionId`）重新派生 `expectedRelative/expectedAbsolute/
  expectedParent`；path stat 只使用派生值，绝不信任 `evidence.absolutePathInternal/
  parentRealpath`；evidence 路径字段必须逐项等于派生值（canonical source fd/path +
  bytes exact + relativePath 伪装 destination 的攻击 → `SEAL_MISMATCH`、projection=0）。
- **P0-C full ancestor seal**：acquisition 记录 root/profile/revision(parent)/file 四级
  dev/ino；commit-time 逐级 `lstat`（非 symlink、类型、dev/ino 与 acquisition 相同）+
  root realpath 锚定 `path.resolve(materializationRootAbs())` + revision parent realpath
  精确等于 acquisition 值且位于 root 下。profile/root ancestor rename+symlink 替换
  （final/immediate parent inode 不变）必拒绝。实现为 path+lstat 逐级复核（非 dirfd/openat
  anchored traversal），依赖本地 single-writer contract；ancestor mutation 由测试覆盖。
- **P0-D verify 零写**：root helper 拆分——`requireExistingMaterializationRootSafe`
  （缺失 → MISSING，绝不 mkdir；GET/replay/validation/reuse/recovery verify/integrityStatusOf/
  validateMaterializedFileSnapshot 专用）与 `ensureOrCreateMaterializationRootSafe`
  （仅 Worker durable copy / recovery durabilize writer）。删除整个 `voice-materializations/`
  后 GET/replay/validation 返回 missing/unusable 且 filesystem snapshot 完全不变。
- **Zero-subscriber closure（§七）**：worker final transaction 在任何 projection INSERT/repair
  前事务内重统计 active subscriber（`waiting/running`），为 0 → job cancelled、projection=0、
  `requestsUpdated=0`（不只依赖 `cancel_requested`）；validation usable 分支 Phase 3 前
  subscriber=0 → job cancelled、不 succeeded、不 fan-out reused；recovery 既有 durabilize 前
  检查 + success transaction 再检查不回退。
- **Recovery cleanup（§八）**：删除 `classifyProjectVoiceAssignment(projectId, artifactId as never)`
  调用；唯一合法路径 = `getProjectVoiceAssignment` → artifact row → `classifyProjectVoiceAssignment`。
- **GET request-scope memoization（§九）**：单次 GET 内按
  `materialization_id + source_canonical_sha256 + projection.updated_at + assignment_artifact_id`
  memoize integrity validation（assignment 分类参与判定故入 key）；不跨请求缓存；每次 HTTP
  请求仍对每个 distinct key fail-closed 检查。
- **测试**：新增 `test-tts-c1a-r4-hardening.ts`（55 PASS：CAP-01…05 / SEAL-08…11 /
  DIR-04…07 / VERIFY-01…04 / CANCEL-06…08）；mutation proof 7 项（MUT-R4-01…07）全部
  使目标测试 FAIL——其中 DIR-04/05 的 profile/root swap invariant 由「ancestor seal +
  parent realpath 等值」多层互补 fence 共同覆盖，mutation 按整组 invariant 变异验证。

## 12. TTS-C.1A.R5 加固（独立 Review FAIL 关闭项；pending independent Review PASS；not frozen；未部署）

- **P0-A Immutable Authority Record**：`HeldMaterializedFileEvidence` 删除 `static create`；构造器由 module-private `HELD_ISSUE_TOKEN: unique symbol`（不导出）门控；module-private `WeakMap<HeldMaterializedFileEvidence, HeldAuthorityRecord>` 存储权威 `mode/diagnosticSnapshot/fileHandle/parentHandle/closed`——**所有授权决策必须从 record 读取**，绝不依赖公开 `evidence.durabilityEstablished`/`fileFd`/`parentFd`。`assertHeldCapability` + `assertHeldCurrentSync({requireDurability})` 强制：verify capability 即使公开字段被改为 `durabilityEstablished=true` 仍必须被 Worker reject（CAP-06 实证）；close 后 capability 不可用（CAP-09 实证）；tamper 公开 evidence/handle/getter 均不影响 record（CAP-07/08 实证）；合法 durabilize capability 成功（CAP-10 实证）。
- **P0-B Branded Reuse Capability**：`ValidatedReusableProjectionCapability` 仅由 validator 经 `__validatorInternal.issueReuseCapabilityFromHeld` 发行；module-private `WeakMap<...ReuseAuthorityRecord>` 绑定 projection identity + candidate metadata hash + 四级 ancestor + 真实 fd + 真实 SHA/WAV；`finalizeValidatingJob` 仅接受 branded capability；plain `ProjectionValidationResult`/`ValidatedProjectionEvidence` 无法注册；clone / `Object.create(prototype)` / plain 对象全部 SEAL_MISMATCH（REUSE-CAP-01/04 实证）；合法 validator 发行 capability 走通 reused（REUSE-CAP-05 实证）。
- **P0-C Unified Ancestor Seal**：`assertHeldCurrentSync(cap, {requireDurability, expectedVoiceProfileId, expectedVoiceProfileRevisionId, expectedSha256})` 同一函数同时被 Worker（`requireDurability=true`）与 reuse finalize（`requireDurability=false`）调用，路径从 frozen identity 重新派生，逐级 lstat root/profile/revision(final parent)/final + realpath 锚定；commit-time `realpathSync` 用 try/catch 包装，悬挂 symlink → SEAL_MISMATCH；覆盖既有 hook 窗口（REUSE-DIR-01..04 实证）。
- **P0-D SHA Authenticity Closure**：真实 SHA 来自 issuer 对 held fd 的读取并写入 record；caller 无法注入；finalizeValidatingJob 内部 record→projection row SHA 比对（REUSE-CAP-03 damaged file + 同 requestId replay → MATERIALIZATION_UNUSABLE）。
- **§七 Terminal Response Link Closure**：`createMaterializationRequest` Phase 3 后重读最终 request；projection 仅当 `request.materialization_id !== null` 时按 `getMaterializationById(id)` 取；cancelled/failed/waiting + materialization_id 空 → projection=null（RESP-01 实证）；succeeded/reused → projection.id === request.materialization_id（RESP-03/04 实证）；不再依赖 `validation.kind === 'usable'`。
- **§八 POST Integrity Closure**：Phase 3 后若 `outcome === 'reused' && request.status === 'reused' && request.materialization_id` 则强制调用 `integrityStatusOf(request)`；非 `verified` → throw `MaterializationError(MATERIALIZATION_UNUSABLE)`；reused response `materialization.status='file_ready_unpublished'`（POST-INT-01 实证）；damaged/deleted linked projection → fail-closed（POST-INT-02 实证）。
- **§九 Production Hook Guard**：`setAfterProjectionValidationBeforeFinalize` 与 `setAfterRecoveryEvidenceBeforeCommit` 在 `NODE_ENV='production'` 下抛 Error；test 环境仍可用（HOOK-01/02/03 实证）。
- **测试**：新增 `test-tts-c1a-r5-hardening.ts`（28 PASS）+ `test-tts-c1a-r5-mutations.ts`（reproducible runner，输出 `/tmp/r5-mutation-output.txt`）；既有 12 个 TTS-C.1A 套件全部 PASS（R3 SEAL-08/10/11 删除——R5 下公开字段不可信，语义由 CAP-07 覆盖）。
- **mutation proof**（reproducible）：9 项 mutation 修改真实生效点；目标测试 FAIL 符合预期（MUT-R5-01..07 实证于 R4 阶段原型；MUT-R5-08/09 在 R5 runner 跑通后归档）。
