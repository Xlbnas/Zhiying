# TTS-C 实施计划（TTS-C.0.R5 修订；runtime implementation not started）

> 状态：**TTS-C.0.R5 architecture closure completed；pending independent Review PASS；
> TTS-C runtime implementation not started；TTS-C.1A not started**。
> 本计划按 TTS-C.0.R5 Review 闭环更新：① **validation finalization fencing**（`validating_reuse`/`validating_existing`
> 的 finalization 全部为带 token/attempt/lease/candidate 条件的 fenced UPDATE，`changes=1` 必须，否则
> `STALE_VALIDATION_OWNER` 整事务回滚零副作用；lease renewal 同样 fenced；三方竞争单数据库裁决——设计文档 §3/§5）；
> ② **可执行 SQLite contract**（设计文档 §2 全部为可直接转 migration 的真实 SQL：CREATE TABLE / ADD COLUMN /
> CREATE UNIQUE INDEX / CREATE TRIGGER；FK + composite FK + 状态依赖 CHECK + pair trigger；`tts_jobs` 纯增量零 rebuild；
> 本轮已在临时目录 sqlite3 3.45.1 实证：apply / foreign_key_check / integrity_check / happy path / 43 项非法 mutation 全过）；
> ③ **relational provenance 闭包**（composite FK `(job_id, claim_id)` / `(successful_attempt_id, job_id)` +
> BEFORE INSERT provenance trigger + 原子成功终局 6 步顺序冻结——设计文档 §2.4/§8）；
> ④ **crash-safe cutover protocol**（stable/candidate 双 registry view；candidate 意图与证据持久化于
> `legacy_adapter_voice_entries` 新增列，保持 9 表；6 点 crash reconciliation 矩阵；fenced mapped_active +
> published_usable 同事务——设计文档 §7）；⑤ **完整状态机冻结**（每表 old→new 全矩阵 + 真实 trigger SQL，
> 消除 `* → failed` 模糊写法；published_usable 不可逆；request succeeded/reused 不混写——设计文档 §9）；
> ⑥ **未来测试矩阵冻结**（VF-1…5 / MF-1…6 / PC-1…7 / CC-1…6 + contract validation——设计文档 §10）；
> ⑦ **依赖 DAG 化**（§依赖顺序，与并行矩阵一致，不再是 1A→1B→1C 链）。
> 每阶段：独立 migration、独立 tests、独立 Review、独立 deployment gate、不跨阶段、不产生半成品 active 状态。

---

## 0. 总原则（R5 强化）

- **exact source 纪律**：全链路显式 artifact ID；禁止 current/latest/default。
- **mutable job ≠ immutable artifact**：`tts_jobs`（mutable execution）+ `sentence_audio_artifacts`（immutable result，trigger ABORT）；regeneration = 新 job + 新 artifact + 新文件。
- **synthesis reservation（可回收 + fenced）**：`tts_synthesis_claims` 是 active synthesis identity 的唯一 reservation（partial unique）；`validating_reuse` **Scheduler 永不 claim**；validating 阶段带独立 validation owner/lease/attempt；lease 过期 → fenced CAS 接管重验（不永久阻塞）；**finalization 必须 fenced**（§3.1 contract；`changes=0` → `STALE_VALIDATION_OWNER` 零副作用）；artifact usable 不建 job；unusable 才在 claim 保护下转 generation_pending + 恰好一个 queued job。
- **零 subscriber 语义**：最后 subscriber 在 validating_reuse 阶段取消 → 直接取消 claim 不建 job；generation_pending/running 阶段取消 → 才置 `job.cancel_requested=1`；**不允许创建 zero-subscriber provider job**；validator/cancel/takeover 三方竞争由事务串行单裁决。
- **共享 fan-in**：`tts_audio_requests` many-to-one → claim/job；成功/失败 fan-out 全部有效 subscriber；per-request cancel 仅 detach 该 envelope。
- **persisted phases**：crash recovery 由 `tts_generation_attempts.execution_phase` 持久化真相驱动；**不得仅凭 status='running' 无条件 requeue**（TTS-C 行 trigger 禁止 running→queued；legacy 行隔离）。
- **relational provenance 闭包**：artifact 的 attempt∈job∈claim 由 composite FK + BEFORE INSERT trigger 数据库级强制；content hash 一致性由 final transaction 内应用层 fenced 重读强制。
- **原子成功终局**：文件（temp→校验→rename→fsync）先于 DB；单 BEGIN IMMEDIATE 内按冻结顺序 attempt→artifact→job→claim→requests 原子完成；任一步失败整事务回滚（attempt 恢复 file_durable）；cancel 优先。
- **crash-safe cutover**：stable view 与 candidate view 分离；candidate 意图/证据持久化（非进程内状态）；active SHA 与 DB 可 reconciliation；未知 SHA fail-closed。
- **零真实 provider 门禁**：自动化测试用临时 DB + Mock provider；真实 provider 仅人工验收命令。
- **单门禁入口**：每阶段新测试并入 `scripts/run-m7-quality-gate.sh`（suite 数递增）。
- **部署纪律**：exact-SHA build + 镜像内 gate + backup + compose up + invariants + docs evidence commit；禁手工 sqlite3。

