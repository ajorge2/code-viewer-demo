# Intent Algebra: Semantic-First Restart Brief

**Decision date:** October 1, 2026  
**Status:** Ready for a clean pilot restart

## Objective

Build a reusable algebra of human-understandable software meanings whose terms can
describe most meaningful components in unfamiliar Python and JavaScript repositories.
Every accepted term must remain traceable to the code examples supporting it.

## Architectural correction

Semantic discovery and structural verification are separate stages.

1. Cluster actual code examples by semantic meaning.
2. Name the shared human-understandable meaning of each cluster.
3. Recursively cluster the examples inside coherent semantic clusters.
4. Validate overlaps against the term algebra.
5. Only afterward use AST, GumTree, Tree Edit Distance, gSpan, or Semgrep evidence to
   test whether each semantic idea corresponds to reproducible code patterns.

Structural features must not determine semantic cluster membership. Generated English
labels must not be clustered to manufacture broader parents. Structure validates or
falsifies a proposed vocabulary; it does not create the vocabulary.

## Term algebra

For terms `A` and `B`, a partial overlap is admissible only when at least one
directional difference is a valid term:

`A ∩ B != ∅  =>  valid(A \ B) or valid(B \ A)`

The empty set is a valid silent zero term. This preserves proper subset relationships.
If both directional differences are empty, the terms are extensionally equal and must
be treated as aliases unless later evidence distinguishes them.

Terms on different descriptive dimensions may eventually be composed, but an
organizational or domain umbrella is not automatically an algebraic term.

## Meaning and confidence

- Labels are concise noun phrases that describe a recognizable software responsibility.
- The LLM proposes meanings from all cluster members rather than from a centroid example.
- Embedding centroids measure cohesion, member fit, winner margin, bootstrap stability,
  and outlier rate; they do not independently determine meaning.
- A label is provisional until its member evidence is repository-independent and its
  overlap relationships pass the algebra.
- Structural verification may produce one shared rule or a small disjunction of
  recurring patterns. A semantic cluster with no transferable structural evidence
  remains a hypothesis rather than an accepted algebraic term.

## What remains reusable

- CommitPackFT bucket and local corpus
- Python/JavaScript ingestion, cleaning, and addition-dominant filtering
- Repository and provenance metadata
- Code excerpts and change records
- LLM structured-output and embedding caches/infrastructure
- Recursive clustering and centroid-confidence machinery, after removing structural
  features from membership decisions
- Structural mining, Semgrep compilation, mutation probes, MDL diagnostics, and
  held-out testing as downstream validators
- Human review interface, report, and visualization infrastructure
- One-sided overlap audit in `experiments/intent-algebra/audit-term-overlap-closure.py`

## Prior run: retain as an ablation

The structure-influenced exploratory run produced 49 narrower meaning hypotheses and
11 broad parent hypotheses. It obtained 68.8% exploratory static-file coverage but is
not a valid final taxonomy because broad parents were created by clustering generated
term meanings rather than code examples. A reproducible overlap audit found three
failures among nine observed partial overlaps:

- Authentication × Routing
- User interface × Game application
- Web server integration × Routing

The run remains useful evidence about failure modes, coverage gaps, provenance,
structural overfitting, and the importance of explicit abstention. Existing labels may
be used as comparison hypotheses, never as authoritative inputs to the restart.

## Clean pilot sequence

1. Freeze all current artifacts; write the restart to a new output directory.
2. Define the semantic unit of analysis explicitly: function, class, module, or bounded
   changed component. Do not mix unit levels in one clustering run.
3. Generate code-grounded behavioral descriptions for each unit. Treat commit and PR
   text as supporting evidence rather than ground truth.
4. Embed only the semantic representation used for meaning discovery.
5. Cluster code examples at multiple semantic resolutions and preserve explicit
   residuals rather than forcing every example into a cluster.
6. Name and score coherent clusters using all members.
7. Recursively cluster within accepted semantic clusters.
8. Run the empty-set-aware overlap audit on actual membership sets.
9. Mine and validate structural realizations inside each surviving semantic term.
10. Promote only terms that pass semantic, independence, algebraic, and structural
    gates. Then scale to the final breadth sweep.

## Phase 1 north star

On genuinely unseen repositories, at least 80% of meaningful first-party components
should receive one to three correct, composable terms, with at least 90% precision and
at least 60% receiving a term more specific than a generic parent. Unknown concepts
must remain explicit abstentions rather than forced matches.

## One-shot continuation prompt

> Continue the CodeArchitect Intent Algebra experiment from the semantic-first restart.
> Work in `/Users/ajorge/code-viewer-demo` and first read
> `docs/intent-algebra-semantic-first-restart.md` plus the current experiment report.
> Preserve the existing structure-influenced run as an ablation. Implement a new pilot
> in a separate output directory where actual code examples are clustered only by
> semantic meaning, recursively subclustered, labeled from all members, and checked with
> the empty-set-aware one-sided difference rule. Do not use AST, GumTree, TED, gSpan,
> Semgrep, file paths, or generated cluster labels to determine semantic membership.
> Use structural tooling only after semantic terms exist, as held-out verification that
> the proposed meanings correspond to reproducible code patterns. Keep the report and
> plots current, preserve code traceability and repository independence, and checkpoint
> completed work without overwriting the previous artifacts.

