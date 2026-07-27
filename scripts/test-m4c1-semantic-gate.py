#!/usr/bin/env python3
"""M4-C1B2-R5A — semantic-compose-gate.py 单元 fixture 测试（stdlib only）。

真实执行 scripts/deploy/m4c1/semantic-compose-gate.py，检查 exit code：
  approved delta          => rc 0 (SEMANTIC_DIFF_GATE=PASS)
  任何越界 delta          => rc 1 (SEMANTIC_DIFF_GATE=FAIL)

用法：python3 scripts/test-m4c1-semantic-gate.py
"""

import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GATE = os.path.join(REPO, "scripts", "deploy", "m4c1", "semantic-compose-gate.py")

# Windows GBK 控制台无法打印 µ/μ 等字符，统一 utf-8 + replace
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 直接载入 gate 模块以单元测试 duration_seconds（文件名含连字符，用 importlib）
_spec = importlib.util.spec_from_file_location("semantic_compose_gate", GATE)
_gate_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_gate_mod)
duration_seconds = _gate_mod.duration_seconds

PROXY = "http://127.0.0.1:7890"


def base_current():
    """模拟 Feiniu 正式 compose normalize 后的形态：indextts2 无 command
    （image-default CMD）、network_mode=host、无 top-level volumes。"""
    return {
        "services": {
            "qwen3-tts": {
                "image": "xlbnas/qwen3-tts:1.7b",
                "container_name": "qwen3-tts",
                "network_mode": "host",
                "restart": "unless-stopped",
                "environment": {"HTTP_PROXY": PROXY, "HTTPS_PROXY": PROXY},
            },
            "indextts2": {
                "image": "neosun/indextts2:v2.2-performance-optimized",
                "container_name": "indextts2",
                "network_mode": "host",
                "restart": "unless-stopped",
                "device_requests": [{"driver": "gpu", "count": -1, "capabilities": [["gpu"]]}],
                "environment": {
                    "HTTP_PROXY": PROXY,
                    "HTTPS_PROXY": PROXY,
                    "http_proxy": PROXY,
                    "https_proxy": PROXY,
                    "NO_PROXY": "localhost,127.0.0.1",
                    "HF_ENDPOINT": "https://huggingface.co",
                    "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
                },
                "volumes": [{"type": "bind", "source": "./outputs/index", "target": "/app/outputs"}],
                "shm_size": 8589934592,
            },
            "cosyvoice3": {
                "image": "neosun/cosyvoice:v3.4.0",
                "container_name": "cosyvoice3",
                "network_mode": "host",
                "restart": "unless-stopped",
            },
        },
        "networks": {},
    }


def approved_proposed(cur):
    """唯一合法 delta：bridge 网络 + 限定 ports + R5A 四项 offline env + healthcheck。"""
    p = copy.deepcopy(cur)
    it = p["services"]["indextts2"]
    del it["network_mode"]
    it["networks"] = {"zhiying-tts-net": None}
    it["ports"] = [
        {"mode": "ingress", "target": 8002, "published": "8002", "host_ip": "127.0.0.1", "protocol": "tcp"},
        {"mode": "ingress", "target": 7870, "published": "7870", "protocol": "tcp"},
    ]
    it["environment"]["UV_NO_SYNC"] = "1"
    it["environment"]["UV_OFFLINE"] = "1"
    it["environment"]["HF_HUB_CACHE"] = "/app/checkpoints/hf_cache"
    it["environment"]["HF_HUB_OFFLINE"] = "1"
    it["healthcheck"] = {
        "test": ["CMD-SHELL", "curl -f http://127.0.0.1:8002/health >/dev/null || exit 1"],
        "interval": 15000000000,
        "timeout": 10000000000,
        "start_period": 600000000000,
        "retries": 10,
    }
    p["networks"] = {"zhiying-tts-net": {"name": "zhiying-tts-net", "external": True}}
    return p


