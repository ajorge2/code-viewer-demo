#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  loadReviews,
  upsertClusterReview,
  upsertReview,
  validateClusterReview,
  validateReview,
} from "./lib/review-store.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const staticRoot = path.join(projectRoot, "experiments/intent-algebra/review-ui");
const queuePath = process.env.INTENT_GROUNDING_QUEUE
  || path.join(projectRoot, ".data/intent-pilot/grounding-queue.jsonl");
const reviewPath = process.env.INTENT_HUMAN_REVIEWS
  || path.join(projectRoot, ".data/intent-pilot/human-reviews.json");
const clusterPath = process.env.INTENT_CONCEPT_CLUSTERS
  || path.join(projectRoot, ".data/intent-pilot-additive/embedding-concept-clusters.json");
const clusterReviewPath = process.env.INTENT_CLUSTER_REVIEWS
  || path.join(projectRoot, ".data/intent-pilot-additive/human-cluster-interpretations.json");
const clusterSamplesPath = process.env.INTENT_CLUSTER_SAMPLES
  || path.join(projectRoot, ".data/intent-pilot-additive/sample-results.jsonl");
const clusterSuggestionsPath = path.join(
  projectRoot,
  "experiments/intent-algebra/cluster-interpretation-suggestions.json",
);
const portArgument = process.argv.indexOf("--port");
const port = portArgument >= 0 ? Number(process.argv[portArgument + 1]) : 4317;

async function readQueue() {
  const candidates = [];
  const input = createReadStream(queuePath);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) candidates.push(JSON.parse(line));
  return candidates;
}

async function readJsonl(pathname, include = () => true) {
  const records = [];
  const input = createReadStream(pathname);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (include(record)) records.push(record);
  }
  return records;
}

const candidates = await readQueue();
const candidateIds = new Set(candidates.map((candidate) => candidate.candidate_id));
const queueHash = createHash("sha256")
  .update(await readFile(queuePath))
  .digest("hex");
const clusterSource = await readFile(clusterPath);
const clusterHash = createHash("sha256").update(clusterSource).digest("hex");
const clusterPayload = JSON.parse(clusterSource);
const clusterSuggestions = JSON.parse(await readFile(clusterSuggestionsPath, "utf8"));
const clusterSampleIds = new Set(clusterPayload.clusters.flatMap((cluster) =>
  cluster.members.map((member) => member.sample_id)));
const clusterSamples = new Map((await readJsonl(
  clusterSamplesPath,
  (sample) => clusterSampleIds.has(sample.sample_id),
)).map((sample) => [sample.sample_id, sample]));
const clusters = clusterPayload.clusters.map((cluster) => ({
  ...cluster,
  suggestions: clusterSuggestions[cluster.cluster_id] || [],
  evidence: cluster.members.map((member) => ({
    ...member,
    ...clusterSamples.get(member.sample_id),
  })),
}));
const clusterIds = new Set(clusters.map((cluster) => cluster.cluster_id));
const suggestionIdsByCluster = new Map(clusters.map((cluster) => [
  cluster.cluster_id,
  new Set(cluster.suggestions.map((suggestion) => suggestion.id)),
]));

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function bodyJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_000_000) throw new Error("Request body exceeds 1 MB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(response, filename, contentType) {
  try {
    const content = await readFile(path.join(staticRoot, filename));
    response.writeHead(200, {
      "content-type": `${contentType}; charset=utf-8`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'",
    });
    response.end(content);
  } catch (error) {
    json(response, error.code === "ENOENT" ? 404 : 500, { error: error.message });
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/") {
      await serveStatic(response, "index.html", "text/html");
    } else if (request.method === "GET" && url.pathname === "/clusters") {
      await serveStatic(response, "clusters.html", "text/html");
    } else if (request.method === "GET" && url.pathname === "/review.js") {
      await serveStatic(response, "review.js", "text/javascript");
    } else if (request.method === "GET" && url.pathname === "/cluster-review.js") {
      await serveStatic(response, "cluster-review.js", "text/javascript");
    } else if (request.method === "GET" && url.pathname === "/review.css") {
      await serveStatic(response, "review.css", "text/css");
    } else if (request.method === "GET" && url.pathname === "/text-diff.js") {
      await serveStatic(response, "text-diff.js", "text/javascript");
    } else if (request.method === "GET" && url.pathname === "/api/state") {
      const reviewerId = String(url.searchParams.get("reviewer_id") || "");
      const reviews = (await loadReviews(reviewPath))
        .filter((review) => review.reviewer_id === reviewerId);
      json(response, 200, { candidates, reviews, queue_sha256: queueHash });
    } else if (request.method === "GET" && url.pathname === "/api/export") {
      json(response, 200, { queue_sha256: queueHash, reviews: await loadReviews(reviewPath) });
    } else if (request.method === "GET" && url.pathname === "/api/clusters/state") {
      const reviewerId = String(url.searchParams.get("reviewer_id") || "");
      const reviews = (await loadReviews(clusterReviewPath))
        .filter((review) => review.reviewer_id === reviewerId);
      json(response, 200, { clusters, reviews, cluster_sha256: clusterHash });
    } else if (request.method === "GET" && url.pathname === "/api/clusters/export") {
      json(response, 200, {
        cluster_sha256: clusterHash,
        reviews: await loadReviews(clusterReviewPath),
      });
    } else if (request.method === "POST" && url.pathname === "/api/reviews") {
      const review = validateReview(await bodyJson(request), candidateIds);
      const saved = await upsertReview(reviewPath, { ...review, queue_sha256: queueHash });
      json(response, 200, { saved });
    } else if (request.method === "POST" && url.pathname === "/api/clusters/reviews") {
      const review = validateClusterReview(
        await bodyJson(request),
        clusterIds,
        suggestionIdsByCluster,
      );
      const saved = await upsertClusterReview(
        clusterReviewPath,
        { ...review, cluster_sha256: clusterHash },
      );
      json(response, 200, { saved });
    } else {
      json(response, 404, { error: "Not found" });
    }
  } catch (error) {
    json(response, 400, { error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Intent Algebra human review: http://127.0.0.1:${port}`);
  console.log(`Semantic cluster review: http://127.0.0.1:${port}/clusters`);
  console.log(`Candidates: ${candidates.length}; reviews: ${reviewPath}`);
  console.log(`Clusters: ${clusters.length}; reviews: ${clusterReviewPath}`);
});
