# Context-preparation benchmark reconstruction

This page reconstructs the benchmark behind CodeArchitect's historical “61% latency / 80% cost” resume bullet from the original local runner and its dated machine-readable result.

## Correct conclusion

The benchmark supports this narrow claim:

> Moved repository-wide LLM summarization off the interactive path with content-addressed prewarming, reducing median context-preparation latency 61% (33.2s to 12.9s) across three fixed questions in a 36-file, 9.7K-line self-benchmark; immediate repeat queries prepared context in 0.81ms.

It does **not** support an “80% summarization cost reduction.” The old run did not capture tokens or dollars. Its 72-to-13 median request-path model-call change is approximately 82%, but the separate background prewarm made 59 model calls. Most of the work was moved before the question rather than eliminated.

## Original measurement

Generated 2026-08-01 on an Apple M2 with Node 23.7.0. The benchmark recorded one observation for each of three fixed questions in every cache state.

| State | Context preparation p50 | End-to-end p50 | Model calls p50 |
|---|---:|---:|---:|
| Cold | 33,223.190 ms | 39,083.333 ms | 72 |
| Prewarmed | 12,865.299 ms | 18,802.391 ms | 13 |
| Immediate repeat | 0.810 ms | 6,280.933 ms | 1 |

The cold-to-prewarmed context-preparation change is `(33,223.190 - 12,865.299) / 33,223.190 = 61.276%`.

The prewarm itself took 18,857.843 ms p50 and made 59 calls p50. Adding that one-time work back makes the distinction clear:

- **Interactive latency improved:** most repository summarization completed before the question.
- **Repeated work was eliminated:** an immediate repeat reused cached context in 0.81 ms.
- **Total first-use cost was not shown to fall by 80%:** schema v1 did not record token usage, and the background pass still performed the displaced calls.

## What was reconstructed

The repository now contains:

- the original dated JSON and Markdown artifacts;
- the benchmark configuration with all three fixed questions;
- isolated cache reset and per-phase timing instrumentation;
- tests proving benchmark telemetry and cache isolation;
- a schema-v2 runner that records provider-reported token usage by model and phase and separates foreground context work from the one-time prewarm.

The current dry-run resolves all three benchmark targets and reports the repository's observed file, line, and byte scale without making model calls. A fresh model-backed run was intentionally not presented as completed evidence here.

## Limits

- One repository was measured.
- There were only three observations per state—one per question.
- The source state was recorded as commit `afc99fe` plus uncommitted benchmark instrumentation.
- Different questions contribute to each p50; this is not repeated timing of one identical request.
- The result measures the pre-answer context stage. Answer-generation latency is separate.
- The v1 artifact cannot establish dollar cost because it lacks token usage.

## Inspect the evidence

- [Original machine-readable result](https://github.com/ajorge2/code-viewer-demo/blob/main/benchmark-results/context-2026-08-01T18-44-42-448Z.json)
- [Original generated summary](https://github.com/ajorge2/code-viewer-demo/blob/main/benchmark-results/context-2026-08-01T18-44-42-448Z.md)
- [Artifact interpretation and limitations](https://github.com/ajorge2/code-viewer-demo/blob/main/benchmark-results/README.md)
- [Benchmark method](https://github.com/ajorge2/code-viewer-demo/blob/main/benchmarks/README.md)
- [Runner source](https://github.com/ajorge2/code-viewer-demo/blob/main/scripts/benchmark-context.js)
- [Telemetry tests](https://github.com/ajorge2/code-viewer-demo/tree/main/test)
