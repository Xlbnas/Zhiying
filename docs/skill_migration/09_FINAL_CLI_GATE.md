# Phase 2D — Final CLI Gate

审查日期：2026-08-22（Asia/Shanghai）  
性质：只读最终门禁；除本报告外未修改代码、测试、schema 或运行环境。

## Verdict

**NEEDS_FIX**

P0 已关闭，五个命令、四条 authoritative source fence、现有 Worker/asset 边界和向后兼容均通过。但 `scripts/test-cli-v1.ts` 没有实际断言 Render `--wait` 的 cancelled、timeout、成功 job 缺少结果以及结果 media/manifest 不匹配会 non-zero。`test-m6311-artifact.ts` 的相关断言覆盖 `resolveJobArtifact`，而当前 CLI wait 路径使用自身的 job/manifest/media 读取，不能替代 CLI 路径的断言。因此 `TEST_CLOSURE: FAIL`，尚不允许创建 Skill。

## P0 Closure

`TTS_WAIT_EXACT_IDENTITY: PASS`

`TOCTOU_P0_CLOSED: YES`

- requested plan 在 enqueue、每轮 polling、finalize 前及返回前固定校验。
- `tryFinalizeNarrationAudio` 的 optional `expectedPlan` 在最终 `BEGIN IMMEDIATE` 内再次校验；source 前进后 fail closed。
- isolated test 实际断言 A 等待期间 current 前进到 B、旧 waiter non-zero，且没有生成任何 audio manifest；ready 返回也断言 audio source plan 等于 requested plan。

## CLI

`INSPECT: PASS`

`TTS: PASS`

`SUBTITLES: PASS`

`RECONCILE: PASS`

`RENDER: PASS`

五个命令均保持 DB-backed exact identity；TTS/Render 只入现有 job/Worker 路径，Subtitles/Reconcile 只调用现有 deterministic builder。未发现 latest-job fallback、direct TTS provider 或 direct render execution。

## Source Fences

`TTS_SOURCE_FENCE: PASS`

`SUBTITLE_SOURCE_FENCE: PASS`

`RECONCILE_SOURCE_FENCE: PASS`

`RENDER_SOURCE_FENCE: PASS`

`TOCTOU_REMAINING: NO`

四条 fence 均在各自 authoritative immediate transaction 内重读并核对 optional expected identity，且在对应 artifact/job/attempt 副作用前失败。

## Architecture

`CLI_THIN: PASS`

`NEW_WORKFLOW_ABSTRACTIONS: NONE`

`DB_SCHEMA_CHANGES: NONE`

`WORKER_REUSED: YES`

`ASSET_GATE_PRESERVED: YES`

`DIRECT_TTS_PROVIDER_BYPASS: NO`

`DIRECT_RENDER_MEDIA_BYPASS: NO`

`OLD_RUN_STAGE_CALLS: 0`

`DEEPSEEK_LLM_EXECUTOR_CALLS: 0`

未新增 workflow manager、pipeline runner、state machine、registry、scheduler、queue、worker 或 CLI state store。Next.js 15.5.21 锁版是 Phase 2A 前已有 dirty state，不计为 CLI 架构变更。

## Test Evidence

`TEST_CLOSURE: FAIL`

`HISTORICAL_FIXTURE_BLOCKER_ACCEPTABLE: YES`

本轮新鲜结果：

- CLI isolated：31 PASS
- artifact/exact-job：32 PASS / 0 FAIL
- resource leases：87 PASS / 0 FAIL
- asset source gate：11 PASS / 0 FAIL
- M3-B：99 PASS / 0 FAIL
- M3-C：82 PASS / 0 FAIL
- `pnpm build`：PASS（Next.js 15.5.21）
- `pnpm typecheck`：PASS（在 build 后独立运行）
- M3-D / M3-E：仍在既有 `audio finalize 失败` fixture 点中止；允许保持 PRE_EXISTING blocker。

已存在实际断言：TTS plan drift fail closed；Reconcile exact/mismatch/零 artifact 副作用；Render exact enqueue/job/attempt、source mismatch 零副作用、asset gate、exact successful job/manifest、inspect no-fallback；artifact resolver 的 failed/missing/mismatch/no-fallback。

缺口：当前 isolated CLI 测试没有实际调用并断言 Render `--wait` cancelled、timeout、missing result、manifest/path/size/SHA mismatch 的 non-zero 结果。最小修复只需在现有 isolated test 补这些路径，不需要修改架构或历史 M3-D/M3-E fixture。

## Compatibility

`BACKWARD_COMPATIBILITY: PASS`

四个生产入口新增的 expected identity 均为 optional；旧 UI/API caller 不传时保持原 schema、DB semantics、provider/voice、Worker 和 render 行为。现有旧 caller 仍按原签名通过 typecheck，M3-B/M3-C 回归通过。

## Findings

`P0: 0`

`P1: 0`

`P2: 1`

1. `scripts/test-cli-v1.ts` 缺少 Render wait cancelled/timeout/missing/mismatched-result 的 CLI 级失败断言。代码检查显示对应 fail-closed 分支存在，但 Phase 2D 明确要求实际 assertion；在这些最小测试补齐前，不能把 test closure 判为 PASS。

`READY_FOR_SKILL: NO`
