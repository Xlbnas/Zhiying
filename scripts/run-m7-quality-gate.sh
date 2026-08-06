#!/bin/bash
# 知影 M7 quality gate 统一权威入口（TTS-B.R2）
#
# 单一真相源：agentvm、Docker 镜像内、GitHub Actions 都调用本脚本，
# 避免三套门禁清单漂移。清单以 docs/M7_IMPLEMENTATION_STATUS.md §11 权威清单为准。
#
# 行为：
#   1. git diff --check
#   2. pnpm typecheck
#   3. pnpm build
#   4. CI 失败退出码传播自测（TTS-B.R3）
#   5. TTS-B 5 套
#   6. TTS-A frozen 7 套
#   7. frozen / existing 11 套
#   任一失败立即非零退出。
#
# 用法：
#   bash scripts/run-m7-quality-gate.sh
#
# 机器可读汇总：
#   QUALITY_GATE_RESULT=PASS|FAIL
#   QUALITY_GATE_SHA=<sha>
#   QUALITY_GATE_TOTAL_SUITES=<n>
#   FAILED_SUITE=<name>
#   FAILED_COMMAND=<command>
set -euo pipefail

# 音频测试依赖真实 ffmpeg/ffprobe：优先仓库内静态构建，否则用系统 PATH
TOOLS_DIR="$(cd "$(dirname "$0")/.." && pwd)/.tools/static-ffmpeg"
if [ -x "$TOOLS_DIR/ffprobe" ]; then
  export PATH="$TOOLS_DIR:$PATH"
fi

GATE_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
GATE_LOG="${GATE_LOG:-/tmp/m7-quality-gate.log}"
: > "$GATE_LOG"

PASS_COUNT=0
FAILED_SUITE=""
FAILED_COMMAND=""

run_suite() {
  local name="$1"
  shift
  local start
  local end
  start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "=== $name ===" >> "$GATE_LOG"
  echo "command: $*" >> "$GATE_LOG"
  echo "start: $start" >> "$GATE_LOG"
  if "$@" >> "$GATE_LOG" 2>&1; then
    end="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "end: $end" >> "$GATE_LOG"
    echo "exit: 0" >> "$GATE_LOG"
    PASS_COUNT=$((PASS_COUNT + 1))
    printf 'PASS  %-42s exit=0\n' "$name"
  else
    local ec=$?
    end="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "end: $end" >> "$GATE_LOG"
    echo "exit: $ec" >> "$GATE_LOG"
    printf 'FAIL  %-42s exit=%s\n' "$name" "$ec"
    echo "QUALITY_GATE_RESULT=FAIL"
    echo "FAILED_SUITE=$name"
    echo "FAILED_COMMAND=$*"
    echo "QUALITY_GATE_SHA=$GATE_SHA"
    echo "GATE_LOG=$GATE_LOG"
    exit "$ec"
  fi
}

# 1. git diff --check（无 .git 环境——如 Docker 镜像——跳过并记录，不视为失败）
if git rev-parse --git-dir >/dev/null 2>&1; then
  run_suite "git-diff-check" git diff --check
else
  echo "SKIP git-diff-check（非 git 仓库环境）" >> "$GATE_LOG"
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'SKIP  %-42s (no git repo)\n' "git-diff-check"
fi

# 2. typecheck
run_suite "typecheck" pnpm typecheck

# 3. build（剥离 NODE_ENV：next build 在 NODE_ENV=development 下 prerender 异常；
#    CI/agentvm/镜像内共用本入口，build 统一以无 NODE_ENV 运行）
run_suite "next-build" env -u NODE_ENV pnpm build

# 4. CI 失败退出码传播自测（TTS-B.R3：gate 失败必须使 workflow conclusion=failure）
run_suite "m7-exit-propagation" bash scripts/test-m7-quality-gate-exit-propagation.sh

