import assert from "node:assert/strict";
import test from "node:test";

import { buildCandidateUniverse } from "./prepare-message-code-records.js";

function node(type, start, end, children = []) {
  return { type, start, end, children };
}

test("multi-edit candidate sets include direct edits, the LCA, and every intermediate path", () => {
  const beforeTree = node("module", 0, 0);
  const firstEdit = node("first_edit", 30, 40);
  const secondEdit = node("second_edit", 70, 80);
  const afterTree = node("module", 0, 100, [
    node("function_definition", 5, 95, [
      node("shared_block", 10, 90, [
        node("left_branch", 20, 45, [
          node("left_block", 25, 42, [firstEdit]),
        ]),
        node("right_branch", 60, 85, [
          node("right_block", 65, 82, [secondEdit]),
        ]),
      ]),
    ]),
  ]);
  const analysis = {
    actions: [
      { action: "insert-node", side: "after", node: firstEdit },
      { action: "insert-node", side: "after", node: secondEdit },
    ],
  };

  const { candidates } = buildCandidateUniverse(
    beforeTree,
    afterTree,
    analysis,
    "",
    "x".repeat(100),
    64,
  );

  assert.deepEqual(new Set(candidates.map((candidate) => candidate.node_type)), new Set([
    "first_edit", "second_edit", "shared_block",
    "left_block", "right_block", "left_branch", "right_branch",
  ]));
  assert.equal(candidates.find((candidate) => candidate.node_type === "shared_block")
    .roles.includes("overall_lca"), true);
});

test("subset-LCA discovery remains bounded when many edits share the same LCA", () => {
  const directEdits = Array.from({ length: 20 }, (_, index) =>
    node(`edit_${index}`, index * 4 + 5, index * 4 + 7));
  const afterTree = node("module", 0, 100, [
    node("shared_block", 1, 90, directEdits),
  ]);
  const analysis = {
    actions: directEdits.map((edit) => ({
      action: "insert-node",
      side: "after",
      node: edit,
    })),
  };

  const { candidates } = buildCandidateUniverse(
    node("module", 0, 0),
    afterTree,
    analysis,
    "",
    "x".repeat(100),
    64,
  );

  assert.equal(candidates.filter((candidate) => candidate.roles.includes("direct_edit")).length, 20);
  assert.equal(candidates.filter((candidate) => candidate.roles.includes("overall_lca")).length, 1);
  assert.equal(candidates.filter((candidate) => candidate.roles.includes("subset_lca")).length, 0);
});
