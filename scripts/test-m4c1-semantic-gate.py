#!/usr/bin/env python3
"""M4-C1B0-R3 — semantic-compose-gate.py 单元 fixture 测试（stdlib only）。

真实执行 scripts/deploy/m4c1/semantic-compose-gate.py，检查 exit code：
  approved delta          => rc 0 (SEMANTIC_DIFF_GATE=PASS)
  任何越界 delta          => rc 1 (SEMANTIC_DIFF_GATE=FAIL)

用法：python3 scripts/test-m4c1-semantic-gate.py
"""

import copy
import json
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GATE = os.path.join(REPO, "scripts", "deploy", "m4c1", "semantic-compose-gate.py")

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
    """唯一合法 delta：bridge 网络 + 限定 ports + UV offline env + healthcheck。"""
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

    npass = nfail = 0

    def check(label, cond, detail=""):
        nonlocal npass, nfail
        if cond:
            npass += 1
            print(f"PASS  {label}")
        else:
            nfail += 1
            print(f"FAIL  {label}  {detail}")

    with tempfile.TemporaryDirectory() as tmp:
        rc, out = run_gate(tmp, cur, good)
        check("F00 approved delta => PASS", rc == 0 and "SEMANTIC_DIFF_GATE=PASS" in out, out[-200:])

        for name, case in fail_cases.items():
            c, p = case if isinstance(case, tuple) else (cur, case)
            rc, out = run_gate(tmp, c, p)
            check(f"Fxx {name} => FAIL", rc == 1 and "SEMANTIC_DIFF_GATE=FAIL" in out, out[-200:])

    print(f"\nM4-C1 semantic-gate fixtures: {npass} PASS, {nfail} FAIL")
    return 1 if nfail else 0


if __name__ == "__main__":
    sys.exit(main())
