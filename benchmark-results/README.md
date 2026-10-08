# Published context-benchmark artifact

`context-2026-08-01T18-44-42-448Z.json` is the original machine-readable result
recovered from the local CodeArchitect worktree. Its absolute local paths were replaced
with repository-relative paths before publication; the measurements are unchanged.

`context-2026-08-01T18-44-42-448Z.md` is the original generated summary. It predates
token accounting and uses “model calls” as a diagnostic count, not a cost measurement.

## What this run can support

Across three fixed questions on one 36-file, 9,726-line repository, one observation per
question and state:

| State | Context preparation p50 | Total model calls p50 |
|---|---:|---:|
| Cold | 33,223.19 ms | 72 |
| Prewarmed | 12,865.299 ms | 13 |
| Immediate repeat | 0.81 ms | 1 |

The cold-to-prewarmed critical-path latency reduction was 61.276%. The separate
background prewarm made 59 model calls and took 18,857.843 ms p50. Therefore, the
72-to-13 request-path call reduction must not be described as an 80% reduction in total
cost: most of that work was moved earlier rather than removed.

## Limitations

- This is a self-benchmark on one repository, not a cross-repository study.
- There was one observation per question and only three observations per state.
- The source worktree was dirty, so the JSON preserves the exact commit plus that fact.
- Provider token usage was not captured in schema version 1; use the v2 runner for a
  defensible token or dollar-cost comparison.
