import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadReviews,
  upsertClusterReview,
  upsertReview,
  validateClusterReview,
  validateReview,
} from "../experiments/intent-algebra/lib/review-store.js";

const candidateIds = new Set(["PILOT_GSPAN_0001"]);
const clusterIds = new Set(["EMBED_CONCEPT_0001"]);
const suggestionIds = new Map([["EMBED_CONCEPT_0001", new Set(["python_packaging"])]]);

test("human review validation requires a meaning and scores for a shared intent", () => {
  assert.throws(() => validateReview({
    reviewer_id: "reviewer-1",
    candidate_id: "PILOT_GSPAN_0001",
    shared_intent: "yes",
    confidence: 4,
  }, candidateIds), /output_meaning/);

  const review = validateReview({
    reviewer_id: "reviewer-1",
    candidate_id: "PILOT_GSPAN_0001",
    shared_intent: "yes",
    output_meaning: "Increase the test timeout",
    entailment: 5,
    specificity: 4,
    confidence: 4,
  }, candidateIds);
  assert.equal(review.output_meaning, "Increase the test timeout");
  assert.equal(review.entailment, 5);
});

test("human review validation allows rejection without a fabricated meaning", () => {
  const review = validateReview({
    reviewer_id: "reviewer_2",
    candidate_id: "PILOT_GSPAN_0001",
    shared_intent: "no",
    confidence: 5,
    notes: "Examples only share string-update syntax.",
  }, candidateIds);
  assert.equal(review.output_meaning, null);
  assert.equal(review.entailment, null);
});

test("review storage upserts one reviewer-candidate pair without overwriting others", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "intent-reviews-"));
  const file = path.join(directory, "reviews.json");
  try {
    await upsertReview(file, { reviewer_id: "a", candidate_id: "one", shared_intent: "no" }, new Date("2026-01-01T00:00:00Z"));
    await upsertReview(file, { reviewer_id: "b", candidate_id: "one", shared_intent: "yes" }, new Date("2026-01-02T00:00:00Z"));
    await upsertReview(file, { reviewer_id: "a", candidate_id: "one", shared_intent: "uncertain" }, new Date("2026-01-03T00:00:00Z"));
    const reviews = await loadReviews(file);
    assert.equal(reviews.length, 2);
    assert.equal(reviews.find((review) => review.reviewer_id === "a").shared_intent, "uncertain");
    assert.equal(reviews.find((review) => review.reviewer_id === "a").created_at, "2026-01-01T00:00:00.000Z");
    assert.match(await readFile(file, "utf8"), /reviewer_id/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cluster interpretation validation preserves a selected noun concept", () => {
  const review = validateClusterReview({
    reviewer_id: "reviewer-1",
    cluster_id: "EMBED_CONCEPT_0001",
    shared_concept: "yes",
    suggestion_id: "python_packaging",
    interpretation: "Python packaging",
    fit: 5,
    breadth: "usable",
    confidence: 4,
  }, clusterIds, suggestionIds);
  assert.equal(review.interpretation, "Python packaging");
  assert.equal(review.suggestion_id, "python_packaging");
  assert.equal(review.fit, 5);
});

test("cluster interpretation validation rejects cross-cluster suggestions", () => {
  assert.throws(() => validateClusterReview({
    reviewer_id: "reviewer-1",
    cluster_id: "EMBED_CONCEPT_0001",
    shared_concept: "yes",
    suggestion_id: "authentication_endpoints",
    interpretation: "Authentication endpoints",
    fit: 4,
    breadth: "usable",
    confidence: 4,
  }, clusterIds, suggestionIds), /suggestion_id/);
});

test("cluster review storage upserts one reviewer-cluster pair", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cluster-reviews-"));
  const file = path.join(directory, "reviews.json");
  try {
    await upsertClusterReview(file, {
      reviewer_id: "a",
      cluster_id: "EMBED_CONCEPT_0001",
      shared_concept: "yes",
      interpretation: "Project tooling",
    }, new Date("2026-01-01T00:00:00Z"));
    await upsertClusterReview(file, {
      reviewer_id: "a",
      cluster_id: "EMBED_CONCEPT_0001",
      shared_concept: "no",
      interpretation: null,
    }, new Date("2026-01-02T00:00:00Z"));
    const reviews = await loadReviews(file);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].shared_concept, "no");
    assert.equal(reviews[0].created_at, "2026-01-01T00:00:00.000Z");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
