# Intent Algebra pilot

This directory contains the reproducible first pass from CommitPackFT file pairs to
GumTree edit scripts, observed-file change components, structural signatures, and a
gSpan-compatible graph interchange file.

## Prerequisites

- Java/Javac 17 or newer.
- GumTree 4.0.0's all-in-one JAR at
  `.tools/gumtree-src/dist/build/install/gumtree/lib/gumtree.jar`, or a custom path
  supplied through `GUMTREE_JAR`/`--gumtree-jar`.
- The Hugging Face bucket mounted read-only at `.data/commitpackft`.

The current machine was prepared with the official GumTree 4.0.0 source distribution:

```sh
.tools/gumtree-src/gradlew -p .tools/gumtree-src :dist:installShadowDist
```

Semgrep 1.176.0 is installed for paired matcher compilation and execution. Run it
without network/version checks and with workspace-local config/cache directories:

```sh
env XDG_CONFIG_HOME="$PWD/.tools/semgrep/config" \
  XDG_CACHE_HOME="$PWD/.tools/semgrep/cache" \
  SSL_CERT_FILE=/etc/ssl/cert.pem \
  SEMGREP_ENABLE_VERSION_CHECK=0 \
  SEMGREP_SEND_METRICS=off \
  pysemgrep --version
```

## Run

```sh
npm run intent:pilot -- --per-language 100
```

The additive refinement is reproducible without overwriting the original baseline:

```sh
npm run intent:pilot:additive -- --per-language 100
npm run intent:mine:additive
npm run intent:grounding-queue:additive
npm run intent:plots:additive
npm run intent:facets:additive
```

It retains changes with one to three observed-file components, at least two added AST
nodes, and a removed-to-added AST-node ratio no greater than 0.25. Insert/delete tree
actions are weighted by subtree size; an update counts as one removed and one added
node. These are explicit pilot thresholds, not final registry rules.

The reproducible 500-per-language sweep uses a separate artifact directory:

```sh
npm run intent:sweep:additive
npm run intent:sweep:mine
npm run intent:sweep:grounding-queue
npm run intent:sweep:facets
npm run intent:sweep:cluster
npm run intent:sweep:plots
```

It retains 336 of 1,000 sampled changes. The bounded global mining pass uses support
≥15 and 3–6 vertices; larger structural composites are intentionally deferred to the
localized per-base expansion loop rather than enumerated globally.

The next nested scale-up samples 2,000 changes per language:

```sh
npm run intent:scale:additive
npm run intent:scale:mine
npm run intent:scale:grounding-queue
npm run intent:scale:facets
npm run intent:scale:cluster
npm run intent:scale:stability
npm run intent:scale:expansion-pool
npm run intent:scale:expand
npm run intent:scale:expand-within
npm run intent:scale:align
npm run intent:scale:refine-semantics
npm run intent:scale:ground-meanings
npm run intent:scale:plots
```

It retains 1,278 of 4,000 sampled changes for queue discovery. The separate expansion
pool contains 1,933 addition-dominant changes with no component-count ceiling, including
655 changes above the queue's three-component boundary and examples with as many as 32
components. `intent:scale:stability` follows the exact
members of every 336-change-sweep cluster into the larger nested sample; it does not
infer stability from label similarity. `intent:scale:expand` prototypes the proposal's
per-base inner loop using provisional action/type retrieval as `D_base`, resolves the
likely base component, bundles every other observed-file component, and groups the
abstract bundles at normalized ordered-TED similarity ≥0.75. Composite complexity is
therefore data-driven rather than capped at three components. The command also audits
constraint retrieval against known gSpan hosts; the current 4,000-diff run obtained
100% micro recall but only 22.8% micro precision, so its apparent high-support counts
must not be treated as valid support. `intent:scale:expand-within` uses exact known host
sets to cluster complete changed action subtrees inside the anchor component. It yielded
67 raw candidates, reduced by exact structure-plus-host deduplication to 45 unique
contexts with 13 cross-anchor intersections. Those intersections preserve every base ID
in `contains`, directly representing where orthogonal pieces meet. Contexts reach 23
abstract nodes; the two candidates above 100 commits were punctuation-only and are
rejected semantically. Paired Semgrep
rules must replace constraint retrieval before the flexible host corpus can support
registration claims.

