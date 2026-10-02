import assert from "node:assert/strict";
import test from "node:test";

import { buildCandidateUniverse } from "./prepare-message-code-records.js";

function node(type, start, end, children = []) {
  return { type, start, end, children };
}

test("multi-edit path candidates are ordered bottom-up from edits toward the LCA", () => {
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

  assert.deepEqual(candidates.slice(0, 3).map((candidate) => candidate.node_type), [
    "first_edit",
    "second_edit",
    "shared_block",
  ]);
  assert.deepEqual(
    candidates
      .filter((candidate) => candidate.roles.includes("path")
        && !candidate.roles.includes("overall_lca"))
      .map((candidate) => candidate.node_type),
    ["left_block", "right_block", "left_branch", "right_branch"],
  );
});
