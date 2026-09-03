# Narration Audio V1 QC

- Project: `75c6255a-4826-49eb-98d4-bd092df03657`
- Input narration: `3e02dda8-5805-4857-8ec2-1f0fa4b896e9@2`
- Input plaintext SHA-256: `bc85e2ce7da55150e3c6c327c37f9663d36b4afbe9f8474c67247aca5721917f`
- Narration plan: `e39bed7d-f3d9-423a-ade9-2f237df8b758@1`
- Production audio artifact: `e1080081-5c12-4f8a-83b7-d99c6048215b@1`
- Provider / voice: `indextts2` / `xlbnas@1`
- Master: `projects/75c6255a-4826-49eb-98d4-bd092df03657/audio/narration-master-v1-indextts2-xlbnas@1.wav`
- Master SHA-256: `376bb291e4fab2965839c47a354b992fc63af7240eebae328ab2a887ad8bb498`

## Execution

- 60/60 speech units succeeded.
- All units succeeded on attempt 1; targeted retries: 0.
- No provider or voice switch occurred.
- Reconstructed speech-unit text matches the locked plaintext after structural whitespace normalization.
- Segment files: 60 present, 60 SHA matches, 60 full decodes passed.

## Master media facts

- WAV, PCM signed 16-bit little-endian, 48 kHz, mono.
- Size: 60,192,450 bytes.
- Duration: 627.004229 seconds (`00:10:27.004`).
- Locked Han characters: 2,546.
- Actual rate: 243.635 Han characters/minute.
- Historical estimate at 266.87 Han characters/minute: 572.414 seconds (`00:09:32.414`).
- Variance from historical estimate: +54.591 seconds.
- Duration classification: `TARGET_PASS`.
- Full master decode: 0 errors.

## Signal QC

- Integrated loudness: -13.8 LUFS.
- Loudness range: 2.9 LU.
- True peak: +0.7 dBFS.
- Sample peak: full scale (min -32768, max 32767).
- Full-scale samples: 1,302 (70 positive, 1,232 negative), in 847 runs; longest run 5 samples.
- Units reaching full scale before final assembly: N003, N004, N015, N018, N023, N029, N031, N036, N042, N044, N045, N058, N059.
- Clipping gate: **FAIL** (`CLIPPING = 0` was required).

## Silence / joins

Measured with `silencedetect`, -50 dB threshold and 30 ms minimum duration.

- Leading silence: 0.073379 seconds.
- Trailing silence: 0 seconds at the -50 dB / 30 ms threshold.
- 59 inter-segment joins: median 0.068889 seconds, minimum 0, maximum 0.239000 seconds.
- IQR outliers: 4; joins under 20 ms: 11.
- The final unit has 0.102721 seconds of leading silence and no detected trailing silence; its final 250 ms remains low-level but non-silent.

## Verdict

`BLOCKED_AUDIO_QC`. The generated artifact and all successful segments are preserved, but the artifact is not promoted to a locked narration master. Full perceptual listening acceptance is not claimed after the clipping gate failed. The current deterministic production path has no supported successful-job targeted-regeneration operation, so no automatic retry, provider change, speed change, limiter, time stretch, or finalize redesign was performed.

No subtitles, scene design, visual assets, reconciliation, or render job were created.