`intent:scale:align` makes semantic categories primary and joins them to all 77
structural candidates by exact sample ID. It emits an OR rule hypothesis per semantic
category, ranks structural clauses by bidirectional coverage/purity, and proposes
non-tautological AND pairs for recursive composition. In the current sweep, only 9 of
169 semantic categories have recurrent structural overlap on at least two commits, and
none reaches both 50% semantic coverage and 50% rule precision. Consequently the next
executor must mine structural context inside each semantic category rather than treating
the precomputed base-first candidates as final category rules.

`intent:scale:refine-semantics` is the downward recursion harness. It tries multiple
local distance thresholds inside every semantic parent with at least six members and
requires children of at least three examples. A split must pass coverage, cohesion-gain,
silhouette, deterministic subsample-stability, and noun-label-distinctness gates. Hard
children remain disjoint for safe recursion; a separate soft layer permits at most two
sibling memberships per change. The current sweep expands 169 roots into 199 nodes via
9 accepted splits and reaches depth two. Every node also ranks structural bases and
composites as explanatory rule candidates. The harness validates acyclicity, parent
containment, hard-sibling disjointness, soft-membership limits, and reachability before
writing `recursive-semantic-refinement.json`.

`intent:scale:ground-meanings` pilots centroid-aware meaning inference on semantic nodes
with at least six hard members. The LLM returns three competing noun-category meanings
using structured output, but does not assign confidence. The harness embeds each
definition and chooses the winner from its trimmed-centroid alignment and cumulative fit
across every member. Confidence also records member vote share, winner margin, bootstrap
winner stability, centroid cohesion, and outlier rate. Child meanings are compared with
their parent meaning on the child members to verify that semantic refinement adds fit.
The 30-node run produced 15 high, 6 medium, 4 low, and 5 abstaining results; these are
heuristic in-sample levels, not calibrated probabilities. Both hypothesis and meaning
embedding requests are content-addressed and can be replayed with `-- --offline`.

The next nested semantic sweep samples 5,000 changes per language:

```sh
npm run intent:large:additive
npm run intent:large:facets
npm run intent:large:cluster
npm run intent:large:stability
npm run intent:large:refine-semantics
npm run intent:large:ground-meanings
npm run intent:large:induce-structure
npm run intent:large:plots
```

It retains 3,130 of 10,000 sampled changes, assigns 1,883 changes to 456
multi-record semantic clusters, and leaves 1,247 singletons. Exact member tracking
classifies 69 of the preceding tier's 169 clusters as stable expansions, 19 as
membership-stable label shifts, and 81 as partial splits, splits, or dissolutions. The
downward loop expands 456 roots into 545 nodes through 27 accepted splits and reaches
depth three. Centroid-aware grounding covers 77 nodes: 34 high, 15 medium, 15 low, and
13 abstaining after hierarchy gating. A child meaning cannot exceed low confidence
unless it improves fit over the selected parent meaning; 21 of 23 grounded child-parent
pairs pass that gate. The large refinement currently ranks the preceding tier's 77
structural candidates only as fixed reference evidence; new category-conditioned
structural mining is deliberately a separate next stage.

`intent:large:induce-structure` now runs that first category-conditioned structural
stage. It evaluates 49 high/medium semantic nodes using three held-out folds and learns
an OR of short AND clauses from GumTree/AST relations plus bounded code-context anchors.
Commit text and file paths are excluded. The name-invariant ablation yields only two
weak candidates; edited-subtree symbols yield four; untyped excerpt anchors yield
twelve; and bounded typed AST context frames yield nine. The final GumTree format stores
up to three 48-node enclosing neighborhoods per eligible edit and streams JSONL output.
Trove taxonomy metadata reaches 100% held-out precision, 87.5% recall, and 1.95x on the
classification-MDL proxy; Python package setup reaches 73.6%, 77.9%, and 1.37x. Neither
is registered because precision/support/repository gates remain unmet. The proxy is an
intermediate diagnostic; final promotion requires paired Semgrep execution,
repository-family evaluation, and edit-script MDL against constituent patterns.

