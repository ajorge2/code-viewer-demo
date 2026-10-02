# Intent Algebra audit notebook contract

The Steps 1–2 calibration run is audited through
`experiments/intent-algebra/notebooks/01_steps_1_2_calibration_audit.ipynb`.

The notebook is a read-only inspection layer. Model calls, parsing, queue construction,
and alignment happen in deterministic/resumable executors that write versioned artifacts.
Rerunning the notebook must not change experiment results.

## Required run artifacts

Each run directory contains:

| Artifact | Purpose |
|---|---|
| `run-manifest.json` | Run ID, Git revision, timestamps, data/config/prompt/model versions, seeds, and environment |
| `artifact-index.json` | SHA-256, byte length, row count, and schema version for every artifact |
| `records.jsonl` | Sampled record provenance, message, before/after source, and content hashes |
| `claims.jsonl` | Every extracted `(verb, noun/object)` claim, confidence, model response ID, and cache key |
| `ast-candidates.jsonl` | Every queue candidate, single diff side, AST identity/span/tree, rank, sign, tier, and provenance |
| `code-labels.jsonl` | Selected single-sided AST-subtree datapoints and alignment evidence |
| `unresolved.jsonl` | Rejected or unresolved claims with explicit reason codes |
| `calibration-summary.json` | Funnel, latency, token/cost, parsing, queue, confidence, and yield summaries |
| `review-sample.jsonl` | Deterministically selected alignment cases for human audit |
| `review-decisions.jsonl` | Append-only human judgments keyed by run, reviewer, claim, and candidate |

Every derived row retains stable IDs linking back to the original record and forward to
claims, queue candidates, selected code labels, and review judgments. A claim that maps
to both diff sides emits two code-label datapoints with different candidate IDs and a
shared claim ID.

The executor uses `audit_artifacts.py` to create content-addressed IDs, refuse silent
artifact overwrites, validate every foreign-key link and single-side constraint, and
seal the completed run with SHA-256 hashes. `artifact-index.json` does not contain its
own hash because that value would be circular; the notebook identifies it as the index
rather than reporting it as unindexed.

## Notebook views

The notebook provides:

1. artifact-integrity verification against the persisted index;
2. run/config/prompt/model provenance;
3. the Steps 1–2 funnel and unresolved-reason distribution;
4. record-level before/after diffs with highlights;
5. every message-derived verb+noun claim;
6. the complete deduplicated AST candidate queue in evaluation order;
7. the selected single-sided subtree and its AST representation;
8. alignment scores, winner margins, and abstentions;
9. deterministic human-review samples and agreement metrics; and
10. language, verb-sign, queue-depth, node-type, and confidence slices.

The notebook must remain usable while a run is incomplete. Missing artifacts are shown
as pending instead of causing unrelated audit sections to fail.

## Local use

Create the isolated notebook environment once:

```bash
./experiments/intent-algebra/setup-audit-notebook.sh
```

Then launch the audit view:

```bash
.tools/intent-audit-venv/bin/jupyter lab \
  experiments/intent-algebra/notebooks/01_steps_1_2_calibration_audit.ipynb
```

By default, the notebook reads
`.data/intent-message-code-calibration-1000`. To inspect another immutable run, set
`INTENT_ALGEBRA_RUN_ROOT` before launch. The run executor, not the notebook, owns all
artifact creation and final hash indexing.
