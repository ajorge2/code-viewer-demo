#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { graphForResult, renderGSpan } from "./lib/pilot.js";

const rootArgument = process.argv.indexOf("--pilot-root");
const pilotRoot = rootArgument >= 0
  ? path.resolve(process.argv[rootArgument + 1])
  : path.resolve(".data/intent-sweep-additive-2000");

const rows = (await readFile(path.join(pilotRoot, "sample-results.jsonl"), "utf8"))
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);

const expansionRecords = rows.filter((row) => (
  row.addition_dominant
  && row.analysis?.ok
  && Array.isArray(row.components)
  && row.components.length > 0
));
const graphs = expansionRecords.map(graphForResult);
const graphIndex = Object.fromEntries(
  expansionRecords.map((record, index) => [index, record.sample_id]),
);
const gspan = renderGSpan(graphs);
const componentCounts = expansionRecords.reduce((counts, record) => {
  const key = String(record.component_count);
  counts[key] = (counts[key] || 0) + 1;
  return counts;
}, {});
const summary = {
  policy: "addition-dominant parsed changes with one or more components; no component-count ceiling",
  records: expansionRecords.length,
  queue_base_records: expansionRecords.filter((record) => record.component_count <= 3).length,
  complex_expansion_records: expansionRecords.filter((record) => record.component_count > 3).length,
  maximum_component_count: Math.max(...expansionRecords.map((record) => record.component_count)),
  component_count_distribution: componentCounts,
};

await Promise.all([
  writeFile(path.join(pilotRoot, "expansion-change-graphs.data"), gspan.text),
  writeFile(path.join(pilotRoot, "expansion-gspan-labels.json"), `${JSON.stringify(gspan.labels, null, 2)}\n`),
  writeFile(path.join(pilotRoot, "expansion-graph-index.json"), `${JSON.stringify(graphIndex, null, 2)}\n`),
  writeFile(path.join(pilotRoot, "expansion-pool-summary.json"), `${JSON.stringify(summary, null, 2)}\n`),
]);

console.log(
  `Wrote ${summary.records} expansion graphs: ${summary.queue_base_records} queue-sized and `
  + `${summary.complex_expansion_records} complex changes (max ${summary.maximum_component_count} components)`,
);
