#!/usr/bin/env node

import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  analysisExcerpts,
  canonicalPatchHash,
  cheapExclusionReason,
  deterministicSample,
  graphForResult,
  groupEditComponents,
  isAdditionDominant,
  renderGSpan,
  sha256,
  structuralSignature,
  summarizeAstChurn,
} from "./lib/pilot.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_DATA_ROOT = path.join(PROJECT_ROOT, ".data/commitpackft/data");
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, ".data/intent-pilot");
const DEFAULT_GUMTREE_JAR = path.join(
  PROJECT_ROOT,
  ".tools/gumtree-src/dist/build/install/gumtree/lib/gumtree.jar",
);
const JAVA_SOURCE = path.join(PROJECT_ROOT, "experiments/intent-algebra/GumTreeBatch.java");
const CLASS_DIR = path.join(PROJECT_ROOT, ".tools/intent-algebra/classes");
const LANGUAGES = ["python", "javascript"];
const EXTENSIONS = { python: ".py", javascript: ".js" };

function parseArguments(argv) {
  const options = {
    dataRoot: DEFAULT_DATA_ROOT,
    output: DEFAULT_OUTPUT,
    perLanguage: 100,
    languages: LANGUAGES,
    maxComponents: 3,
    additionDominantOnly: false,
    minAddedNodes: 2,
    maxRemovalRatio: 0.25,
    gumtreeJar: process.env.GUMTREE_JAR || DEFAULT_GUMTREE_JAR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value after ${argument}`);
      return argv[index];
    };
    if (argument === "--data-root") options.dataRoot = path.resolve(next());
    else if (argument === "--output") options.output = path.resolve(next());
    else if (argument === "--per-language") options.perLanguage = Number.parseInt(next(), 10);
    else if (argument === "--max-components") options.maxComponents = Number.parseInt(next(), 10);
    else if (argument === "--addition-dominant") options.additionDominantOnly = true;
    else if (argument === "--min-added-nodes") options.minAddedNodes = Number.parseInt(next(), 10);
    else if (argument === "--max-removal-ratio") options.maxRemovalRatio = Number.parseFloat(next());
    else if (argument === "--gumtree-jar") options.gumtreeJar = path.resolve(next());
    else if (argument === "--languages") options.languages = next().split(",");
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.languages.every((language) => LANGUAGES.includes(language))) {
    throw new Error(`Supported languages: ${LANGUAGES.join(", ")}`);
  }
  if (!Number.isInteger(options.perLanguage) || options.perLanguage < 1) {
    throw new Error("--per-language must be a positive integer");
  }
  if (!Number.isInteger(options.minAddedNodes) || options.minAddedNodes < 1) {
    throw new Error("--min-added-nodes must be a positive integer");
  }
  if (!Number.isFinite(options.maxRemovalRatio) || options.maxRemovalRatio < 0) {
    throw new Error("--max-removal-ratio must be a non-negative number");
  }
  return options;
}

function printHelp() {
  console.log(`Intent Algebra corpus pilot

Usage: node experiments/intent-algebra/run-pilot.js [options]

  --per-language N       Deterministic bottom-hash sample size (default: 100)
  --languages LIST       Comma-separated python,javascript (default: both)
  --max-components N     Observed-file AST component ceiling (default: 3)
  --addition-dominant    Require the configured addition/removal gate
  --min-added-nodes N    Minimum inserted/replacement AST nodes (default: 2)
  --max-removal-ratio N  Maximum removed/added AST-node ratio (default: 0.25)
  --data-root PATH       CommitPackFT data directory
  --output PATH          Output directory
  --gumtree-jar PATH     GumTree all-in-one JAR
`);
}

async function compileWorker(gumtreeJar) {
  await stat(gumtreeJar).catch(() => {
    throw new Error(
      `GumTree JAR not found at ${gumtreeJar}. See experiments/intent-algebra/README.md.`,
    );
  });
  await mkdir(CLASS_DIR, { recursive: true });
  const classFile = path.join(CLASS_DIR, "GumTreeBatch.class");
  const [sourceStats, classStats] = await Promise.all([
    stat(JAVA_SOURCE),
    stat(classFile).catch(() => null),
  ]);
  if (classStats && classStats.mtimeMs >= sourceStats.mtimeMs) return;

  const build = spawnSync("javac", ["-cp", gumtreeJar, "-d", CLASS_DIR, JAVA_SOURCE], {
    encoding: "utf8",
  });
  if (build.status !== 0) {
    throw new Error(`Failed to compile GumTree worker:\n${build.stderr || build.stdout}`);
  }
}

class GumTreeWorker {
  constructor(gumtreeJar) {
    this.gumtreeJar = gumtreeJar;
    this.pending = [];
    this.stderr = "";
  }

  async start() {
    const separator = process.platform === "win32" ? ";" : ":";
    this.child = spawn("java", ["-cp", `${CLASS_DIR}${separator}${this.gumtreeJar}`, "GumTreeBatch"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      const waiter = this.pending.shift();
      if (!waiter) return;
      try { waiter.resolve(JSON.parse(line)); }
      catch (error) { waiter.reject(new Error(`Invalid worker JSON: ${line}`, { cause: error })); }
    });
    this.child.on("exit", (code) => {
      const error = new Error(`GumTree worker exited with ${code}: ${this.stderr.trim()}`);
      while (this.pending.length) this.pending.shift().reject(error);
    });
    const ready = await this.readNext();
    if (!ready.ready) throw new Error(`GumTree worker did not become ready: ${JSON.stringify(ready)}`);
  }

  readNext() {
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  async analyze(id, beforePath, afterPath) {
    const response = this.readNext();
    this.child.stdin.write(`${id}\t${beforePath}\t${afterPath}\n`);
    return response;
  }

  async close() {
    if (!this.child) return;
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await new Promise((resolve) => this.child.once("exit", resolve));
  }
}

async function selectRows(filePath, language, limit, counters) {
  const candidates = [];
  const patchHashes = new Set();
  const input = createReadStream(filePath);
  const fileHash = createHash("sha256");
  input.on("data", (chunk) => fileHash.update(chunk));
  const lines = createInterface({ input, crlfDelay: Infinity });
  let rowIndex = 0;

  for await (const line of lines) {
    rowIndex += 1;
    counters.raw += 1;
    let row;
    try { row = JSON.parse(line); }
    catch {
      counters.excluded.invalid_json = (counters.excluded.invalid_json || 0) + 1;
      continue;
    }

    const reason = cheapExclusionReason(row, language);
    if (reason) {
      counters.excluded[reason] = (counters.excluded[reason] || 0) + 1;
      continue;
    }

    const patchHash = canonicalPatchHash(row);
    if (patchHashes.has(patchHash)) {
      counters.excluded.duplicate_patch = (counters.excluded.duplicate_patch || 0) + 1;
      continue;
    }
    patchHashes.add(patchHash);
    counters.cheap_eligible += 1;
    candidates.push({
      row,
      row_index: rowIndex,
      patch_hash: patchHash,
      sample_key: sha256(`${language}:${row.commit}:${patchHash}`),
    });
  }
  return {
    sample: deterministicSample(candidates, limit),
    sha256: fileHash.digest("hex"),
  };
}

function resultRecord(language, candidate, analysis, options) {
  const { row } = candidate;
  const base = {
    sample_id: `${language}:${row.commit}`,
    language,
    commit: row.commit,
    row_index: candidate.row_index,
    file: row.new_file,
    subject: row.subject,
    message: row.message,
    license: row.license,
    repos: row.repos,
    repository_name_count: String(row.repos || "").split(",").filter(Boolean).length,
    patch_hash: candidate.patch_hash,
  };
  if (!analysis.ok) {
    return { ...base, eligible: false, exclusion_reason: "gumtree_error", analysis };
  }
  if (analysis.source_error_nodes || analysis.destination_error_nodes) {
    return { ...base, eligible: false, exclusion_reason: "parse_error_nodes", analysis };
  }
  if (!analysis.actions.length) {
    return { ...base, eligible: false, exclusion_reason: "no_ast_actions", analysis };
  }

  const components = groupEditComponents(analysis.actions);
  const astChurn = summarizeAstChurn(analysis.actions);
  const atomicEligible = components.length >= 1 && components.length <= options.maxComponents;
  const additionDominant = isAdditionDominant(astChurn, options);
  const eligible = atomicEligible && (!options.additionDominantOnly || additionDominant);
  const excerpts = analysisExcerpts(analysis, row.old_contents, row.new_contents);
  const persistedAnalysis = eligible
    ? analysis
    : {
      ...analysis,
      actions: analysis.actions.map(({ context_frames: _contextFrames, ...action }) => action),
    };
  return {
    ...base,
    eligible,
    exclusion_reason: eligible
      ? null
      : (atomicEligible && options.additionDominantOnly
        ? "not_addition_dominant"
        : "too_many_components"),
    component_count: components.length,
    components,
    atomic_eligible: atomicEligible,
    addition_dominant: additionDominant,
    ast_churn: astChurn,
    structural_signature: structuralSignature(analysis, components),
    before_excerpt: excerpts.before,
    after_excerpt: excerpts.after,
    analysis: persistedAnalysis,
  };
}

async function writeJsonl(filePath, rows) {
  const output = createWriteStream(filePath, { encoding: "utf8" });
  for (const row of rows) {
    if (!output.write(`${JSON.stringify(row)}\n`)) {
      await new Promise((resolve) => output.once("drain", resolve));
    }
  }
  output.end();
  await new Promise((resolve, reject) => {
    output.once("finish", resolve);
    output.once("error", reject);
  });
}

function markdownSummary(summary) {
  const exclusions = Object.entries(summary.excluded)
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => `| ${reason} | ${count.toLocaleString()} |`)
    .join("\n");
  const languages = Object.entries(summary.by_language)
    .map(([language, values]) => `| ${language} | ${values.raw.toLocaleString()} | ${values.cheap_eligible.toLocaleString()} | ${values.sampled} | ${values.ast_atomic} | ${values.ast_eligible} | ${values.not_addition_dominant} | ${values.too_many_components} | ${values.errors} |`)
    .join("\n");
  return `# Intent Algebra pilot summary

Generated: ${summary.generated_at}

| Language | Raw rows | After cheap filters | Sampled | 1–${summary.parameters.max_components} components | Addition-dominant | Removal gate rejected | >${summary.parameters.max_components} components | Parse/tool errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${languages}

## Cheap-filter exclusions

| Reason | Rows |
|---|---:|
${exclusions}

This is a deterministic bottom-hash pilot sample, not a corpus-scale discovery result. Repository names attached to one row are not counted as independent support.
`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  await compileWorker(options.gumtreeJar);
  await mkdir(options.output, { recursive: true });

  const summary = {
    generated_at: new Date().toISOString(),
    parameters: {
      languages: options.languages,
      per_language: options.perLanguage,
      max_components: options.maxComponents,
      addition_dominant_required: options.additionDominantOnly,
      min_added_nodes: options.minAddedNodes,
      max_removal_to_addition_ratio: options.maxRemovalRatio,
      churn_unit: "AST nodes; updates count as one removed and one added node",
      sampling: "lowest SHA-256(language, commit, canonical patch hash)",
      atomicity_scope: "observed file only",
    },
    excluded: {},
    by_language: {},
  };
  const selected = [];
  for (const language of options.languages) {
    const counters = { raw: 0, cheap_eligible: 0, excluded: {} };
    const input = path.join(options.dataRoot, language, "data.jsonl");
    console.log(`Scanning ${language}: ${input}`);
    const { sample, sha256: inputSha256 } = await selectRows(input, language, options.perLanguage, counters);
    const inputStats = await stat(input);
    selected.push(...sample.map((candidate) => ({ language, candidate })));
    summary.by_language[language] = {
      raw: counters.raw,
      cheap_eligible: counters.cheap_eligible,
      sampled: sample.length,
      ast_atomic: 0,
      ast_eligible: 0,
      not_addition_dominant: 0,
      too_many_components: 0,
      errors: 0,
      source_file: path.relative(PROJECT_ROOT, input),
      source_bytes: inputStats.size,
      source_sha256: inputSha256,
    };
    for (const [reason, count] of Object.entries(counters.excluded)) {
      summary.excluded[reason] = (summary.excluded[reason] || 0) + count;
    }
    console.log(`Selected ${sample.length} of ${counters.cheap_eligible} cheap-eligible ${language} rows`);
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), "intent-algebra-"));
  const worker = new GumTreeWorker(options.gumtreeJar);
  const results = [];
  try {
    await worker.start();
    for (let index = 0; index < selected.length; index += 1) {
      const { language, candidate } = selected[index];
      const extension = EXTENSIONS[language];
      const beforePath = path.join(temporary, `before${extension}`);
      const afterPath = path.join(temporary, `after${extension}`);
      await Promise.all([
        writeFile(beforePath, candidate.row.old_contents),
        writeFile(afterPath, candidate.row.new_contents),
      ]);
      const analysis = await worker.analyze(String(index), beforePath, afterPath);
      const result = resultRecord(language, candidate, analysis, options);
      results.push(result);
      const languageSummary = summary.by_language[language];
      if (result.atomic_eligible) languageSummary.ast_atomic += 1;
      if (result.eligible) languageSummary.ast_eligible += 1;
      else if (result.exclusion_reason === "not_addition_dominant") languageSummary.not_addition_dominant += 1;
      else if (result.exclusion_reason === "too_many_components") languageSummary.too_many_components += 1;
      else languageSummary.errors += 1;
      if ((index + 1) % 20 === 0 || index + 1 === selected.length) {
        console.log(`Analyzed ${index + 1}/${selected.length}`);
      }
    }
  } finally {
    await worker.close();
    await rm(temporary, { recursive: true, force: true });
  }

  const eligible = results.filter((result) => result.eligible);
  const graphs = eligible.map(graphForResult);
  const graphIndex = Object.fromEntries(eligible.map((result, index) => [index, result.sample_id]));
  const gspan = renderGSpan(graphs);
  const signatureCounts = Object.entries(Object.groupBy
    ? Object.groupBy(eligible, (result) => result.structural_signature)
    : eligible.reduce((groups, result) => {
      (groups[result.structural_signature] ||= []).push(result);
      return groups;
    }, {}))
    .map(([signature, matches]) => ({
      signature,
      support: matches.length,
      languages: [...new Set(matches.map((match) => match.language))].sort(),
      examples: matches.slice(0, 5).map((match) => match.sample_id),
    }))
    .sort((left, right) => right.support - left.support || left.signature.localeCompare(right.signature));

  summary.totals = {
    raw: Object.values(summary.by_language).reduce((sum, item) => sum + item.raw, 0),
    cheap_eligible: Object.values(summary.by_language).reduce((sum, item) => sum + item.cheap_eligible, 0),
    sampled: results.length,
    ast_atomic: Object.values(summary.by_language).reduce((sum, item) => sum + item.ast_atomic, 0),
    ast_eligible: eligible.length,
    not_addition_dominant: Object.values(summary.by_language).reduce((sum, item) => sum + item.not_addition_dominant, 0),
    unique_structural_signatures: signatureCounts.length,
  };

  await writeJsonl(path.join(options.output, "sample-results.jsonl"), results);
  await Promise.all([
    writeFile(path.join(options.output, "eligible-change-graphs.data"), gspan.text),
    writeFile(path.join(options.output, "gspan-labels.json"), `${JSON.stringify(gspan.labels, null, 2)}\n`),
    writeFile(path.join(options.output, "graph-index.json"), `${JSON.stringify(graphIndex, null, 2)}\n`),
    writeFile(path.join(options.output, "signature-counts.json"), `${JSON.stringify(signatureCounts, null, 2)}\n`),
    writeFile(path.join(options.output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`),
    writeFile(path.join(options.output, "summary.md"), markdownSummary(summary)),
  ]);
  console.log(`Wrote pilot artifacts to ${options.output}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
