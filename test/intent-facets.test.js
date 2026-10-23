import assert from "node:assert/strict";
import test from "node:test";
import { conceptTokens, deriveEditFacets, entityForAction } from "../experiments/intent-algebra/lib/facets.js";

function action(type, subtree = [], ancestors = []) {
  return { action: "insert-tree", node: { type, ancestors: [{ type }, ...ancestors] }, subtree };
}

test("facet entities are noun constructs independent of the edit operation", () => {
  assert.equal(entityForAction(action("if_statement", [{ type: "call", label: "" }])), "conditional_guard");
  assert.equal(entityForAction(action("keyword_argument", [{ type: "identifier", label: "timeout" }])), "named_argument");
  assert.equal(entityForAction(action("pair", [{ type: "property_identifier", label: "cacheSize" }])), "object_property");
});

test("faceted edits separate operation, entity, container, and concept tokens", () => {
  const result = {
    sample_id: "python:abc",
    language: "python",
    file: "services/cache/store.py",
    subject: "Check cache entry before database lookup",
    analysis: { actions: [action("if_statement", [
      { type: "identifier", label: "cache_entry" },
      { type: "attribute", label: "database" },
    ], [{ type: "function_definition" }])] },
  };
  const facets = deriveEditFacets(result);
  assert.deepEqual(facets.operations, ["insert"]);
  assert.equal(facets.primary_entity_name, "conditional guard");
  assert.deepEqual(facets.containers.map((container) => container.name), ["function"]);
  assert.ok(facets.concept_tokens.changed_code.includes("cache"));
  assert.ok(facets.concept_tokens.changed_code.includes("database"));
});

test("concept tokens preserve domain nouns while dropping edit boilerplate", () => {
  const tokens = conceptTokens({
    file: "src/database/cache_store.py",
    subject: "Add cache invalidation for database records",
    analysis: { actions: [{ subtree: [{ type: "identifier", label: "invalidateCache" }] }] },
  });
  assert.ok(tokens.changed_code.includes("cache"));
  assert.ok(tokens.file_path.includes("database"));
  assert.ok(tokens.commit_subject.includes("invalidation"));
  assert.ok(!tokens.commit_subject.includes("add"));
});
