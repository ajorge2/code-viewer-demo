#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseToTree } from "../../server/ingest/parseTree.js";
import { canonicalPatchHash, sha256 } from "./lib/pilot.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_DATA_ROOT = path.join(PROJECT_ROOT, ".data/commitpackft/data");
const DEFAULT_GUMTREE_JAR = path.join(
  PROJECT_ROOT,
  ".tools/gumtree-src/dist/build/install/gumtree/lib/gumtree.jar",
);
const JAVA_SOURCE = path.join(PROJECT_ROOT, "experiments/intent-algebra/GumTreeBatch.java");
const CLASS_DIR = path.join(PROJECT_ROOT, ".tools/intent-algebra/classes");
const EXTENSIONS = { python: ".py", javascript: ".js" };
const ROOT_TYPES = new Set(["module", "program"]);
const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
  "poetry.lock", "pipfile.lock",
]);
const NOISY_SEGMENTS = new Set([
  "node_modules", "vendor", "vendors", "third_party", "dist", "build", "coverage",
  "generated", "fixtures", "snapshots", "__snapshots__",
]);
const GENERATED_HEADER = /(?:auto[- ]?generated|generated (?:file|code)|do not edit|machine generated)/i;

function parseArguments(argv) {
  const options = {
    dataRoot: DEFAULT_DATA_ROOT,
    output: null,
    perLanguage: 5,
    seed: "intent-message-code-v1",
    gumtreeJar: process.env.GUMTREE_JAR || DEFAULT_GUMTREE_JAR,
    maxSubsetLcas: 64,
    gumtreeTimeoutMs: 30_000,
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
    else if (argument === "--seed") options.seed = next();
    else if (argument === "--gumtree-jar") options.gumtreeJar = path.resolve(next());
    else if (argument === "--max-subset-lcas") options.maxSubsetLcas = Number.parseInt(next(), 10);
    else if (argument === "--gumtree-timeout-ms") options.gumtreeTimeoutMs = Number.parseInt(next(), 10);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.output) throw new Error("--output is required");
  if (!Number.isInteger(options.perLanguage) || options.perLanguage < 1) {
    throw new Error("--per-language must be a positive integer");
  }
  return options;
}

function exclusionReason(row, language) {
  const file = String(row.new_file || row.old_file || "").replaceAll("\\", "/");
  const basename = path.posix.basename(file).toLowerCase();
  const segments = file.toLowerCase().split("/");
  const before = row.old_contents ?? "";
  const after = row.new_contents ?? "";
  const message = String(row.message || row.subject || "").trim();
  if (!message) return "missing_message";
  if (!before && !after) return "empty_change";
  if (before === after) return "unchanged";
  if (before.replace(/\s+/g, "") === after.replace(/\s+/g, "")) return "formatting_only";
  if (LOCKFILES.has(basename)) return "lockfile";
  if (segments.some((segment) => NOISY_SEGMENTS.has(segment))) return "noisy_path";
  if (/\.(?:min|bundle)(?:\.[a-f0-9]{6,})?\.js$/i.test(basename)) return "minified_or_bundle";
  if (/(?:^|[._-])(?:generated|gen)(?:[._-]|$)/i.test(basename)) return "generated_name";
  if (GENERATED_HEADER.test(after.slice(0, 800))) return "generated_header";
  if (language === "python" && !basename.endsWith(".py")) return "wrong_extension";
  if (language === "javascript" && !/\.(?:js|mjs|cjs|jsx)$/.test(basename)) return "wrong_extension";
  if (/(?:^|\/)(?:tests?|specs?)(?:\/|$)/i.test(file)
      && /\b(?:set ?up|configure|initialize|bootstrap)\b.*\b(?:tests?|jest|pytest|mocha)\b/i.test(message)) {
    return "test_setup_boilerplate";
  }
  const lines = after.split("\n");
  if (after.length > 2_000 && lines.length < 5
      && lines.reduce((maximum, line) => Math.max(maximum, line.length), 0) > 1_000) {
    return "minified_content";
  }
  return null;
}

