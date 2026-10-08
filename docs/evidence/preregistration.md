# CodeArchitect threshold launch gate

Status: **frozen before human review**

Frozen: 2026-10-02

## Decision

Decide whether to lower CodeArchitect's semantic acceptance threshold from the
frozen conservative policy (`0.72`) to the higher-coverage candidate (`0.62`).
The decision concerns the threshold change, not whether the underlying taxonomy
is useful in general.

## Evaluation population

- 151 code-labeled components from 132 repository families excluded from taxonomy fitting.
- The taxonomy was fit on 685 diffs from 668 repository families.
- Every prediction accepted by either semantic policy or by the exact-token baseline is reviewed.
- Review items are deterministically shuffled and do not identify the producing method or score.

This is a confirmatory **human adjudication of a previously model-judged holdout**.
The holdout and its model judgments already informed development, so this is not
a new untouched test set. The human labels are new and must not be inspected or
changed after the decision rule is applied.

## Metrics

Primary metric: accepted coverage, accepted components / 151 components.

Quality guardrail: strict human-reviewed precision, `correct` reviews / all
accepted predictions. `partial`, `incorrect`, and `cannot_judge` all count as
guardrail failures.

Secondary metrics:

- correct-or-partial concept-fit precision;
- abstention rate;
- precision difference from the 0.72 policy;
- exact-token baseline coverage and precision;
- Wilson 95% confidence intervals for precision.

## Bars fixed before review

The `0.62` candidate ships only if all of the following hold:

1. coverage is at least 20%;
2. strict human-reviewed precision is at least 80%;
3. strict precision is no more than 5 percentage points below the `0.72` policy;
4. no review row is missing a valid label.

Otherwise the decision is **no-ship**. No primary-metric gain can override a
quality-guardrail failure. The threshold may be reconsidered only after the
alignment system changes and a new repository-disjoint evaluation is frozen.

## Review rubric

- `correct`: both the developer-written intent and matched code evidence instantiate the predicted concept.
- `partial`: the concept is related, but too broad, indirect, or supported by only one side.
- `incorrect`: the concept does not describe the intent-and-code evidence.
- `cannot_judge`: the supplied evidence is insufficient. This is conservatively treated as not correct.

The reviewer must not consult the CLI judgments in the source artifact while labeling.

