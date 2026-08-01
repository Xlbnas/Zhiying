#!/usr/bin/env bash
# test-m7-status-doc-consistency.sh — docs/M7_IMPLEMENTATION_STATUS.md 一致性检查。
# 拒绝：
#   1. 重复 milestone heading（同一里程碑出现两次 DONE）；
#   2. production 已部署但同时存在 "deployed: 否"；
#   3. runtime SHA 格式不合法（40 位 hex）；
#   4. TODO 与 DONE 同一里程碑冲突。
# 用法：bash scripts/test-m7-status-doc-consistency.sh
set -euo pipefail

DOC="docs/M7_IMPLEMENTATION_STATUS.md"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL  $1"; }

[ -f "$DOC" ] || { echo "FAIL 文档不存在: $DOC"; exit 1; }

# 1) 重复 milestone heading（"| **M7.x ...** | **DONE**" 行出现两次）
milestones=$(grep -E '^\| \*\*M7\.[0-9A-Za-z.]+' "$DOC" | grep -c '\*\*DONE\*\*')
unique=$(grep -E '^\| \*\*M7\.[0-9A-Za-z.]+' "$DOC" | grep '\*\*DONE\*\*' | sed -E 's/^\| \*\*([^*]+)\*\*.*/\1/' | sort -u | wc -l)
if [ "$milestones" -eq "$unique" ]; then
  ok "milestone heading 无重复（${unique} 个唯一 DONE 里程碑）"
else
  bad "milestone heading 重复（总数 ${milestones}，唯一 ${unique}）"
  grep -E '^\| \*\*M7\.' "$DOC" | grep '\*\*DONE\*\*' | sed -E 's/^\| \*\*([^*]+)\*\*.*/\1/' | sort | uniq -d | sed 's/^/      重复: /'
fi

# 2) production 已部署 + 旧里程碑 "deployed: 否" 并存 → 拒绝
#    当前进行中的最新里程碑（4.9 M7.3A.3.1）允许 "否（待部署）"。
deployed_yes=$(grep -cE '\*\*deployed\*\*.*是' "$DOC" || true)
deployed_no_lines=$(grep -nE '\*\*deployed\*\*.*否' "$DOC" || true)
no_count=$(printf '%s\n' "$deployed_no_lines" | grep -c . || true)
# 4.9 章节起始行
sec49_line=$(grep -n '### 4.9 ' "$DOC" | head -1 | cut -d: -f1 || echo 99999)
illegal_no=0
if [ "$no_count" -gt 0 ]; then
  while IFS= read -r line; do
    ln=$(printf '%s' "$line" | cut -d: -f1)
    if [ -n "$ln" ] && [ "$ln" -lt "$sec49_line" ]; then
      illegal_no=1
      bad "旧里程碑（4.9 之前）仍有 deployed=否: $line"
    fi
  done <<< "$deployed_no_lines"
fi
if [ "$deployed_yes" -gt 0 ] && [ "$illegal_no" -eq 0 ]; then
  ok "deployed 状态一致（是=${deployed_yes}，进行中 4.9 允许待部署）"
fi

# 3) SHA 字段：reviewedCodeSHA / productionRuntimeSHA / productionHostCheckoutSHA
#    格式 40 位 hex；且必须是当前 Git HEAD 的 ancestor（不要求等于 HEAD）。
sha_lines=$(grep -E '^\| (reviewedCodeSHA|productionRuntimeSHA|productionHostCheckoutSHA) ' "$DOC" || true)
if [ -z "$sha_lines" ]; then
  bad "缺少 reviewedCodeSHA/productionRuntimeSHA/productionHostCheckoutSHA 字段"
else
  bad_sha=0
  while IFS= read -r line; do
    sha=$(printf '%s' "$line" | sed -E 's/.*`([0-9a-f]{40})`.*/\1/')
    if ! printf '%s' "$sha" | grep -qE '^[0-9a-f]{40}$'; then
      bad_sha=1
      bad "SHA 格式非法: $line"
      continue
    fi
    if ! git merge-base --is-ancestor "$sha" HEAD 2>/dev/null; then
      bad_sha=1
      bad "SHA 不是当前 Git HEAD 的 ancestor: $line"
    fi
  done <<< "$sha_lines"
  [ "$bad_sha" -eq 0 ] && ok "SHA 字段格式合法且均为 HEAD ancestor（不要求等于 HEAD）"
fi

# 4) TODO 与 DONE 同一里程碑冲突（TODO 行与 DONE 行同里程碑名）
conflict=0
while IFS= read -r name; do
  if grep -qE "^\| \[ \] .*${name}" "$DOC" 2>/dev/null; then
    conflict=1
    bad "里程碑 '$name' 同时为 DONE 与 TODO"
  fi
done < <(grep -E '^\| \*\*M7\.[0-9A-Za-z.]+' "$DOC" | grep '\*\*DONE\*\*' | sed -E 's/^\| \*\*([^*]+)\*\*.*/\1/')
[ "$conflict" -eq 0 ] && ok "无 TODO/DONE 同里程碑冲突"

echo ""
echo "${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ] || exit 1
