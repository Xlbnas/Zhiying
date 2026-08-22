# Zhiying → Codex Skill Migration
# Phase 2B — Adversarial Thin CLI Review

审查日期：2026-08-22（Asia/Shanghai）  
审查性质：只读对抗审查；本轮未修改 CLI/业务代码，未创建 Skill，未连接或修改生产环境。

## Verdict

**NEEDS_FIX**

四条 authoritative source fence 都在各自现有 `BEGIN IMMEDIATE` 内重读并比对 expected identity，且均在 artifact/job 副作用前 fail closed。CLI 也没有绕过 Worker、deterministic builder 或 asset/visual gate。

但 `tts --wait` 未在 enqueue 后继续绑定请求的 exact plan：每次轮询都以项目当前 plan 调用 `tryFinalizeNarrationAudio(projectId)`，随后接受任意 current audio，没有验证该 audio 仍属于 CLI 输入的 `<planId>@<version>`。当 UI/API 在等待期间推进 script/plan，且新 plan 的 jobs 完成时，旧 CLI 请求可为新 plan finalize manifest，并以 `ok: true` 把新 audio 当成旧 plan 的终态结果返回。这违反 frozen exact-identity/wait contract，必须先修复。

## Architecture Boundary

`CLI_THIN: PASS`

`NEW_WORKFLOW_ABSTRACTIONS: NONE`

`WORKER_REUSED: PASS`

`ASSET_GATE_PRESERVED: PASS`

- `tts` 调用 `enqueueNarrationAudioJobs`，不直接调 provider，不复制 unit loop/manifest compiler/retry state machine。
- `subtitles` 只调用 `buildSubtitleTiming` 与现有 readiness。
- `reconcile` 只调用 `buildTimingReconciliation`，没有重算 frames/residual/cue mapping。
- `render` 调用 `enqueueFinalRender` 并轮询 exact `render_jobs.id`；未直接调 `renderMedia`/Remotion bundle/FFmpeg final pipeline，未接受 CLI `assetMap`。
- Phase 2A 未新增 schema、migration、table、workflow state、CLI state file、queue、scheduler、worker、pipeline runner、command registry 或 plugin abstraction。

## Source Fence Review

`TTS_SOURCE_FENCE: PASS`

- `src/lib/narration/audio.ts:158-186`：`tx.immediate()` 内重读 current plan，比对 expected artifact ID/version，然后才进入 job reuse/insert。

`SUBTITLE_SOURCE_FENCE: PASS`

- `src/lib/subtitles/timing.ts:189-228`：同一 immediate transaction 内读 current audio、比对 expected ID/version，再 reuse/compile/insert。

`RECONCILE_SOURCE_FENCE: PASS`

- `src/lib/reconciliation/timing.ts:343-406`：同一 immediate transaction 内重读 locked scenes/current audio/current subtitle，全部 expected identity 比对后才 reuse/compile/insert。

`RENDER_SOURCE_FENCE: PASS`

- `src/lib/final-render/bridge.ts:481-512`：同一 immediate transaction 内重读四 source，比对 expected identities，然后才进入 visual readiness、props/sourceKey、source artifact、job 和 attempt 副作用。

`TOCTOU_FOUND: YES`

- authoritative enqueue/build source fences 未发现 TOCTOU。
- 发现的 TOCTOU 在 TTS post-enqueue wait/finalize 路径：`src/cli/zhiying.ts:216-225`。它不会让 enqueue transaction 接受 stale plan，但会令旧等待者对新 current plan 产生 finalize 副作用并错误报告成功。

## Runtime Contract

`MACHINE_READABLE_STDOUT: PASS`

- CLI 成功和失败路径均只用一次 `process.stdout.write(JSON.stringify(...))`；诊断写 stderr。
- `pnpm test:cli` 能对 stdout 直接 `JSON.parse`，5 项全部通过。已检查实际 CLI 调用链，未发现底层函数向 stdout 写调试/progress 文本。

`WAIT_EXACT_IDENTITY: FAIL`

- `render --wait` 绑定 enqueue 返回的 exact job ID，没有 fallback。
- `tts --wait` 的 job query 绑定 plan artifact ID，但 overview/finalize/audio resolution 绑定的是项目当前 plan，不是 expected plan；source 前进后无法保证 exact result。

`TERMINAL_FAILURE_EXIT: PASS`

- malformed identity/wrong version 已有实跑 non-zero 证据。
- 代码检查确认 TTS/render failed/cancelled、timeout、missing exact artifact、path/size/SHA/probe mismatch 均抛错并由顶层设置 exit code 1。
- 但 TTS source 前进的错误成功例外由 `WAIT_EXACT_IDENTITY: FAIL` 单独阻断。

`BACKWARD_COMPATIBILITY: PASS`

- 四个现有入口新增的 expected-source 字段都是 optional；旧 caller 不传时走原有 source/readiness/write 路径。
- 未改 artifact schema、DB write 形式、TTS provider/voice 默认值、render props 或 Worker semantics。
- 新鲜回归：M3-B `99 PASS / 0 FAIL`，M3-C `82 PASS / 0 FAIL`，`pnpm typecheck` 和 `pnpm build` 均 exit 0。

## Fixture Analysis

`FIXTURE_BLOCKER_ORIGIN: PRE_EXISTING`

`M3_D_REACHED_RECONCILIATION_ASSERTIONS: NO`

`M3_E_REACHED_FINAL_RENDER_ASSERTIONS: NO`

