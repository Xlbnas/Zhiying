#!/usr/bin/env python3
"""TTS-C Contract Gate：双引擎结果一致性校验（CI 步骤）。

断言（任一不满足 → 非零 exit）：
1. 两引擎 test ID 集合与逐 test PASS/FAIL 完全一致；
2. TOTAL/PASS/FAIL/SKIP 一致；
3. design doc sha256 一致；
4. extracted §2 sql sha256 一致。
"""
import sys


def parse(path):
    header = {}
    tests = []
    totals = {}
    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\n")
        if line.startswith("[PASS]") or line.startswith("[FAIL]"):
            ok = line.startswith("[PASS]")
            tid = line.split()[1]
            tests.append((tid, ok))
        elif line.startswith("TOTAL="):
            for part in line.split():
                if "=" in part:
                    k, v = part.split("=", 1)
                    totals[k] = int(v)
        elif ":" in line and not line.startswith("  "):
            k, v = line.split(":", 1)
            header[k.strip()] = v.strip()
    return header, tests, totals


def main():
    if len(sys.argv) != 3:
        print("usage: verify_engines.py <results-python-sqlite.txt> <results-sqlite-3.45.1.txt>")
        return 1
    h1, t1, n1 = parse(sys.argv[1])
    h2, t2, n2 = parse(sys.argv[2])
    errors = []

    if t1 != t2:
        errors.append("per-test results differ between engines")
        for (a, b) in zip(t1, t2):
            if a != b:
                errors.append("  first diff: %s vs %s" % (a, b))
                break
    if n1 != n2:
        errors.append("totals differ: %s vs %s" % (n1, n2))
    if h1.get("design doc sha256") != h2.get("design doc sha256"):
        errors.append("design doc sha256 differs")
    if h1.get("extracted §2 sql sha256") != h2.get("extracted §2 sql sha256"):
        errors.append("extracted §2 sql sha256 differs")
    if n1.get("FAIL", -1) != 0 or n2.get("FAIL", -1) != 0:
        errors.append("FAIL>0 (%s / %s)" % (n1.get("FAIL"), n2.get("FAIL")))

    if errors:
        print("ENGINE-CONSISTENCY FAIL:")
        for e in errors:
            print("  - " + e)
        return 1
    print("ENGINE-CONSISTENCY PASS: tests=%d PASS=%d FAIL=%d SKIP=%d" %
          (n1.get("TOTAL"), n1.get("PASS"), n1.get("FAIL"), n1.get("SKIP")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