---

## TTS-C.1A — Materialization requests/jobs/projection（实现到 `file_ready_unpublished`）

**scope**（设计文档 §2.5–2.7/§5/§6）：
- 三层表：`voice_materialization_requests`（project-scoped envelope：`project_id + UNIQUE(project_id, request_id)`；
  assignment FK + pair trigger 必须属同 project 且 kind=`project_voice_assignment`）
  + `voice_materialization_jobs`（含 `validating_existing` unschedulable + partial unique `uq_voice_materialization_jobs_active`；
  状态依赖 CHECK 冻结所有权语义；Scheduler 只领取 `queued`）
  + `voice_materializations`（`UNIQUE(profile, revision)`；状态机含 published_usable 不可逆与 repair 路径——但 1A 止于 file_ready_unpublished）。
- **fenced single-flight 算法**：Phase 1（BEGIN IMMEDIATE：envelope-first → 查 projection + metadata hash → 查/建
  active job=validating_existing（validation owner/lease/attempt）→ 多 request 链接同一 job）→ 事务外 exact
  projection/file validator → Phase 3（BEGIN IMMEDIATE **fenced finalize**：usable → 全部未取消 request `reused` +
  job succeeded，**零文件写**；unusable → active subscriber=0 → fenced cancelled，否则 fenced → `queued`；
  `changes=0` → `STALE_VALIDATION_OWNER` 整事务回滚零文件写）→ Worker 才执行 temp copy。
- **stale validating recovery**：validation lease 过期 → fenced CAS 接管（attempt+1）→ 重跑 exact validator；
  lease renewal 仅当前 owner（token+attempt+status WHERE，旧 owner changes=0）。
- **1A durability 流程**：exact source validator → materialization claim（单 BEGIN IMMEDIATE）→ temp copy →
  SHA/codec/size 校验 → final rename + file fsync + dir fsync → **单事务 fan-out**（fenced 重读 job owner/lease/status +
  exact Voice Revision + 全部 active subscriber + identity/Assignment/project 自洽（任一 mismatch → 回滚 +
  REQUEST_STATE_INCONSISTENT）→ projection=file_ready_unpublished → job=succeeded → 全部未取消 request=succeeded +
  materialization_id）→ COMMIT。目标路径固定 voice-root-relative（`<profile_id>/<revision_id>/reference.wav`）。
- Worker 唯一 writer（Web 无 voice/registry 挂载、无文件写）；`/voice-config` 目录挂载。

