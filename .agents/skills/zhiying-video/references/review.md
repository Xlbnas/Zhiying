# Review and Failure Correction

Use this reference for content review, audiovisual acceptance, final technical review, or diagnosing a failed output.

## Content review

Confirm:

- important factual claims have traceable support and retain its scope;
- theory, interpretation, argument, and example are not presented as facts;
- logic connects evidence to the conclusion without hidden leaps;
- credible rebuttals and uncertainty boundaries remain visible;
- repeated arguments, unsupported precision, fabricated facts, and vague wording are absent;
- the opening, progression, and ending serve the intended audience and takeaway.

## Audio and subtitles

Review the whole narration for missing or duplicated passages, obvious truncation, wrong pronunciation, unnatural sentence breaks, unintended instruction leakage, and abrupt loudness changes. Confirm subtitles cover the spoken content, remain readable, and refer to the current audio source. An editorial mismatch is a reason to locate its source, not to hand-edit timing values.

Listen for restrained variation that follows rhetorical function rather than mechanical delivery rotation. Confirm the formal delivery is a clean master plus exact SRT/VTT/ASS/JSON sidecars; a burned review copy does not replace the canonical subtitle-timing artifact. User listening judgment outranks a metadata-only prosody pass.

## Visual review

Watch the result rather than accepting readiness metadata alone. Check:

- each asset fits the scene's subject and explanatory purpose;
- archive imagery is authentic where required and provenance is plausible;
- no placeholder, demo text, blank/black frame, incorrect image, or missing visual appears;
- composition, typography, emphasis, and subtitle placement remain legible;
- there is no obvious overlap, clipping, aspect-ratio distortion, or repetitive layout fatigue;
- motion graphics clarify relationships and hold long enough to read;
- static images are not held implausibly long and suspicious asset reuse is reviewed.
- factual and historical assets carry a traceable narrative or evidentiary role, and synthetic reconstructions are explicitly labeled;
- on-screen copy is audience-facing, Chinese-first when serving a general Chinese audience, and free of debug or prompt-like language;
- every prominent motion has a visible semantic cause and result rather than decorative travel;
- same-scene beat boundaries do not re-enter objects, retract completed paths, reset positions or cameras, or replay completed reveals;
- visual changes follow acoustic pauses, semantic completion, or object handoff instead of cutting mechanically at subtitle cues;
- the actual MP4 remains readable on a mobile-sized display without depending on burned subtitles to explain the main visual.

## Technical final review

Inspect the exact render job, not another successful job:

```bash
pnpm zhiying inspect --project <projectId> --job <jobId> --media
```

Require a succeeded exact job with a matching manifest, file path, size, SHA, usable probe data, and exact source references. Review duration, dimensions/aspect, video and audio codec, visual audit, loudness facts, and readiness output when present. A succeeded status without a valid exact result is not acceptance, and no older output may be substituted.

## Correct the earliest faulty source

Trace a failure backward to the earliest source that is actually wrong:

- unsupported narration → evidence or writing;
- wrong emphasis or sequence → script or scene design;
- unsuitable or false imagery → asset selection/binding or scene requirement;
- stale subtitles → exact current audio;
- timing mismatch → deterministic reconciliation using current sources;
- missing media or manifest mismatch → exact render job diagnosis.

A bad final visual does not automatically mean "render again." Preserve valid artifacts, change the smallest faulty source, inspect the resulting identities, and rebuild only its dependents. Do not turn failure recovery into a full-project rerun.

Technical checks and aggregate reviewer scores do not supersede an informed user review of the actual video. Record the user's final visual or audio judgment explicitly.