证据：

- 当前工作树：M3-D 在 `scripts/test-m3d-timing-reconciliation.ts:139` 抛 `audio finalize 失败`；M3-E 在 `scripts/test-m3e-final-render.ts:140` 抛同一错误，两者 exit 1。
- 从 `git archive HEAD` 创建的隔离基线快照（复用当前本地 `node_modules`，不写 production）在完全相同行号/错误点中止，M3-D/M3-E 同为 exit 1。
- Phase 2A 对 `audio.ts` 的改动仅在 enqueue transaction 中增加 optional expected-plan 分支；两个旧 fixture 均不传该参数。

## Test Evidence

### PROVEN

- TypeScript compile correctness：`pnpm typecheck` exit 0。
- Next production build：`pnpm build` exit 0（Next.js 15.5.21）。
- Basic CLI parse/JSON/exact artifact version behavior：`pnpm test:cli` 为 `5 PASS`。
- 旧 M6 TTS 主链回归：M3-B `99 PASS / 0 FAIL`。
- 旧 subtitle builder/readiness 回归：M3-C `82 PASS / 0 FAIL`。
- TTS/subtitle/reconciliation/final-render expected-source 比对位于 authoritative immediate transaction 内：代码检查已证明。
- Final Render 仍在 expected-source 比对后使用现有 asset readiness、physical-file/final visual props gate、existing render job/Worker。
- M3-D/M3-E 的 audio finalize blocker 在 `HEAD` 基线可同样复现，不是 Phase 2A regression。

### NOT_YET_PROVEN

- `tts --wait` 在 plan 等待期间前进时 fail closed（现代码已证明不成立）。
- reconciliation expected sources 全部 exact-match 的真实 builder happy path。
- reconciliation 任一 expected source mismatch 在无 artifact 副作用前 fail closed。
- Final Render 四 source exact-match 能进入现有 enqueue，且任一 mismatch 在 source/job/attempt 副作用前 fail closed。
- CLI render 的 asset readiness blocker 和 exact-job terminal success/failure/cancel/timeout 实跑路径。

## Findings

### P0

1. **`tts --wait` 可以将新 current plan 的 audio 作为旧 expected plan 的成功结果返回。**
   - 精确路径：`src/cli/zhiying.ts:215-225`。enqueue 正确绑定 expected plan，但 wait callback 调用 project-current `getNarrationAudioOverview` / `tryFinalizeNarrationAudio` / `getCurrentNarrationAudioArtifact`，不再比对 `plan.id/version`。
   - 可达前置：CLI 以 `--wait` 等待 plan A；同时现有 UI/API 修改并锁定 script，生成 plan B；Worker 完成 plan B 的 jobs。这不需要恶意内部调用或 DB 篡改。
   - 可复现断言：在 wait callback 第一次轮询后把 current plan 从 A 推进为 B，使 B 的 default@1 jobs succeeded；现实现会 finalize/返回 B audio，顶层仍输出 `ok:true` 和请求的 `plan:A`。
   - 影响：Codex/自动化调用方可将 B audio 当成 A 的 exact result 继续构建 subtitle/reconciliation；还可由 stale waiter 触发 B 的 manifest finalize 副作用。这是“错误结果被当作成功”的真实路径。
   - 最小修复：让 wait/finalize 接受 expected plan identity；在 finalize 的 authoritative transaction 内 fail closed，并且只接受 manifest source 精确匹配 A 的 audio。不需要新 watcher/service/state machine。

### P1

NONE

### P2

1. **Phase 2A 没有对新 expected-source 参数做直接运行断言。** 在 `scripts/test-cli-v1.ts`、M3-B/C/D/E suites 中搜索 `expectedPlan/expectedAudio/expectedScenes/expectedSubtitle/expectedReconciliation/SOURCE_MISMATCH` 无命中。代码检查可证明 transaction 位置，但不能替代 gate 要求的 reconcile/render happy + stale-source 实跑证据。
2. **Phase 2A 报告的 Git Diff Summary 遗漏 dependency 改动。** 实际 diff 还将 `next` 从 `^15.5.0`（旧 lock 解析为 15.5.20）改为精确 `15.5.21`，并更新 lockfile。这符合当前架构 Skill 的精确锁版约束，且本轮 build 通过，但应在实施报告中明示或与 Phase 2A diff 分离。

## Minimal Test Closure

在最小修复后，只需补以下 isolated tests：

1. `tts --wait` 对 plan A enqueue 后，current plan 推进到 B：必须 non-zero，不得 finalize/返回 B audio。
2. Reconciliation：一个全部 expected sources exact-match PASS；一个任意 source mismatch FAIL，且 reconciliation artifact 数不变。
3. Final Render：四 source exact-match 到达现有 enqueue 并产生 exact source/job/attempt；一个 source mismatch 在这三类副作用前 FAIL。
4. Final Render asset readiness 未满足时仍 FAIL，且不产生 source/job/attempt。
5. CLI render wait 仅解析 enqueue 返回的 exact job；failed/cancelled/timeout/missing manifest 均 non-zero。

不需要修复整个历史 M3-D/M3-E fixture，不需要重构 test framework，不调用真实付费 TTS/Remotion 或 production。

## Gate

`READY_FOR_SKILL: NO`

`NEXT_ACTION: MINIMAL_FIX`

先修复 TTS wait/finalize exact-plan 绑定，再完成上述最小测试闭环。本轮不创建 Skill，不进入下一阶段。