async function selectRows(filePath, language, limit, seed) {
  const candidates = [];
  const patchHashes = new Set();
  const exclusions = {};
  const input = createReadStream(filePath);
  const fileHash = createHash("sha256");
  input.on("data", (chunk) => fileHash.update(chunk));
  const lines = createInterface({ input, crlfDelay: Infinity });
  let raw = 0;
  for await (const line of lines) {
    raw += 1;
    let row;
    try { row = JSON.parse(line); }
    catch {
      exclusions.invalid_json = (exclusions.invalid_json || 0) + 1;
      continue;
    }
    const reason = exclusionReason(row, language);
    if (reason) {
      exclusions[reason] = (exclusions[reason] || 0) + 1;
      continue;
    }
    const patchHash = canonicalPatchHash(row);
    if (patchHashes.has(patchHash)) {
      exclusions.duplicate_patch = (exclusions.duplicate_patch || 0) + 1;
      continue;
    }
    patchHashes.add(patchHash);
    candidates.push({
      row,
      rowIndex: raw,
      patchHash,
      sampleKey: sha256(`${seed}:${language}:${row.commit}:${patchHash}`),
    });
  }
  candidates.sort((left, right) => left.sampleKey.localeCompare(right.sampleKey));
  return {
    rows: candidates.slice(0, limit),
    source: {
      path: path.relative(PROJECT_ROOT, filePath),
      bytes: (await stat(filePath)).size,
      sha256: fileHash.digest("hex"),
      raw_rows: raw,
      eligible_rows: candidates.length,
      exclusions,
    },
  };
}

async function compileWorker(gumtreeJar) {
  await stat(gumtreeJar);
  await mkdir(CLASS_DIR, { recursive: true });
  const build = spawnSync("javac", ["-cp", gumtreeJar, "-d", CLASS_DIR, JAVA_SOURCE], {
    encoding: "utf8",
  });
  if (build.status !== 0) throw new Error(build.stderr || build.stdout);
}

class GumTreeWorker {
  constructor(gumtreeJar) {
    this.gumtreeJar = gumtreeJar;
    this.pending = [];
    this.stderr = "";
  }

  async start() {
    const separator = process.platform === "win32" ? ";" : ":";
    this.child = spawn(
      "java",
      ["-cp", `${CLASS_DIR}${separator}${this.gumtreeJar}`, "GumTreeBatch"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      const waiter = this.pending.shift();
      if (!waiter) return;
      try { waiter.resolve(JSON.parse(line)); }
      catch (error) { waiter.reject(error); }
    });
    this.child.on("exit", (code) => {
      const error = new Error(`GumTree worker exited with ${code}: ${this.stderr}`);
      while (this.pending.length) this.pending.shift().reject(error);
    });
    const ready = await this.readNext();
    if (!ready.ready) throw new Error(`GumTree did not become ready: ${JSON.stringify(ready)}`);
  }

  readNext() {
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  analyze(id, beforePath, afterPath) {
    const response = this.readNext();
    this.child.stdin.write(`${id}\t${beforePath}\t${afterPath}\n`);
    return response;
  }

  async close() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.stdin.end();
    await new Promise((resolve) => this.child.once("exit", resolve));
  }

  async terminate() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill("SIGKILL");
    await new Promise((resolve) => this.child.once("exit", resolve));
  }
}

async function withTimeout(promise, milliseconds, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function flattenTree(root, side) {
  const nodes = [];
  const visit = (node, parentId, depth) => {
    const id = `${side}:${node.start}:${node.end}:${node.type}`;
    const flat = {
      id, side, type: node.type, start: node.start, end: node.end,
      parent_id: parentId, depth, child_ids: [],
    };
    nodes.push(flat);
    for (const child of node.children || []) {
      const childId = visit(child, id, depth + 1);
      flat.child_ids.push(childId);
    }
    return id;
  };
  visit(root, null, 0);
  return nodes;
}

function findTreeNode(nodes, gumtreeNode) {
  if (!gumtreeNode) return null;
  const exact = nodes.filter((node) => node.start === gumtreeNode.start && node.end === gumtreeNode.end);
  if (exact.length) {
    return exact.find((node) => node.type === gumtreeNode.type)
      || exact.sort((a, b) => b.depth - a.depth)[0];
  }
  return nodes
    .filter((node) => node.start <= gumtreeNode.start && node.end >= gumtreeNode.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start) || b.depth - a.depth)[0]
    || null;
}

