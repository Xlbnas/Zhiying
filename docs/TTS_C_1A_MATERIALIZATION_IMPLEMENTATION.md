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
