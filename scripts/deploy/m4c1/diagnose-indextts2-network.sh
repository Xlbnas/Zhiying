#!/usr/bin/env bash
# M4-C1B0-R2 — IndexTTS2 bridge 网络失败只读诊断（Git 受审版）
# 只做：read-only inspection + docker run --rm --pull=never ephemeral 测试容器。
# 不做：stop/restart/recreate 运行中容器、修改 compose、创建/删除 network、
#       修改 proxy/firewall、写 production config、pull 任何 image。
# 用法：bash scripts/deploy/m4c1/diagnose-indextts2-network.sh
set -euo pipefail

FORMAL="/vol1/1000/tts-stack/docker-compose.yml"
EXPECTED_FORMAL_SHA="a404b1a0889556dd5b687b685569d990e25f42f3c395bac13ac646c33bcb3f88"
NET="zhiying-tts-net"
RESULTS=()

note() { RESULTS+=("$1"); echo "$1"; }

# image 必须来自当前 running container（禁止硬编码 tag、禁止 pull）
IMG="$(docker inspect --format '{{.Config.Image}}' indextts2)"
[ -n "$IMG" ] || { echo "FAIL: 无法从 indextts2 读取 image" >&2; exit 1; }
echo "image=$IMG"

echo "=== Test A：当前 host-network 恢复状态（只读） ==="
sha=$(sha256sum "$FORMAL" | awk '{print $1}')
[ "$sha" = "$EXPECTED_FORMAL_SHA" ] \
  && note "PASS A1 formal compose = host-network 原 SHA" \
  || note "FAIL A1 formal compose SHA 漂移：$sha"
nm=$(docker inspect --format '{{.HostConfig.NetworkMode}}' indextts2)
[ "$nm" = "host" ] \
  && note "PASS A2 NetworkMode=host" \
  || note "FAIL A2 NetworkMode=$nm（预期 host）"
ss -lnt | grep -q '0.0.0.0:8002' && note "PASS A3 8002 = 0.0.0.0 LISTEN" || note "FAIL A3 8002 未按 host 形态监听"
ss -lnt | grep -q '0.0.0.0:7870' && note "PASS A4 7870 = 0.0.0.0 LISTEN" || note "FAIL A4 7870 未监听"
curl -fsS -m 8 http://127.0.0.1:8002/health >/dev/null && note "PASS A5 /health HTTP success" || note "FAIL A5 /health 不可用"
CACHE=/vol1/1000/tts-stack/outputs/index/speaker_cache
for f in index.json spk_73d01a47_emb.pkl spk_73d01a47.wav; do
  [ -f "$CACHE/$f" ] && note "PASS A6 speaker cache: $f" || note "FAIL A6 speaker cache 缺失: $f"
done
nvidia-smi >/dev/null 2>&1 && note "PASS A7 nvidia-smi success（GPU 可见）" || note "FAIL A7 nvidia-smi 失败"

