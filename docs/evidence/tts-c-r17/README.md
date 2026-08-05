# TTS-C.1A.R7 Mutation Gate evidence

Runner: `scripts/test-tts-c1a-r7-mutations.ts`（portable；`git rev-parse --show-toplevel`）。
Target tests: `test-tts-c1a-r5-hardening.ts` + `test-tts-c1a-r6-hardening.ts`。
Artifact: `mutation-output.txt`（本目录 + `/tmp/r7-mutation-output.txt`）。

R6 订正（来自独立 Review FAIL）：
- R6 mutation 实测：**2/10 STRONG、1/10 PARTIAL、7/10 no expected failure**
- R6 Mutation CI 曾因 runner/workflow 接受 bug 显示为成功（no observable effect / PARTIAL 被计为 PASS）——
  R7 起 STRONG-only：任一 mutation 非 STRONG → runner exit 1 → CI fail-closed。