The first paired matcher evaluation is reproducible with:

```sh
npm run intent:large:materialize-pairs
npm run intent:large:semgrep-before
npm run intent:large:semgrep-after
npm run intent:large:evaluate-semgrep
npm run intent:large:audit-expansions
npm run intent:large:induce-structure:expanded
npm run intent:large:evaluate-semgrep:expanded
```

The materializer reconstructs 3,130 complete before/after files, including 1,533 Python
pairs. Semgrep runs independently on each revision, the evaluator joins matches by
sample ID, and the category's learned GumTree clause verifies the actual edit. Against
the initial discovery-cluster reference, Python package setup reaches 75.3% precision
and 70.9% recall after verification, compared with
70.3% and 90.7% for the source-only prefilter. Trove taxonomy metadata reaches 100%
precision and 75% recall after verification, compared with 8.5% and 87.5% for its broad
source-only prefilter. This is executable evidence that Semgrep should remain a fast
prefilter rather than define change intent by itself.

Cluster membership is not treated as exhaustive ground truth. The feedback stage sends
traceable out-of-cluster matches through a cached LLM entailment audit and combines that
judgment with fit to the grounded meaning vector. For package setup, all 20 executable
out-of-cluster matches entail the category; 15 also clear the fifth-percentile member-fit
floor and are provisionally added, while five remain review candidates. Re-induction on
101 changes reaches 90.1% held-out precision, 81.2% recall, and 2.00x classification-MDL
compression. The paired executable matcher reaches 93.8% precision and 75.2% recall
against this expanded provisional reference. Zero rules are registered because
independent-repository support and the final edit-script MDL gate remain unresolved.

`intent:facets:additive` writes one record per retained change with four deliberately
separate fields: edit operation, noun-only edited entity, semantic container, and raw
concept tokens. The first three form the orthogonal local representation. Concept tokens
are allowed to overlap and are reserved for broader topic exploration.

Create the reproducible clustering environment and run the exploratory macro layer with:

```sh
.tools/submine-venv/bin/python -m venv .tools/concept-cluster-venv
.tools/concept-cluster-venv/bin/pip install -r experiments/intent-algebra/requirements-clustering.txt
npm run intent:cluster:additive
```

The clusterer uses TF-IDF plus non-negative matrix factorization with soft memberships.
Its labels are top recurrent nouns, not accepted ontology names. With only 68 changes,
the output is a pipeline and hypothesis generator—not evidence that the inferred topics
are stable.

The stronger semantic baseline uses OpenAI embeddings over commit text, file paths,
structural facets, changed identifiers/literals, and bounded before/after excerpts:

```sh
npm run intent:cluster:embeddings:additive
```

It defaults to `text-embedding-3-small` at 512 dimensions and stores vectors in an
ignored, content-addressed cache. Re-running the command does not request unchanged
embeddings. Pass `-- --offline` to verify a fully cached run without API access. Cluster
formation uses cosine-distance average linkage with an explicit distance threshold and
does not force a cluster count. The conservative pilot threshold is 0.30. The output
also includes a threshold sweep so cluster
coverage and silhouette can be inspected instead of treating the default as settled.

The embedding output also performs bounded recursive clustering over leaf-cluster
centroids. Each macro node stores child cluster IDs and the union of their sample IDs.
These parents are candidate generators, not automatic taxonomy entries: generated
parents still require an identifiable shared meaning and the registry's support and MDL
cutoffs. Accepted, quarantined, and rejected interpretations are recorded in
`semantic-cluster-decisions.json`.

Semantic categories are the primary readable layer (for ideas such as database, cache,
authentication, or UI). The bounded structural queue supplies orthogonal building
blocks. For every stable semantic category, its overlapping bases seed a localized
Semgrep → TED → gSpan search over the category's supporting diffs and negative examples
outside it.

Recursive expansion composes those building blocks into an AND/OR structural rule for
the semantic category. A merge is useful only when it improves held-out category
coverage, category precision, and MDL while remaining structurally coherent. Structural
rules never override the semantic category when they overlap; they explain and make it
traceable. Every rule retains child candidate IDs and supporting diff IDs, preserving
the path `semantic category → structural rule → code`.

