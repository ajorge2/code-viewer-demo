# CodeArchitect human-review decision

Decision: **no-ship** lowering the semantic acceptance threshold from `0.72` to `0.62`.

## Pre-registered decision result

| Metric | Conservative 0.72 | Candidate 0.62 | Candidate bar | Result |
|---|---:|---:|---:|---|
| Accepted coverage | 11.9% (18/151) | 23.2% (35/151) | at least 20% | Pass |
| Strict human-reviewed precision | 77.8% (14/18) | 68.6% (24/35) | at least 80% | Fail |
| Precision change | — | -9.2 percentage points | no worse than -5 points | Fail |
| Correct-or-partial precision | 88.9% | 85.7% | secondary | Reported only |

The candidate nearly doubled accepted coverage, but its primary-metric win could
not override either quality-guardrail failure. The frozen rule therefore blocks
the threshold reduction.

## Evaluation scope

- 151 held-out components from 132 repository families excluded from taxonomy fitting.
- 39 method-blinded review cards covering 35 semantic-policy accepts and nine exact-token baseline accepts; five identical predictions were reviewed once and attributed to both methods.
- Human labels: 27 correct, seven partial, five incorrect.
- Strict precision counts only `correct`; `partial`, `incorrect`, and `cannot_judge` count as failures.
- Candidate strict-precision Wilson 95% interval: 52.0%–81.4%.
- Conservative strict-precision Wilson 95% interval: 54.8%–91.0%.

## Supported result summary

Blocked lowering CodeArchitect's acceptance threshold from 0.72 to 0.62: coverage
cleared the pre-registered 20% bar (11.9% to 23.2%), but strict precision in blinded
human review fell 9.2 points to 68.6%, breaking the 80% guardrail across 151 held-out
components from 132 unseen repository families.

## Boundaries

The human adjudication is new, but the holdout and its earlier model judgments
previously informed development. This evaluates precision among accepted predictions,
not recall over every possible software concept or downstream user outcomes.
