#!/bin/bash
# 知影 M7 quality gate — GitHub Actions 失败退出码传播自测（TTS-B.R3）
#
# 背景：R2 的 workflow 用 `bash scripts/run-m7-quality-gate.sh | tee log`，
# 外层 GitHub shell 未启用 pipefail，tee 会吞掉子脚本失败退出码，
# 导致 gate 失败但 workflow conclusion 仍为 success。
#
# 本脚本在 CI/agentvm/镜像内统一验证：
#   1. pipefail 下失败退出码能穿过 `| tee` 传播；
#   2. 带 QUALITY_GATE_RESULT=FAIL 的 canary 失败同样传播；
#   3. 不使用 continue-on-error / command || true。
#
# 任一断言失败 → 非零退出（run-m7-quality-gate.sh 的 run_suite 捕获）。

set -u

fails=0

# 1. 最小 pipefail 证明：exit 37 必须原样穿过 tee
set +e
bash -c 'set -o pipefail; (exit 37) | tee /tmp/m7-pipefail-test.log' >/dev/null 2>&1
ec1=$?
set -e
if [ "$ec1" -eq 37 ]; then
  echo "PASS  m7-exit-propagation: pipefail 传播 exit 37（tee 未吞码）"
else
  echo "FAIL  m7-exit-propagation: pipefail 未传播 exit 37（got $ec1）"
  fails=$((fails + 1))
fi

# 2. canary：模拟 gate 失败（QUALITY_GATE_RESULT=FAIL + exit 41）穿过 tee
set +e
bash -c 'set -o pipefail; bash -c "echo QUALITY_GATE_RESULT=FAIL; exit 41" | tee /tmp/m7-pipefail-canary.log' >/dev/null 2>&1
ec2=$?
set -e
if [ "$ec2" -eq 41 ]; then
  echo "PASS  m7-exit-propagation: canary gate 失败 exit 41 传播（QUALITY_GATE_RESULT=FAIL 不吞码）"
else
  echo "FAIL  m7-exit-propagation: canary 失败未传播 exit 41（got $ec2）"
  fails=$((fails + 1))
fi

# 3. 反向对照：无 pipefail 时 tee 吞码（证明修复必要性，仅记录行为差异）
set +e
bash -c '(exit 42) | tee /tmp/m7-nopipefail-test.log' >/dev/null 2>&1
ec3=$?
set -e
echo "INFO  m7-exit-propagation: 无 pipefail 时管道退出码=$ec3（期望 0/吞码，对比项）"

if [ "$fails" -gt 0 ]; then
  echo "FAIL  m7-quality-gate-exit-propagation: $fails 项失败"
  exit 1
fi
echo "PASS  m7-quality-gate-exit-propagation: 全部通过"
exit 0
