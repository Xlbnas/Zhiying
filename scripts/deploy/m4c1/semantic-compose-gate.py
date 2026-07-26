#!/usr/bin/env python3
"""M4-C1B0-R2 — IndexTTS2 bridge migration normalized semantic diff gate。

输入：两份 `docker compose config --format json` 输出（CURRENT, PROPOSED）。
仅使用 Python stdlib。任一违规即 fail-closed（exit 1），通过时输出
SEMANTIC_DIFF_GATE=PASS 并 exit 0。

允许且仅允许的 delta：
  - qwen3-tts / cosyvoice3：deep equality（零 delta）
  - indextts2：immutable 字段（image/container_name/command/entrypoint/
    gpus/device_requests/restart/volumes/shm_size/working_dir/user/build）
    完全相等；environment 仅新增 UV_NO_SYNC=1 / UV_OFFLINE=1；
    network_mode host -> zhiying-tts-net + 限定 ports + 限定 healthcheck
  - top-level：仅新增 external network zhiying-tts-net
"""

import json
import sys

IMMUTABLE = (
    "image", "container_name", "command", "entrypoint",
    "gpus", "device_requests", "restart", "volumes",
    "shm_size", "working_dir", "user", "build",
)
# indextts2 上允许走专门校验的 delta key（其余 key 必须完全相等）
DELTA_KEYS = ("environment", "network_mode", "networks", "ports", "healthcheck")
ALLOWED_ENV_ADD = {"UV_NO_SYNC": "1", "UV_OFFLINE": "1"}
NET_NAME = "zhiying-tts-net"

errors = []


def fail(msg):
    errors.append(msg)
    print(f"GATE_VIOLATION: {msg}")


def norm_env(env):
    """environment 归一化为 dict（compose json 可能是 dict 或 list）。"""
    if env is None:
        return {}
    if isinstance(env, dict):
        return dict(env)
    out = {}
    for kv in env:
        k, _, v = str(kv).partition("=")
        out[k] = v
    return out


def norm_net_names(networks):
    """service.networks 归一化为名字集合（list 或 dict 形态）。"""
    if networks is None:
        return set()
    if isinstance(networks, dict):
        return set(networks.keys())
    return {str(n) for n in networks}


