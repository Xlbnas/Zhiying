# TTS-C 实施计划（TTS-C.0 产物；runtime implementation not started）

> 状态：**TTS-C.0 architecture audit completed；TTS-C runtime implementation not started**。
> 本计划将 TTS-C 拆分为可独立测试/Review/部署的阶段；每阶段不产生半成品 active 状态、
> migration 可回滚、不跨阶段实现后续功能、明确 production deployment gate 与禁真 provider 测试阶段。

---

## 0. 总原则

- **exact source 纪律**：全链路显式 artifact ID（TTS-A/B 冻结语义延续）；禁止 current/latest/default。
- **不可变产物**：sentence audio / manifest / master 一律 append-only；regeneration = 新 artifact，不 UPDATE 旧产物。
- **durability 顺序**：文件（temp 写 → 校验 → rename → fsync 目录）先于 SQLite commit（TTS-A 模式复用）。
- **零真实 provider 门禁**：所有自动化测试用临时 DB + Mock provider（`MockTtsProvider` / `ScriptableProvider` 模式），零真实 APIYi / 零真实 IndexTTS2 / 零 GPU；真实 provider 只允许人工验收命令（独立于 CI）。
- **单门禁入口**：每阶段新测试并入 `scripts/run-m7-quality-gate.sh`（suite 数随阶段递增，权威清单单一来源）。
- **部署纪律**：每阶段 exact-SHA build + 镜像内 gate + production backup + compose up + invariants + docs-only evidence commit；禁止手工 sqlite3。

---

## TTS-C.1 — Voice materialization + registry 发布 + capability compile

**范围**（对应设计文档 §4/§5）：
- materialization API（requestId 幂等；`UNIQUE(profile, revision, request_id)` envelope 或等价状态表）；temp 写 + fsync + rename 发布到 `<VOICE_ROOT>/<pid>/<rid>/reference.wav`；registry JSON 原子更新；并发 single-flight；crash 幂等重放；orphan best-effort cleanup（不得删 DB 已引用文件）。
- capability snapshot + capability compiler（纯函数）：authorial intent（delivery/deliveryOverride/pace/energy/emotion）→ compiled capability（compiledDelivery/Speed/SynthesisParameters + unsupportedFlags[]）；版本化（capabilityCompilerVersion）；**禁止静默丢弃**（unsupported → 显式标记 + review/block）。
- 迁移：materialization 状态表（append-only）；`tts_jobs` 暂不动（TTS-C.2 加列）。
- 测试：materialization 原子性/幂等/并发/orphan/archive 语义；capability compile 全矩阵（intent×capability→unsupported/compiled）；registry 发布后 adapter 视角验证（用 adapter 校验逻辑的镜像实现，不启动真 adapter）；mock provider 零真实调用。
- **不含**：不合成音频、不改 tts_jobs、不动 subtitle/timing。
- **deployment gate**：materialization 不触发任何真实合成；production 可安全部署（voice-library 仍 0/0，无 materialize 动作）。
- **Review 入口**：TTS-C.1 contract + 测试通过后独立 Review。

## TTS-C.2 — Exact sentence input fingerprint + durable sentence job/artifact

**范围**（对应设计文档 §3/§6）：
- `tts-payload@2.0`（完整 source 引用 + `ttsInputFingerprintV2`）；`tts_jobs` 加列（`tts_input_fingerprint`、`assignment_artifact_id`、`performance_plan_artifact_id`、`capability_compiler_version`、`capability_snapshot_json`）；旧 payload union 保持可读，不改写历史行。
- 幂等键升级：`(project_id, narration_plan_artifact_id, unit_id, tts_input_fingerprint)` 精确复用；fingerprint 不一致 → 新 job。
- 执行路径：enqueue 前 exact 校验链（Narration candidate eligible + Assignment current + exact voice usable + Performance source 一致 + capability compile 成功）；worker 执行前重算 fingerprint 比对（fail-closed `INPUT_FINGERPRINT_MISMATCH`）。
- 迁移：ALTER 加列（可回滚：仅加列不删）；副本演练 + 幂等重跑 + integrity ok。
- 测试：fingerprint 两段式（source identity vs compiled payload 变化矩阵）；payload v2 兼容；幂等复用/冲突；worker fingerprint 比对 fail-closed；无真实 provider。
- **不含**：preview/A-B、manifest、master。
- **deployment gate**：可部署，但 production 不 enqueue 任何 TTS job（新增=0 不变量保持）。

## TTS-C.3 — Preview + override + A/B selection + incremental regeneration

