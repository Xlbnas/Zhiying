# Editorial Polish V2 — Audio Probe Review

## Verdict

`PROSODY_PROBE = PASS`

The four probes are technically valid, provenance-valid, and first-attempt successful. The user approved N001, N005, and N025 directly, then partially rejected N012 for an unnatural pause. A punctuation-only N012 correction removed two disruptive commas and was approved on the second listening pass.

`DELIVERY_EFFECTIVE = NO` for the current provider path: the typed delivery value reaches `tts-payload@1.1`, but the IndexTTS2 adapter sends only `text` and `speaker_id` upstream. Duration differences are not evidence that `soft`, `slow`, or `firm` metadata was applied.

## Frozen identity

- Project: `3778ffb0-c430-4499-9f7f-2590f45cb8cb`
- Voice: `xlbnas@1`
- Reference SHA-256: `42a32a1fc12b12752e1f2f6050108f458cd47c240208c353a7dd9a7d4fd7a999`
- Provider: `indextts2` / `IndexTTS-2`
- Random fallback: disabled

## Probe facts

| Unit | Intent | Job | Attempt | V1 duration | Probe duration | Delta | Result |
|---|---|---|---:|---:|---:|---:|---|
| N001 | soft hook | `c2a9bc10-69d7-49a6-bad4-d61fdd3848de` | 1 | 5.050s | 5.224s | +0.174s | succeeded |
| N005 | slow history | `729f7229-6160-43e8-b7fd-55db02bb0411` | 1 | 12.318s | 13.235s | +0.917s | succeeded |
| N012 | firm mechanism | `271d8ea4-6b39-432a-9cc9-4e915f26e1ce` | 1 | 9.764s | 10.553s | +0.789s | succeeded |
| N025 | soft conclusion | `91523913-8c36-4787-a63c-1b1f9c8e94f9` | 1 | 9.694s | 10.739s | +1.045s | succeeded |

All four result payloads record `xlbnas@1`, the exact frozen reference SHA, PCM s16le / 22050 Hz / mono, and no error or retry.

## Human listening decision

The accepted files are in:

`outputs/fresh-3778ffb0-c430-4499-9f7f-2590f45cb8cb/editorial-polish-v2/prosody-probes/`

User decision:

- N001 soft: PASS
- N005 slow: PASS
- N012 firm corrected (`064f4b93-3db1-483a-9b4e-3ba9bba955be`): PASS
- N025 soft: PASS

## Downstream blocker

`MISSING_AGENT_NATIVE_ENTRYPOINT`: the repository has a `narration-audio@2.0` schema and pure subtitle-v2 compiler, but no production finalizer/CLI path that can persist an exact master from 24 fingerprint-reused jobs plus one rebuilt job. The M6 finalizer only searches for 25 succeeded jobs attached to one M6 narration plan. No old run-stage fallback or synthetic job rows are permitted.
