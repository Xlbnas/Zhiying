# Local full-length stability fix

## Frozen identity

- Baseline: `INITIAL_PRODUCTION_BASELINE_V1`
- Props SHA-256: `8289a196d0aa7ff6f6aa9ae46e8a67f8bf1d6e13a2b6b0d4b4cfec734e50b23f`
- Audio SHA-256: `658235d97a94f67feb9bc50d0849e7b15c2edf85f95b8db229b40b12a2460997`
- Phase 1 commit: `1601f55b3ce894632ea073d112067416afff960f`
- Remotion: `4.0.492`

## Previous failure preservation

`full-length-attempt-1/` preserves the failure JSON, the observed stdout/stderr sequence, and the empty nearby crash-report search. The first failure was frame 5670 (`S022`, range 5627–5923), `Chromium Target closed`; the later timeout was frame 6259 (`S024`, range 6140–6395) after Remotion recovery. No candidate MP4 was created.

## Diagnosis

All scene-local checks passed in fresh browser/process runs: 18/18 exact frames, S022 3/3, S024 3/3, S023–S025 3/3, 5500–5850 3/3, and 5500–6400 2/2. The before-fix 0–6400 prefix also passed once, so the original incident was not deterministically reproducible and is not proven to be an S024-local failure. The diagnostic run used Remotion's `renderMedia -> openBrowser/internalOpenBrowser` path, fresh browser ownership per render, Chrome for Testing `149.0.7790.0`, `headless-shell`, default GL options, and no supplied Puppeteer instance. No browser recovery, page/browser error, or crash report was observed in the matrix.

The only evidence-backed mitigation is accumulated concurrency/resource pressure: before-fix concurrency 4 reached approximately 1.56 GB Chromium aggregate RSS in the prefix; candidate concurrency 1 reached approximately 612–626 MB. Parallel encoding was false in both configurations. System memory pressure reported 56–57% free and free disk remained above 136 GB. The classification is therefore `CONCURRENCY_PRESSURE` as a preventive local-candidate mitigation, with the original one-off process incident remaining `TRANSIENT_EXTERNAL_PROCESS_FAILURE / UNKNOWN` rather than being misattributed to S024.

## Candidate matrix

The candidate `concurrency=1` matrix is recorded in `matrix/candidate-concurrency-1/summary.json`:

| Gate | Result | Target closed | Timeout | Recovery |
|---|---:|---:|---:|---:|
| Exact frames 5669/5670/5671/6258/6259/6260 | 18/18 | 0 | 0 | 0 |
| First-failure scene S022 | 3/3 | 0 | 0 | 0 |
| S024 | 3/3 | 0 | 0 | 0 |
| S023–S025 | 3/3 | 0 | 0 | 0 |
| First-failure window 5500–5850 | 3/3 | 0 | 0 | 0 |
| Combined window 5500–6400 | 2/2 | 0 | 0 | 0 |
| Prefix 0–6400 | 2/2 | 0 | 0 | 0 |

The required nine representative groups were rerun after fixing the local candidate default to concurrency 1: `9/9 PASS`, with no observed P0/P1, subtitle, or color-range regression. The production default remains Existing Worker / NAS.

## Scope

Changed only `LocalRemotionExecutor` and the targeted stability test. The local default concurrency changed from 4 to 1; timeout, browser, GL, parallel encoding, scene code, props, audio, Worker, TTS, DB, queue, Remotion version, and frozen baseline were unchanged. Diagnostics are optional and append bounded JSONL; they do not alter rendered pixels.

Full-length Attempt 2 is intentionally not recorded in this file until the fix commit is pushed and a clean worktree is prepared.