Outputs are written to ignored `.data/intent-pilot/`:

- `sample-results.jsonl`: auditable row metadata, AST actions, grouping, and excerpts.
- `summary.json` / `summary.md`: retention and exclusion accounting.
- `signature-counts.json`: exact pilot structural-signature frequencies.
- `eligible-change-graphs.data`: graph-miner interchange data. Directed AST relations
  are reified as relation vertices so their source/target orientation is preserved for
  an undirected gSpan backend.
- `gspan-labels.json`: numeric label dictionary for the graph file.
- `graph-index.json`: gSpan graph ids mapped back to auditable sample ids.

The sample is deterministic: it retains the rows with the smallest SHA-256 values over
language, commit SHA, and canonical before/after patch hash. The pilot enforces the
one-to-three-component boundary only within the observed file because CommitPackFT does
not include every file touched by the original commit.

`summary.json` also records each mounted JSONL file's byte size and SHA-256 digest. This
pins the exact bucket contents used even though the storage-bucket mount does not expose
a dataset revision id.

The current component rule groups GumTree actions at their nearest statement,
declaration, or definition boundary. It is intentionally versioned as a pilot rule;
manual review must validate it before corpus-scale support counts are computed.

## Mine the pilot graphs

The ignored `.tools/submine-venv` environment pins Submine 0.1.4 on Python 3.13.
The graph representation preserves directed relationships using relation vertices,
then deliberately runs gSpan in its tested undirected mode.
The runner calls Submine's bundled C++ binding directly because the 0.1.4 high-level
wrapper drops the backend's node and edge labels while constructing result objects;
the runner retains and decodes those labels from the backend records.

```sh
npm run intent:mine
```

The original bounded pilot defaults to support ≥5 and 3–6 vertices. A 3–10 vertex trial did not
finish within one minute even on 139 graphs, while the 3–6 vertex search completed in
under a second. These are exploration
settings, not the registered corpus acceptance thresholds of 100 patch-distinct commits
and 50 independent repository families.

After the additive gate reduced the cohort to 68 graphs, the 3–10 vertex search completed
in about 1.1 seconds. This permits more contextual candidates, although punctuation and
generic-expression fragments still require candidate-level semantic filtering.

Prepare an auditable, still-unlabeled grounding queue from the support-closed candidates:

```sh
npm run intent:grounding-queue
```

The queue deliberately leaves `output_meaning` and human-review fields null. Pilot
support is not evidence that a shared intent exists, and CommitPackFT's repository lists
cannot yet establish independent repository support.

Generate the four report figures from the persisted pilot outputs:

```sh
npm run intent:plots
```

The SVGs are written to `docs/figures/intent-algebra/`. The generator has no plotting
dependencies and labels full-corpus quantities separately from pilot estimates.

## Human review

The grounding queue is reviewed through a local evidence-first interface rather than by
editing JSONL directly:

```sh
npm run intent:review
```

Open `http://127.0.0.1:4317`, enter a reviewer ID, and review each candidate. Separate
reviewer IDs create independent judgments in `.data/intent-pilot/human-reviews.json`.
Each evidence card renders an aligned before/after diff with line numbers, red deletions,
green additions, token-level emphasis, and collapsed unchanged context. Use **Show full
context** when the surrounding code matters to the judgment.
The full rubric and adjudication rule are in `HUMAN_REVIEW.md`.

Open `http://127.0.0.1:4317/clusters` to review the embedding-based macro-concepts
separately. The page shows all member diffs, offers multiple noun-level interpretations,
and records acceptance, fit, breadth, confidence, and notes in
`.data/intent-pilot-additive/human-cluster-interpretations.json`.
Each cluster also exposes recurrent pairwise links between the orthogonal facets
(`operation↔entity`, `entity↔container`, and `operation↔container`). Every link retains
the sample IDs of its supporting changes, and every member retains its full
operation → entity → container signature, providing a direct path from a semantic
interpretation back to highlighted code evidence.
