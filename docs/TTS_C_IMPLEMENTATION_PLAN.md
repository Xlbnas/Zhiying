# TTS-C 实施计划（TTS-C.0.R1 修订；runtime implementation not started）

> 状态：**TTS-C.0.R1 architecture closure completed；pending independent Review PASS；
> TTS-C runtime implementation not started；TTS-C.1 not started**。
> 本计划按 TTS-C.0.R1 Review 结论调整 milestone（materialization 拆 1A/1B/1C；
> 四表分离与 fingerprint 三分离进入 C.2；manifest/master 分离进入 C.4）。
> 每阶段：独立 migration、独立 tests、独立 Review、独立 deployment gate、不跨阶段、不产生半成品 active 状态。

---

## 0. 总原则（R1 强化）

- **exact source 纪律**：全链路显式 artifact ID；禁止 current/latest/default。
- **mutable job ≠ immutable artifact**：`tts_jobs`（mutable execution）+ `sentence_audio_artifacts`（immutable result，trigger ABORT）；regeneration = 新 job + 新 artifact + 新文件。
- **durability 顺序**：文件（temp → 校验 → rename → fsync 目录）先于 DB commit。
- **零真实 provider 门禁**：自动化测试用临时 DB + Mock provider；真实 provider 仅人工验收命令。
- **单门禁入口**：每阶段新测试并入 `scripts/run-m7-quality-gate.sh`（suite 数递增）。
- **部署纪律**：exact-SHA build + 镜像内 gate + backup + compose up + invariants + docs evidence commit；禁手工 sqlite3。

---

## TTS-C.1A — Voice materialization durable requests/files/DB projection

**范围**（设计文档 §5.1/§5.3/§5.5）：
- materialization request envelope（DB rows 是 authoritative；exact Assignment/source 授权校验——**不按 Profile active 状态裁决**；archived Profile 的合法历史 Assignment 引用的 revision 允许 materialize）。
- Worker 唯一 writer（Web 无 voice/registry 挂载、无文件写）；voice root rw + `/voice-config` 目录 rw（目录挂载，非单文件 bind）。
- 文件发布：`<VOICE_ROOT>/<pid>/<rid>/reference.wav` temp 写 + fsync + rename + 目录 fsync。
- `materialization_state` 表（TTS-C.1 定义 schema；rows = registry 的 authoritative source）。
- 测试：幂等/并发 single-flight（全局锁）/orphan 清理（不得删 DB 已引用）/archive 语义（历史 Assignment 可 materialize、archive 禁新 revision/新 Assignment 不变量保持）/路径 containment。
- **不含**：registry 发布、adapter reload、capability。
- **deployment gate**：materialize 不触发合成；production 可安全部署（voice-library 仍 0/0，无 materialize 动作）。

## TTS-C.1B — Global registry publisher + adapter hot reload

**范围**（设计文档 §5.3/§5.4）：
- global registry publisher：全局发布锁 + 从 DB **全量确定性重建**完整 registry（canonical ordering）+ temp write → fsync → rename → **directory fsync**；无并发 read-modify-write patch；crash 后从 DB 重建。
- adapter hot reload（修改 `server.py`）：mtime/inode/size 检测 → 原子加载临时 RegistryState（完整校验）→ 一次性 swap 内存 REGISTRY → 失败保持 **last-known-good** + health.detail 报告；health 与 synthesize 均触发检测；不依赖 Docker restart / 不需要 docker.sock。
- 测试：真实 Python parser/reloader + mock upstream（httpx MockTransport）；并发 synthesize 不消费过期 registry；entry 增删语义；reference 先 durable 再发布。
- **不含**：capability compile（1C）、TTS 合成。
- **deployment gate**：adapter 镜像变更需 exact-SHA 重建 + 镜像内 gate + 部署；production 仍零合成。

## TTS-C.1C — Provider capability snapshot/compiler

**范围**（设计文档 §7）：
- capability snapshot（provider/model/providerVersion/providerCommit + capabilityCompilerVersion）固化（enqueue 前）与校验（执行前比对）。
- capability compiler 纯函数：intent 矩阵编译——**neutral 默认值（delivery=normal/pace=normal/energy=normal/emotion=none/deliveryOverride=null）→ supported no-op（unsupportedFlags=[]）**；非 neutral 无通道 → explicit unsupported（unsupportedFlags 精确 + block/review 语义，不静默丢弃）。
- 编译结果进入 provenance + `synthesisPayloadFingerprint`。
- 测试：neutral 矩阵全 unit 不 block；非 neutral 全矩阵 unsupported/compiled；compiler 版本化。
- **不含**：任何音频合成。
- **deployment gate**：纯函数 + 快照存储，production 零合成。

## TTS-C.2 — Request envelope + durable job + attempt journal + immutable artifact + fingerprints

**范围**（设计文档 §3/§4/§6）：
- 新表：`tts_audio_requests`（`UNIQUE(project_id, request_id)` envelope）、`tts_generation_attempts`（append-only journal：in_flight/response_received/validation_failed/succeeded/transport_failed/indeterminate）、`sentence_audio_artifacts`（immutable，trigger ABORT 禁 UPDATE/DELETE，exact reader）。
- `tts_jobs` ALTER：加 `tts_audio_request_id`、`result_artifact_id`（→ sentence_audio_artifacts.id）、`generation_variant_id`、fingerprint 列；`output_path/duration_ms/audio_sha256/result_json` 降级为 legacy 兼容（TTS-C 路径不写不读为 authoritative）。
- fingerprint 三分离实现：`exactSourceFingerprint` / `synthesisPayloadFingerprint` / `finalTtsInputFingerprint`（length-prefixed + 版本化）；复用唯一依据 = finalTtsInputFingerprint 一致 + artifact usable；跨 source 复用需 immutable `acoustic_equivalence_attestation`（禁仅比 SHA 静默复用）；A/B variant（generationVariantId + seed）进入 identity。
- DB 级 single-flight（envelope INSERT + job claim 同 BEGIN IMMEDIATE）；indeterminate 保守语义（禁自动重调 provider）；usage/attempt 对账。
- 测试：四表分离（job mutable/artifact immutable trigger）；envelope replay/conflict/inconsistent；fingerprint 矩阵；indeterminate；usage 对账；零真实 provider。
- **deployment gate**：可部署；production 不 enqueue 任何 TTS job（新增=0 不变量保持）。