def run_gate(tmp, cur, prop):
    cp = os.path.join(tmp, "current.json")
    pp = os.path.join(tmp, "proposed.json")
    with open(cp, "w", encoding="utf-8") as f:
        json.dump(cur, f)
    with open(pp, "w", encoding="utf-8") as f:
        json.dump(prop, f)
    r = subprocess.run([sys.executable, GATE, cp, pp], capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def main():
    cur = base_current()
    good = approved_proposed(cur)

    def it(p):
        return p["services"]["indextts2"]

    fail_cases = {}

    p = copy.deepcopy(good); p["services"]["qwen3-tts"]["environment"]["NEW"] = "1"
    fail_cases["qwen change"] = p
    p = copy.deepcopy(good); p["services"]["cosyvoice3"]["restart"] = "always"
    fail_cases["cosyvoice change"] = p
    p = copy.deepcopy(good); it(p)["command"] = "bash -c rebuilt"
    fail_cases["command absent->added"] = p
    cur_cmd = copy.deepcopy(cur); it(cur_cmd)["command"] = "X"
    p = approved_proposed(cur_cmd); it(p)["command"] = "Y"
    fail_cases["command X->Y"] = (cur_cmd, p)
    p = copy.deepcopy(good); del it(p)["environment"]["HTTPS_PROXY"]
    fail_cases["existing env removed"] = p
    p = copy.deepcopy(good); it(p)["environment"]["HF_ENDPOINT"] = "https://mirror.example"
    fail_cases["existing env changed"] = p
    p = copy.deepcopy(good); it(p)["environment"]["EXTRA_ENV"] = "1"
    fail_cases["extra env added"] = p
    p = copy.deepcopy(good); it(p)["networks"]["other-net"] = None
    fail_cases["extra service network"] = p
    p = copy.deepcopy(good); it(p)["ports"][0]["host_ip"] = "0.0.0.0"
    fail_cases["8002 exposed 0.0.0.0"] = p
    p = copy.deepcopy(good); it(p)["ports"].append({"target": 9000, "published": "9000", "protocol": "tcp"})
    fail_cases["extra port"] = p
    p = copy.deepcopy(good); it(p)["healthcheck"]["start_period"] = 300000000000
    fail_cases["health start_period too short"] = p
    p = copy.deepcopy(good); it(p)["healthcheck"]["interval"] = 30000000000
    fail_cases["health interval changed"] = p
    p = copy.deepcopy(good); p["volumes"] = {"extra-vol": {}}
    fail_cases["top-level volume added"] = p
    cur_vol = copy.deepcopy(cur); cur_vol["volumes"] = {"keep": {}}
    p = approved_proposed(cur_vol); del p["volumes"]
    fail_cases["top-level volume removed"] = (cur_vol, p)
    p = copy.deepcopy(good); p["networks"]["unrelated"] = {"external": True, "name": "unrelated"}
    fail_cases["unrelated top-level network added"] = p
    p = copy.deepcopy(good); it(p)["healthcheck"]["retries"] = 5
    fail_cases["health retries changed"] = p
    p = copy.deepcopy(good); it(p)["healthcheck"]["timeout"] = 20000000000
    fail_cases["health timeout changed"] = p
    # R4 — compound duration 边界（模拟 Feiniu compose normalize 输出形态）
    p = copy.deepcopy(good); it(p)["healthcheck"]["start_period"] = "9m59s"
    fail_cases['start_period "9m59s" (<600s)'] = p
    p = copy.deepcopy(good); it(p)["healthcheck"]["start_period"] = "5m0s"
    fail_cases['start_period "5m0s" (<600s)'] = p
    p = copy.deepcopy(good); it(p)["healthcheck"]["start_period"] = "10m0sJUNK"
    fail_cases['start_period "10m0sJUNK" (partial parse 禁止)'] = p
    p = copy.deepcopy(good); it(p)["healthcheck"]["interval"] = "14s"
    fail_cases['interval "14s" (!=15s)'] = p
    p = copy.deepcopy(good); it(p)["healthcheck"]["timeout"] = "11s"
    fail_cases['timeout "11s" (!=10s)'] = p

    # R5A — HF runtime artifact closure contract 负例
    p = copy.deepcopy(good); del it(p)["environment"]["HF_HUB_CACHE"]
    fail_cases["R5A HF_HUB_CACHE 缺失"] = p
    p = copy.deepcopy(good); it(p)["environment"]["HF_HUB_CACHE"] = "/root/.cache/huggingface"
    fail_cases["R5A HF_HUB_CACHE 路径错误（writable-layer cache）"] = p
    p = copy.deepcopy(good); del it(p)["environment"]["HF_HUB_OFFLINE"]
    fail_cases["R5A HF_HUB_OFFLINE 缺失"] = p
    p = copy.deepcopy(good); it(p)["environment"]["HF_HUB_OFFLINE"] = "0"
    fail_cases["R5A HF_HUB_OFFLINE=0"] = p
    p = copy.deepcopy(good); it(p)["environment"]["HF_HUB_OFFLINE"] = "true"
    fail_cases["R5A HF_HUB_OFFLINE=true（contract 锁定 \"1\"）"] = p
    p = copy.deepcopy(good); it(p)["environment"]["HF_HOME"] = "/app/checkpoints/hf_cache"
    fail_cases["R5A 额外 HF_HOME"] = p
    p = copy.deepcopy(good); it(p)["environment"]["HUGGINGFACE_HUB_CACHE"] = "/app/checkpoints/hf_cache"
    fail_cases["R5A 额外 HUGGINGFACE_HUB_CACHE"] = p
    p = copy.deepcopy(good); it(p)["environment"]["TRANSFORMERS_OFFLINE"] = "1"
    fail_cases["R5A 额外 TRANSFORMERS_OFFLINE"] = p
    p = copy.deepcopy(good); it(p)["environment"]["HTTP_PROXY"] = "http://192.168.31.56:7890"
    fail_cases["R5A 修改 HTTP_PROXY"] = p
    p = copy.deepcopy(good); del it(p)["environment"]["HTTP_PROXY"]
    fail_cases["R5A 删除 HTTP_PROXY"] = p
    p = copy.deepcopy(good); it(p)["volumes"].append(
        {"type": "bind", "source": "./models/hf", "target": "/app/checkpoints/hf_cache"})
    fail_cases["R5A 新增 HF cache volume"] = p
    p = copy.deepcopy(good); it(p)["volumes"][0] = {
        "type": "bind", "source": "./outputs/other", "target": "/app/outputs"}
    fail_cases["R5A 修改现有 outputs volume"] = p

    # R4 — 合法 compound/字符串 duration 仍应 PASS
    pass_cases = {}
    p = copy.deepcopy(good)
    it(p)["healthcheck"]["start_period"] = "10m0s"   # 本次 Feiniu 真实 normalize 形态
    it(p)["healthcheck"]["interval"] = "15s"
    it(p)["healthcheck"]["timeout"] = "10s"
    pass_cases['real Feiniu normalized: start_period "10m0s" interval "15s" timeout "10s"'] = p
    p = copy.deepcopy(good); it(p)["healthcheck"]["interval"] = "0m15s"
    pass_cases['interval "0m15s" (compound=15s)'] = p
    p = copy.deepcopy(good); it(p)["healthcheck"]["timeout"] = "0m10s"
    pass_cases['timeout "0m10s" (compound=10s)'] = p
    p = copy.deepcopy(good); it(p)["healthcheck"]["start_period"] = "0h10m0s"
    pass_cases['start_period "0h10m0s" (=600s)'] = p
    # R5A — 四个 approved offline env 精确存在（显式命名，approved_proposed 即 R5A contract）
    pass_cases["R5A 四个 approved offline env 精确存在"] = copy.deepcopy(good)

    npass = nfail = 0

    def check(label, cond, detail=""):
        nonlocal npass, nfail
        if cond:
            npass += 1
            print(f"PASS  {label}")
        else:
            nfail += 1
            print(f"FAIL  {label}  {detail}")

    # ---- R4: duration_seconds 单元测试（直接 import gate 函数） ----
    valid = {
        "0": 0, "15s": 15, "600s": 600, "10m0s": 600, "1m30s": 90,
        "1h0m0s": 3600, "1h15m30s": 4530, "1.5h": 5400, "500ms": 0.5,
        "100us": 0.0001, "100µs": 0.0001, "100μs": 0.0001,
        "100ns": 0.0000001, "1m0.5s": 60.5,
    }
    for s, want in valid.items():
        got = duration_seconds(s)
        check(f'D01 duration_seconds("{s}") == {want}',
              got is not None and abs(got - want) < 1e-9 * max(1, abs(want)), f"got={got}")
    check('D02 duration_seconds(600000000000) == 600 (numeric ns compat)',
          duration_seconds(600000000000) == 600)
    for s in ["", "abc", "10m0sJUNK", "abc10m", "10", "1x", "m10", "1..5s", "-10s"]:
        got = duration_seconds(s)
        check(f'D03 duration_seconds("{s}") is None', got is None, f"got={got}")

    with tempfile.TemporaryDirectory() as tmp:
        rc, out = run_gate(tmp, cur, good)
        check("F00 approved delta => PASS", rc == 0 and "SEMANTIC_DIFF_GATE=PASS" in out, out[-200:])

        for name, p in pass_cases.items():
            rc, out = run_gate(tmp, cur, p)
            check(f"F01 {name} => PASS", rc == 0 and "SEMANTIC_DIFF_GATE=PASS" in out, out[-200:])

        for name, case in fail_cases.items():
            c, p = case if isinstance(case, tuple) else (cur, case)
            rc, out = run_gate(tmp, c, p)
            check(f"Fxx {name} => FAIL", rc == 1 and "SEMANTIC_DIFF_GATE=FAIL" in out, out[-200:])

    print(f"\nM4-C1 semantic-gate fixtures: {npass} PASS, {nfail} FAIL")
    return 1 if nfail else 0


if __name__ == "__main__":
    sys.exit(main())