# 5. TTS-B 5 套
run_suite "tts-b-voice-assignment" npx tsx scripts/test-tts-b-voice-assignment.ts
run_suite "tts-b-performance-schema" npx tsx scripts/test-tts-b-performance-schema.ts
run_suite "tts-b-performance-generation" npx tsx scripts/test-tts-b-performance-generation.ts
run_suite "tts-b-dag" npx tsx scripts/test-tts-b-dag.ts
run_suite "tts-b-api" npx tsx scripts/test-tts-b-api.ts

# 6. TTS-A frozen 7 套（docs/M7_IMPLEMENTATION_STATUS.md §11 权威清单）
run_suite "tts-a-voice-library-schema" npx tsx scripts/test-tts-a-voice-library-schema.ts
run_suite "tts-a-voice-library-ingest" npx tsx scripts/test-tts-a-voice-library-ingest.ts
run_suite "tts-a-voice-library-api" npx tsx scripts/test-tts-a-voice-library-api.ts
run_suite "tts-a-voice-library-files" npx tsx scripts/test-tts-a-voice-library-files.ts
run_suite "tts-a-durability" npx tsx scripts/test-tts-a-durability.ts
run_suite "tts-a-multipart" npx tsx scripts/test-tts-a-multipart.ts
run_suite "tts-a-staging-failures" npx tsx scripts/test-tts-a-staging-failures.ts

# 7. frozen / existing 11 套（docs/M7_IMPLEMENTATION_STATUS.md §11 权威清单）
run_suite "m73b-visual-sequences" npx tsx scripts/test-m73b-visual-sequences.ts
run_suite "m73b-shots" npx tsx scripts/test-m73b-shots.ts
run_suite "m73b-generation" npx tsx scripts/test-m73b-generation.ts
run_suite "m73b-dag" npx tsx scripts/test-m73b-dag.ts
run_suite "m73a-visual-intent" npx tsx scripts/test-m73a-visual-intent.ts
run_suite "image-billing-monotonic" npx tsx scripts/test-image-billing-monotonic.ts
run_suite "asset-bind-atomicity" npx tsx scripts/test-asset-bind-atomicity.ts
run_suite "workflow-resource-leases" npx tsx scripts/test-workflow-resource-leases.ts
run_suite "m71-tts" npx tsx scripts/test-m71-tts.ts
run_suite "m3b-tts" npx tsx scripts/test-m3b-tts.ts
run_suite "m3c-subtitle-timing" npx tsx scripts/test-m3c-subtitle-timing.ts

