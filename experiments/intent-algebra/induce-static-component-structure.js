#!/usr/bin/env node

// Induce cross-language structural rules for one static component candidate.
//
// The script reconstructs the same repository-disjoint 500-file pool used by the
// open-vocabulary feedback loop, parses complete Python/JavaScript files with the
// project's Tree-sitter runtime, abstracts language-specific nodes into semantic
// roles, and learns a small OR of recurring AND clauses. Leave-one-positive-out
// evaluation prevents the seven-file pilot from reporting an in-sample fit as proof.

import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import process from "node:process";
import { parseToTree } from "../../server/ingest/parseTree.js";

const LANGUAGES = ["python", "javascript"];
const EXTENSIONS = {
  python: new Set([".py"]),
  javascript: new Set([".js", ".jsx", ".mjs", ".cjs"]),
};
const NOISY_PARTS = new Set([
  "benchmark", "benchmarks", "build", "dist", "docs", "examples", "fixtures",
  "generated", "node_modules", "test", "tests", "testing", "vendor",
]);
const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "poetry.lock", "yarn.lock"]);
const CALL_ANCHORS = [
  "replace", "split", "join", "strip", "trim", "lower", "lowercase", "upper",
  "uppercase", "capitalize", "title", "format", "match", "search", "sub", "subn",
  "encode", "decode", "parse", "sanitize", "escape", "normalize", "startswith",
  "endswith", "test",
];

