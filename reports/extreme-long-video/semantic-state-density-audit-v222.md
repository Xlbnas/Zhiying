# Extreme Long Video — Semantic State Density Audit V2.2.2

## Scope

- 111/111 scenes audited from the frozen V2.2 scene boundaries and visual theses.
- State timing is renderer-local QC metadata only; it is not stored in DB/schema and does not change scene boundaries.
- A semantic state means a newly visible explanatory object, relation, condition, result, boundary, archive annotation, or conclusion. Decorative motion is not counted.
- Soft rule: <9s requires 1–2 states; 9–13s requires at least 2; >13s requires at least 3. The implementation uses two states from 7s upward so a non-deliberate unchanged state remains under about 7s.

## Summary

| Metric | Result |
| --- | ---: |
| scenes audited | 111 |
| user-observed long-static scenes before V2.2.1 | 48/91 covered scenes (>=8s) |
| planned unchanged interval >7s after V2.2.1 | 0/111 |
| measured near-static interval >7s in full clean MP4 | 0/111 |
| archive-bound scenes | 7 |
| deliberate rhetorical holds | 1 |
| audit failures | 0 |

## Scene audit

| scene | duration | states | local state timestamps | planned longest | measured near-static | archive | deliberate hold | verdict | required fix |
| --- | ---: | ---: | --- | ---: | ---: | --- | --- | --- | --- |
| S001 | 7.6s | 2 | 0.5s, 4.2s | 3.6s | 7.0s | no | no | PASS | none |
| S002 | 7.8s | 2 | 0.5s, 4.3s | 3.7s | 6.0s | no | no | PASS | none |
| S003 | 7.6s | 2 | 0.5s, 4.2s | 3.6s | 6.0s | no | no | PASS | none |
| S004 | 8.7s | 2 | 0.6s, 4.8s | 4.2s | 2.5s | no | no | PASS | none |
| S005 | 6.7s | 1 | 0.5s | 6.1s | 4.5s | no | no | PASS | none |
| S006 | 8.2s | 2 | 0.6s, 4.5s | 4.0s | 3.5s | no | no | PASS | none |
| S007 | 8.0s | 2 | 0.6s, 4.4s | 3.8s | 6.0s | no | no | PASS | none |
| S008 | 8.4s | 2 | 0.6s, 4.6s | 4.0s | 3.0s | no | no | PASS | none |
| S009 | 7.6s | 2 | 0.5s, 4.2s | 3.6s | 2.5s | no | no | PASS | none |
| S010 | 8.9s | 2 | 0.6s, 4.9s | 4.3s | 7.0s | no | no | PASS | none |
| S011 | 6.4s | 1 | 0.5s | 5.9s | 0.5s | no | no | PASS | none |
| S012 | 7.6s | 2 | 0.5s, 4.2s | 3.6s | 6.0s | no | no | PASS | none |
| S013 | 9.3s | 2 | 0.7s, 5.1s | 4.5s | 4.5s | no | no | PASS | none |
| S014 | 8.7s | 2 | 0.6s, 4.8s | 4.2s | 3.0s | no | no | PASS | none |
| S015 | 7.1s | 2 | 0.5s, 3.9s | 3.4s | 1.5s | yes | no | PASS | none |
| S016 | 8.9s | 2 | 0.6s, 4.9s | 4.3s | 3.0s | no | no | PASS | none |
| S017 | 5.8s | 1 | 0.5s | 5.3s | 4.0s | no | no | PASS | none |
| S018 | 15.1s | 3 | 0.8s, 5.7s, 10.6s | 5.0s | 3.0s | no | no | PASS | none |
| S019 | 11.8s | 2 | 0.8s, 6.5s | 5.6s | 4.5s | no | no | PASS | none |
| S020 | 10.0s | 2 | 0.7s, 5.5s | 4.8s | 3.5s | no | no | PASS | none |
| S021 | 12.4s | 2 | 0.9s, 6.8s | 6.0s | 4.5s | no | no | PASS | none |
| S022 | 10.9s | 2 | 0.8s, 6.0s | 5.2s | 2.0s | yes | no | PASS | none |
| S023 | 7.6s | 2 | 0.5s, 4.2s | 3.6s | 2.5s | no | no | PASS | none |
| S024 | 8.4s | 2 | 0.6s, 4.6s | 4.0s | 2.5s | no | no | PASS | none |
| S025 | 6.4s | 1 | 0.5s | 5.9s | 6.0s | no | no | PASS | none |
| S026 | 5.6s | 1 | 0.4s | 5.1s | 4.5s | no | no | PASS | none |
| S027 | 10.4s | 2 | 0.7s, 5.7s | 5.0s | 3.5s | no | no | PASS | none |
| S028 | 8.0s | 2 | 0.6s, 4.4s | 3.8s | 3.0s | no | no | PASS | none |
| S029 | 13.1s | 3 | 0.7s, 5.0s, 9.2s | 4.3s | 6.5s | no | no | PASS | none |
| S030 | 11.6s | 2 | 0.8s, 6.4s | 5.6s | 4.5s | no | no | PASS | none |
| S031 | 9.6s | 2 | 0.7s, 5.3s | 4.6s | 3.5s | no | no | PASS | none |
| S032 | 10.0s | 2 | 0.7s, 5.5s | 4.8s | 5.5s | no | no | PASS | none |
| S033 | 14.2s | 3 | 0.7s, 5.4s, 10.0s | 4.7s | 3.0s | no | no | PASS | none |
| S034 | 9.1s | 2 | 0.6s, 5.0s | 4.4s | 1.5s | no | no | PASS | none |
| S035 | 5.5s | 1 | 0.4s | 5.1s | 5.0s | no | no | PASS | none |
| S036 | 6.2s | 1 | 0.5s | 5.7s | 1.5s | no | no | PASS | none |
| S037 | 5.5s | 1 | 0.4s | 5.1s | 4.5s | no | no | PASS | none |
| S038 | 8.2s | 2 | 0.6s, 4.5s | 4.0s | 3.5s | no | no | PASS | none |
| S039 | 10.9s | 2 | 0.8s, 6.0s | 5.2s | 4.0s | no | no | PASS | none |
| S040 | 7.6s | 2 | 0.5s, 4.2s | 3.6s | 2.5s | no | no | PASS | none |
| S041 | 9.8s | 2 | 0.7s, 5.4s | 4.7s | 3.0s | no | no | PASS | none |
| S042 | 5.5s | 1 | 0.4s | 5.1s | 4.5s | no | no | PASS | none |
| S043 | 9.8s | 2 | 0.7s, 5.4s | 4.7s | 3.5s | no | no | PASS | none |
| S044 | 12.0s | 2 | 0.8s, 6.6s | 5.8s | 6.0s | no | no | PASS | none |
| S045 | 8.2s | 2 | 0.6s, 4.5s | 4.0s | 1.0s | no | no | PASS | none |
| S046 | 9.1s | 2 | 0.6s, 5.0s | 4.4s | 3.0s | no | no | PASS | none |
| S047 | 7.6s | 2 | 0.5s, 4.2s | 3.6s | 2.5s | no | no | PASS | none |
| S048 | 6.0s | 1 | 0.5s | 5.5s | 5.0s | no | no | PASS | none |
| S049 | 7.3s | 2 | 0.5s, 4.0s | 3.5s | 3.5s | no | no | PASS | none |
| S050 | 5.5s | 1 | 0.4s | 5.1s | 4.5s | no | no | PASS | none |
| S051 | 8.9s | 2 | 0.6s, 4.9s | 4.3s | 3.0s | no | no | PASS | none |
| S052 | 11.3s | 2 | 0.8s, 6.2s | 5.4s | 3.5s | no | no | PASS | none |
| S053 | 13.3s | 3 | 0.7s, 5.1s, 9.3s | 4.4s | 3.0s | no | no | PASS | none |
| S054 | 11.1s | 2 | 0.8s, 6.1s | 5.3s | 4.0s | no | no | PASS | none |
| S055 | 13.1s | 3 | 0.7s, 5.0s, 9.2s | 4.3s | 3.0s | no | no | PASS | none |
| S056 | 7.3s | 2 | 0.5s, 4.0s | 3.5s | 2.5s | no | no | PASS | none |
| S057 | 6.9s | 1 | 0.6s | 6.3s | 1.0s | no | no | PASS | none |
| S058 | 6.7s | 1 | 0.5s | 6.1s | 5.5s | no | no | PASS | none |
| S059 | 13.1s | 3 | 0.7s, 5.0s, 9.2s | 4.3s | 2.5s | no | no | PASS | none |
| S060 | 6.0s | 1 | 0.5s | 5.5s | 4.5s | no | no | PASS | none |
| S061 | 5.5s | 1 | 0.4s | 5.1s | 5.0s | no | no | PASS | none |
| S062 | 12.9s | 2 | 0.9s, 7.1s | 6.2s | 4.5s | no | no | PASS | none |
| S063 | 8.0s | 2 | 0.6s, 4.4s | 3.8s | 2.5s | no | no | PASS | none |
| S064 | 10.7s | 2 | 0.7s, 5.9s | 5.1s | 4.0s | no | no | PASS | none |
| S065 | 10.0s | 2 | 0.7s, 5.5s | 4.8s | 3.5s | no | no | PASS | none |
| S066 | 9.1s | 2 | 0.6s, 5.0s | 4.4s | 3.0s | no | no | PASS | none |
| S067 | 15.3s | 3 | 0.8s, 5.8s, 10.7s | 5.1s | 0.5s | yes | no | PASS | none |
| S068 | 5.5s | 1 | 0.4s | 5.1s | 4.0s | no | no | PASS | none |
| S069 | 8.7s | 2 | 0.6s, 4.8s | 4.2s | 2.5s | no | no | PASS | none |
| S070 | 6.9s | 1 | 0.6s | 6.3s | 6.5s | no | no | PASS | none |
| S071 | 7.1s | 2 | 0.5s, 3.9s | 3.4s | 2.5s | no | no | PASS | none |
| S072 | 8.4s | 2 | 0.6s, 4.6s | 4.0s | 2.5s | no | no | PASS | none |
| S073 | 5.5s | 1 | 0.4s | 5.1s | 5.0s | no | no | PASS | none |
| S074 | 12.4s | 2 | 0.9s, 6.8s | 6.0s | 4.5s | no | no | PASS | none |
| S075 | 5.5s | 1 | 0.4s | 5.1s | 4.0s | no | no | PASS | none |
| S076 | 9.3s | 2 | 0.7s, 5.1s | 4.5s | 3.0s | no | no | PASS | none |
| S077 | 8.4s | 2 | 0.6s, 4.6s | 4.0s | 3.0s | no | no | PASS | none |
| S078 | 13.3s | 3 | 0.7s, 5.1s, 9.3s | 4.4s | 0.5s | yes | no | PASS | none |
| S079 | 8.2s | 2 | 0.6s, 4.5s | 4.0s | 0.5s | yes | no | PASS | none |
| S080 | 7.3s | 2 | 0.5s, 4.0s | 3.5s | 2.0s | no | no | PASS | none |
| S081 | 8.0s | 2 | 0.6s, 4.4s | 3.8s | 3.0s | no | no | PASS | none |
| S082 | 9.8s | 2 | 0.7s, 5.4s | 4.7s | 3.5s | no | no | PASS | none |
| S083 | 6.0s | 1 | 0.5s | 5.5s | 4.5s | no | no | PASS | none |
| S084 | 11.1s | 2 | 0.8s, 6.1s | 5.3s | 4.0s | no | no | PASS | none |
| S085 | 10.0s | 2 | 0.7s, 5.5s | 4.8s | 3.5s | no | no | PASS | none |
| S086 | 9.3s | 2 | 0.7s, 5.1s | 4.5s | 3.0s | no | no | PASS | none |
| S087 | 8.4s | 2 | 0.6s, 4.6s | 4.0s | 3.0s | no | no | PASS | none |
| S088 | 11.8s | 2 | 0.8s, 6.5s | 5.6s | 6.0s | no | no | PASS | none |
| S089 | 14.2s | 3 | 0.7s, 5.4s, 10.0s | 4.7s | 2.0s | no | no | PASS | none |
| S090 | 10.7s | 2 | 0.7s, 5.9s | 5.1s | 3.5s | no | no | PASS | none |
| S091 | 6.9s | 1 | 0.6s | 6.3s | 5.0s | no | no | PASS | none |
| S092 | 7.1s | 2 | 0.5s, 3.9s | 3.4s | 2.0s | no | no | PASS | none |
| S093 | 11.8s | 2 | 0.8s, 6.5s | 5.6s | 4.0s | no | no | PASS | none |
| S094 | 8.2s | 2 | 0.6s, 4.5s | 4.0s | 2.5s | no | no | PASS | none |
| S095 | 8.9s | 2 | 0.6s, 4.9s | 4.3s | 2.5s | no | no | PASS | none |
| S096 | 11.6s | 2 | 0.8s, 6.4s | 5.6s | 4.5s | no | no | PASS | none |
| S097 | 10.4s | 2 | 0.7s, 5.7s | 5.0s | 3.5s | no | no | PASS | none |
| S098 | 10.2s | 2 | 0.7s, 5.6s | 4.9s | 0.5s | yes | no | PASS | none |
| S099 | 10.2s | 2 | 0.7s, 5.6s | 4.9s | 3.5s | no | no | PASS | none |
| S100 | 10.0s | 2 | 0.7s, 5.5s | 4.8s | 3.5s | no | no | PASS | none |
| S101 | 12.0s | 2 | 0.8s, 6.6s | 5.8s | 4.5s | no | no | PASS | none |
| S102 | 7.6s | 2 | 0.5s, 4.2s | 3.6s | 0.5s | no | no | PASS | none |
| S103 | 8.0s | 2 | 0.6s, 4.4s | 3.8s | 2.5s | no | no | PASS | none |
| S104 | 10.0s | 2 | 0.7s, 5.5s | 4.8s | 3.5s | no | no | PASS | none |
| S105 | 6.9s | 1 | 0.6s | 6.3s | 5.0s | no | no | PASS | none |
| S106 | 15.1s | 3 | 0.8s, 5.7s, 10.6s | 5.0s | 1.5s | yes | no | PASS | none |
| S107 | 6.0s | 1 | 0.5s | 5.5s | 4.0s | no | no | PASS | none |
| S108 | 9.3s | 2 | 0.7s, 5.1s | 4.5s | 4.0s | no | no | PASS | none |
| S109 | 16.0s | 3 | 0.8s, 6.1s, 11.2s | 5.3s | 3.5s | no | no | PASS | none |
| S110 | 8.0s | 2 | 0.6s, 4.4s | 3.8s | 2.5s | no | no | PASS | none |
| S111 | 10.2s | 2 | 0.7s, 5.6s | 4.9s | 3.5s | no | yes | PASS | none |

## Required dynamic verification

This report proves the intended state schedule, not the final pixels. The complete 1013.299s clean and burned local previews must be decoded and independently watched before the long-static and fatigue gates can pass.