def duration_seconds(v):
    """compose json duration 归一化为秒（int=纳秒，str=Go duration 如 600s）。"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return v / 1e9
    s = str(v).strip()
    try:
        if s.endswith("ns"):
            return float(s[:-2]) / 1e9
        if s.endswith("ms"):
            return float(s[:-2]) / 1e3
        if s.endswith("m"):
            return float(s[:-1]) * 60
        if s.endswith("s"):
            return float(s[:-1])
        return float(s)
    except ValueError:
        return None


def norm_ports(ports):
    out = []
    for p in ports or []:
        if isinstance(p, dict):
            out.append({
                "target": p.get("target"),
                "published": str(p.get("published", "")),
                "host_ip": p.get("host_ip") or "",
                "protocol": p.get("protocol", "tcp"),
            })
        else:
            out.append({"raw": str(p)})
    return out


def check_service_set(cur, prop):
    if set(cur) != set(prop):
        fail(f"service 集合变化：removed={sorted(set(cur) - set(prop))} "
             f"added={sorted(set(prop) - set(cur))}")


def check_untouched(name, cur_svc, prop_svc):
    if cur_svc != prop_svc:
        keys = set(cur_svc or {}) | set(prop_svc or {})
        diff = [k for k in sorted(keys)
                if (cur_svc or {}).get(k) != (prop_svc or {}).get(k)]
        fail(f"{name} 必须 deep equality，差异 keys={diff}")


def check_indextts2(ci, pi):
    ci = ci or {}
    pi = pi or {}
    for k in IMMUTABLE:
        if ci.get(k) != pi.get(k):
            fail(f"indextts2.{k} 变化：{ci.get(k)!r} -> {pi.get(k)!r}")

    # environment：existing 全保持，仅允许新增 UV_NO_SYNC/UV_OFFLINE=1
    ce, pe = norm_env(ci.get("environment")), norm_env(pi.get("environment"))
    for k, v in ce.items():
        if k not in pe:
            fail(f"indextts2.environment 删除 {k}")
        elif pe[k] != v:
            fail(f"indextts2.environment 修改 {k}")
    added = {k: v for k, v in pe.items() if k not in ce}
    if added != ALLOWED_ENV_ADD:
        fail(f"indextts2.environment 新增项异常：{sorted(added)}（仅允许 {sorted(ALLOWED_ENV_ADD)}=1）")

    # network delta：current=host -> proposed=zhiying-tts-net
    if ci.get("network_mode") != "host":
        fail(f"indextts2 当前 network_mode={ci.get('network_mode')!r}（预期 host，否则不应执行本迁移）")
    if pi.get("network_mode"):
        fail(f"indextts2 proposed 仍声明 network_mode={pi.get('network_mode')!r}")
    if NET_NAME not in norm_net_names(pi.get("networks")):
        fail(f"indextts2 proposed 未挂 {NET_NAME}")

    # ports：必须精确包含 127.0.0.1:8002->8002 与 7870->7870；8002 不得 0.0.0.0/:: 发布
    ports = norm_ports(pi.get("ports"))
    p8002 = [p for p in ports if p.get("target") == 8002]
    if len(p8002) != 1 or p8002[0]["published"] != "8002" or p8002[0]["host_ip"] != "127.0.0.1":
        fail(f"indextts2 8002 发布必须恰为 127.0.0.1:8002->8002，实际={p8002}")
    if any(p.get("host_ip") in ("0.0.0.0", "::", "") and p.get("target") == 8002 for p in ports):
        fail("indextts2 8002 不得以 0.0.0.0/::/空 host_ip 发布")
    p7870 = [p for p in ports if p.get("target") == 7870 and p.get("published") == "7870"]
    if len(p7870) != 1:
        fail(f"indextts2 7870->7870 发布缺失或重复：{p7870}")
    if len(ports) != 2:
        fail(f"indextts2 ports 仅允许 8002/7870 两条，实际={ports}")

    # healthcheck：127.0.0.1:8002/health 且 start_period >= 600s
    hc = pi.get("healthcheck") or {}
    test = hc.get("test")
    test_str = " ".join(str(t) for t in test) if isinstance(test, list) else str(test or "")
    if "127.0.0.1:8002/health" not in test_str:
        fail(f"indextts2 healthcheck test 不含 127.0.0.1:8002/health：{test_str!r}")
    sp = duration_seconds(hc.get("start_period"))
    if sp is None or sp < 600:
        fail(f"indextts2 healthcheck start_period={hc.get('start_period')!r}（>=600s 必需）")

    # 其余 key 零 delta
    skip = set(IMMUTABLE) | set(DELTA_KEYS)
    for k in sorted((set(ci) | set(pi)) - skip):
        if ci.get(k) != pi.get(k):
            fail(f"indextts2.{k} 非白名单变化：{ci.get(k)!r} -> {pi.get(k)!r}")


def check_top_level(cur, prop):
    cn, pn = cur.get("networks") or {}, prop.get("networks") or {}
    for k, v in cn.items():
        if k not in pn:
            fail(f"top-level network 删除：{k}")
        elif pn[k] != v:
            fail(f"top-level network 修改：{k}")
    added = set(pn) - set(cn)
    if added != {NET_NAME}:
        fail(f"top-level networks 新增异常：{sorted(added)}（仅允许 {NET_NAME}）")
    elif added:
        net = pn[NET_NAME] or {}
        if net.get("external") is not True or net.get("name") != NET_NAME:
            fail(f"{NET_NAME} 必须 external=true name={NET_NAME}，实际={net}")
    cv, pv = cur.get("volumes") or {}, prop.get("volumes") or {}
    for k, v in cv.items():
        if k not in pv:
            fail(f"top-level volume 删除：{k}")
        elif pv[k] != v:
            fail(f"top-level volume 修改：{k}")
    for k in sorted((set(cur) | set(prop)) - {"services", "networks", "volumes"}):
        if cur.get(k) != prop.get(k):
            fail(f"top-level key {k} 变化")


def main():
    if len(sys.argv) != 3:
        print("usage: semantic-compose-gate.py CURRENT.json PROPOSED.json", file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8") as f:
        cur = json.load(f)
    with open(sys.argv[2], encoding="utf-8") as f:
        prop = json.load(f)
    cs, ps = cur.get("services") or {}, prop.get("services") or {}

    check_service_set(cs, ps)
    for name in ("qwen3-tts", "cosyvoice3"):
        if name in cs:
            check_untouched(name, cs.get(name), ps.get(name))
    if "indextts2" not in cs or "indextts2" not in ps:
        fail("indextts2 service 缺失")
    else:
        check_indextts2(cs["indextts2"], ps["indextts2"])
    check_top_level(cur, prop)

    if errors:
        print(f"SEMANTIC_DIFF_GATE=FAIL ({len(errors)} violations)")
        return 1
    print("SEMANTIC_DIFF_GATE=PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
