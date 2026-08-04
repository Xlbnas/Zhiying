# TTS-C.0.R11 reproducible contract evidence

本目录是 TTS-C.0.R11 的可复跑证据：**只从** `docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md` §2
逐字提取可执行 SQL（`extract_contract.py`），不维护任何手写 contract schema 副本，不依赖 `/tmp`
中未提交的脚本。既有基座表（`projects/artifacts/tts_jobs/voice_profiles/voice_profile_revisions`）
按设计文档 §0「基座前提」以最小真实 fixture 提供（见 `extract_contract.py` 注释）。

## 一条命令复跑

```bash
python3 docs/evidence/tts-c-r11/contract_runner.py \
  --design docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md \
  --sqlite-bin sqlite3 \
  --engine all
```

- `--engine python`：只跑 Python sqlite3 内置库（结果写 `results-python-sqlite.txt`）。
- `--engine cli`：只跑 sqlite3 CLI 子进程（结果写 `results-sqlite-3.45.1.txt`）。
- `--engine all`：两个引擎都跑。任一 FAIL → 非零 exit code。

双引擎一致性校验（CI 步骤）：

```bash
python3 docs/evidence/tts-c-r11/verify_engines.py \
  <results-python-sqlite.txt> <results-sqlite-3.45.1.txt>
```

输出：机器可读（TOTAL/PASS/FAIL/SKIP、逐 test ID）+ 人类可读计数；结果文件记录 git HEAD、
design doc sha256、extracted §2 sql sha256、SQLite 版本、对象计数（表/trigger/index/ALTER）、
每个 test ID 的 PASS/FAIL 与最终总数。

## 真实事务能力（R11 P1-A 修复）

`contract_runner.py` 的 `Harness.tx(statements)`：

- Python 引擎：**同一 sqlite3 connection** `BEGIN IMMEDIATE` → 逐条执行（不自动提交）→
  `COMMIT`；任一失败 `ROLLBACK` 并抛错（单条 exec 不会破坏事务测试）。
- CLI 引擎：**同一个 sqlite3 进程**内执行 `BEGIN IMMEDIATE; stmt1; …; COMMIT;`
  （`-bail`，任一失败非零；失败后调用方用新连接验证全部回滚）。

测试 JS-33（成功事务）/ JS-34（跨语句失败整事务回滚）依赖此能力，禁止用"两条自动提交 exec"
冒充同事务。

## 文件

| 文件 | 作用 |
|---|---|
| `extract_contract.py` | §2 SQL 提取 + 最小基座 fixture（唯一 contract 来源 = 设计文档） |
| `contract_runner.py` | 双引擎 runner：schema apply → FK/integrity → 对象计数 → 逐 test（含 `tx()`） |
| `verify_engines.py` | 双引擎结果一致性校验（CI 使用） |
| `test_js.py` | JS-01…35：execution lifecycle + owner command closure + prestart + 真实事务 |
| `test_lc.py` | LC-01…12：legacy cutover 双路径可达性 / 竞争裁决 / cardinality 与 retired |
| `test_tf.py` | TF-01…08：database-time fencing 回归 |
| `test_ie.py` | IE 全组：indeterminate entry seal / exact-attempt resolve |
| `test_vi.py` | VI 全组：voice identity compat |
| `test_regress.py` | 历史回归子集（PA/CJ/JR/EN/SM/ET/GN/LR/PE/RP），实跑才计数 |
| `results-sqlite-3.45.1.txt` | sqlite3 CLI 3.45.1 原始输出（final commit 前最后一次成功运行） |
| `results-python-sqlite.txt` | Python sqlite3 原始输出（同一次运行） |

## 口径

- 本轮实际执行 110 项，PASS=110，FAIL=0，SKIP=0（两引擎逐 test 一致）；PASS+FAIL+SKIP=总数。
- 未执行的历史回归一律 NOT EXECUTED，不计入 PASS（清单见设计文档 §10.5）。
- 不提交临时 DB，不生成音频，不调用真实 provider。
- 结果文件 SQL hash（`extracted §2 sql sha256`）必须与对 final 文档再跑 `extract_contract.py`
  的 sha256 一致（EA-05）。
- CI（`.github/workflows/m7-quality-gate.yml` 的 `TTS-C Contract Gate` job）在 final HEAD 重新
  生成双引擎结果，不依赖 checked-in result 伪装执行。
