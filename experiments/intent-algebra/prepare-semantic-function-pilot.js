#!/usr/bin/env node

/** Build a deterministic, repository-family-disjoint function-level semantic pilot.
 *
 * Tree-sitter is used only to identify callable boundaries. No node types, edit
 * actions, paths, or structural features are emitted into the representation that
 * will be embedded or clustered.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

import { parseToTree } from '../../server/ingest/parseTree.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

function parseArgs(argv) {
  const args = {
    dataRoot: path.join(ROOT, '.data/commitpackft/data'),
    output: path.join(ROOT, '.data/intent-semantic-first-pilot/function-units.jsonl'),
    perLanguage: 80,
    candidateRows: 600,
    seed: 'semantic-first-functions-v1',
    minChars: 180,
    maxChars: 4000,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--data-root') args.dataRoot = path.resolve(value);
    else if (flag === '--output') args.output = path.resolve(value);
    else if (flag === '--per-language') args.perLanguage = Number(value);
    else if (flag === '--candidate-rows') args.candidateRows = Number(value);
    else if (flag === '--seed') args.seed = value;
    else if (flag === '--min-chars') args.minChars = Number(value);
    else if (flag === '--max-chars') args.maxChars = Number(value);
    else throw new Error(`Unknown argument: ${flag}`);
    index += 1;
  }
  return args;
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function repositoryFamily(repos) {
  const names = [...new Set(String(repos || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
  return { names, id: digest(names.join('\n') || 'unknown') };
}

function excludedPath(file) {
  const normalized = String(file || '').toLowerCase();
  return !normalized
    || /(^|\/)(test|tests|testing|fixtures|vendor|vendors|node_modules|dist|build|generated|migrations)(\/|$)/.test(normalized)
    || /(^|\/)(__snapshots__|coverage)(\/|$)/.test(normalized)
    || /(?:\.min\.js|package-lock\.json|poetry\.lock)$/.test(normalized);
}

function callableTypes(language) {
  if (language === 'python') return new Set(['function_definition']);
  return new Set([
    'function_declaration',
    'generator_function_declaration',
    'method_definition',
    'arrow_function',
    'function_expression',
  ]);
}

function collectCallables(node, language, source, options, insideCallable = false, output = []) {
  const types = callableTypes(language);
  const callable = types.has(node.type);
  if (callable && !insideCallable) {
    const code = source.slice(node.start, node.end).trim();
    if (code.length >= options.minChars && code.length <= options.maxChars && /[A-Za-z_]/.test(code)) {
      output.push({ type: node.type, start: node.start, end: node.end, code });
    }
  }
  for (const child of node.children || []) {
    collectCallables(child, language, source, options, insideCallable || callable, output);
  }
  return output;
}

async function rankedRows(input, language, options) {
  const bestByFamily = new Map();
  const stream = fs.createReadStream(input, 'utf8');
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row.new_contents || row.new_contents.length < options.minChars || row.new_contents.length > 60000) continue;
    if (excludedPath(row.new_file)) continue;
    const family = repositoryFamily(row.repos);
    const rank = digest(`${options.seed}\0${language}\0${row.commit}\0${row.new_file}\0${family.id}`);
    const current = bestByFamily.get(family.id);
    if (!current || rank < current.rank) bestByFamily.set(family.id, { rank, row, family });
  }
  return [...bestByFamily.values()].sort((left, right) => left.rank.localeCompare(right.rank)).slice(0, options.candidateRows);
}

async function sampleLanguage(language, options) {
  const input = path.join(options.dataRoot, language, 'data.jsonl');
  const candidates = await rankedRows(input, language, options);
  const selected = [];
  const codeHashes = new Set();
  for (const candidate of candidates) {
    if (selected.length >= options.perLanguage) break;
    const tree = await parseToTree(candidate.row.new_contents, language);
    if (!tree) continue;
    const functions = collectCallables(tree, language, candidate.row.new_contents, options);
    if (!functions.length) continue;
    functions.sort((left, right) => digest(`${candidate.rank}\0${left.start}`).localeCompare(digest(`${candidate.rank}\0${right.start}`)));
    const unit = functions[0];
    const codeHash = digest(unit.code);
    if (codeHashes.has(codeHash)) continue;
    codeHashes.add(codeHash);
    selected.push({
      sample_id: `SEM_FUNC_${language.toUpperCase()}_${digest(`${candidate.row.commit}\0${candidate.row.new_file}\0${unit.start}`).slice(0, 12).toUpperCase()}`,
      language,
      unit_level: 'function',
      unit_type: unit.type,
      commit: candidate.row.commit,
      repository_family_id: candidate.family.id,
      repository_names: candidate.family.names.slice(0, 8),
      file: candidate.row.new_file,
      code_hash: codeHash,
      code_chars: unit.code.length,
      code: unit.code,
    });
  }
  if (selected.length < options.perLanguage) {
    throw new Error(`Only found ${selected.length}/${options.perLanguage} ${language} function units`);
  }
  return selected;
}

async function main() {
  const options = parseArgs(process.argv);
  const python = await sampleLanguage('python', options);
  const javascript = await sampleLanguage('javascript', options);
  const rows = [...python, ...javascript].sort((left, right) => left.sample_id.localeCompare(right.sample_id));
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const manifest = {
    schema_version: 1,
    unit_level: 'function',
    clustering_inputs_excluded: ['file paths', 'commit text', 'AST features', 'edit actions', 'generated category labels'],
    languages: { python: python.length, javascript: javascript.length },
    repository_family_count: new Set(rows.map((row) => row.repository_family_id)).size,
    output: options.output,
  };
  fs.writeFileSync(path.join(path.dirname(options.output), 'function-units-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

