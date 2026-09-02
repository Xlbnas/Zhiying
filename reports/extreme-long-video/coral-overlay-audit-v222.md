# Extreme Long Video — Coral Overlay Audit V2.2.2

## Result

- scenes checked: 111/111
- significant accent instances: 64
- FLOATING_OVERSIZED_CORAL_TEXT: 0
- FUTURE_ANSWER_LEAK: 0
- ACCENT_WITHOUT_LAYOUT_OWNER: 0
- structural accents are retained; coral color itself is not treated as a failure.

The audit classifies prominent coral text/operators and sequence-state labels from the current scene routes. Borders, underlines, and small non-text color fields are structural styling and are not counted as prominent text overlays.

| scene | timestamp | text | classification | font scale | layout owner | overlaps primary objects? | appears after initial state? | narration timing valid? | future information leaked? | verdict | fix |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S002 | 00:07.6–00:15.3 | 冲突点 / 那句话出现 / 那句话未出现 | INTEGRATED_KEYWORD | 24–28px | version cards + reserved lower callout | no | yes, card state change | valid | no | PASS | floating phrase removed |
| S003 | 00:15.3–00:22.9 | 确信（双侧等长指标） | INTEGRATED_KEYWORD | 24px | version A/B cards | no | yes, card state change | valid | no | PASS | central sentence removed |
| S003 | 00:15.3–00:22.9 | ≠ | STRUCTURAL_ACCENT | 120px | two-sided logical relation | no | semantic relation | valid | no | PASS | none |
| S014 | 01:42.7–01:51.4 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S016 | 01:58.5–02:07.4 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S018 | 02:13.1–02:28.2 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S019 | 02:28.2–02:40.0 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S020 | 02:40.0–02:50.0 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S021 | 02:50.0–03:02.4 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S023 | 03:13.3–03:20.9 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S024 | 03:20.9–03:29.3 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S038 | 05:24.6–05:32.8 | 睡眠？ / 原词表未出现 | INTEGRATED_KEYWORD | 68px + 30px | reserved DRM reveal card | no | yes | after 329.088s / 331.347s | no | PASS | moved after exact cue boundaries |
| S039 | 05:32.8–05:43.7 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S040 | 05:43.7–05:51.3 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S041 | 05:51.3–06:01.0 | ≠ | STRUCTURAL_ACCENT | 120px | two-sided logical relation | no | semantic relation | valid | no | PASS | none |
| S041 | 05:51.3–06:01.0 | 共同意义 ≠ 是否出现 | STRUCTURAL_ACCENT | 88px operator | paired gist/detail panels | no | no | valid | no | PASS | none |
| S041 | 05:51.3–06:01.0 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S042 | 06:01.0–06:06.5 | 共同意义 ≠ 是否出现 | STRUCTURAL_ACCENT | 88px operator | paired gist/detail panels | no | no | valid | no | PASS | none |
| S043 | 06:06.5–06:16.3 | 共同意义 ≠ 是否出现 | STRUCTURAL_ACCENT | 88px operator | paired gist/detail panels | no | no | valid | no | PASS | none |
| S043 | 06:06.5–06:16.3 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S044 | 06:16.3–06:28.3 | 共同意义 ≠ 是否出现 | STRUCTURAL_ACCENT | 88px operator | paired gist/detail panels | no | no | valid | no | PASS | none |
| S044 | 06:16.3–06:28.3 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S045 | 06:28.3–06:36.5 | 共同意义 ≠ 是否出现 | STRUCTURAL_ACCENT | 88px operator | paired gist/detail panels | no | no | valid | no | PASS | none |
| S046 | 06:36.5–06:45.6 | 共同意义 ≠ 是否出现 | STRUCTURAL_ACCENT | 88px operator | paired gist/detail panels | no | no | valid | no | PASS | none |
| S046 | 06:36.5–06:45.6 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S047 | 06:45.6–06:53.2 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S049 | 06:59.2–07:06.5 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S051 | 07:12.0–07:20.9 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S052 | 07:20.9–07:32.3 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S053 | 07:32.3–07:45.6 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S054 | 07:45.6–07:56.7 | ≠ | STRUCTURAL_ACCENT | 120px | two-sided logical relation | no | semantic relation | valid | no | PASS | none |
| S054 | 07:45.6–07:56.7 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S055 | 07:56.7–08:09.8 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S056 | 08:09.8–08:17.1 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S059 | 08:30.7–08:43.8 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S060 | 08:43.8–08:49.8 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S062 | 08:55.3–09:08.2 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S063 | 09:08.2–09:16.2 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S064 | 09:16.2–09:26.9 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S065 | 09:26.9–09:36.9 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S066 | 09:36.9–09:46.0 | ≠ | STRUCTURAL_ACCENT | 120px | two-sided logical relation | no | semantic relation | valid | no | PASS | none |
| S066 | 09:36.9–09:46.0 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S069 | 10:06.8–10:15.5 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S071 | 10:22.4–10:29.5 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S072 | 10:29.5–10:37.9 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S074 | 10:43.4–10:55.8 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S075 | 10:55.8–11:01.3 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S076 | 11:01.3–11:10.7 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S077 | 11:10.7–11:19.1 | ≠ | STRUCTURAL_ACCENT | 120px | two-sided logical relation | no | semantic relation | valid | no | PASS | none |
| S077 | 11:10.7–11:19.1 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S090 | 13:16.6–13:27.3 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S091 | 13:27.3–13:34.2 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S092 | 13:34.2–13:41.3 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S093 | 13:41.3–13:53.1 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S094 | 13:53.1–14:01.3 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S095 | 14:01.3–14:10.2 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S096 | 14:10.2–14:21.8 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S097 | 14:21.8–14:32.2 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S098 | 14:32.2–14:42.4 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S099 | 14:42.4–14:52.7 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S100 | 14:52.7–15:02.7 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S101 | 15:02.7–15:14.7 | selected sequence state | INTEGRATED_KEYWORD | 17px | sequence spine | no | no | valid | no | PASS | none |
| S103 | 15:22.2–15:30.2 | ≠ | STRUCTURAL_ACCENT | 120px | two-sided logical relation | no | semantic relation | valid | no | PASS | none |
| S111 | 16:41.6–16:51.8 | ≠ | STRUCTURAL_ACCENT | 120px | two-sided logical relation | no | semantic relation | valid | no | PASS | none |
