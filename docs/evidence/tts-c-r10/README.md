# TTS-C.0.R10 reproducible contract evidence

本目录是 TTS-C.0.R10 的可复跑证据：**只从** `docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md` §2
逐字提取可执行 SQL（`extract_contract.py`），不维护任何手写 contract schema 副本，不依赖 `/tmp`
中未提交的脚本。既有基座表（`projects/artifacts/tts_jobs/voice_profiles/voice_profile_revisions`）
按设计文档 §0「基座前提」以最小真实 fixture 提供（见 `extract_contract.py` 注释）。

## 一条命令复跑

```bash
python3 docs/evidence/tts-c-r10/contract_runner.py \
  --design docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md \
  --sqlite-bin sqlite3 \
  --engine all
```

- `--engine python`：只跑 Python sqlite3 内置库（结果写 `results-python-sqlite.txt`）。
- `--engine cli`：只跑 sqlite3 CLI 子进程（结果写 `results-sqlite-3.45.1.txt`）。
- `--engine all`：两个引擎都跑。任一 FAIL → 非零 exit code。

输出：机器可读（TOTAL/PASS/FAIL/SKIP、逐 test ID）+ 人类可读计数；结果文件记录 git HEAD、
design doc sha256、extracted §2 sql sha256、SQLite 版本、对象计数（表/trigger/index/ALTER）、
每个 test ID 的 PASS/FAIL 与最终总数。

## 文件

| 文件 | 作用 |
|---|---|
| `extract_contract.py` | §2 SQL 提取 + 最小基座 fixture（唯一 contract 来源 = 设计文档） |
| `contract_runner.py` | 双引擎 runner：schema apply → FK/integrity check → 对象计数 → 逐 test 执行 |
| `test_js.py` | JS-01…17+11b：execution lifecycle（worker_claim / state_transition / 全生命周期） |
| `test_lc.py` | LC-01…12：legacy cutover 双路径可达性 / 竞争裁决 / cardinality 与 retired |
| `test_tf.py` | TF-01…08：database-time fencing 回归 |
| `test_ie.py` | IE-01…14+06b+08a/b：indeterminate entry seal / exact-attempt resolve |
| `test_vi.py` | VI-05…08+07b：voice identity compat |
| `test_regress.py` | 历史回归子集（PA/CJ/JR/EN/SM/ET/GN/LR/PE/RP），实跑才计数 |
| `results-sqlite-3.45.1.txt` | sqlite3 CLI 3.45.1 原始输出（final commit 前最后一次成功运行） |
| `results-python-sqlite.txt` | Python sqlite3 原始输出（同一次运行） |

## 口径

- 本轮实际执行 91 项，PASS=91，FAIL=0，SKIP=0（两引擎一致）；PASS+FAIL+SKIP=总数（EA-03）。
- 未执行的历史回归一律 NOT EXECUTED，不计入 PASS（清单见设计文档 §10.5）。
- 不提交临时 DB，不生成音频，不调用真实 provider。
- 结果文件 SQL hash（`extracted §2 sql sha256`）必须与对 final 文档再跑 `extract_contract.py`
  的 sha256 一致（EA-05）。
