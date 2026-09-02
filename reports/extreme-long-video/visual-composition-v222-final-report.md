# Extreme Long Video — Visual Composition V2.2.2 Final Report

## Verdict

```text
VERDICT = PASS
P0 = 0
P1 = 0
P2 = 0
READY_FOR_FULL_RENDER_ATTEMPT_2 = YES
FORMAL_RENDER_JOBS_CREATED = 0
FULL_RENDER_CAPACITY_REMAINING = 1
```

This is a local-QC result. It does not create a production artifact, authorize publication, or consume the remaining formal render attempt.

## Root cause

V2.2.1 increased semantic-state density by placing late, oversized coral phrases over completed compositions. The opening phrases lacked a layout owner. The generic early DRM word-cloud route also contained `睡眠`, revealing the lure before the frozen narration/subtitle timeline introduced it.

The informed user review overrides the earlier aggregate V2.2.1 PASS. That report is marked superseded.

## Coral audit

```text
scenes_checked = 111/111
significant_accent_instances = 64
floating_overlay_before = 2
floating_overlay_after = 0
future_answer_leak_before = 1
future_answer_leak_after = 0
accent_without_layout_owner_after = 0
```

Detailed report: `reports/extreme-long-video/coral-overlay-audit-v222.md`.

Coral remains available for attached keywords, state labels, borders, underlines, selected results, and structural operators. The repair is not a global color removal.

## Targeted fixes

### S002

- Old: oversized `冲突词被定位 →` floated over the two version cards.
- New: each version card owns its conflict field; a 28px lower callout occupies a reserved region and short lines attach it to both cards.
- Card/title/callout overlap: `0`.

### S003

- Old: oversized central `双方都很确信` competed with the headline and cards.
- New: equal `确信` indicators live inside version A and version B; `谁记错了？` remains the sole primary headline.
- Card/title overlap: `0`.

### S035–S037

- Old: the generic DRM phase-0/phase-1 word cloud contained a large coral `睡眠`, including before S036 began.
- New: S035 is a no-answer boundary page; S036/S037 contain only `床、休息、清醒、疲倦、梦、被子、打盹` plus the reserved question region.
- Frames checked without a sleep token: S035 `165`, S036 `187`, S037 `165`.

### S038 reveal chronology

The frozen subtitle artifact is the timing authority. Because the scene boundary and cue boundary do not coincide, the reveal occurs in S038 rather than being forced into S037:

```text
317.438–325.925  seven-word list cue
325.925–329.088  question cue containing “睡眠”
329.088          neutral “睡眠？” may appear
329.088–331.347  explanatory clause
331.347          coral result + “原词表未出现” may appear
```

This conservative timing guarantees the visual token does not precede the spoken-question cue.

## Structural accents

- S041 `记忆 ≠ 判断`: preserved and independently reviewed.
- S066 `记忆 ≠ 判断`: preserved and independently reviewed.
- DRM `共同意义 ≠ 是否出现`: retained as an owned two-panel relationship.

`STRUCTURAL_ACCENT_PRESERVED = PASS`.

## Targeted reel

| File | Duration | Media | Decode |
| --- | ---: | --- | --- |
| `outputs/extreme-long-video/visual-composition-v222/coral-overlay-reel-clean.mp4` | 67.2s | H.264 1280×720 30fps + AAC 48kHz stereo | PASS |
| `outputs/extreme-long-video/visual-composition-v222/coral-overlay-reel-burned.mp4` | 67.2s | H.264 1280×720 30fps + AAC 48kHz stereo | PASS |

Independent GPT-5.6 Luna review, clean primary plus burned timing check:

```text
P0 = 0
P1 = 0
P2 = 0
FLOATING_LARGE_CORAL_OVERLAY = PASS
DRM_FUTURE_ANSWER_LEAK = PASS
DRM_DEMONSTRATION_INTEGRITY = PASS
STRUCTURAL_ACCENT_PRESERVED = PASS
REEL = PASS
```

The reviewer did not subjectively listen to the audio; the reveal-order judgment uses the frozen burned-subtitle timing and visible frames. Audio streams were separately decoded and compared.

## Full local preview

| File | Duration | Video | Audio | Decode | SHA-256 |
| --- | ---: | --- | --- | --- | --- |
| `outputs/extreme-long-video/visual-composition-v222/full-local-preview-720p-v222.mp4` | 1013.354667s | H.264 1280×720 30fps | AAC 48kHz stereo | PASS | `aba8b806f994d6e2dbfe6a68f4ab3aca19db48c10b84aa8168df74903b01a1a6` |
| `outputs/extreme-long-video/visual-composition-v222/full-local-preview-720p-v222-burned.mp4` | 1013.354667s | H.264 1280×720 30fps | AAC 48kHz stereo | PASS | `a561fba383ea5140613f1c8886c5724178937b6cb0b919e92a0eb450e7fd7b18` |

- Clean/burned AAC stream MD5: `28aaff4c909c61cb11cebba5a27838dd` for both.
- Clean and burned subtitle-check frames are distinct.
- Direct 1fps extraction from full clean 05:10–05:34 confirms no early `睡眠`; neutral question and final absent-from-list state appear in order.

## Frozen chain

- Narration master SHA-256: `658235d97a94f67feb9bc50d0849e7b15c2edf85f95b8db229b40b12a2460997`.
- Subtitle Timing V2 SHA-256: `dfab1dab6b1ef7707b9d6173b44455428ec6e59b74c81c528a6ed8a3ea29237b`.
- Script, narration, audio, TTS, subtitle timing, scene boundaries, 111 visual theses, archive bindings/assets, theme, sequence manifests, DB schema, and Remotion `4.0.492` remain frozen.

## Regression

```text
coral overlay regression: PASS
DRM reveal chronology: PASS
opening progression: PASS
visual grammar: PASS (111 scenes, 0 visible production IDs)
semantic state density: PASS (111/111, measured >7s = 0)
archive semantic audit: PASS (19 requirements, 7 retained assets)
exact source chain: PASS (91/91)
typecheck: PASS (fresh, serial after build)
production build: PASS (Next.js 15.5.21)
scoped git diff check: PASS
formal render enqueue calls: 0
```

The unrelated legacy M3-E fixture was not modified or used as a gate.

## Next step

```text
NEXT_STEP = USER_AUTHORIZE_FULL_RENDER_ATTEMPT_2
```

Stop here. Do not create the final formal render job without explicit user authorization.
