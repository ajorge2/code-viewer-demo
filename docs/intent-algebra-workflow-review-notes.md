# Intent Algebra Workflow Review Notes

**Started:** October 1, 2026

## Code-unit level

- The distinction between clustering functions, classes, modules, or files does not yet
  feel well justified.
- Do not treat function-only analysis as a settled architectural decision. It is a
  controlled pilot choice that must be tested against alternatives or replaced with a
  representation that can handle multiple code scales responsibly.

## Semantic input

- The LLM should not interpret source code to create the semantic description used for
  clustering.
- Semantic meaning should come from the natural-language diff message.
- Code remains traceable evidence and is used later to verify whether the message-derived
  semantic idea corresponds to a recurring code pattern.
- This correction invalidates the code-grounded description stage of the current
  semantic-first function pilot; retain that run only as an ablation.

## Corpus eligibility

- Sample complete diff-message and code-diff pairs rather than extracting after-state
  functions before semantic discovery.
- Prefer changes that are strongly **addition-dominant** or strongly
  **removal-dominant**. Exclude changes with a balanced mixture of additions and
  removals, where the natural-language message is less likely to map cleanly to one
  code region or transformation.
- Preserve the direction of the change as metadata, but do not use it as a semantic
  clustering feature.
- The exact dominance threshold and whether it is measured with changed lines or AST
  node mass remain experimental choices. Evaluate both directions symmetrically.

## Cluster-to-structure transition

- Once diff messages have been embedded and clustered, the cluster already has a
  semantic meaning. Do not add a redundant “dense semantic group” artifact or a second
  all-member semantic audit.
- Replace the all-member semantic audit with an **all-member structural audit** over the
  code diffs belonging to that semantic cluster.
- The structural audit must infer what the message-derived meaning looks like in code
  across all supporting examples.
- Structural templates must support metavariable-style placeholders for identifiers,
  expressions, values, calls, blocks, and other substitutable code roles. These are
  pattern placeholders, not literal Python variables.
- A template must also support optional structural elements so it can preserve real
  variation without forcing every member to have identical syntax. Optional elements
  should retain support statistics and must not make the matcher unconstrained.
- A reasonable representation to investigate is a small regex-like language over
  normalized AST node types, edit operations, and syntax relationships—not ordinary
  regex over raw source text. It could provide named placeholders, optional elements,
  repetition, and alternatives while retaining tree nesting. This remains an open
  design choice to compare with Semgrep templates or another tree-pattern DSL.