**范围**（对应设计文档 §7）：
- sentence/unit preview（同一合成路径 + preview 标记；selection=null）；A/B（两次合成 → 比较 → 选择新 artifact，旧保留）。
- selection 持久化（per-unit：selected job id / fingerprint / overrideRequestId / reviewedBy / reviewedAt / source）；bulk approve / unit override。
- 失效规则实现：文本/voice/performance/pronunciation/capability 变化 → 受影响 unit 失效 + 局部重生成（复用未变 unit 的 exact artifact）；禁 full regeneration。
- review lock（selected 后可 lock；source 漂移 → stale 提示 + 重 review，fail-closed）。
- 测试：A/B 选择不覆盖旧 artifact；失效范围矩阵（§7.1 表逐项）；override provenance；lock 后漂移 stale；mock 合成零真实。
- **不含**：manifest/master/subtitle。
- **deployment gate**：selection 状态不影响已有管线（v2 管线未接 API/UI）；production 零 TTS job 不变量保持。

## TTS-C.4 — Narration Audio Manifest v2 + master re-concatenation + ffprobe

**范围**（对应设计文档 §8）：
- `narration_audio_manifest_v2` artifact 层（candidate；selected 由 review lock 决定）+ master 构建（temp + ffprobe 校验 + rename + fsync 先于 DB commit；manifest 行 + master 文件原子序列）。
- master 拼接实现决策（§12.6：Node PCM concat 现状 vs ffmpeg concat filter——静态 ffmpeg 可用性已验证于构建门禁）。
- 测试：manifest 顺序对齐/缺失/重复/stale sentence artifact；gap 决策；concat 失败不覆盖旧 master；master 时长防线（±100ms 容差）；ffprobe 实测断言。
- **不含**：subtitle timing v2 构建（下一阶段）。
- **deployment gate**：v2 manifest/master 不接入 UI；production 零 TTS job 不变量保持（若启用生成需人工验收命令）。

## TTS-C.5 — Downstream stale 传播 + review UI + production acceptance

**范围**（对应设计文档 §9/§10 + UI）：
- `subtitle_timing_v2` artifact 层（复用既有 schema+compiler）+ `timing-reconciliation@2.0`（三源 reconcile）接入 DAG；downstream 失效按 §9 规则（文本/声音/时长/仅 metadata 区分）。
- Review UI：Voice Assignment / Performance / Sentence Audio / Master / Timing review 节点 + preview/A-B/accept/reject/bulk/lock/stale 提示/failed-retry/cost-usage。
- **production acceptance gate**：人工验收命令（真实 IndexTTS2、真实材料、受控 project）明确独立于 CI；验收通过前 production 不产生业务 TTS 数据。
- 测试：stale 传播矩阵；UI 只读 smoke（无真实 provider）；DAG 状态机。

---

## 阶段门禁与禁止

| 阶段 | 可独立测试 | 可独立 Review | 半成品 active 状态 | migration 回滚 | production 真 provider |
|---|---|---|---|---|---|
| C.1 | ✓ | ✓ | ✗（materialize 是显式用户动作） | ✓（仅加表） | ✗ |
| C.2 | ✓ | ✓ | ✗（payload v2 只是新格式，不产生音频） | ✓（仅加列） | ✗ |
| C.3 | ✓ | ✓ | ✗（preview/selection 是显式动作） | ✓（仅加表） | ✗ |
| C.4 | ✓ | ✓ | ✗（master 只在显式构建时产生） | ✓ | ✗ |
| C.5 | ✓ | ✓ | ✗ | ✓ | 仅人工验收命令 |

## 依赖顺序与建议

- **依赖**：C.1 → C.2 → C.3 → C.4 → C.5（C.3 依赖 C.2 的 fingerprint/job；C.4 依赖 C.3 的 selection；C.5 依赖 C.4 的 manifest）。
- **建议首先实现**：**TTS-C.1**（理由见设计文档 §13——零音频风险、解锁 materialization、capability compile 先行避免 payload 返工）。
- **可并行**：C.1 的 capability compiler 与 materialization 是两个独立子任务（同一阶段内并行）。

## 未决事项（进入 C.1 前定）

1. delivery 编译策略（文本改写 vs 显式 unsupported）——设计文档 §12.1。
2. pace 经 adapter 扩展直传的可行性（upstream duration control 支持度）。
3. unit vs sentence 原子单位。
4. capability 升级后存量音频失效策略。
5. pronunciation dictionary 是否纳入（建议 C.3 后）。
6. master 拼接实现（Node PCM vs ffmpeg concat）。
