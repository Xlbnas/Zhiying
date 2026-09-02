# Extreme Long Video End-to-End Run

## Verdict

**PARTIAL**

The run produced and independently reviewed the research, evidence ledger, strict Script V2, exact narration plan, 111-scene visual design, exact `xlbnas@1` narration master, Subtitle Timing V2 and sidecars, 19 rights-usable physical archive files, a new local Remotion visual profile, and ten representative video prototypes. The local code gates pass.

It does **not** qualify for `PASS` or `PASS_WITH_MINOR_NOTES`: no Visual Source V2 production artifact, full render, decoded final video inspection, or user visual acceptance exists. The new renderer is not deployed to the production worker, and 13 of 19 archive scene requirements remain without semantically exact production bindings.

No full-length render was started. Full-render count: **0 / maximum 2**.

## Goal and scope

- Topic: 《你记得的，真的发生过吗？——从虚假记忆、目击证词到大脑如何重写过去》
- Intended duration: 16–18 minutes; 15–20 minutes acceptable.
- Route: strict Script V2 → exact `xlbnas@1` TTS → Subtitle Timing V2 → `memory-lab-editorial@1` → exact reconciliation → clean master and burned review.
- Explicitly excluded: H3, old `run-stage`, DeepSeek stage execution, workflow UI, manual database patching, fabricated succeeded jobs, `latest/current` inference, dependency upgrades, and architecture redesign.

The implementation reused the existing Script V2, Narration Plan V2, TTS job, Subtitle Timing V2, Visual Source V2, reconciliation, asset-binding, Remotion, and final-render contracts. It added no database table, worker, queue, scheduler, migration, or new service.

## Research and editorial result

### Evidence ledger

- File: `docs/long_video/evidence-ledger.md`
- 25 evidence entries, with explicit roles: source claim, modern evidence, theory, interpretation, and limitation.
- Coverage includes Bartlett and the source history of *The War of the Ghosts*, Loftus and Palmer, misinformation/source monitoring, DRM, gist/detail accounts, reconsolidation limits, confidence-feedback contamination, flashbulb memory, eyewitness safeguards, autobiographical false-memory methods, and external verification.
- The ledger separates direct findings from interpretation and preserves contradictory or limiting evidence.
- The Chinese DRM list is labeled as an adapted, non-normed demonstration rather than a Chinese replication.

### Script and scene design

- Strict script: `docs/long_video/script-v2.md`
- 113 total units, 111 speech units, 4,507 spoken Chinese characters, `needsReview=0` in Narration Plan V2.
- Ten chapters and 111 deterministic speech-aligned scenes.
- Design estimate: 1,011.8 seconds (16:51.8). The physical TTS master is 1,013.299 seconds (16:53.299), a 1.499-second difference and inside the 15–20 minute acceptance range.
- Independent script review found three P1 wording/logic issues. They were corrected before TTS enqueue:
  - the DRM demonstration is explicitly non-standardized;
  - imagination inflation is not described as requiring repeated imagination in this cited experiment;
  - flashbulb consistency is not equated with objective event accuracy.

## Visual direction and prototypes

### New visual profile

- Profile: `memory-lab-editorial@1`
- Direction: warm paper archive + restrained cognitive laboratory; no dashboard, file-manager, cyber-brain HUD, or R3-D recolor.
- Ten data-driven visual families cover fragment assembly, source documents, provenance, controlled experiments, semantic activation, trace comparison, source attribution, longitudinal records, procedural safeguards, and memory/belief classification.
- Each scene maps to one exact speech unit. Earlier state remains visible when later beats arrive.

Local implementation:

- `src/remotion/templates/production/MemoryLabEditorialScene.tsx`
- `src/remotion/compositions/ProductionSceneRenderer.tsx`
- `src/remotion/compositions/FullCutV1.tsx`
- `src/lib/visual-source-v2.ts`

### Prototype review

Ten approximately six-second MP4 prototypes are in `outputs/extreme-long-video/prototypes/`:

1. opening fragment assembly;
2. Bartlett source chain using the physical *Kathlamet Texts* source;
3. Loftus wording manipulation;
4. adapted DRM demonstration;
5. candidate mechanism comparison;
6. first choice → immediate confidence T0 → confirming feedback → later confidence;
7. flashbulb T0 versus later reports, with confidence separate from consistency;
8. first eyewitness report → suggestive question → repeated interview → new information;
9. parallel memory/belief categories, explicitly not an automatic upgrade path;
10. current memory → photograph/text/timestamp/independent witness → checked conclusion.

The first independent visual review identified P1 semantic gaps in prototypes 02, 06, 07, 08, 09, and 10. After correction, a second review extracted frames from all ten MP4s at 2 fps, checked 480×270 mobile views, and found no P0/P1 blocker. The retained evidence package contains 120 frames under `outputs/extreme-long-video/prototypes/review2-mobile/`; the itemized verdict is in `docs/long_video/prototype-visual-review.md`. Remaining P2 notes are small archive attribution/support labels in 02, 05, and 07. Prototype visual gate: **PASS**.

These prototypes are intentionally silent design previews and do not count as narration or full-film acceptance.

## Archive assets

- Provenance: `outputs/extreme-long-video/assets/archive/provenance.json`
- 20 physical candidate files acquired.
- 19 are usable under item-level metadata: public domain, CC0, no-known-restrictions, or CC BY-SA with attribution.
- The Frederic Bartlett portrait is excluded from production because the Commons record contains a third-party copyright-claim warning.
- A separate witness-stand candidate with conflicting embedded copyright metadata was moved to `outputs/extreme-long-video/assets/rejected/`.
- The 272-page physical *Kathlamet Texts* PDF is retained as a source file; the prototype uses its cover. No unverified inner page is represented as the exact story page.

