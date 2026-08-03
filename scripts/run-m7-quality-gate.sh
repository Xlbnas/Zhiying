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
#   4. TTS-B 5 套
#   5. TTS-A frozen 7 套
#   6. frozen / existing 11 套
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

# 3. build
run_suite "next-build" pnpm build

# 4. TTS-B 5 套
run_suite "tts-b-voice-assignment" npx tsx scripts/test-tts-b-voice-assignment.ts
run_suite "tts-b-performance-schema" npx tsx scripts/test-tts-b-performance-schema.ts
run_suite "tts-b-performance-generation" npx tsx scripts/test-tts-b-performance-generation.ts
run_suite "tts-b-dag" npx tsx scripts/test-tts-b-dag.ts
run_suite "tts-b-api" npx tsx scripts/test-tts-b-api.ts

# 5. TTS-A frozen 7 套（docs/M7_IMPLEMENTATION_STATUS.md §11 权威清单）
run_suite "tts-a-voice-library-schema" npx tsx scripts/test-tts-a-voice-library-schema.ts
run_suite "tts-a-voice-library-ingest" npx tsx scripts/test-tts-a-voice-library-ingest.ts
run_suite "tts-a-voice-library-api" npx tsx scripts/test-tts-a-voice-library-api.ts
run_suite "tts-a-voice-library-files" npx tsx scripts/test-tts-a-voice-library-files.ts
run_suite "tts-a-durability" npx tsx scripts/test-tts-a-durability.ts
run_suite "tts-a-multipart" npx tsx scripts/test-tts-a-multipart.ts
run_suite "tts-a-staging-failures" npx tsx scripts/test-tts-a-staging-failures.ts

# 6. frozen / existing 11 套（docs/M7_IMPLEMENTATION_STATUS.md §11 权威清单）
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

echo "QUALITY_GATE_RESULT=PASS"
echo "QUALITY_GATE_SHA=$GATE_SHA"
echo "QUALITY_GATE_TOTAL_SUITES=$((PASS_COUNT))"
echo "GATE_LOG=$GATE_LOG"
exit 0
