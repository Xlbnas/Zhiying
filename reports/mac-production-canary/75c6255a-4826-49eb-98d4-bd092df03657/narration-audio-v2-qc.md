# Narration Audio V2 QC

- Project: `75c6255a-4826-49eb-98d4-bd092df03657`
- Input narration: `3e02dda8-5805-4857-8ec2-1f0fa4b896e9@2`
- Locked plaintext SHA-256: `bc85e2ce7da55150e3c6c327c37f9663d36b4afbe9f8474c67247aca5721917f`
- Narration plan: `e39bed7d-f3d9-423a-ade9-2f237df8b758@1`
- Superseded audio: `e1080081-5c12-4f8a-83b7-d99c6048215b@1`
- New append-only audio: `ea84e5fa-d06c-4449-a649-a5d21b507695@2`
- Provider / voice: `indextts2` / `xlbnas@1`
- Deployed code SHA: `925061e099d623b6dc6a37aeea06a8c77cab94ef`

## Scoped repair

- Only `N031`, `N036`, and `N045` were generated.
- Each parent was split into two children using its existing full stop. The six children reconstruct their three locked parent strings exactly.
- All six children succeeded on candidate 1 with `max_attempts=1`; targeted retry count was 0.
- Every child and all three parent composites have `full_scale_samples=0` and `saturation_runs=0`.
- Intra-parent join gaps measured at -50 dB / 30 ms were 67.528 ms, 67.982 ms, and 68.662 ms. These are near the previous production inter-unit median of 68.889 ms; no technical gap outlier was found.
- Final logical input set is exactly 47 clean originals + 10 existing clean replacements + 3 repaired parent replacements = 60 units.

## Finalize and media facts

- Repair-only finalize used -1.4 dB pre-resample headroom.
- No limiter, compressor, time stretch, pitch shift, or speed change was used.
- Master: `projects/75c6255a-4826-49eb-98d4-bd092df03657/audio/narration-master-v1-indextts2-xlbnas@1-audio-r2.wav`
- SHA-256: `3821ed838f9548b3d7a733cba13fbd6b896be765fe29e4cf4a722d805d7191e8`
- Format: WAV / `pcm_s16le` / signed 16-bit / 48 kHz / mono.
- Size: 60,270,216 bytes.
- Duration: 627.814292 seconds (`00:10:27.814`).
- Locked Han characters: 2,546; actual rate: 243.320 characters/minute.
- Historical estimate: 572.414 seconds; actual is 55.401 seconds longer.
- Duration classification: `TARGET_PASS`.
- Full decode errors: 0.
- Integrated loudness: -15.3 LUFS; loudness range: 3.0 LU; true peak: -0.1 dBFS.
- Master `full_scale_samples=0`, `saturation_runs=0`, clipping gate PASS.
- The superseded V1 master remains unchanged at SHA-256 `376bb291e4fab2965839c47a354b992fc63af7240eebae328ab2a887ad8bb498`.

## Content integrity

- The 60 manifest speech units remain in `N001`–`N060` order.
- Their joined text SHA-256 is `69a34454b7280192f9c6515e7f9873eaaf9a39c42be48aa229b756dd4f20db73`, matching the locked plaintext after structural newline removal.
- `N060` remains the final and complete sentence: `从现在开始，下一单位生命，准备分配到哪里？`
- No unit follows `N060`.

## Perceptual gate

Objective generation, decode, clipping, timing, text identity, and join-gap checks pass. Model-side human hearing is unavailable, so this report does not claim the required full perceptual listening review. The master and three repaired parents were copied to `outputs/canary-75c6255a/audio-r2-review/` for user listening.

Current verdict: `PARTIAL — TECHNICAL_PASS_LISTENING_PENDING`.

No subtitles, scene design, visual assets, reconciliation, or render jobs were created.
