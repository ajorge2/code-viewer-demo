import assert from "node:assert/strict";
import test from "node:test";
import {
  analysisExcerpts,
  canonicalPatchHash,
  cheapExclusionReason,
  deterministicSample,
  groupEditComponents,
  isAdditionDominant,
  renderGSpan,
  selectComponentAnchor,
  summarizeAstChurn,
} from "../experiments/intent-algebra/lib/pilot.js";

function action({ name = "update-node", side = "before", leaf, ancestors }) {
  return {
    action: name,
    side,
    node: {
      type: leaf,
      label: "value",
      start: ancestors[0].start,
      end: ancestors[0].end,
      ancestors,
    },
  };
}

test("cheap exclusions identify additions, generated files, and minified bundles", () => {
  assert.equal(cheapExclusionReason({ old_contents: "", new_contents: "x", new_file: "a.py" }, "python"), "file_addition");
  assert.equal(cheapExclusionReason({ old_contents: "x", new_contents: "y", new_file: "src/generated_api.py" }, "python"), "generated_name");
  assert.equal(cheapExclusionReason({ old_contents: "x", new_contents: "y", new_file: "app.min.js" }, "javascript"), "minified_or_bundle");
  assert.equal(cheapExclusionReason({ old_contents: "x", new_contents: "y", new_file: "src/app.py" }, "python"), null);
});

test("canonical patch hash ignores repository metadata but changes with code", () => {
  const first = { old_contents: "x = 1", new_contents: "x = 2", commit: "one" };
  const duplicate = { ...first, commit: "two", repos: "mirror/repo" };
  const changed = { ...first, new_contents: "x = 3" };
  assert.equal(canonicalPatchHash(first), canonicalPatchHash(duplicate));
  assert.notEqual(canonicalPatchHash(first), canonicalPatchHash(changed));
});

test("deterministic sampling is independent of input order", () => {
  const rows = [{ sample_key: "c" }, { sample_key: "a" }, { sample_key: "b" }];
  assert.deepEqual(deterministicSample(rows, 2).map((row) => row.sample_key), ["a", "b"]);
  assert.deepEqual(deterministicSample(rows.reverse(), 2).map((row) => row.sample_key), ["a", "b"]);
});

test("actions in the same statement form one component", () => {
  const statement = { type: "return_statement", start: 10, end: 32, child_index: 1 };
  const root = { type: "module", start: 0, end: 33, child_index: -1 };
  const actions = [
    action({ leaf: "identifier", ancestors: [{ type: "identifier", start: 17, end: 18 }, statement, root] }),
    action({ leaf: "integer", ancestors: [{ type: "integer", start: 21, end: 22 }, statement, root] }),
  ];
  assert.equal(selectComponentAnchor(actions[0]).type, "return_statement");
  const components = groupEditComponents(actions);
  assert.equal(components.length, 1);
  assert.deepEqual(components[0].action_indexes, [0, 1]);
});

test("independent statements remain separate components", () => {
  const root = { type: "program", start: 0, end: 80, child_index: -1 };
  const actions = [
    action({ leaf: "identifier", ancestors: [{ type: "identifier", start: 4, end: 5 }, { type: "lexical_declaration", start: 0, end: 12 }, root] }),
    action({ leaf: "identifier", ancestors: [{ type: "identifier", start: 42, end: 43 }, { type: "return_statement", start: 35, end: 48 }, root] }),
  ];
  assert.equal(groupEditComponents(actions).length, 2);
});

test("AST churn counts tree edits by subtree size and updates on both sides", () => {
  const churn = summarizeAstChurn([
    { action: "insert-tree", subtree: [{}, {}, {}, {}] },
    { action: "delete-node", subtree: [{}] },
    { action: "update-node", subtree: [{}] },
    { action: "move-tree", subtree: [{}, {}] },
  ]);
  assert.equal(churn.added_nodes, 5);
  assert.equal(churn.removed_nodes, 2);
  assert.equal(churn.net_added_nodes, 3);
  assert.equal(churn.removal_to_addition_ratio, 0.4);
  assert.equal(churn.moved_actions, 1);
});

test("addition dominance requires enough additions and caps removal burden", () => {
  assert.equal(isAdditionDominant({ added_nodes: 8, removal_to_addition_ratio: 0.25 }), true);
  assert.equal(isAdditionDominant({ added_nodes: 8, removal_to_addition_ratio: 0.26 }), false);
  assert.equal(isAdditionDominant({ added_nodes: 1, removal_to_addition_ratio: 0 }), false);
  assert.equal(isAdditionDominant({ added_nodes: 8, removal_to_addition_ratio: null }), false);
});

test("analysis excerpts use mapped nodes on both sides of an update", () => {
  const excerpts = analysisExcerpts({ actions: [{
    side: "before",
    node: { start: 4, end: 9 },
    mapped_node: { start: 4, end: 10 },
  }] }, "let old = 1;", "let newer = 1;");
  assert.match(excerpts.before, /old/);
  assert.match(excerpts.after, /newer/);
});

test("gSpan rendering has deterministic numeric labels and terminator", () => {
  const rendered = renderGSpan([{
    id: "example",
    vertices: [{ id: 0, label: "before:return_statement" }, { id: 1, label: "action:update-node" }],
    edges: [{ from: 1, to: 0, label: "affects" }],
  }]);
  assert.match(rendered.text, /^t # 0\nv 0 \d+\nv 1 \d+\nv 2 \d+\ne 1 2 \d+\ne 2 0 \d+\nt # -1\n$/);
  assert.ok(Object.values(rendered.labels.vertices).includes("action:update-node"));
  assert.ok(Object.values(rendered.labels.vertices).includes("relation:affects"));
});
