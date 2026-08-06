#!/bin/bash
# TTS-C.1B.1 adapter registry 测试 runner（venv bootstrap + suite 执行）。
#
# venv 为 gitignored 本地环境（ci.yml 同款创建方式）；缺失时现场创建，
# 创建失败 → 非零退出，由统一 gate 的 run_suite 捕获为标准失败输出：
#   FAILED_SUITE / FAILED_COMMAND / QUALITY_GATE_RESULT=FAIL
# 硬规则：不给 web/worker 镜像安装 Python；不新增 CI workflow。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADAPTER_DIR="$ROOT/services/indextts2-api-adapter"
VENV_PY="$ADAPTER_DIR/.venv/bin/python"

if [ ! -x "$VENV_PY" ]; then
  echo "adapter venv 缺失，按 requirements.txt 现场创建"
  python3 -m venv "$ADAPTER_DIR/.venv"
  "$ADAPTER_DIR/.venv/bin/pip" install -q -r "$ADAPTER_DIR/requirements.txt"
fi

exec npx tsx "$ROOT/scripts/test-tts-c1b1-adapter-registry.ts"