function parseArguments(argv) {
  const options = {
    dataRoot: ".data/commitpackft/data",
    discoverySamples: ".data/intent-sweep-additive-5000/sample-results.jsonl",
    staticCoverage: ".data/intent-sweep-additive-5000/static-component-coverage.json",
    gapExpansions: ".data/intent-sweep-additive-5000/static-gap-expansions.json",
    output: ".data/intent-sweep-additive-5000/static-component-structure.json",
    category: "String processing algorithms",
    poolPerLanguage: 250,
    minimumChars: 300,
    maximumSourceChars: 50_000,
    maximumClauses: 4,
    maximumAtomsPerClause: 3,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => argv[++index];
    if (argument === "--data-root") options.dataRoot = next();
    else if (argument === "--discovery-samples") options.discoverySamples = next();
    else if (argument === "--static-coverage") options.staticCoverage = next();
    else if (argument === "--gap-expansions") options.gapExpansions = next();
    else if (argument === "--output") options.output = next();
    else if (argument === "--category") options.category = next();
    else if (argument === "--pool-per-language") options.poolPerLanguage = Number.parseInt(next(), 10);
    else if (argument === "--maximum-clauses") options.maximumClauses = Number.parseInt(next(), 10);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function aliases(value) {
  return new Set((value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function intersects(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function cleanPath(value) {
  return (value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function eligibleSource(language, file, contents, options) {
  const normalized = cleanPath(file).toLowerCase();
  const parts = normalized.split("/");
  const basename = parts.at(-1) || "";
  const extension = path.posix.extname(basename);
  if (LOCKFILES.has(basename) || !EXTENSIONS[language].has(extension)) return false;
  if (parts.slice(0, -1).some((part) => NOISY_PARTS.has(part))) return false;
  if (/(?:^|[._-])(?:min|bundle|generated|gen)(?:[._-]|$)/i.test(basename)) return false;
  if (contents.length < options.minimumChars || contents.length > options.maximumSourceChars) return false;
  const lines = contents.split("\n");
  if (lines.length < 5 || lines.some((line) => line.length > 1_000)) return false;
  return true;
}

async function readJsonLines(file, visit) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let rowIndex = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    rowIndex += 1;
    await visit(JSON.parse(line), rowIndex);
  }
}

async function discoveryMetadata(file) {
  const seenAliases = new Set();
  const rows = new Map(LANGUAGES.map((language) => [language, new Set()]));
  await readJsonLines(file, async (sample) => {
    for (const value of aliases(sample.repos)) seenAliases.add(value);
    rows.get(sample.language)?.add(Number(sample.row_index));
  });
  return { aliases: seenAliases, rows };
}

async function unseenPool(options) {
  const discovery = await discoveryMetadata(options.discoverySamples);
  const selected = [];
  for (const language of LANGUAGES) {
    const bestByRepository = new Map();
    await readJsonLines(path.join(options.dataRoot, language, "data.jsonl"), async (row, rowIndex) => {
      if (discovery.rows.get(language).has(rowIndex)) return;
      const rowAliases = aliases(row.repos);
      if (!rowAliases.size || intersects(rowAliases, discovery.aliases)) return;
      const file = cleanPath(row.new_file);
      const contents = row.new_contents || "";
      if (!eligibleSource(language, file, contents, options)) return;
      const repository = [...rowAliases].sort()[0];
      const stableKey = sha256(`${language}\0${repository}\0${row.commit || ""}\0${file}`);
      const item = {
        sample_id: `STATIC_${language.toUpperCase()}_${stableKey.slice(0, 12).toUpperCase()}`,
        language,
        row_index: rowIndex,
        commit: row.commit || "",
        repository,
        file,
        contents,
        code_hash: sha256(contents),
      };
      const previous = bestByRepository.get(repository);
      if (!previous || stableKey < previous.stableKey) bestByRepository.set(repository, { stableKey, item });
    });
    selected.push(...[...bestByRepository.values()]
      .sort((left, right) => left.stableKey.localeCompare(right.stableKey))
      .slice(0, options.poolPerLanguage)
      .map(({ item }) => item));
  }
  return selected.sort((left, right) => left.sample_id.localeCompare(right.sample_id));
}

function roleFor(type) {
  if (/^(function_definition|function_declaration|method_definition|arrow_function|generator_function_declaration)$/.test(type)) return "function";
  if (/^(class_definition|class_declaration)$/.test(type)) return "class";
  if (/^(call|call_expression|new_expression)$/.test(type)) return "call";
  if (/^(string|string_fragment|template_string|concatenated_string)$/.test(type)) return "string";
  if (type === "return_statement") return "return";
  if (/^(if_statement|elif_clause|conditional_expression|ternary_expression)$/.test(type)) return "conditional";
  if (/^(for_statement|for_in_statement|while_statement|list_comprehension|dictionary_comprehension)$/.test(type)) return "iteration";
  if (/^(assignment|assignment_expression|augmented_assignment|lexical_declaration|variable_declaration|pair)$/.test(type)) return "assignment";
  if (/^(subscript|member_expression|attribute)$/.test(type)) return "access";
  if (/^(binary_expression|comparison_operator|boolean_operator|unary_operator)$/.test(type)) return "operator";
  if (/^(list|array|array_pattern|tuple|set)$/.test(type)) return "sequence";
  if (/^(dictionary|object|object_pattern)$/.test(type)) return "mapping";
  if (/^(regex|regex_pattern)$/.test(type)) return "regex";
  if (/^(try_statement|except_clause|catch_clause|finally_clause)$/.test(type)) return "error_flow";
  if (/^(lambda|lambda_expression)$/.test(type)) return "lambda";
  if (/^(import_statement|import_from_statement|import_clause)$/.test(type)) return "import";
  return null;
}

function structuralFeatures(tree, source) {
  const features = new Set();
  const counts = new Map();
  function visit(node, semanticAncestors = []) {
    const role = roleFor(node.type);
    let nextAncestors = semanticAncestors;
    if (role) {
      counts.set(role, (counts.get(role) || 0) + 1);
      features.add(`role:${role}`);
      const nearest = semanticAncestors.at(-1);
      if (nearest) features.add(`edge:${nearest}>${role}`);
      if (semanticAncestors.length >= 2) {
        features.add(`path:${semanticAncestors.at(-2)}>${nearest}>${role}`);
      }
      nextAncestors = [...semanticAncestors.slice(-2), role];
      if (role === "call") {
        const callText = source.slice(node.start, Math.min(node.end, node.start + 220)).toLowerCase();
        for (const anchor of CALL_ANCHORS) {
          if (new RegExp(`(?:\\.|\\b)${anchor}\\s*\\(`).test(callText)) {
            features.add(`string_api:${anchor}`);
          }
        }
      }
    }
    for (const child of node.children || []) visit(child, nextAncestors);
  }
  visit(tree);
  for (const [role, count] of counts) {
    if (count >= 2) features.add(`count:${role}:2+`);
    if (count >= 5) features.add(`count:${role}:5+`);
  }
  return features;
}

function combinations(values, maximumSize) {
  const output = [];
  function build(start, current, size) {
    if (current.length === size) {
      output.push([...current]);
      return;
    }
    for (let index = start; index < values.length; index += 1) {
      current.push(values[index]);
      build(index + 1, current, size);
      current.pop();
    }
  }
  for (let size = 1; size <= maximumSize; size += 1) build(0, [], size);
  return output;
}

function matchesClause(features, clause) {
  return clause.every((atom) => features.has(atom));
}

function matchesRule(features, clauses) {
  return clauses.some((clause) => matchesClause(features, clause));
}

function metrics(predicted, positives) {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const id of predicted) {
    if (positives.has(id)) truePositive += 1;
    else falsePositive += 1;
  }
  for (const id of positives) if (!predicted.has(id)) falseNegative += 1;
  const precision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : 0;
  const recall = truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : 0;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  return { true_positive: truePositive, false_positive: falsePositive, false_negative: falseNegative, precision, recall, f1 };
}

function learnRule(records, positiveIds, options) {
  const positives = records.filter((record) => positiveIds.has(record.sample_id));
  const positiveSupport = new Map();
  const negativeSupport = new Map();
  for (const record of records) {
    const destination = positiveIds.has(record.sample_id) ? positiveSupport : negativeSupport;
    for (const atom of record.features) destination.set(atom, (destination.get(atom) || 0) + 1);
  }
  const rankedAtoms = [...positiveSupport]
    .filter(([, support]) => support >= 2)
    .sort((left, right) => {
      const leftScore = (left[1] / positives.length) / ((negativeSupport.get(left[0]) || 0) / (records.length - positives.length) + 0.02);
      const rightScore = (right[1] / positives.length) / ((negativeSupport.get(right[0]) || 0) / (records.length - positives.length) + 0.02);
      return rightScore - leftScore || left[0].localeCompare(right[0]);
    })
    .slice(0, 36)
    .map(([atom]) => atom);
  const rankedSet = new Set(rankedAtoms);
  const clausesByKey = new Map();
  for (const record of positives) {
    const atoms = [...record.features].filter((atom) => rankedSet.has(atom)).sort();
    for (const clause of combinations(atoms, options.maximumAtomsPerClause)) {
      clausesByKey.set(clause.join("&&"), clause);
    }
  }
  const candidates = [];
  for (const clause of clausesByKey.values()) {
    const matched = new Set(records.filter((record) => matchesClause(record.features, clause)).map((record) => record.sample_id));
    const result = metrics(matched, positiveIds);
    if (result.true_positive < 2 || result.precision < 0.5) continue;
    candidates.push({ clause, matched, metrics: result });
  }
  candidates.sort((left, right) => right.metrics.f1 - left.metrics.f1
    || right.metrics.precision - left.metrics.precision
    || left.clause.length - right.clause.length);

  const selected = [];
  let predicted = new Set();
  let current = metrics(predicted, positiveIds);
  while (selected.length < options.maximumClauses) {
    let best = null;
    for (const candidate of candidates) {
      if (selected.includes(candidate)) continue;
      const union = new Set([...predicted, ...candidate.matched]);
      const result = metrics(union, positiveIds);
      if (result.f1 <= current.f1 + 1e-9) continue;
      if (!best || result.f1 > best.metrics.f1
        || (result.f1 === best.metrics.f1 && result.precision > best.metrics.precision)) {
        best = { candidate, predicted: union, metrics: result };
      }
    }
    if (!best) break;
    selected.push(best.candidate);
    predicted = best.predicted;
    current = best.metrics;
  }
  return {
    clauses: selected.map((item) => item.clause),
    metrics: current,
    predicted,
    ranked_atoms: rankedAtoms.map((atom) => ({
      atom,
      positive_support: positiveSupport.get(atom) || 0,
      negative_support: negativeSupport.get(atom) || 0,
    })),
  };
}

function roundedMetrics(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "number" ? Number(item.toFixed(6)) : item]));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const coverage = JSON.parse(await readFile(options.staticCoverage, "utf8"));
  const expansion = JSON.parse(await readFile(options.gapExpansions, "utf8"));
  const gap = coverage.gap_clusters.find((item) => item.name === options.category);
  const expanded = expansion.categories.find((item) => item.name === options.category);
  if (!gap || !expanded) throw new Error(`Category not found in static artifacts: ${options.category}`);
  const positiveIds = new Set([...gap.sample_ids, ...expanded.accepted_sample_ids]);
  const pool = await unseenPool(options);
  const poolIds = new Set(pool.map((item) => item.sample_id));
  for (const sampleId of positiveIds) {
    if (!poolIds.has(sampleId)) throw new Error(`Positive file missing from reconstructed pool: ${sampleId}`);
  }

  const records = [];
  for (const [index, item] of pool.entries()) {
    const tree = await parseToTree(item.contents, item.language);
    if (!tree) continue;
    const features = structuralFeatures(tree, item.contents);
    records.push({
      sample_id: item.sample_id,
      language: item.language,
      repository: item.repository,
      file: item.file,
      row_index: item.row_index,
      code_hash: item.code_hash,
      feature_count: features.size,
      features,
    });
    if ((index + 1) % 100 === 0) process.stderr.write(`Parsed ${index + 1}/${pool.length} files\n`);
  }

  const finalRule = learnRule(records, positiveIds, options);
  const folds = [];
  let heldOutTruePositive = 0;
  let repeatedFalsePositive = 0;
  const negativeCount = records.length - positiveIds.size;
  for (const heldOutId of [...positiveIds].sort()) {
    const trainingIds = new Set([...positiveIds].filter((sampleId) => sampleId !== heldOutId));
    const trainingRecords = records.filter((record) => record.sample_id !== heldOutId);
    const learned = learnRule(trainingRecords, trainingIds, options);
    const heldOut = records.find((record) => record.sample_id === heldOutId);
    const heldOutMatched = learned.clauses.length > 0 && matchesRule(heldOut.features, learned.clauses);
    const falsePositiveIds = records
      .filter((record) => !positiveIds.has(record.sample_id) && matchesRule(record.features, learned.clauses))
      .map((record) => record.sample_id);
    heldOutTruePositive += Number(heldOutMatched);
    repeatedFalsePositive += falsePositiveIds.length;
    folds.push({
      held_out_sample_id: heldOutId,
      held_out_language: heldOut.language,
      held_out_matched: heldOutMatched,
      learned_clauses: learned.clauses,
      training_metrics: roundedMetrics(learned.metrics),
      false_positive_count: falsePositiveIds.length,
      false_positive_sample_ids: falsePositiveIds.slice(0, 20),
    });
  }
  const heldOutFalseNegative = positiveIds.size - heldOutTruePositive;
  const cvPrecision = heldOutTruePositive + repeatedFalsePositive
    ? heldOutTruePositive / (heldOutTruePositive + repeatedFalsePositive) : 0;
  const cvRecall = heldOutTruePositive / positiveIds.size;
  const cvF1 = cvPrecision + cvRecall ? 2 * cvPrecision * cvRecall / (cvPrecision + cvRecall) : 0;
  const crossValidation = {
    folds: positiveIds.size,
    held_out_true_positive: heldOutTruePositive,
    held_out_false_negative: heldOutFalseNegative,
    repeated_false_positive: repeatedFalsePositive,
    negative_exposures: negativeCount * positiveIds.size,
    precision: Number(cvPrecision.toFixed(6)),
    recall: Number(cvRecall.toFixed(6)),
    f1: Number(cvF1.toFixed(6)),
    false_positive_rate: Number((repeatedFalsePositive / (negativeCount * positiveIds.size)).toFixed(6)),
  };
  const status = cvPrecision >= 0.8 && cvRecall >= 0.6
    ? "structurally_supported_candidate"
    : "semantic_only_insufficient_structural_precision";
  const recordById = new Map(records.map((record) => [record.sample_id, record]));
  const output = {
    method: "cross-language semantic-role AST features; OR of short AND clauses; leave-one-positive-out evaluation",
    category: options.category,
    semantic_support: positiveIds.size,
    pool_files: records.length,
    negative_files: negativeCount,
    status,
    promotion_thresholds: { minimum_cv_precision: 0.8, minimum_cv_recall: 0.6 },
    final_rule: {
      clauses: finalRule.clauses,
      in_sample_metrics: roundedMetrics(finalRule.metrics),
      matched_sample_ids: [...finalRule.predicted].sort(),
    },
    cross_validation: crossValidation,
    folds,
    top_structural_atoms: finalRule.ranked_atoms.slice(0, 20),
    positive_files: [...positiveIds].sort().map((sampleId) => {
      const record = recordById.get(sampleId);
      return {
        sample_id: sampleId,
        language: record.language,
        repository: record.repository,
        file: record.file,
        row_index: record.row_index,
        code_hash: record.code_hash,
        features: [...record.features].sort(),
      };
    }),
    interpretation: status === "structurally_supported_candidate"
      ? "The semantic category has a provisional recurring structural description. It is not registered and still requires human meaning validation and larger support."
      : "The semantic category is coherent enough for retrieval but the current examples do not support a precise shared AST rule. Keep it semantic-only and gather more evidence or split it.",
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `${options.category}: ${status}; final p=${finalRule.metrics.precision.toFixed(3)} `
    + `r=${finalRule.metrics.recall.toFixed(3)}; LOO p=${cvPrecision.toFixed(3)} r=${cvRecall.toFixed(3)}`,
  );
  for (const clause of finalRule.clauses) console.log(`  ${clause.join(" AND ")}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
