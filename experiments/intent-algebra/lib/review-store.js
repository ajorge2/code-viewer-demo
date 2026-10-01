import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const SHARED_INTENT = new Set(["yes", "no", "uncertain"]);
const BREADTH = new Set(["too_broad", "usable", "too_narrow"]);

function cleanText(value, maximum) {
  return String(value ?? "").trim().slice(0, maximum);
}

function score(value, field, required) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new Error(`${field} is required when a shared intent is proposed`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    throw new Error(`${field} must be an integer from 1 to 5`);
  }
  return parsed;
}

export function validateReview(input, candidateIds) {
  const reviewerId = cleanText(input.reviewer_id, 64);
  const candidateId = cleanText(input.candidate_id, 128);
  const sharedIntent = cleanText(input.shared_intent, 16);
  const outputMeaning = cleanText(input.output_meaning, 240);

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(reviewerId)) {
    throw new Error("reviewer_id must use 1–64 letters, numbers, dots, underscores, or hyphens");
  }
  if (!candidateIds.has(candidateId)) throw new Error("Unknown candidate_id");
  if (!SHARED_INTENT.has(sharedIntent)) {
    throw new Error("shared_intent must be yes, no, or uncertain");
  }
  if (sharedIntent === "yes" && outputMeaning.length < 3) {
    throw new Error("output_meaning is required when shared_intent is yes");
  }

  const requiresScores = sharedIntent === "yes";
  return {
    reviewer_id: reviewerId,
    candidate_id: candidateId,
    shared_intent: sharedIntent,
    output_meaning: requiresScores ? outputMeaning : null,
    entailment: requiresScores ? score(input.entailment, "entailment", true) : null,
    specificity: requiresScores ? score(input.specificity, "specificity", true) : null,
    confidence: score(input.confidence, "confidence", true),
    notes: cleanText(input.notes, 2_000) || null,
  };
}

export function validateClusterReview(input, clusterIds, suggestionIdsByCluster) {
  const reviewerId = cleanText(input.reviewer_id, 64);
  const clusterId = cleanText(input.cluster_id, 128);
  const sharedConcept = cleanText(input.shared_concept, 16);
  const suggestionId = cleanText(input.suggestion_id, 128);
  const interpretation = cleanText(input.interpretation, 240);
  const breadth = cleanText(input.breadth, 24);

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(reviewerId)) {
    throw new Error("reviewer_id must use 1–64 letters, numbers, dots, underscores, or hyphens");
  }
  if (!clusterIds.has(clusterId)) throw new Error("Unknown cluster_id");
  if (!SHARED_INTENT.has(sharedConcept)) {
    throw new Error("shared_concept must be yes, no, or uncertain");
  }

  const requiresInterpretation = sharedConcept === "yes";
  if (requiresInterpretation && interpretation.length < 3) {
    throw new Error("interpretation is required when a shared concept is proposed");
  }
  if (suggestionId && !suggestionIdsByCluster.get(clusterId)?.has(suggestionId)) {
    throw new Error("Unknown suggestion_id for this cluster");
  }
  if (requiresInterpretation && !BREADTH.has(breadth)) {
    throw new Error("breadth must be too_broad, usable, or too_narrow");
  }

  return {
    reviewer_id: reviewerId,
    cluster_id: clusterId,
    shared_concept: sharedConcept,
    suggestion_id: requiresInterpretation ? suggestionId || null : null,
    interpretation: requiresInterpretation ? interpretation : null,
    fit: requiresInterpretation ? score(input.fit, "fit", true) : null,
    breadth: requiresInterpretation ? breadth : null,
    confidence: score(input.confidence, "confidence", true),
    notes: cleanText(input.notes, 2_000) || null,
  };
}

export async function loadReviews(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("Review store must contain a JSON array");
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function upsertReview(filePath, review, now = new Date()) {
  const reviews = await loadReviews(filePath);
  const index = reviews.findIndex((item) =>
    item.reviewer_id === review.reviewer_id && item.candidate_id === review.candidate_id);
  const timestamp = now.toISOString();
  const record = {
    ...review,
    created_at: index >= 0 ? reviews[index].created_at : timestamp,
    updated_at: timestamp,
  };
  if (index >= 0) reviews[index] = record;
  else reviews.push(record);
  reviews.sort((left, right) =>
    left.reviewer_id.localeCompare(right.reviewer_id)
      || left.candidate_id.localeCompare(right.candidate_id));

  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(reviews, null, 2)}\n`);
  await rename(temporary, filePath);
  return record;
}

export async function upsertClusterReview(filePath, review, now = new Date()) {
  const reviews = await loadReviews(filePath);
  const index = reviews.findIndex((item) =>
    item.reviewer_id === review.reviewer_id && item.cluster_id === review.cluster_id);
  const timestamp = now.toISOString();
  const record = {
    ...review,
    created_at: index >= 0 ? reviews[index].created_at : timestamp,
    updated_at: timestamp,
  };
  if (index >= 0) reviews[index] = record;
  else reviews.push(record);
  reviews.sort((left, right) =>
    left.reviewer_id.localeCompare(right.reviewer_id)
      || left.cluster_id.localeCompare(right.cluster_id));

  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(reviews, null, 2)}\n`);
  await rename(temporary, filePath);
  return record;
}
