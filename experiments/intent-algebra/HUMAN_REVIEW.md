# Human review protocol

The review task asks whether a mined structural candidate supports one reusable human
intent. It does **not** ask whether the commit messages sound similar.

## Independent pass

Each candidate should be reviewed independently by at least two people under distinct
reviewer IDs. Reviewers should not see one another's judgments before both passes finish.

For every candidate:

1. Read every before/after excerpt before relying on the commit subject or message.
2. Choose **Yes** only when one short verb–object phrase is entailed by every example.
3. Choose **No** when examples share syntax but perform different jobs. Do not rescue a
   mixed group with a vague label such as “update configuration” or “change behavior.”
4. Choose **Uncertain** when excerpts are incomplete or more evidence is required.
5. When choosing **Yes**, propose a concise meaning, then score:
   - **Entailment**: 1 contradicts the code; 5 is directly established by every diff.
   - **Specificity**: 1 is unusably vague; 5 is the most precise phrase that does not
     overclaim beyond the code.
   - **Confidence**: certainty in the judgment, not perceived pattern frequency.

Commit text can disambiguate a candidate but cannot override contradictory code.

## Adjudication and acceptance

- Any disagreement on `shared_intent` requires a third-person adjudication.
- Paraphrased meanings may be canonicalized only after agreement that a shared intent
  exists.
- Pilot candidates remain exploratory. Human agreement does not waive the registered
  requirements of 100 patch-distinct commits, 50 independent repository families, and
  the composite MDL threshold.
- Review data is stored locally at `.data/intent-pilot/human-reviews.json`, keyed by
  reviewer and candidate. The grounding queue hash is stored on every review so stale
  decisions can be detected after the queue changes.

Start the reviewer with:

```sh
npm run intent:review
```

Then open `http://127.0.0.1:4317`.

The evidence cards align before and after excerpts by line. Red marks removed code, green
marks added code, and darker spans isolate changed tokens within a modified line. Long
unchanged runs are collapsed by default; use **Show full context** to expand one example.

## Semantic cluster interpretation

Broad embedding clusters use a separate review at `http://127.0.0.1:4317/clusters`.
For each cluster, the reviewer sees every highlighted member diff and three deliberately
competing noun-level interpretations. Reviewers may select one, write a custom concept,
or reject the cluster as semantically mixed. They score fit across all members, whether
the interpretation is too broad/usable/too narrow, and confidence.

These judgments are stored separately in
`.data/intent-pilot-additive/human-cluster-interpretations.json`. Accepting a semantic
interpretation creates a macro-concept annotation only; it never promotes the embedding
cluster into a structural primitive.
