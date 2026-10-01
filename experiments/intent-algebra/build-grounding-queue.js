#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rootArgument = process.argv.indexOf("--pilot-root");
const pilotRoot = rootArgument >= 0
  ? path.resolve(process.argv[rootArgument + 1])
  : path.join(projectRoot, ".data/intent-pilot");
const resultPath = path.join(pilotRoot, "sample-results.jsonl");
const patternPath = path.join(pilotRoot, "mined-patterns.json");
const summaryPath = path.join(pilotRoot, "summary.json");
const outputPath = path.join(pilotRoot, "grounding-queue.jsonl");

async function loadResults() {
  const byId = new Map();
  const lines = createInterface({ input: createReadStream(resultPath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const result = JSON.parse(line);
    byId.set(result.sample_id, result);
  }
  return byId;
}

async function main() {
  const [mining, results, summary] = await Promise.all([
    readFile(patternPath, "utf8").then(JSON.parse),
    loadResults(),
    readFile(summaryPath, "utf8").then(JSON.parse),
  ]);

  const queue = mining.patterns.map((pattern) => ({
    candidate_id: `PILOT_GSPAN_${String(pattern.id).padStart(4, "0")}`,
    discovery_status: "pilot_only_below_registry_thresholds",
    pilot_graph_count: summary.totals.ast_eligible,
    support_in_pilot: pattern.support,
    independent_repository_support: null,
    corpus_commit_support: null,
    output_meaning: null,
    grounding_review: {
      shared_intent_exists: null,
      entailment: null,
      specificity: null,
      reviewer_notes: null,
    },
    graph: {
      nodes: pattern.nodes,
      edges: pattern.edges,
    },
    evidence: pattern.sample_ids.slice(0, 8).map((sampleId) => {
      const match = results.get(sampleId);
      return {
        sample_id: sampleId,
        language: match?.language,
        file: match?.file,
        subject: match?.subject,
        message: match?.message,
        before_excerpt: match?.before_excerpt,
        after_excerpt: match?.after_excerpt,
        repos: match?.repos,
      };
    }),
  }));

  await writeFile(outputPath, `${queue.map(JSON.stringify).join("\n")}\n`);
  console.log(`Prepared ${queue.length} pilot grounding candidates at ${outputPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