Production binding remains blocked. The current preview binds 6 of 19 archive scenes; 13 have no semantically exact asset. An earlier preview incorrectly mapped the S090 shopping-mall requirement to the Doty family portrait; independent review caught the error, the mapping was removed from the generator, and all ten prototypes were regenerated. Generic courtroom/notebook imagery is not substituted for NASEM or DOJ records, and S090 now remains honestly unbound.

## Production run state

### Project and locked inputs

- Project ID: `8f955b4c-42dd-4a02-8e76-e721a37fab41`
- Scenes artifact: `94b1697c-a9c5-4bb1-ab20-9b8a5a933b34@1`
- Narration Beat Map: `6a2a000f-a91e-4189-b5c1-ae9fc4161cd8@1`
- Shot List: `4e646771-1986-41e3-b39a-692c3aa064a2@1`
- Narration Plan V2: `43da40d7-ba4f-4016-8bf7-8de37b2c4c5c@1`
- Plan status: 113 units, 111 speech units, `needsReview=0`.

All project stages were created and locked through repository domain functions. No direct SQLite mutation or fake job status was used.

### Exact TTS

- Requested voice: `xlbnas@1`
- Provider: `indextts2`
- Model: `IndexTTS-2`
- Reference audio SHA-256: `42a32a1fc12b12752e1f2f6050108f458cd47c240208c353a7dd9a7d4fd7a999`
- Enqueue result: 111 new jobs, 0 reused, 0 already active; all decisions were `NO_LEGACY_MATCH`.
- Read-only production snapshot at `2026-08-31T19:07:32+08:00`: 44 succeeded, 1 running, 66 queued, 0 failed/cancelled. The snapshot, project/plan identities, one-job-set identity, full worker SHA, and image ID are retained at `outputs/extreme-long-video/production-evidence/2026-08-31T19-07-32+08-00.md`.
- Terminal TTS status: 111 succeeded, 0 failed/cancelled.
- Finalize result: 111 exact sources reused by fingerprint, 0 rebuilt, 0 enqueued, 0 active.
- Narration Audio V2: `ae26c0bd-0d99-4557-9f39-44781b0d8bba@1`.
- Physical master: `outputs/extreme-long-video/audio/narration-master.wav`, 1,013,299 ms, PCM S16LE, 48 kHz mono, 97,276,784 bytes.
- Master SHA-256: `658235d97a94f67feb9bc50d0849e7b15c2edf85f95b8db229b40b12a2460997` (artifact and copied file match).

### Subtitle Timing V2

- Artifact: `277908e8-ad94-402d-8b8e-b1c3496bf4af@1`.
- 213 cues, all derived from the exact audio and plan identities.
- No overlap, no non-positive cue, maximum inter-cue gap 900 ms, and 1,203 ms planned trailing silence.
- Exported local sidecars: SRT, VTT, ASS, and `subtitle_timing_v2.json` under `outputs/extreme-long-video/subtitles/`.
- Terminal production snapshot and media facts: `outputs/extreme-long-video/production-evidence/2026-08-31T20-00-22+08-00-terminal.md`.

## Verification evidence

Fresh local verification after the last implementation change:

- `npx tsx scripts/test-m71-audio-subtitle-v2.ts` → **91 PASS, 0 FAIL**.
- `pnpm typecheck` → exit 0.
- `pnpm build` → exit 0; Next.js production build completed.
- Scoped `git diff --check` on the tracked long-video implementation files → exit 0. Untracked long-video documents are not covered by ordinary `git diff --check`; the repository-wide check is not claimed because unrelated pre-existing Remotion-skill changes contain whitespace findings.
- Independent prototype review → no P0/P1 blocker after the second pass.
- `ffprobe` on the copied narration master → 1,013.299375 seconds, PCM S16LE, 48 kHz mono, 97,276,784 bytes.
- Local master SHA-256 equals the Narration Audio V2 manifest SHA-256.
- Subtitle structural QA → 213 cues, 0 overlaps, 0 non-positive durations, 1,203 ms trailing silence.
- Production terminal snapshot → 111 succeeded TTS jobs, exact audio and subtitle artifacts present, 0 render jobs.

These checks prove the exact source/compiler route, physical audio identity, subtitle structural timing, and prototype behavior. They do not prove subjective narration quality, deployed visual behavior, production asset binding, or final-video quality.

Audio QA note: integrated loudness is approximately `-14.0 LUFS`; measured true peak is `+0.3 dBFS`. The PCM contains 1,302 full-scale samples, with a longest consecutive run of approximately 0.10 ms. This is retained as a P2 release-QA note; the exact master was not silently normalized or replaced.

## Blocking conditions

1. **The new renderer is local only.** The required `agentvm` development path could not authenticate from this machine. The production worker runs `zhiying:14586bddb9bbaba735eb752a3126b10a8028a2b7` (image ID `sha256:7841324f66aaa4e4998b0d5639faf2e6543bd0d2d2534970191946595508423e`), which does not contain `memory-lab-editorial@1`. Production code was not patched directly and no uncommitted local code was mislabeled as deployed.
2. **Archive binding is incomplete.** Only 6 of 19 archive scenes have semantically exact preview bindings. The missing official/bibliographic/mall assets cannot be replaced with nearby stock; the detected S090 wrong binding was removed.
3. **No full render exists.** Consequently there is no decoded final video, no burned review, no whole-film visual inspection, and no user visual acceptance.

## Stop decision

The honest end-to-end verdict is **PARTIAL**. Research, script, deterministic scene design, exact narration master, Subtitle Timing V2 sidecars, local renderer integration, archive acquisition, representative prototype generation, and independent prototype review are complete. The production video remains blocked at the deployed-renderer and exact-asset gates. The run does not consume either of the two allowed full renders.
