# Extreme Long Video — Visual Composition V2.2 Final Report

```text
VERDICT:
PASS — dynamic-preview gate only; this is not formal full-film visual acceptance.

ACTUAL_MP4_BASELINE:
render_job: 7f2cfa6a-ad81-4ee5-9746-160dd4ae977c
sha256: 61bcf37d5c5605d1270bb8848046505a36e57aceea13124c1bf7458285b5d8a5 (formal manifest)
local_same_name_sha256: 26f2647928d06b8c12ce2736d14f8c7c6fd67f82083e52df33ba40c6b30c7f19 (not the formal immutable file; excluded)
P1: repeated rendered composition primitives caused long-form fatigue
scope: renderer primitives plus six sequence visual worlds; frozen research/script/audio/subtitles/bindings/schema/Remotion version unchanged

PRIMITIVE_AUDIT:
top_left_empty: 16
two_cards: 16
three_node: 6
input_condition_report: 5
version_cards: 7
chapter_diamond: 16
archive_small_frame: 4

FAMILY_REDESIGN:

VERSION_DIFF:
layouts_before: overlapping versions / two horizontal cards
layouts_after: document redline / split memory / version timeline / layer accumulation / branching versions

KINETIC_CLAIM:
layouts_before: top-left headline plus empty field; diamond-led claim
layouts_after: contradiction / correction / object-led / editorial statement / question field

CONCEPT_SPACE:
layouts_before: repeated three-node arc
layouts_after: nested layers / continuum / threshold / source cluster / inside-outside / overlap / competition / distance scale

PROCESS_MAP:
layouts_before: input-condition-report boxes
layouts_after: literal flow / branch / feedback / gate / contamination / before-after / parallel / accumulation / failure point

COMPARISON:
layouts_before: two cards or one horizontal divider
layouts_after: split screen / overlay / before-after / evidence table / two axes / paired documents / image-vs-report / claim-vs-boundary / conditions

SEQUENCE_WORLDS:

A_OPENING: opening-disagreement, S001-S012, 00:00-01:33
B_BARTLETT_LOFTUS: bartlett-to-loftus, S013-S025, 01:33-03:35
C_DRM: drm-mechanisms, S035-S056, 05:07-08:17
D_CONFIDENCE: confidence-eyewitness, S058-S066, 08:24-09:46
E_FLASHBULB: flashbulb-longitudinal, S067-S077, 09:46-11:19
F_AUTOBIOGRAPHICAL: suggested-autobiographical, S089-S101, 13:02-15:15

ARCHIVE:
binding_changed: 0
assets_changed: 0
large_format_scenes: 7/7
status: PASS; archive-led surface about 51%, contextual surface about 44% of 1920x1080 before crop

DYNAMIC_PREVIEWS:
A: A-opening.mp4, 93.056s, 1280x720, H.264 + AAC 48kHz stereo, sha256 5e987a944f9a8ac837c308e6cc5ed34ddc9ec0e6872896afc693287fd4cfc76a
B: B-bartlett-loftus.mp4, 122.048s, 1280x720, H.264 + AAC 48kHz stereo, sha256 78eddcd20a3db3638bb99bbca605a2790717407f1eba3b08d8e6727bac819868
C: C-drm-mechanisms.mp4, 190.059s, 1280x720, H.264 + AAC 48kHz stereo, sha256 a525ceacc4d58342a6605ffe021649cad878f9235ddd82e2243e3672792db94f
D: D-confidence-flashbulb.mp4, 188.053s, 1280x720, H.264 + AAC 48kHz stereo, sha256 fa4517d49794e1357176c1af27d9a1e8553408fc956855b1766a26a2350ac7fd
E: E-autobiographical.mp4, 133.056s, 1280x720, H.264 + AAC 48kHz stereo, sha256 1194e49701575be0d0d322a65ffce4c8c83914e33cbb1435bfa7ad9d4c2b5bda
F: F-conclusion.mp4, 98.048s, 1280x720, H.264 + AAC 48kHz stereo, sha256 f575c977b5426251a48744056259d83d41717ee76743f697ff94b7f15e8e7b63

INDEPENDENT_REVIEW:
reviewer: independent gpt-5.6-luna/high subagent; normal-speed full-frame decode plus timestamped pixel sampling
P0: 0
P1: 0
P2: 2
pixel_repetition: PASS
sequence_continuity: PASS
content_footprint: PARTIAL
archive_scale: PASS
experiment_identity: PASS
long_form_fatigue: PARTIAL
verdict: READY_FOR_ATTEMPT2_PREVIEW_GENERATION = YES
limitations: reviewer verified audio stream continuity only; no subjective listening claim. P2 items are some small subjects/large dark fields and isolated 10-12s static information boards.

TESTS:
visual grammar: PASS, 111 scenes, 6 sequence worlds, 0 visible production scene IDs
composition audit: PASS against explicit b602510 V2.1 git baseline
exact source chain: PASS, 91/91
archive binding: PASS, 11/11
renderer route: PASS, 28/28
typecheck: PASS
production build: PASS, Next.js 15.5.21
preview decode/probe: PASS, six files, 1280x720/30fps with AAC 48kHz stereo
scoped git diff check: PASS
repository-wide git diff check: BLOCKED by pre-existing unrelated Remotion skill whitespace changes
historical M3-E harness: FAIL before renderer at mock audio finalize (`audio finalize 失败`, test-m3e-final-render.ts:140); renderer-route and six real preview renders pass

FORMAL_RENDER_JOBS_CREATED:
0

FULL_RENDER_CAPACITY_REMAINING:
1

READY_FOR_FULL_RENDER_ATTEMPT_2:
YES

NEXT_STEP:
USER_AUTHORIZE_FULL_RENDER_ATTEMPT_2
```

No render job was enqueued, no deployment was performed, and the remaining full-render attempt was not spent.
