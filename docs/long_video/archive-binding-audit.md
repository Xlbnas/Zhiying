# Extreme Long Video Archive Binding Audit

## Decision

This audit replaces the earlier preview-level `6 bound / 13 unbound` statement with a production semantic decision for all 19 archive-marked scenes.

- `EXACT_EVIDENCE`: 2
- `CONTEXTUAL_ARCHIVE`: 5
- `ILLUSTRATIVE_ONLY`: 0
- `EDITORIAL_REPLACEMENT`: 12
- `UNBOUND`: 0 after the reviewed design replacement is applied
- rights-blocked candidates excluded: 1 (`A01`, Frederic Bartlett portrait)

Contextual assets must carry an on-screen `背景资料 - 非研究现场` or equivalent label in their attribution. They are not evidence of the named experiment, participants, event, or location.

## Scene-by-scene audit

| Scene | Narration claim | Required visual fact | Current candidate / source | Rights | Semantic relation | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| S013 | Bartlett changed the experimental question | Bartlett identity or a reliable bibliographic record | A01 Bartlett portrait / Wikimedia Commons | conflicting third-party claim | exact identity, unusable rights | `EDITORIAL_REPLACEMENT` - native name/method card |
| S015 | *War of the Ghosts* came through a different cultural tradition | primary source volume behind the story chain | A20 *Kathlamet Texts* / Internet Archive via Commons | public domain | exact primary source volume; cover is not represented as the exact story page | `EXACT_EVIDENCE` |
| S018 | later replications observed omission, rationalisation and distortion | the cited replication/method, not a generic report cover | no semantically matching physical candidate | n/a | unbound | `EDITORIAL_REPLACEMENT` - trace-comparison diagram |
| S019 | repeated reproduction and serial reproduction differ | two experimental procedures | A01 Bartlett portrait | rights conflict and does not show the procedures | wrong visual fact | `EDITORIAL_REPLACEMENT` - two-path experiment diagram |
| S021 | transition from repeated recall to controlled wording | method transition | A01 Bartlett portrait | rights conflict and portrait does not show the transition | wrong visual fact | `EDITORIAL_REPLACEMENT` - provenance/process transition |
| S022 | Loftus and Palmer's 1974 experiment | named researcher identity; experiment mechanics remain native graphics | A03 Elizabeth Loftus / Wikimedia Commons | CC BY-SA 4.0 with attribution | exact named person, not footage of the 1974 experiment | `EXACT_EVIDENCE` for identity only |
| S053 | reconsolidation evidence has bounded conditions | research conditions, not anatomy in general | A04 Gray amygdala plate / Wikimedia Commons | public domain | anatomy is illustrative only and could imply stronger evidence | `EDITORIAL_REPLACEMENT` - bounded-evidence comparison |
| S058 | confidence depends on when and under what procedure it was recorded | procedure and timing | no exact NASEM/DOJ physical page | n/a | unbound | `EDITORIAL_REPLACEMENT` - confidence timeline |
| S066 | confidence is useful only under defined procedures | conditional relationship, not a guilt calculator | no exact physical record | n/a | unbound | `EDITORIAL_REPLACEMENT` - safeguard diagram |
| S067 | flashbulb memory is vivid context, not photographic accuracy | people receiving news as period atmosphere only | A11 soldiers listening to radio / Library of Congress Matson Collection via Commons | public domain | period context; not study participants or the reported event | `CONTEXTUAL_ARCHIVE` |
| S076 | ten-year reports changed most early, then stabilised | the exact longitudinal record | A15 unrelated 1880s notebook / DPLA via Commons | public domain | generic written record is not the 9/11 study record | `EDITORIAL_REPLACEMENT` - longitudinal record diagram |
| S078 | forensic identification often has one first-report opportunity | historical lineup environment | A05 St. Louis Police lineup room / DPLA via Commons | no restrictions | historical procedure context; not the cited study or case | `CONTEXTUAL_ARCHIVE` |
| S079 | reconstructive memory creates pressure in forensic settings | historical lineup environment | A06 St. Louis Police lineup room / DPLA via Commons | no restrictions | historical procedure context; not the cited study or case | `CONTEXTUAL_ARCHIVE` |
| S083 | blind/blinded administration improves photo-array procedure | DOJ 2017 procedure text | DOJ official 2017 memorandum verified online; no reliable physical page retrieved in the runtime | U.S. government source; physical acquisition incomplete | primary source known, physical asset unavailable | `EDITORIAL_REPLACEMENT` - source-attributed DOJ procedure card |
| S084 | warn that the suspect may be absent; record initial confidence in the witness's own words | DOJ 2017 sections 6.3.1, 8.2 and 9.1 | same DOJ official memorandum | same | primary source known, physical asset unavailable | `EDITORIAL_REPLACEMENT` - source-attributed safeguard sequence |
| S087 | distance, occlusion, stress and attention cannot be repaired later | estimator variables at the scene | no semantically exact archive candidate | n/a | unbound | `EDITORIAL_REPLACEMENT` - estimator-variable diagram |
| S090 | lost-in-the-mall studies mix true family stories with a suggested event | study procedure, not any shopping mall | earlier Doty family substitution removed; no mall/study asset | n/a | no acceptable candidate | `EDITORIAL_REPLACEMENT` - experimental-stage diagram |
| S098 | imagination inflation can raise later occurrence ratings | study operation and rating shift | A07 Indiana family photograph / DPLA via Commons | public domain | family-album atmosphere; not participants or evidence of the experiment | `CONTEXTUAL_ARCHIVE` |
| S106 | consequential memories should be checked against early records and external evidence | archival written record as background | A15 historical notebook / DPLA via Commons | public domain | generic record context; not evidence from a named case | `CONTEXTUAL_ARCHIVE` |

## Primary-source verification note

The U.S. Department of Justice 2017 memorandum was verified on the official DOJ archive. It explicitly covers blind/blinded administration, the instruction that the perpetrator may not be in the array, confidence in the witness's own words, and audio/video or near-verbatim documentation:

- <https://www.justice.gov/archives/opa/pr/justice-department-announces-department-wide-procedures-eyewitness-identification>
- <https://www.justice.gov/archives/opa/press-release/file/923201/dl?inline=>

The application runtime could read the official document through the research browser but could not retrieve a stable physical PDF over its direct TLS path. Therefore S083/S084 use attributed native editorial cards rather than a fabricated scan or unrelated report cover.

## Production rule

Only the seven retained archive requirements are bound. The other twelve requirements are removed in a new immutable scenes version and rendered by `memory-lab-editorial@1`. The original scenes v1 and all prototype artifacts remain unchanged.