function ancestors(node, byId) {
  const result = [];
  let current = node;
  while (current) {
    result.push(current);
    current = current.parent_id ? byId.get(current.parent_id) : null;
  }
  return result;
}

function lowestCommonAncestor(nodes, byId) {
  if (!nodes.length) return null;
  const firstAncestors = ancestors(nodes[0], byId);
  const otherSets = nodes.slice(1).map((node) => new Set(ancestors(node, byId).map((item) => item.id)));
  return firstAncestors.find((candidate) => otherSets.every((set) => set.has(candidate.id))) || null;
}

function combinations(items, size, callback, start = 0, chosen = []) {
  if (chosen.length === size) {
    callback(chosen);
    return;
  }
  for (let index = start; index <= items.length - (size - chosen.length); index += 1) {
    combinations(items, size, callback, index + 1, [...chosen, items[index]]);
  }
}

function compareSortValues(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === rightValue) continue;
    if (leftValue === undefined) return -1;
    if (rightValue === undefined) return 1;
    if (typeof leftValue === "number" && typeof rightValue === "number") return leftValue - rightValue;
    return String(leftValue).localeCompare(String(rightValue));
  }
  return 0;
}

function compactSexpr(root, byId, maximumNodes = 300) {
  let emitted = 0;
  const render = (node) => {
    if (emitted >= maximumNodes) return "…";
    emitted += 1;
    const children = node.child_ids.map((id) => byId.get(id)).filter(Boolean);
    if (!children.length) return node.type;
    return `(${node.type} ${children.map(render).join(" ")})`;
  };
  return render(root);
}

function excerpt(source, start, end, maximum = 2_500) {
  const exact = source.slice(start, end);
  if (exact.length <= maximum) return exact;
  return `${exact.slice(0, maximum)}\n…`;
}

function intrinsicOperation(actionName) {
  if (actionName.startsWith("insert")) return "add";
  if (actionName.startsWith("delete")) return "remove";
  return "neutral";
}