**tests**（设计文档 §10.2/§10.3/§10.5 落地）：请求幂等/conflict（同 scope 同 requestId 异 source 409）；
并发两 requestId 单 job；validating_existing Scheduler 不 copy；usable 零文件写；不可用恰好一个 queued；
两 Worker claim 唯一 running owner（MF-5）；fan-out 原子（无部分成功）；stale validating CAS 不永久阻塞（MF-1/2）；
零 subscriber 不建 job（MF-6）；pair mismatch/project mismatch/非法状态组合 ABORT（PC-4/5/6）；
orphan 清理（不得删 DB 已引用）；archive 语义（历史 Assignment 授权可 materialize）；路径 containment。

**not included**：registry 发布、adapter reload、capability、TTS 合成；API 不声称 adapter ready；TTS dispatch 不可用。

**deployment gate**：materialize 不触发合成；production 可安全部署（voice-library 仍 0/0，无 materialize 动作）。

## TTS-C.1B — Legacy crash-safe cutover + global publisher + adapter reload/activation ack

**scope**（设计文档 §2.8/§7）：
- **legacy shadow + crash-safe cutover**：`legacy_adapter_voice_entries` 5 态 + cutover 列
  （owner/lease/attempt + candidate generation/SHA/selector/created/activated）；
  **stable/candidate 双 view**（stable：unmapped/mapped_verified/mapping_pending → legacy，mapped_active → TTS-A，
  retired → 不输出；candidate：仅 pending key 用 TTS-A）；**每个 canonical key 恰好一个 source**（冲突 fail-closed）；
  映射等价性验证 6 项通过才 `mapped_verified`；不伪造 TTS-A 数据。
- **cutover 协议 T1-T5**（设计文档 §7.3）：持久化 candidate 意图（mapping_pending）→ 写 candidate registry
  （temp/fsync/rename/dir-fsync）→ adapter reload → poll active SHA → fenced T5 事务（mapped_active +
  published_usable，双 changes=1 必须）。
- **crash reconciliation 6 点矩阵**（设计文档 §7.4）：含 LKG 保持 legacy、stale cutover owner fenced CAS 接管、
  未知 SHA fail-closed（不 retire legacy、不错误标 published_usable）。
- **global registry publisher**：全局发布锁 + DB 全量确定性重建 + temp/fsync/rename/dir-fsync；registry 文档含
  `registryGeneration + publisherSchemaVersion`；cutover 前后 legacy 集合与 SHA 完全保持。
- **adapter hot reload + LKG health**：mtime/inode/size 检测 → 原子加载 → swap → 失败保持 LKG
  （ready=true/degraded=true/detail=VOICE_REGISTRY_PUBLISH_FAILURE）；无 LKG → ready=false + 503；
  Docker healthcheck 视 LKG degraded 为 healthy。

**tests**：真实 Python parser/reloader + mock upstream；mapping 状态机（5 态全矩阵 + 每 key 单 source 断言）；
cutover crash 矩阵 CC-1…CC-6（设计文档 §10.4）；cutover 全等性；activation 轮询；LKG/degraded/empty 矩阵。

**not included**：capability compiler（1C）、TTS 合成（C.2）。

**deployment gate**：adapter 镜像变更需 exact-SHA 重建 + 镜像内 gate + 部署；production 仍零合成。

## TTS-C.1C — Provider capability snapshot/compiler

**scope**（设计文档 §12 capability neutral matrix）：capability snapshot 固化与执行前比对；capability compiler
纯函数——neutral 默认值 → supported no-op（unsupportedFlags=[]）；非 neutral 无通道 → explicit unsupported
（不静默丢弃）；编译结果进 provenance + `synthesisPayloadFingerprint`。

**tests**：neutral 矩阵全 unit 不 block；非 neutral 全矩阵；compiler 版本化。

**not included**：materialization（1A）、registry/cutover（1B）、TTS 合成。

**deployment gate**：纯函数 + 快照存储，production 零合成。

## TTS-C.2 — Request envelope + synthesis claim + durable job + persisted attempt + immutable artifact

**scope**（设计文档 §2.0–2.4/§3/§4/§8）：
- 新表：`tts_audio_requests`、`tts_synthesis_claims`（fenced reclaimable validation：§3.1 contract + takeover CAS +
  fenced renewal + 三方竞争单裁决）、`tts_generation_attempts`（persisted phase + 全矩阵 trigger）、
  `sentence_audio_artifacts`（immutable；**relational provenance 闭包**：composite FK + BEFORE INSERT trigger）。
