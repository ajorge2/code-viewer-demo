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

- Split each diff message into one or more semantically separable claims while retaining
  the claim-to-message and message-to-diff links. Do not split a meaning whose substance
  is itself a relationship between multiple changes.
- Once those message-derived claims have been embedded and clustered, the cluster
  already has a semantic meaning. Do not add a redundant “dense semantic group”
  artifact or a second all-member semantic audit.
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

## Edit-object candidate generation

- Do not force one definitive AST partition before message-to-code alignment. Generate
  candidates at multiple structural scales and let the evidence select among them.
- Starting from the edited AST nodes, include every meaningful node on the ancestor
  paths between each edited node and the relevant lowest common ancestors. For example,
  an edited statement nested in a body can yield candidates for the statement, the body,
  and the enclosing construct; the body must not be omitted merely because it was not
  itself the directly edited leaf.
- Generate relevant LCAs for subsets of edits rather than relying only on the single LCA
  of the entire diff, which may be an uninformative function, module, or file root.
- Retain both single-subtree candidates and composite sets of structurally separate
  candidates. A distant composite should be represented as a relationship between
  objects rather than as one enormous enclosing subtree.
- Place candidates in a best-first priority queue instead of eliminating broader or
  intermediate candidates upfront. Initial priority can combine proximity to the edited
  nodes, subtree compactness, message/code lexical anchors, edit-operation agreement,
  and recurrence across other records in the same semantic cluster.
- Queue priority controls evaluation order, not truth. Preserve competing candidates
  until alignment evidence clearly separates them, and leave a claim unresolved when
  the evidence is insufficient.

## Revised experiment workflow

```mermaid
flowchart TD
    A[CommitPackFT Python and JavaScript records] --> B[Remove generated, lockfile, formatting-only, and unusable records]
    B --> C[Preserve each complete record: natural-language diff message plus full code diff]

    C --> D[Split each message into semantically separable claims while preserving record links]
    D --> E[Embed only the message-derived claims]
    E --> F[Cluster claims by semantic meaning]
    F --> G[LLM proposes a human-readable meaning from all member claims]
    G --> H[Estimate meaning confidence from member agreement and embedding cohesion]
    H --> I[Candidate semantic term]
    H --> J{Stable semantic subgroups remain?}
    J -- Yes --> K[Re-cluster member claims within this cluster]
    K --> G
    J -- No --> L[Stop semantic refinement on this branch]

    C --> M[Parse before and after code and derive AST edit evidence]
    M --> N[Partition each diff into localized edit objects at a flexible code scale]
    N --> O[Group nearby or overlapping additions and removals as a likely shared object]
    N --> P[Keep structurally separate edits as separate candidate objects]

    I --> Q[For every member claim, align it with edit objects from the same record]
    O --> Q
    P --> Q
    Q --> R{How is this claim realized in code?}
    R -- One object --> S[One localized object independently supports the claim]
    R -- Multiple independent objects --> T[Each object independently supports the claim]
    R -- Multiple jointly necessary objects --> U[Only the combined objects support the claim]
    S --> V[For this claim, unaligned objects are negative or contextual evidence]
    T --> V
    U --> V
    V --> V2[The same object may still be positive for another claim from the message]

    V2 --> W[All-member structural audit for the semantic term]
    W --> X[Infer a recurring AST edit rule with metavariables, options, repetition, and alternatives]
    X --> Y[Validate against positive and negative objects, repositories, commits, coverage, and confidence]
    Y --> Z{Does recurring code evidence support the semantic term?}
    Z -- Yes --> AA[Register grounded term: meaning, structural rule, evidence, and confidence]
    Z -- No --> AB[Reject, leave unresolved, or return claims to semantic refinement]
    AB --> K

    AA --> AC[Relate broader, narrower, overlapping, and set-difference terms in the taxonomy]

    AD[Addition and removal balance] -. metadata and evaluation slice only .-> N
```
