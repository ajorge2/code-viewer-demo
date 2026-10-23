# AST-Regex Structural Evidence Induction

**Status:** Current design decision; implementation pending

## Purpose

Semantic clusters are created from message-derived noun/object meanings. Their member
code labels are used only afterward to determine whether the human concept has recurring
code evidence. Each datapoint contributes exactly one AST subtree from exactly one side
of its diff.

Structural validation uses a bounded, regex-like language over AST trees. It does not use
ordinary regular expressions over source text, and structural similarity never creates
or renames semantic clusters.

## AST-regex representation

Every labeled subtree is normalized while preserving its original source and AST:

- retain node types, named fields, child order where meaningful, operators, nesting,
  edited-node markers, diff side, operation metadata, language, and provenance;
- replace identifiers and literals with typed placeholders when their exact values are
  not structurally meaningful;
- retain semantically important operators and literal classes rather than erasing them;
- make optionality and alternatives explicit instead of flattening the tree.

The initial pattern language should support:

```text
$X:type       one typed subtree placeholder
P?            optional node or group
P*            zero or more children
P+            one or more children
P | Q         structural alternatives
...           a bounded descendant gap
@edit(add)    a required edit operation in the matched region
@side(before) a required diff side
```

Tree nesting and named AST fields are part of the match. The surface syntax is regex-like,
but the executor is a tree matcher or tree automaton rather than a text-regex engine.

## Sample-infer-execute loop

For each semantic cluster and each relevant language/side stratum:

1. Draw a small, repository-stratified sample of member subtrees. Include central,
   boundary, and random members rather than taking the first records.
2. From that sample, propose up to three simple AST-regex candidates using deterministic
   tree anti-unification plus an LLM constrained to the pattern grammar and complexity
   budget.
3. Compile every candidate and execute it against all remaining cluster-member subtrees.
4. Execute it against out-of-cluster subtrees from the wider corpus to measure false
   positives. Fingerprint indexes may prefilter candidates, but the compiled matcher
   decides the final match.
5. Score positive coverage, corpus precision, repository independence, rule complexity,
   MDL, metamorphic robustness, and stability across repeated small samples.
6. Keep only simple, stable rules that meet every gate. A lucky rule from one sample is
   insufficient.

This is a RANSAC-like induction strategy: repeatedly fit a bounded rule from a small
sample, then let full-corpus execution determine whether it represents a real recurring
pattern.

## Multiple implementation families

A high-precision rule with incomplete coverage may describe one legitimate implementation
family. After accepting it, remove its matched positive members from the uncovered pool,
sample the residual members, and induce another clause. Combine accepted clauses with
`OR`, subject to the total rule-family complexity and MDL budgets.

For example, one semantic term may be supported by separate Python exception, JavaScript
`catch`, and Promise rejection-handler rules. The term remains semantic and language-
independent; the executable structural clauses remain language- and side-aware.

Stop adding clauses when the family reaches its coverage target, no residual sample can
produce an incrementally useful high-precision clause, the clause limit is reached, or
the MDL cost outweighs the additional coverage.

## Pilot defaults

| Parameter | Default |
|---|---:|
| Independent sample draws | 10 |
| Subtrees per draw | `min(10, max(6, ceil(sqrt(cluster_size))))` |
| Candidate rules per sample | 3 |
| Required AST atoms per clause | ≤ 12 |
| Metavariables per clause | ≤ 4 |
| Optional groups per clause | ≤ 2 |
| Internal alternations per clause | ≤ 1 |
| Pattern tree depth | ≤ 5 |
| Bounded descendant-gap depth | ≤ 3 |
| Accepted OR clauses per term | ≤ 3 |
| Minimum incremental coverage per added clause | 0.10 |
| Aggregate member coverage | ≥ 0.60 |
| Corpus precision | ≥ 0.90 |
| Match-set agreement across sample draws | ≥ 0.80 mean Jaccard |
| MDL compression ratio | ≥ 1.20 |
| Independent support | ≥ 100 commits and ≥ 50 repository families |
| Identifier-permutation retention | 1.00 |
| Unrelated-mutation rejection | ≥ 0.95 |

These are pre-registered pilot defaults. They may be tuned on repository-disjoint
validation data and must be frozen before final test evaluation.

## Scaling strategy

Store normalized subtrees and rooted fragments by content hash. Build inverted indexes
over node-type paths, field relationships, edit anchors, and ordered tree shingles. These
indexes retrieve plausible matches without comparing every subtree pair. Final coverage
and precision always come from the executable AST-regex matcher, not from the approximate
index.

Rule induction operates locally inside one semantic cluster, but negative evaluation
operates across the wider eligible corpus. This preserves the intended direction of
evidence:

```text
message meaning -> semantic cluster -> proposed AST-regex -> corpus-wide verification
```

It must never reverse into structural grouping that creates the human semantic terms.

