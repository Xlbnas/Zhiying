# Full-length Attempt 2 manual review

## Verdict

`MAC_FULL_LENGTH_PARITY=PASS`

The single post-fix full-length local render completed all 30,399 frames and passed independent media probing and decode. The render crossed the prior failure region at frames 5670 (`S022`) and 6259 (`S024`) without `Target closed`, timeout, browser-crash, or recovery messages.

## Visual review

- Reviewed artifact: `local-clean-full.mp4`
- Reviewed evidence: `full-length-key-contact-sheet.jpg`
- Automated visual sample count: 431 (333 scene-based, 103 uniform, 48 dense-key)
- SSIM: min `0.973571`, median `0.990607`, P05 `0.9805245`, P95 `0.9973335`
- Below-0.95 outliers: 0; outlier sheet not generated
- Manual result: no P0/P1 visual issue observed; no placeholder, subtitle, abrupt red-overlay, or color-range regression observed

## Media and timeline checks

- Candidate SHA-256: `1261ba81b77e060228d296c64559d645172d006da92a98b02bbc8eaf362afdcc`
- Video: H.264, 1920×1080, 30/1 fps, 30,399 frames, `yuvj420p`, full-range `pc`
- Audio: AAC, 48,000Hz, 2 channels; no subtitle stream
- Scene boundaries: 111/111; start/end drift 0; dropped scenes 0; duplicated scenes 0
- Audio: constant `-42.667ms` offset at 0/25/50/75/100%, cumulative drift 0; tail difference is AAC frame padding
- Independent video and audio decode: exit 0, zero stderr bytes

## Scope guard

This was one local Mac render from the clean `ad153479e9b2c9fe368661833782d3a3fa73f89e` worktree. It did not invoke agentvm, NAS Worker, NAS TTS, network asset fetches, or a production render job. No Formal Render Attempt 3 was created.
