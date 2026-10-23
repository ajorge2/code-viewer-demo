# Context benchmark

This harness measures the part of CodeArchitect that the resume's caching claim is
actually about. It compares the same fixed code questions in three states:

- **cold** — an empty, isolated meaning cache where the full warm pass is paid
  synchronously inside the measurement, preserving the same project context as the
  prewarmed state;
- **prewarmed** — an empty cache followed by a completed `warmProjectBares` pass;
- **repeat** — the same selection and question immediately after the prewarmed ask.

The harness runs in-process, points `MEANING_CACHE_DIR` at a temporary directory,
and deletes that directory when it finishes. It does not touch `.meaning-cache/` or
change normal server responses.

## Validate without spending API credits

```sh
npm run benchmark:context:dry
```

The dry run scans every configured repository, resolves every file and locator,
and reports the observed file/line/byte scale. It makes no model calls.

## Run the benchmark

Set `OPENAI_API_KEY` in `.env`, then run:

```sh
npm run benchmark:context -- --config benchmarks/context.example.json --trials 3
```

Results are written to ignored `benchmark-results/` files:

- JSON contains the environment, repository scale, per-observation telemetry, and
  aggregate p50/p95 results.
- Markdown contains a compact comparison and candidate resume wording.

The example starts at one trial because the cold and prewarmed states can make many
summary-model calls. Check the JSON's model-call counts and cost before increasing
the trial count. A defensible resume statistic should use enough observations and
repositories to represent the claim; do not treat the example's one-trial output as
a final benchmark.

## Configure representative questions

Each question needs:

- `file`: an exact project-relative source path;
- `find`: a unique source substring inside the unit to benchmark;
- `question`: the fixed question sent through the normal `ask()` path;
- `id`: a stable label for the result.

Add repositories and questions to a copied config file. Repository paths resolve
relative to the config file. Use the same question suite for every reported run.

## What the telemetry means

- `contextPreparationMs` is the work that must finish before the answer-model call:
  cold runs include the synchronous project warm pass, while prewarmed and repeat
  runs include only folder-context and selected-unit context preparation.
- `frontierContextMs` separately measures `frontierPeersMeaning`: loading or
  computing the selected unit's content-aware context.
- `folderContextMs` measures the folder/project context fold.
- `answerModelMs` is reported separately because network and model-generation
  variance can dominate end-to-end latency.
- Cache hits, misses, sets, and model calls show *why* a state is faster, not only
  whether one run happened to be fast.

The existing sub-millisecond re-chunking claim is a different operation. Benchmark
`cutTree()` separately if that claim remains on the resume; do not label it context
retrieval or background-cache latency.