function buildCandidateUniverse(beforeTree, afterTree, analysis, beforeSource, afterSource, maxSubsetLcas) {
  const allNodes = [
    ...flattenTree(beforeTree, "before"),
    ...flattenTree(afterTree, "after"),
  ];
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  const bySide = {
    before: allNodes.filter((node) => node.side === "before"),
    after: allNodes.filter((node) => node.side === "after"),
  };
  const observations = [];
  for (const [actionIndex, action] of (analysis.actions || []).entries()) {
    const operation = intrinsicOperation(action.action || "");
    const primary = findTreeNode(bySide[action.side] || [], action.node);
    if (primary) observations.push({
      observation_id: `${actionIndex}:${primary.id}`,
      action_index: actionIndex,
      action: action.action,
      operation,
      node_id: primary.id,
      side: primary.side,
      start: primary.start,
      end: primary.end,
    });
    if (operation === "neutral" && action.mapped_node) {
      const mappedSide = action.side === "before" ? "after" : "before";
      const mapped = findTreeNode(bySide[mappedSide], action.mapped_node);
      if (mapped) observations.push({
        observation_id: `${actionIndex}:${mapped.id}`,
        action_index: actionIndex,
        action: action.action,
        operation,
        node_id: mapped.id,
        side: mapped.side,
        start: mapped.start,
        end: mapped.end,
      });
    }
  }
  const deduplicatedObservations = [...new Map(
    observations.map((item) => [`${item.node_id}:${item.action}:${item.operation}`, item]),
  ).values()];
  const directIds = new Set(deduplicatedObservations.map((item) => item.node_id));
  const roles = new Map();
  const addRole = (node, role, sort) => {
    if (!node) return;
    const current = roles.get(node.id) || { node, roles: new Set(), sort };
    current.roles.add(role);
    if (compareSortValues(sort, current.sort) < 0) current.sort = sort;
    roles.set(node.id, current);
  };
  const directNodes = [...directIds].map((id) => byId.get(id)).filter(Boolean);
  directNodes.forEach((node) => addRole(node, "direct_edit", [0, node.side, node.start, node.end]));

  if (directNodes.length === 1) {
    ancestors(directNodes[0], byId).slice(1).forEach((node, distance) => {
      addRole(node, "single_edit_ancestor", [1, distance + 1, node.side, node.start]);
    });
  } else {
    for (const side of ["before", "after"]) {
      const sideDirect = directNodes.filter((node) => node.side === side);
      if (!sideDirect.length) continue;
      const root = ancestors(sideDirect[0], byId).at(-1);
      if (sideDirect.length === 1) {
        const chain = ancestors(sideDirect[0], byId).slice(1).reverse();
        chain.forEach((node, depth) => addRole(node, "path", [3, depth, side, node.start]));
        continue;
      }
      const overall = lowestCommonAncestor(sideDirect, byId);
      addRole(overall, "overall_lca", [1, side, overall?.start || 0]);
      let subsetCount = 0;
      for (let size = 2; size < sideDirect.length && subsetCount < maxSubsetLcas; size += 1) {
        combinations(sideDirect, size, (subset) => {
          if (subsetCount >= maxSubsetLcas) return;
          const lca = lowestCommonAncestor(subset, byId);
          if (lca && lca.id !== overall.id && !directIds.has(lca.id)) {
            addRole(lca, "subset_lca", [2, size, side, lca.depth, lca.start]);
            subsetCount += 1;
          }
        });
      }
      const origin = overall || root;
      const pathIds = new Set();
      for (const direct of sideDirect) {
        let current = direct;
        while (current && current.id !== origin.id) {
          if (!directIds.has(current.id)) pathIds.add(current.id);
          current = current.parent_id ? byId.get(current.parent_id) : null;
        }
        pathIds.add(origin.id);
      }
      [...pathIds]
        .map((id) => byId.get(id))
        .filter((node) => !directIds.has(node.id))
        .sort((a, b) => a.depth - b.depth || a.start - b.start || a.end - b.end)
        .forEach((node) => addRole(node, "path", [3, node.depth, side, node.start, node.end]));
    }
  }

  const candidates = [...roles.values()]
    .sort((left, right) => compareSortValues(left.sort, right.sort))
    .map(({ node, roles: nodeRoles }, baseRank) => {
      const descendants = deduplicatedObservations.filter((observation) =>
        observation.side === node.side
        && observation.start >= node.start
        && observation.end <= node.end);
      const counts = { add: 0, remove: 0, neutral: 0 };
      descendants.forEach((observation) => { counts[observation.operation] += 1; });
      const total = descendants.length;
      const queueSign = total && counts.add / total >= 0.5
        ? "add"
        : (total && counts.remove / total > 0.5 ? "remove" : "neutral");
      const source = node.side === "before" ? beforeSource : afterSource;
      return {
        candidate_key: node.id,
        side: node.side,
        node_type: node.type,
        start: node.start,
        end: node.end,
        depth: node.depth,
        base_rank: baseRank,
        roles: [...nodeRoles].sort(),
        queue_sign: queueSign,
        edit_counts: counts,
        supporting_observation_ids: descendants.map((item) => item.observation_id),
        source_excerpt: excerpt(source, node.start, node.end),
        ast_sexpr: compactSexpr(node, byId),
      };
    });
  return { candidates, edit_observations: deduplicatedObservations };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await compileWorker(options.gumtreeJar);
  const selected = [];
  const sources = {};
  for (const language of ["python", "javascript"]) {
    const input = path.join(options.dataRoot, language, "data.jsonl");
    const result = await selectRows(input, language, options.perLanguage, options.seed);
    sources[language] = result.source;
    selected.push(...result.rows.map((candidate) => ({ language, candidate })));
    console.error(`Selected ${result.rows.length} ${language} records`);
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), "intent-message-code-"));
  let worker = new GumTreeWorker(options.gumtreeJar);
  const partialPath = `${options.output}.partial`;
  let prepared = [];
  try {
    prepared = (await readFile(partialPath, "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    prepared = [];
  }
  const preparedByKey = new Map(prepared.map((row) => [row.sample_key, row]));
  try {
    await worker.start();
    for (const [index, item] of selected.entries()) {
      const { language, candidate } = item;
      const { row } = candidate;
      if (preparedByKey.has(candidate.sampleKey)) {
        console.error(`Prepared ${index + 1}/${selected.length} (checkpoint)`);
        continue;
      }
      const extension = EXTENSIONS[language];
      const beforePath = path.join(temporary, `before${extension}`);
      const afterPath = path.join(temporary, `after${extension}`);
      await Promise.all([
        writeFile(beforePath, row.old_contents || ""),
        writeFile(afterPath, row.new_contents || ""),
      ]);
      const treePromise = Promise.all([
        parseToTree(row.old_contents || "", language),
        parseToTree(row.new_contents || "", language),
      ]);
      let analysis;
      try {
        analysis = await withTimeout(
          worker.analyze(String(index), beforePath, afterPath),
          options.gumtreeTimeoutMs,
          `GumTree record ${index + 1}`,
        );
      } catch (error) {
        await worker.terminate();
        worker = new GumTreeWorker(options.gumtreeJar);
        await worker.start();
        analysis = { ok: false, error: error.message, actions: [] };
      }
      const [beforeTree, afterTree] = await treePromise;
      const parseOk = Boolean(analysis.ok && beforeTree && afterTree
        && !analysis.source_error_nodes && !analysis.destination_error_nodes);
      let structural = { candidates: [], edit_observations: [] };
      let preparationError = null;
      if (parseOk && analysis.actions?.length) {
        structural = buildCandidateUniverse(
          beforeTree, afterTree, analysis, row.old_contents || "", row.new_contents || "",
          options.maxSubsetLcas,
        );
      } else {
        preparationError = !analysis.ok
          ? `gumtree_error:${analysis.error}`
          : (!analysis.actions?.length ? "no_ast_actions" : "parse_error_nodes");
      }
      const preparedRow = {
        language,
        row_index: candidate.rowIndex,
        commit: row.commit,
        repository_names: [...new Set(String(row.repos || "").split(",").filter(Boolean))],
        license: row.license,
        old_file: row.old_file,
        new_file: row.new_file,
        message: row.message || row.subject,
        subject: row.subject,
        before_source: row.old_contents || "",
        after_source: row.new_contents || "",
        patch_hash: candidate.patchHash,
        sample_key: candidate.sampleKey,
        preparation_error: preparationError,
        gumtree_summary: {
          source_nodes: analysis.source_nodes,
          destination_nodes: analysis.destination_nodes,
          mapping_count: analysis.mapping_count,
          action_count: analysis.actions?.length || 0,
        },
        ...structural,
      };
      prepared.push(preparedRow);
      preparedByKey.set(candidate.sampleKey, preparedRow);
      await mkdir(path.dirname(options.output), { recursive: true });
      await appendFile(partialPath, `${JSON.stringify(preparedRow)}\n`);
      console.error(`Prepared ${index + 1}/${selected.length}`);
    }
  } finally {
    await worker.close();
    await rm(temporary, { recursive: true, force: true });
  }

  await mkdir(path.dirname(options.output), { recursive: true });
  const manifest = {
    schema_version: "message-code-preparation/v1",
    seed: options.seed,
    per_language: options.perLanguage,
    sampling: "lowest sha256(seed, language, commit, canonical patch hash)",
    filters: "generated/lock/minified/formatting-only/test-setup/unusable; no add-remove balance gate",
    max_subset_lcas: options.maxSubsetLcas,
    gumtree_timeout_ms: options.gumtreeTimeoutMs,
    sources,
  };
  await writeFile(options.output, prepared.map((row) => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(`${options.output}.manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
  await rm(partialPath, { force: true });
  console.error(`Wrote ${prepared.length} prepared records to ${options.output}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