# 8. TTS-C.1A materialization 套件（Durable Voice Materialization Foundation + R1 加固）
run_suite "tts-c1a-migration" npx tsx scripts/test-tts-c1a-migration.ts
run_suite "tts-c1a-schema" npx tsx scripts/test-tts-c1a-materialization-schema.ts
run_suite "tts-c1a-api" npx tsx scripts/test-tts-c1a-materialization-api.ts
run_suite "tts-c1a-worker" npx tsx scripts/test-tts-c1a-materialization-worker.ts
run_suite "tts-c1a-durability" npx tsx scripts/test-tts-c1a-materialization-durability.ts
run_suite "tts-c1a-concurrency" npx tsx scripts/test-tts-c1a-materialization-concurrency.ts
run_suite "tts-c1a-files" npx tsx scripts/test-tts-c1a-materialization-files.ts
# TTS-C.1A.R1 新增 6 套（validation ownership / worker fencing / recovery / path security / request concurrency / compose mounts）
run_suite "tts-c1a-validation-ownership" npx tsx scripts/test-tts-c1a-validation-ownership.ts
run_suite "tts-c1a-worker-fencing" npx tsx scripts/test-tts-c1a-worker-fencing.ts
run_suite "tts-c1a-recovery" npx tsx scripts/test-tts-c1a-recovery.ts
run_suite "tts-c1a-path-security" npx tsx scripts/test-tts-c1a-path-security.ts
run_suite "tts-c1a-request-concurrency" npx tsx scripts/test-tts-c1a-request-concurrency.ts
run_suite "tts-c1a-compose-mounts" npx tsx scripts/test-tts-c1a-compose-mounts.ts
# TTS-C.1A.R2 新增 5 套（periodic recovery / final evidence / validation evidence / replay integrity / resource cleanup）
run_suite "tts-c1a-recovery-loop" npx tsx scripts/test-tts-c1a-recovery-loop.ts
run_suite "tts-c1a-final-evidence" npx tsx scripts/test-tts-c1a-final-evidence.ts
run_suite "tts-c1a-validation-evidence" npx tsx scripts/test-tts-c1a-validation-evidence.ts
run_suite "tts-c1a-replay-integrity" npx tsx scripts/test-tts-c1a-replay-integrity.ts
run_suite "tts-c1a-resource-cleanup" npx tsx scripts/test-tts-c1a-resource-cleanup.ts
# TTS-C.1A.R3 新增 4 套（commit seal / recovery cancellation / get integrity / db-time stale）
run_suite "tts-c1a-commit-seal" npx tsx scripts/test-tts-c1a-commit-seal.ts
run_suite "tts-c1a-recovery-cancellation" npx tsx scripts/test-tts-c1a-recovery-cancellation.ts
run_suite "tts-c1a-get-integrity" npx tsx scripts/test-tts-c1a-get-integrity.ts
run_suite "tts-c1a-db-time-stale" npx tsx scripts/test-tts-c1a-db-time-stale.ts
# TTS-C.1A.R4 新增 1 套（held capability brand / exact destination binding / ancestor seal / verify zero-write / zero-subscriber closure）
run_suite "tts-c1a-r4-hardening" npx tsx scripts/test-tts-c1a-r4-hardening.ts
# TTS-C.1A.R5 新增 1 套（immutable authority record / branded reuse evidence / reuse ancestor seal / terminal response closure / POST integrity / production hook guard）
run_suite "tts-c1a-r5-hardening" npx tsx scripts/test-tts-c1a-r5-hardening.ts
# TTS-C.1A.R6 新增 1 套（private reuse authority / record-only SHA seal / one-shot consumption / real POST integrity / production hook guard）
run_suite "tts-c1a-r6-hardening" npx tsx scripts/test-tts-c1a-r6-hardening.ts
# TTS-C.1B.1 新增 1 套（adapter registry reload contract：1.0/1.1 双 schema / LKG / atomic swap / registry-status ack）
# venv bootstrap 由 scripts/run-tts-c1b1-adapter-registry.sh 管理（gitignored 本地环境，
# ci.yml 同款创建方式）；bootstrap 失败 → suite 失败、gate FAIL（fail-closed，不静默跳过）
run_suite "tts-c1b1-adapter-registry" bash scripts/run-tts-c1b1-adapter-registry.sh
# TTS-C.1A.R7 STRONG-only mutation runner（12 项 mutation；耗时，不入 gate）—— 独立运行
# `npx tsx scripts/test-tts-c1a-r7-mutations.ts`，输出 /tmp/r7-mutation-output.txt + docs/evidence/tts-c-r17/mutation-output.txt

# 9. TTS-C.1C.1 provider capability snapshot + pure compiler 套件
run_suite "tts-c1c1-capability" npx tsx scripts/test-tts-c1c1-capability.ts

# 10. TTS-C.1B.2 legacy import + publisher candidate creation 套件
# （temp DB + temp dirs；真实双进程并发；零真实 provider / 零 /reload / 零 production）
run_suite "tts-c1b2-publisher-candidate" npx tsx scripts/test-tts-c1b2-publisher-candidate.ts

echo "QUALITY_GATE_RESULT=PASS"
echo "QUALITY_GATE_SHA=$GATE_SHA"
echo "QUALITY_GATE_TOTAL_SUITES=$((PASS_COUNT))"
echo "GATE_LOG=$GATE_LOG"
exit 0
