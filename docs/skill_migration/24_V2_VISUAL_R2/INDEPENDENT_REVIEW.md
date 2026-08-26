# V2 Visual R2 — independent review record

## Verdict boundary

`HISTORICAL_FALSE_POSITIVE` applies to the prior V2 review associated with
`fresh-v2-final.mp4`. The prior MP4, contact sheet, and report are preserved and
were not edited or overwritten.

The review below covers local preview/QC renders only. It establishes the visual
pre-render gate; it is not the final review of a production Worker-rendered MP4.

Reviewer: independent GPT-5.6 Luna agent (Pauli). The reviewer made no file changes.

## Review rounds

| Round | Evidence | Findings | Result |
|---|---|---|---|
| 1 | A/B/C rendered clips, key frames, choreography, cue map | persistent handoff absent; S012/B020 activation bars did not visibly cross; S021/B037 claimed rewire without showing it | P0 0, P1 3, FAIL |
| 2 | corrected A/B/C clips and regenerated evidence | all three P1 findings closed | P0 0, P1 0, PASS |
| 3 | D/E/F rendered clips and complete supporting strips | S017 showed unsupported exact percentages; S018 showed invented support percentages; pale-grid repetition noted as non-blocking | P0 0, P1 2, P2 1, FAIL |
| 4 | rerendered B/E clips plus refreshed full-timeline evidence | B020 uses only qualitative race states; S017 is explicitly marked as illustrative relative activation; S018 uses qualitative evidence states; no unsupported percentages remain | P0 0, P1 0, P2 1, PASS |

The remaining round-4 P2 was only a stale `-1` local frame in the generated B025
cue-map documentation. The evidence generator now clamps preview-local ranges to
the clip, the map was regenerated as `0–190`, and the underlying source frame is
still recorded separately. This change does not alter the visual render.

## Timestamped closure evidence

- `105.867–111.067s`, S012/B020: candidate labels are `竞争中 / 暂时领先 / 低激活`;
  the temporary leader changes and the target recovers; no numeric claim is shown.
- `157.800–163.567s`, S017/B030: title is
  `CANDIDATE RELATIVE ACTIVATION · 示意`; bars express relative change only.
- `163.567–172.900s`, S018/B031–B032: cards read
  `初始支持 / 结果波动 / 支持减弱 / 未稳定复现`; no fabricated support rates remain.

## Gate result

```text
TOP_HEAVY_LAYOUT = PASS
MAIN_FRAME_ADDS_INFORMATION = PASS
SEMANTIC_MOTION = PASS
PERSISTENT_HANDOFF = PASS
SUBTITLE_IS_NOT_PRIMARY_VISUAL = PASS
P0 = 0
P1 = 0
P2 = 0 after documentation correction
FULL_VISUAL_TIMELINE_PRE_RENDER_GATE = PASS
```

The final-production-video gate remains pending because no production artifact or
Worker render was created in this unauthorized deployment boundary.
