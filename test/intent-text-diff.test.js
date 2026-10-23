import assert from "node:assert/strict";
import test from "node:test";
await import("../experiments/intent-algebra/review-ui/text-diff.js");

const { buildSideBySideDiff, diffLineTokens } = globalThis.IntentTextDiff;

test("side-by-side diff aligns modified, inserted, and deleted lines", () => {
  const result = buildSideBySideDiff(
    "const timeout = 1000;\nrun();\ncleanup();",
    "const timeout = 5000;\nlog('start');\nrun();",
    { context: Number.POSITIVE_INFINITY },
  );
  assert.deepEqual(result.stats, { added: 2, removed: 2, modified: 1 });
  assert.equal(result.rows[0].kind, "replace");
  assert.ok(result.rows[0].before.segments.some((segment) => segment.kind === "delete" && segment.text === "1000"));
  assert.ok(result.rows[0].after.segments.some((segment) => segment.kind === "insert" && segment.text === "5000"));
  assert.equal(result.rows[2].kind, "equal");
});

test("token diff isolates changed identifiers instead of highlighting the whole line", () => {
  const result = diffLineTokens("return oldValue;", "return newValue;");
  assert.deepEqual(result.before, [
    { kind: "equal", text: "return " },
    { kind: "delete", text: "oldValue" },
    { kind: "equal", text: ";" },
  ]);
  assert.deepEqual(result.after, [
    { kind: "equal", text: "return " },
    { kind: "insert", text: "newValue" },
    { kind: "equal", text: ";" },
  ]);
});

test("long unchanged runs collapse around the highlighted changes", () => {
  const before = ["a", "b", "c", "z", "old", "d", "e", "f", "g"].join("\n");
  const after = ["a", "b", "c", "z", "new", "d", "e", "f", "g"].join("\n");
  const result = buildSideBySideDiff(before, after, { context: 1 });
  assert.equal(result.rows.filter((row) => row.kind === "skip").length, 2);
  assert.ok(result.rows.some((row) => row.kind === "replace"));
});
