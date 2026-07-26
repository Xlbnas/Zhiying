#!/usr/bin/env bash
# M4-C1B0-R — IndexTTS2 bridge 网络失败只读诊断（Git 受审版）
# 只做：read-only inspection + docker run --rm ephemeral 测试容器。
# 不做：stop/restart/recreate 运行中容器、修改 compose/network/firewall/proxy、
#       写 production config。
# 用法：bash scripts/deploy/m4c1/diagnose-indextts2-network.sh
set -euo pipefail

IMG="neosun/indextts2:v2.2-performance-optimized"
FORMAL="/vol1/1000/tts-stack/docker-compose.yml"
EXPECTED_FORMAL_SHA="a404b1a0889556dd5b687b685569d990e25f42f3c395bac13ac646c33bcb3f88"
RESULTS=()

note() { RESULTS+=("$1"); echo "$1"; }

echo "=== Test A：当前 host 状态 ==="
sha=$(sha256sum "$FORMAL" | awk '{print $1}')
[ "$sha" = "$EXPECTED_FORMAL_SHA" ] \
  && note "PASS A1 formal compose = host-network 原 SHA" \
  || note "FAIL A1 formal compose SHA 漂移：$sha"
ss -lnt | grep -q '0.0.0.0:8002' && note "PASS A2 8002 = 0.0.0.0（host network 形态）" || note "FAIL A2 8002 未按 host 形态监听"
ss -lnt | grep -q '0.0.0.0:7870' && note "PASS A3 7870 = 0.0.0.0" || note "FAIL A3 7870 未监听"
curl -fsS -m 8 http://127.0.0.1:8002/health >/dev/null && note "PASS A4 /health healthy" || note "FAIL A4 /health 不可用"
[ -f /vol1/1000/tts-stack/outputs/index/speaker_cache/index.json ] \
  && note "PASS A5 speaker cache intact" \
  || note "FAIL A5 speaker cache 缺失"

echo "=== Test B：proxy 证据（credential 不输出） ==="
ph=$(grep -E '^\s+HTTPS_PROXY:' "$FORMAL" | head -1 | sed -E 's#.*https?://([^:/"]+):([0-9]+).*#\1 \2#' || true)
echo "proxy host/port: ${ph:-ABSENT}"
ss -lnt | grep -q '127.0.0.1:7890' \
  && note "PASS B1 宿主 proxy 仅监听 127.0.0.1:7890（bridge 不可达 = 根因旁证）" \
  || note "FAIL B1 127.0.0.1:7890 listener 不存在"

echo "=== Test C：bridge 无 proxy egress（ephemeral，不装包） ==="
dns=$(docker run --rm --network zhiying-tts-net "$IMG" bash -c \
  'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy; getent hosts pypi.org >/dev/null && echo OK || echo FAIL' 2>/dev/null || echo FAIL)
[ "$dns" = "OK" ] && note "PASS C1 bridge DNS pypi.org" || note "FAIL C1 bridge DNS"
tcp=$(docker run --rm --network zhiying-tts-net "$IMG" bash -c \
  'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy; timeout 8 bash -c "cat < /dev/null > /dev/tcp/pypi.org/443" && echo OK || echo FAIL' 2>/dev/null || echo FAIL)
[ "$tcp" = "OK" ] && note "PASS C2 bridge TCP pypi.org:443" || note "FAIL C2 bridge TCP443"
https=$(docker run --rm --network zhiying-tts-net "$IMG" bash -c \
  'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy; curl -s -o /dev/null -m 10 -w "%{http_code}" https://pypi.org/' 2>/dev/null || echo 000)
case "$https" in 2*|3*) note "PASS C3 bridge HTTPS pypi.org（NAT egress 正常）";; *) note "FAIL C3 bridge HTTPS（code=$https）";; esac

echo "=== Test D：bridge + 当前 localhost proxy（预期失败=根因实证） ==="
d=$(docker run --rm --network zhiying-tts-net \
  -e HTTP_PROXY=http://127.0.0.1:7890 -e HTTPS_PROXY=http://127.0.0.1:7890 \
  -e http_proxy=http://127.0.0.1:7890 -e https_proxy=http://127.0.0.1:7890 \
  "$IMG" bash -c 'curl -s -o /dev/null -m 10 -w "%{http_code}" https://pypi.org/ 2>/dev/null || echo REFUSED' 2>/dev/null || echo REFUSED)
[ "$d" = "REFUSED" ] || [ "$d" = "000" ] \
  && note "PASS D1 localhost proxy 在 bridge 下不可达（预期失败，复现根因）" \
  || note "FAIL D1 预期外结果（code=$d）"

echo "=== Test E：offline runtime（--network none，不加载模型） ==="
e=$(docker run --rm --network none -e UV_NO_SYNC=1 -e UV_OFFLINE=1 "$IMG" bash -c \
  'cd /app && uv run python3 -c "from indextts.infer_v2 import IndexTTS2; print(\"OFFLINE_IMPORT_OK\")"' 2>&1 || true)
echo "$e" | grep -q OFFLINE_IMPORT_OK \
  && note "PASS E1 uv runtime dependency resolution is offline（--network none 下 import 成功）" \
  || { note "FAIL E1 offline import 失败：$(echo "$e" | tail -3)"; }

echo "=== 汇总 ==="
fails=$(printf '%s\n' "${RESULTS[@]}" | grep -c '^FAIL' || true)
printf '%s\n' "${RESULTS[@]}"
echo "DIAGNOSE: $(( ${#RESULTS[@]} - fails )) PASS, $fails FAIL"
[ "$fails" -eq 0 ]
