#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { deriveEditFacets } from "./lib/facets.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rootArgument = process.argv.indexOf("--pilot-root");
const pilotRoot = rootArgument >= 0
  ? path.resolve(process.argv[rootArgument + 1])
  : path.join(projectRoot, ".data/intent-pilot-additive");
const inputPath = path.join(pilotRoot, "sample-results.jsonl");
const outputPath = path.join(pilotRoot, "edit-facets.jsonl");
const summaryPath = path.join(pilotRoot, "facet-summary.json");

function counts(values) {
  return Object.fromEntries([...values.reduce((result, value) => {
    result.set(value, (result.get(value) || 0) + 1);
    return result;
  }, new Map())].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

async function main() {
  const records = [];
  const lines = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const result = JSON.parse(line);
    if (result.eligible) records.push(deriveEditFacets(result));
  }

  const topicTokens = records.flatMap((record) => [
    ...record.concept_tokens.changed_code,
    ...record.concept_tokens.file_path,
    ...record.concept_tokens.commit_subject,
  ]);
  const summary = {
    generated_at: new Date().toISOString(),
    source: path.relative(projectRoot, inputPath),
    record_count: records.length,
    primary_entities: counts(records.map((record) => record.primary_entity_name)),
    operations: counts(records.flatMap((record) => record.operations)),
    containers: counts(records.flatMap((record) => record.containers.map((container) => container.name))),
    concept_tokens: counts(topicTokens),
    note: "Entity names are noun-only orthogonal facets; concept tokens are overlapping inputs for later fuzzy clustering.",
  };

  await mkdir(pilotRoot, { recursive: true });
  await Promise.all([
    writeFile(outputPath, `${records.map(JSON.stringify).join("\n")}\n`),
    writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`),
  ]);
  console.log(`Wrote ${records.length} faceted edit records to ${outputPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