## TTS-C.3 — Preview/override/variant/A-B/selection

**范围**（设计文档 §9 失效规则 + 设计文档 §7.2 的 variant 语义）：
- preview（同一合成路径 + preview 标记；selection=null）；A/B（显式 variant/seed/override artifact——**adapter 无 variation 通道时禁止同请求伪造 A/B**）；selection 持久化（per-unit：selectedAudioArtifactId（**只引用 immutable artifact**）/overrideRequestId/reviewedBy/reviewedAt/source/bulk/unit override）。
- 失效规则实现（§9 表）：文本/voice/performance/pronunciation/capability 变化 → 受影响 unit 局部失效 + 重生成；未变 unit 复用 exact artifact；禁 full regeneration。
- review lock（selected 后可 lock；source 漂移 → stale + 重 review，fail-closed）。
- 测试：A/B 不覆盖旧 artifact；失效矩阵逐项；override provenance；lock 漂移 stale；零真实 provider。
- **不含**：manifest/master/subtitle。
- **deployment gate**：selection 不影响既有管线；production 零 TTS job 不变量保持。

## TTS-C.4 — Selection manifest + immutable master audio + ffprobe

**范围**（设计文档 §8）：
- `narration_audio_selection_manifest@2.0` artifact（**不含 master 信息**；含 ordered units + selected immutable sentence audio artifact IDs + SHA/duration/fingerprint + silence/gap + reviewSource；顺序逐 index 对齐校验）。
- `narration_master_audio@1.0` immutable artifact（引用 selectionManifestArtifactId + ContentHash + concatCompilerVersion；**masterInputFingerprint 非循环**；output 相对路径/SHA/size/codec/sr/channels/ffprobeDurationMs）。
- 顺序：selected immutable manifest → durable master temp/write/probe/rename/fsync → immutable master artifact DB commit。
- master 拼接实现决策（Node PCM concat 现状 vs ffmpeg concat filter——静态 ffmpeg 可用性已验证于构建门禁）。
- 测试：manifest 对齐/缺失/重复/stale artifact；master 失败不覆盖旧；时长防线 ±100ms；ffprobe 实测断言。
- **不含**：subtitle timing v2（下阶段）。
- **deployment gate**：v2 manifest/master 不接 UI；production 零 TTS job 不变量保持。

## TTS-C.5 — Subtitle timing v2/reconciliation/stale graph/review UI

**范围**（设计文档 §9 stale 图 + UI）：
- `subtitle_timing_v2` artifact 层（复用既有 schema+compiler）+ `timing-reconciliation@2.0`（三源 reconcile）接入 DAG；downstream 失效按 §9 规则。
- Review UI：Voice Assignment / Performance / Sentence Audio / Master / Timing review 节点 + preview/A-B/accept/reject/bulk/lock/stale 提示/failed-retry/cost-usage。
- **production acceptance gate**：人工验收命令（真实 IndexTTS2、真实材料、受控 project）独立于 CI；验收前 production 不产生业务 TTS 数据。
- 测试：stale 传播矩阵；UI 只读 smoke；DAG 状态机。

---

## 阶段门禁与禁止

| 阶段 | 独立 migration | 独立 tests | 独立 Review | deployment gate | 半成品 active | production 真 provider |
|---|---|---|---|---|---|---|
| 1A | ✓ | ✓ | ✓ | ✓ | ✗（materialize 是显式用户动作） | ✗ |
| 1B | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| 1C | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| C.2 | ✓ | ✓ | ✓ | ✓ | ✗（payload v2 新格式，不产音频） | ✗ |
| C.3 | ✓ | ✓ | ✓ | ✓ | ✗（preview/selection 显式动作） | ✗ |
| C.4 | ✓ | ✓ | ✓ | ✓ | ✗（master 显式构建） | ✗ |
| C.5 | ✓ | ✓ | ✓ | ✓ | ✗ | 仅人工验收命令 |

## 依赖顺序与建议

- **依赖**：1A → 1B → 1C → C.2 → C.3 → C.4 → C.5（1B 依赖 1A 的 DB projection；1C 独立于 1A/1B 可并行开发但 C.2 需三者齐备）。
- **建议首先实现**：**TTS-C.1A**（零音频风险、解锁 materialization、为 1B/1C 提供 DB 基础）。
- **可并行**：1C（capability compiler 纯函数）与 1A/1B 并行。

## 未决事项（进入 1A 前定）

1. `materialization_state` 表 schema 与 request envelope 形式（1A 定）。
2. delivery 编译策略（文本改写 vs 显式 unsupported，推荐显式 unsupported）。
3. pace 经 adapter 扩展直传可行性。
4. unit vs sentence 原子单位（推荐 unit）。
5. capability 升级后存量音频失效策略。
6. pronunciation dictionary 是否纳入（建议 C.3 后）。
7. master 拼接实现（Node PCM vs ffmpeg concat，C.4 定）。
