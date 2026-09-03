# Narration Clipping Repair V1

- Project: `75c6255a-4826-49eb-98d4-bd092df03657`
- Baseline / channel: `INITIAL_PRODUCTION_BASELINE_V1` / `production`
- Locked narration: `3e02dda8-5805-4857-8ec2-1f0fa4b896e9@2`
- Locked plaintext SHA-256: `bc85e2ce7da55150e3c6c327c37f9663d36b4afbe9f8474c67247aca5721917f`
- Narration plan: `e39bed7d-f3d9-423a-ade9-2f237df8b758@1`
- Original audio: `e1080081-5c12-4f8a-83b7-d99c6048215b@1`
- Provider / voice: `indextts2` / `xlbnas@1`
- Repair implementation / deployed SHA: `71b41201a1dba5ae97f5c341a3a4963f69f9eecd`

## Localization and root cause

The original 60 source WAV files, the exact per-segment 48 kHz conversion, and the registered master were scanned independently.

- Source WAVs: 47 full-scale samples in 41 saturation runs; 13 affected units.
- Exact 48 kHz conversions: 1,302 full-scale samples in 847 saturation runs; 50 affected units.
- Registered master: 1,302 full-scale samples in 847 saturation runs, byte-identical to the ordered exact conversions.
- Original master true peak: +0.7 dBTP.
- Classification: `MIXED_CLIPPING`, dominated by `RESAMPLE_OR_QUANTIZATION_HEADROOM`, with stochastic provider-side source saturation.

One authorized diagnostic regeneration of N042 produced a different WAV with zero source full-scale samples, confirming that provider source saturation is stochastic. Its 48 kHz conversion still clipped from inter-sample overshoot, independently confirming the finalize-headroom component.

Measured pre-resample headroom sweep on the original 60 units:

| Headroom | Full-scale samples | True peak | Integrated loudness |
| --- | ---: | ---: | ---: |
| -1.1 dB | 0 | +0.2 dBTP | -14.9 LUFS |
| -1.2 dB | 0 | +0.1 dBTP | -15.0 LUFS |
| -1.3 dB | 0 | 0.0 dBTP | -15.1 LUFS |
| -1.4 dB | 0 | -0.1 dBTP | -15.2 LUFS |
| -1.5 dB | 0 | -0.2 dBTP | -15.3 LUFS |

The repair path therefore uses the smallest measured safe margin with clearance, `-1.4 dB`, before resampling. It does not use a limiter, post-clipping attenuation, time stretch, pitch shift, denoise, or mastering redesign. The ordinary finalize path is unchanged.

## Targeted replacement execution

- Affected original units: N003, N004, N015, N018, N023, N029, N031, N036, N042, N044, N045, N058, N059.
- Candidate 1 requests: 13.
- Candidate 2 requests: 6, only for N003, N018, N029, N031, N036, and N045 after candidate 1 still reached full scale.
- Total production requests: 19.
- TTS execution failures: 0; every request succeeded on attempt 1.
- Provider switches: 0. Voice switches: 0. Whole-project retries: 0.
- Clean candidate obtained: 10/13 affected units.
- Two-candidate clipping blockers: N031, N036, N045.

| Unit | Candidate 1 full-scale / runs | Candidate 2 full-scale / runs | Result |
| --- | ---: | ---: | --- |
| N003 | 1 / 1 | 0 / 0 | clean candidate 2 |
| N004 | 0 / 0 | — | clean candidate 1 |
| N015 | 0 / 0 | — | clean candidate 1 |
| N018 | 4 / 3 | 0 / 0 | clean candidate 2 |
| N023 | 0 / 0 | — | clean candidate 1 |
| N029 | 2 / 2 | 0 / 0 | clean candidate 2 |
| N031 | 1 / 1 | 4 / 4 | blocker |
| N036 | 4 / 4 | 8 / 3 | blocker |
| N042 | 0 / 0 | — | clean candidate 1 |
| N044 | 0 / 0 | — | clean candidate 1 |
| N045 | 15 / 4 | 2 / 2 | blocker |
| N058 | 0 / 0 | — | clean candidate 1 |
| N059 | 0 / 0 | — | clean candidate 1 |

## Preservation and gates

- Original artifact count remains one: only `e1080081-5c12-4f8a-83b7-d99c6048215b@1` exists.
- Original master registered and physical SHA-256 remain `376bb291e4fab2965839c47a354b992fc63af7240eebae328ab2a887ad8bb498`.
- Original master size remains 60,192,450 bytes.
- No repaired master or narration audio revision 2 was created.
- No original TTS job or WAV was overwritten.
- No third candidate was requested.
- No subtitle, scene design, visual source, reconciliation, or render job was created.

## Verdict

`PROVIDER_SEGMENT_CLIPPING_BLOCKER`.

The append-only repair implementation and regression gates passed, but production audio cannot be promoted or locked because N031, N036, and N045 exhausted the two-candidate limit without a source-clean result. The ten clean replacement candidates remain preserved for a later explicitly authorized continuation.
