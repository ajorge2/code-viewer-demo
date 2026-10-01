#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import process from "node:process";

function parseArguments(argv) {
  const options = {
    samples: ".data/intent-sweep-additive-5000/sample-results.jsonl",
    dataRoot: ".data/commitpackft/data",
    output: ".data/intent-sweep-additive-5000/paired-corpus",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => argv[++index];
    if (argument === "--samples") options.samples = next();
    else if (argument === "--data-root") options.dataRoot = next();
    else if (argument === "--output") options.output = next();
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function eligibleSamples(samplePath) {
  const byLanguage = new Map();
  const lines = createInterface({ input: createReadStream(samplePath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const sample = JSON.parse(line);
    if (!sample.eligible) continue;
    if (!byLanguage.has(sample.language)) byLanguage.set(sample.language, new Map());
    byLanguage.get(sample.language).set(sample.row_index, sample);
  }
  return byLanguage;
}

async function materializeLanguage(language, wanted, options, manifest) {
  const source = path.join(options.dataRoot, language, "data.jsonl");
  const extension = language === "python" ? ".py" : ".js";
  const beforeDir = path.join(options.output, "before", language);
  const afterDir = path.join(options.output, "after", language);
  await Promise.all([
    mkdir(beforeDir, { recursive: true }),
    mkdir(afterDir, { recursive: true }),
  ]);
  const lines = createInterface({ input: createReadStream(source), crlfDelay: Infinity });
  let rowIndex = 0;
  for await (const line of lines) {
    rowIndex += 1;
    const sample = wanted.get(rowIndex);
    if (!sample) continue;
    const row = JSON.parse(line);
    const basename = `${row.commit}${extension}`;
    const beforePath = path.join(beforeDir, basename);
    const afterPath = path.join(afterDir, basename);
    await Promise.all([
      writeFile(beforePath, row.old_contents, "utf8"),
      writeFile(afterPath, row.new_contents, "utf8"),
    ]);
    manifest.push({
      sample_id: sample.sample_id,
      language,
      row_index: rowIndex,
      before_path: beforePath,
      after_path: afterPath,
    });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const byLanguage = await eligibleSamples(options.samples);
  const manifest = [];
  for (const [language, wanted] of byLanguage) {
    await materializeLanguage(language, wanted, options, manifest);
  }
  manifest.sort((left, right) => left.sample_id.localeCompare(right.sample_id));
  await mkdir(options.output, { recursive: true });
  await writeFile(
    path.join(options.output, "manifest.json"),
    `${JSON.stringify({ records: manifest.length, samples: manifest }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Materialized ${manifest.length} paired files under ${options.output}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