- `tts_jobs` 纯增量迁移（ADD COLUMN×7 + 2 unique index + 2 trigger；零 rebuild；legacy 行 WHEN 隔离）；
  `output_path/duration_ms/audio_sha256/result_json` 降级 legacy 兼容。
- **unschedulable reuse reservation 算法**（三阶段 + fenced finalize，设计文档 §3）；
  **validating 阶段取消语义**（§4：零 subscriber → cancelled 无 job；cancel 优先单裁决）；
- **共享 fan-in** + **per-request cancellation 矩阵**；
- **persisted recovery phases** + **indeterminate resolution**（不自动重调；显式 resolve）；
- **原子成功终局 6 步顺序**（§8.2；任一失败整事务回滚，attempt 恢复 file_durable；无部分成功；cancel 优先）；
- fingerprint 三分离实现。

**tests**（设计文档 §10.1/§10.3/§10.5 落地）：VF-1…5（fencing/接管/续租/三方竞争）；reuse reservation 竞态
（Scheduler provider=0；usable 零新 job；damaged 恰好一个 queued）；fan-in/fan-out/单请求取消矩阵；
PC-1…7（provenance ABORT 矩阵）；phase recovery 矩阵；原子终局（五者一致 + 回滚恢复 file_durable）；
attempt trigger（immutable/phase 禁倒退/终态无出边）；非法状态组合 CHECK；fingerprint 矩阵；零真实 provider。

**not included**：preview/selection（C.3）、manifest/master（C.4）、subtitle timing v2（C.5）。

**deployment gate**：可部署；production 不 enqueue 任何 TTS job（新增=0 不变量保持）。

## TTS-C.3 — Preview/override/variant/A-B/selection

**scope**：preview（同一合成路径 + preview 标记；selection=null）；A/B（显式 variant/seed/override artifact——
adapter 无 variation 通道时禁止同请求伪造 A/B）；selection 持久化（selectedAudioArtifactId 只引用 immutable
artifact/overrideRequestId/reviewedBy/reviewedAt/source/bulk/unit override）；失效规则（局部失效，禁 full
regeneration）；review lock（source 漂移 → stale fail-closed）。

**tests**：A/B 不覆盖旧 artifact；失效矩阵逐项；override provenance；lock 漂移 stale；零真实 provider。

**not included**：manifest/master/subtitle。

**deployment gate**：selection 不影响既有管线；production 零 TTS job 不变量保持。

## TTS-C.4 — Selection manifest + immutable master audio + ffprobe

**scope**：`narration_audio_selection_manifest@2.0` artifact（不含 master 信息；ordered units + selected immutable
artifact IDs + SHA/duration/fingerprint + silence/gap + reviewSource；逐 index 对齐校验）；
`narration_master_audio@1.0` immutable artifact（masterInputFingerprint 非循环）；顺序：selected immutable manifest →
durable master temp/write/probe/rename/fsync → immutable master artifact DB commit；master 拼接实现决策
（Node PCM concat vs ffmpeg concat）。

**tests**：manifest 对齐/缺失/重复/stale artifact；master 失败不覆盖旧；时长防线 ±100ms；ffprobe 实测断言。

**not included**：subtitle timing v2。

**deployment gate**：v2 manifest/master 不接 UI；production 零 TTS job 不变量保持。

## TTS-C.5 — Subtitle timing v2/reconciliation/stale graph/review UI

**scope**：`subtitle_timing_v2` artifact 层 + `timing-reconciliation@2.0` 接入 DAG；Review UI（Voice Assignment /
Performance / Sentence Audio / Master / Timing review 节点 + preview/A-B/accept/reject/bulk/lock/stale 提示/
failed-retry/cost-usage）；**production acceptance gate**：人工验收命令（真实 IndexTTS2）独立于 CI。