echo "=== Test B：proxy 证据（来自 indextts2 容器 env，credential 不输出） ==="
ENV_LIST="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' indextts2)"
for v in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy NO_PROXY; do
  line=$(printf '%s\n' "$ENV_LIST" | grep -E "^${v}=" || true)
  if [ -z "$line" ]; then
    echo "$v=ABSENT"
    continue
  fi
  val="${line#*=}"
  hostport=$(printf '%s' "$val" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://([^/@]*@)?([^/]*).*#\2#')
  host="${hostport%%:*}"; port=""; [ "$hostport" != "$host" ] && port="${hostport##*:}"
  if printf '%s' "$val" | grep -qE '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/@]+@'; then cred="REDACTED"; else cred="none"; fi
  echo "$v=PRESENT host=$host port=${port:-n/a} credential=$cred"
done
ss -lnt | grep -q '127.0.0.1:7890' \
  && note "PASS B1 宿主 proxy 仅监听 127.0.0.1:7890（bridge 不可达 = 根因旁证）" \
  || note "FAIL B1 127.0.0.1:7890 listener 不存在"

echo "=== Test C：bridge 无 proxy egress（ephemeral，不装包，不创建 network） ==="
if docker network inspect "$NET" >/dev/null 2>&1; then
  note "PASS C0 network $NET 存在（diagnose 不创建 network）"
else
  note "FAIL C0 network $NET 不存在（diagnose 禁止创建，需先由 apply 建立）"
fi
UNSET_PROXY='unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy'
if docker run --rm --pull=never --network "$NET" --entrypoint bash "$IMG" -c \
  "$UNSET_PROXY; getent hosts pypi.org >/dev/null" 2>/dev/null; then
  note "PASS C1 bridge DNS pypi.org"
else
  note "FAIL C1 bridge DNS"
fi
if docker run --rm --pull=never --network "$NET" --entrypoint bash "$IMG" -c \
  "$UNSET_PROXY; timeout 8 bash -c 'cat < /dev/null > /dev/tcp/pypi.org/443'" 2>/dev/null; then
  note "PASS C2 bridge TCP pypi.org:443"
else
  note "FAIL C2 bridge TCP443"
fi
if docker run --rm --pull=never --network "$NET" --entrypoint bash "$IMG" -c \
  "$UNSET_PROXY; curl -fsS -m 10 -o /dev/null https://pypi.org/" 2>/dev/null; then
  note "PASS C3 bridge HTTPS pypi.org（NAT egress 正常）"
else
  note "FAIL C3 bridge HTTPS"
fi

echo "=== Test D：bridge + 当前 localhost proxy（exit-code 预期失败=根因实证） ==="
# 直接以 process exit code 判断：curl 必须 non-zero，禁止字符串拼接误判。
if docker run --rm --pull=never --network "$NET" --entrypoint bash \
  -e HTTP_PROXY=http://127.0.0.1:7890 -e HTTPS_PROXY=http://127.0.0.1:7890 \
  -e http_proxy=http://127.0.0.1:7890 -e https_proxy=http://127.0.0.1:7890 \
  "$IMG" -c 'curl -fsS -m 10 -o /dev/null https://pypi.org/' 2>/dev/null; then
  note "FAIL D1 curl 意外成功（localhost proxy 在 bridge 下不应可达）"
else
  note "PASS D1 EXPECTED_FAILURE_CONFIRMED（curl non-zero，复现根因）"
fi

echo "=== Test E：offline runtime（--network none，真实 exit code + marker 双条件） ==="
# Test E begin — fail-closed：保存真实 exit code 与输出，禁止吞错。
E_OUT="$(mktemp)"
trap 'rm -f "$E_OUT"' EXIT
if docker run --rm --pull=never --network none --entrypoint bash \
  -e UV_NO_SYNC=1 -e UV_OFFLINE=1 \
  "$IMG" -c 'cd /app && uv run python3 -c "from indextts.infer_v2 import IndexTTS2; print(\"OFFLINE_IMPORT_OK\")"' \
  >"$E_OUT" 2>&1; then
  e_rc=0
else
  e_rc=$?
fi
if [ "$e_rc" -eq 0 ] && grep -q OFFLINE_IMPORT_OK "$E_OUT"; then
  note "PASS E1 uv runtime dependency resolution is offline（rc=0 且 OFFLINE_IMPORT_OK）"
else
  note "FAIL E1 offline import（rc=$e_rc）：$(tail -3 "$E_OUT")"
fi
# Test E end

echo "=== 汇总 ==="
fails=$(printf '%s\n' "${RESULTS[@]}" | grep -c '^FAIL' || true)
printf '%s\n' "${RESULTS[@]}"
echo "DIAGNOSE: $(( ${#RESULTS[@]} - fails )) PASS, $fails FAIL"
[ "$fails" -eq 0 ]
