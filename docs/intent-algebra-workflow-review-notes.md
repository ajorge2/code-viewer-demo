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
- Do not reject a record merely because it contains a balanced mixture of additions and
  removals. Preserve addition/removal dominance only as metadata and an evaluation
  segment, not as an eligibility gate or semantic clustering feature.
- Partition each diff into localized edit objects. Nearby or overlapping additions and
  removals likely describe one changed object; structurally separate edits remain
  separate candidate objects.
- Treat message-to-edit alignment as a weakly supervised mapping problem. For each
  record, infer which edit object, combination of objects, or shared changed region the
  message describes.
- Assign positive and negative evidence at the edit-object level, not once for the
  entire diff. Every distinct object explicitly or implicitly described by the message
  is a positive alignment, so one message can yield multiple labeled code examples.
  Objects not supported by the message become negative or contextual evidence.
- A message may describe one object, several objects, or a composite relationship. The
  structural audit must distinguish those cases instead of assuming the whole diff is
  positive.
- Addition/removal dominance does not change this rule: even a strongly one-directional
  diff can contain several distinct objects that the message labels separately.

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

## Revised experiment workflow

```mermaid
flowchart TD
    A[CommitPackFT Python and JavaScript records] --> B[Remove generated, lockfile, formatting-only, and unusable records]
    B --> C[Preserve each complete record: natural-language diff message plus full code diff]

    C --> D[Embed only the natural-language diff messages]
    D --> E[Cluster messages by semantic meaning]
    E --> F[LLM proposes a human-readable meaning from all member messages]
    F --> G[Estimate meaning confidence from member agreement and embedding cohesion]
    G --> H[Candidate semantic term]
    G --> I{Stable semantic subgroups remain?}
    I -- Yes --> J[Re-cluster member messages within this cluster]
    J --> F
    I -- No --> K[Stop semantic refinement on this branch]

    C --> L[Parse before and after code and derive AST edit evidence]
    L --> M[Partition each diff into localized edit objects at a flexible code scale]
    M --> N[Group nearby or overlapping additions and removals as a likely shared object]
    M --> O[Keep structurally separate edits as separate candidate objects]

    H --> P[Align every member message and term meaning to its edit objects]
    N --> P
    O --> P
    P --> Q{What does this message describe?}
    Q -- One object --> R[One positive code alignment]
    Q -- Several objects --> S[Several positive code alignments]
    Q -- Their relationship --> T[One composite positive alignment]
    R --> U[Mark only unmentioned edit objects as negative or contextual evidence]
    S --> U
    T --> U

    U --> V[All-member structural audit for the semantic term]
    V --> W[Infer a recurring AST edit rule with metavariables, options, repetition, and alternatives]
    W --> X[Validate against positive and negative objects, repositories, commits, coverage, and confidence]
    X --> Y{Does recurring code evidence support the semantic term?}
    Y -- Yes --> Z[Register grounded term: meaning, structural rule, evidence, and confidence]
    Y -- No --> AA[Reject, leave unresolved, or return messages to semantic refinement]
    AA --> J

    Z --> AB[Relate broader, narrower, overlapping, and set-difference terms in the taxonomy]

    AC[Addition and removal balance] -. metadata and evaluation slice only .-> M
```