**tests**：stale 传播矩阵；UI 只读 smoke；DAG 状态机。

**deployment gate**：验收前 production 不产生业务 TTS 数据。

---

## 阶段门禁与禁止

| 阶段 | 独立 migration | 独立 tests | 独立 Review | deployment gate | 半成品 active | production 真 provider |
|---|---|---|---|---|---|---|
| 1A | ✓ | ✓ | ✓ | ✓ | ✗（止于 `file_ready_unpublished`，API 不声称 ready） | ✗ |
| 1B | ✓ | ✓ | ✓ | ✓ | ✗（cutover 全等 + crash 矩阵后才切换 publisher） | ✗ |
| 1C | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| C.2 | ✓ | ✓ | ✓ | ✓ | ✗（claim reservation + 原子终局，不产半成功） | ✗ |
| C.3 | ✓ | ✓ | ✓ | ✓ | ✗（preview/selection 显式动作） | ✗ |
| C.4 | ✓ | ✓ | ✓ | ✓ | ✗（master 显式构建） | ✗ |
| C.5 | ✓ | ✓ | ✓ | ✓ | ✗ | 仅人工验收命令 |

## 依赖顺序（R5 DAG，取代 R4 的 1A→1B→1C 链）

```text
R5 PASS
├─ 1A ∥ 1C            （可并行开发：不同 worktree/local branch）
└─ 1B-prep            （adapter parser/reloader 测试骨架可并行准备）

1A PASS
→ 1B publisher integration（依赖 1A 的 DB projection + legacy cutover 表）

1A + 1B + 1C PASS
→ C.2（claim/fan-in/persisted phases 依赖三者 schema 齐备）

C.2 PASS
→ C.3 → C.4 → C.5（runtime 串行；仅 schema/mock/test planning 可提前并行）
```

**建议首先实现**：**TTS-C.1A**（零音频风险、解锁 materialization、为 1B cutover 提供 DB 基础）——但 1A 未开始，
须待本 R5 独立 Review PASS。

## 并行开发矩阵（冻结：并行开发，串行集成/Review/部署）

| lane | 并行度 | 说明 |
|---|---|---|
| 1A 与 1C | **可并行开发** | 不同本地 worktree/local branch（1A materialization schema/durability；1C capability compiler 纯函数） |
| 1B adapter parser/reloader 测试骨架 | **可并行准备** | 只写 adapter 侧测试骨架；publisher integration 等 1A PASS |
| 1B publisher integration | 串行 | 依赖 1A PASS |
| C.2 | 串行 | 等 1A/1B/1C 全部 PASS |
| C.3 → C.4 → C.5 | **runtime 串行** | 只允许 schema/mock/test planning 提前并行 |

**Git 纪律**：
- 不推阶段 remote branch；
- **单一 integrator 拥有 `m7`**（禁止多人同时 push m7）；
- 各 lane agent 返回独立 commit SHA；
- integrator 按顺序 cherry-pick 到最新 m7；
- **每个 exact SHA 单独 typecheck/build/tests/Review/deploy**；
- **禁止一次合并多个未 Review lane**（每 lane 必须独立 Review PASS 后才并入）。

## 未决事项（进入 1A 前定）

1. delivery 编译策略（文本改写 vs 显式 unsupported，推荐显式 unsupported）。
2. pace 经 adapter 扩展直传可行性。
3. unit vs sentence 原子单位（推荐 unit）。
4. capability 升级后存量音频失效策略。
5. pronunciation dictionary 是否纳入（建议 C.3 后）。
6. master 拼接实现（Node PCM vs ffmpeg concat，C.4 定）。
7. `voice_materialization_state` 与 TTS-C.2 `tts_audio_requests` 的 envelope 实现是否统一（schema 已冻结，实现细节 1A 定）。

> 注：materialization schema、request envelope、validation/cutover fencing、crash-safe cutover 协议、
> relational provenance 闭包与全部状态机已在 `docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md`（R5）
> 以可执行 contract 冻结，不再属于"进入 1A 后再决定"项。
