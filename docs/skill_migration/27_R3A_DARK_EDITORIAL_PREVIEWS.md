# R3-A Dark Editorial Preview Gate

Date: 2026-08-27 (Asia/Shanghai)

## Scope and frozen chain

This run produced only three representative local previews. It did not create a full production render or mutate the production artifact chain.

- Project: `3778ffb0-c430-4499-9f7f-2590f45cb8cb`
- Script V2: `046bb456-ec8c-431e-b117-186bb63953ab@3`
- Narration Plan V2: `76d3da1e-09dd-4af7-acc2-6116f3c3f4bb@2`
- Narration Audio V2: `ff7ef85f-bf59-4814-ba9a-6306e56e8cb6@1`
- Subtitle Timing V2: `68a8a73c-7863-4fa6-a89f-d9965f66c92f@1`
- Existing Visual Source V2: `b5d26586-dd86-4cf6-8922-38581f646b2b@3`
- Existing reconciliation: `59c717a9-07cc-44e4-8d1c-d24729b62c87@4`
- Master: `243560ms`, SHA-256 `801fadc172e7e5f20ff34337a44d889985fdec04f8609228897239f77c877c2a`

The production snapshot was read once over SSH. Worker state was healthy. No production write, job creation, retry, or restart was performed.

## Implementation boundary

- `dark-editorial-v1@1` is an explicit local-preview renderer marker.
- Existing `v2-visual-r2@2` behavior remains available.
- The new historical files are injected only into local preview props; they are not bound to the existing production visual artifact and are not production-ready.
- The global grid is disabled for the dark path. Backgrounds use warm `#1b1816`, cool `#11191e`, and neutral `#161719`; no pure-black main background is used.
- Existing semantic-motion choreography remains frozen: 44 beats, no automatic spine travel, ornamental path, unlabeled moving node, or S021 card reshuffle.

## Historical material

Six unique traceable sources are planned and present locally: the 1904 title page, Freud portrait, Signorelli self-portrait, a real Signorelli fresco, the 1922 association diagram, and the 1920 Hague Congress photograph. Primary archive-dominant scenes S005, S008, S009, and S010 total **45.50 seconds**. S006 and S007 additionally use the verified Freud portrait as supporting evidence.

Full source URLs, creator/date, rights basis, description, and intended use are recorded in `src/data/r3a-historical-assets.json` and the local deliverable `outputs/r3a-previews/historical-assets.md`.

## Subtitle deliverables and render profiles

The explicit CLI sidecar path consumes exact `narration_audio_v2` and `subtitle_timing_v2` identities. It emits deterministic UTF-8 SRT, VTT, ASS, and canonical JSON derivatives without modifying DB state. The production fixture test proves wrong id, wrong version, and cross-project identities fail closed.

Render profiles:

- `none`: clean master path, exact cues retained in props but no burned track rendered.
- `burned`: review proxy only.
- omitted: legacy callers retain their previous burned behavior.

The local R3-A sidecars contain all 44 exact cues. SRT/VTT text is character-identical; ASS carries every canonical millisecond pair in deterministic comments because the ASS dialogue format itself is centisecond-based. The final cue ends at `243557ms`, within the `243560ms` master.

## Local preview outputs

- History: `30.67–94.03s`, clean and burned, 63.424 seconds.
- Language: `0–14s` plus `94.03–119s`, clean and burned, 39.083 seconds after deterministic concatenation.
- Editorial: `154–225s`, clean and burned, 71.061 seconds.

Every MP4 contains H.264 video and AAC audio. The narration file used for all previews hashes exactly to the frozen master SHA-256.

## Verification

- `node scripts/test-r3a-previews.mjs`: 26 PASS.
- `npx tsx scripts/test-v2-visual-r2-choreography.ts`: PASS; 44 beats, 25 scenes, forbidden-motion counts zero.
- `npx tsx scripts/test-m71-audio-subtitle-v2.ts`: 68 PASS, 0 FAIL.
- `npx tsx scripts/test-m3c-subtitle-timing.ts`: 82 PASS, 0 FAIL.
- `npx tsx scripts/test-m71-subtitle.ts`: 15 PASS, 0 FAIL.
- `pnpm typecheck`: PASS.
- `pnpm build`: PASS.

The older `scripts/test-m3e-final-render.ts` stops in its pre-render audio-finalize fixture. The identical failure reproduces at baseline commit `5e05433`, before all R3-A changes. R3-A's focused V2 test independently proves `none`, `burned`, and omitted/legacy behavior.

## Independent preview review

GPT-5.6 Luna independently decoded and watched all three clean MP4s. Its first pass found two P1 issues: internal-state language in the language preview and meter/dashboard styling in S017. Both were fixed with screen-copy and layout-only changes; the reviewer then decoded the two updated MP4s again.

Final timestamp evidence:

- History `00:08`, `00:16`, `00:32`, `00:40–00:48`, `00:56`: verified title page, Freud portrait, Signorelli portrait/fresco, original association diagram, and Hague Congress image; archive content dominates and clean video has no burned subtitles.
- Language `00:00`, `00:08`, `00:28`, `00:32–00:38`: “还没说出口” and “同一次口误，可以有不止一种解释” replace internal-state language; the meter/threshold UI is now a plain editorial candidate explanation; the language-monitor action remains semantic.
- Editorial `00:04–00:08`, `00:09–00:13`, `00:20–00:28`, `00:52–00:56`, `01:04–01:10`: S017 is no longer a meter dashboard; S018, S022, and S023 remain visibly different editorial structures.

Final independent counts: **P0=0, P1=0, P2=1**. The single P2 is that the historical argument remains concentrated on the Freud–Signorelli case; it does not block the representative preview gate.

Final category results: `HISTORICAL_CONTENT=PASS`, `DARK_EDITORIAL_THEME=PASS`, `CHINESE_FIRST=PASS`, `HUMAN_EDITORIAL_LANGUAGE=PASS`, `CLEAN_MASTER_PATH=PASS`.

## Gate

`R3_PREVIEW=READY_FOR_USER_REVIEW`. These previews still require explicit user visual approval before any full R3 production render or production asset binding.
