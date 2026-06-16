// Tree-sitter parser → a plain, reusable parse tree with CHARACTER offsets.
//
// Self-contained: text + language label → { type, start, end, named, children }.
// Uses web-tree-sitter (WASM) so there's no native build and no grammar version
// conflicts. Any session can import parseToTree() — it doesn't touch the rest of
// the server. The output tree is exactly what codeTree.js consumes.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import Parser from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const WASMS_DIR = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');

// Persistent tree cache, in CodeArchitect's own repo (not the inspected project).
// Keyed by a hash of (language + content), so a file edit produces a new key and
// the stale tree is simply never read again.
const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/ingest
const CACHE_DIR = path.join(HERE, '..', '..', '.tree-cache');

// Our language labels (from code.js) → grammar base names. Most resolve to the
// tree-sitter-wasms pack; r/sql ship as local wasms in server/grammars/.
const GRAMMAR = {
  javascript: 'javascript', typescript: 'typescript', python: 'python', json: 'json',
  go: 'go', rust: 'rust', java: 'java', c: 'c', cpp: 'cpp', csharp: 'c_sharp',
  ruby: 'ruby', php: 'php', css: 'css', html: 'html', bash: 'bash',
  scala: 'scala', swift: 'swift', kotlin: 'kotlin', lua: 'lua',
  toml: 'toml', vue: 'vue', r: 'r', sql: 'sql',
  // (yaml's grammar in tree-sitter-wasms is broken for this runtime → line-chunked.)
};

// Custom/extra grammar wasms not in tree-sitter-wasms (checked first).
const LOCAL_DIR = path.join(HERE, '..', 'grammars');

let initPromise = null;
const langCache = new Map();

async function ensureInit() {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

async function loadLanguage(language) {
  if (langCache.has(language)) return langCache.get(language);
  await ensureInit();
  const base = GRAMMAR[language];
  // Prefer a local wasm (server/grammars/), else the tree-sitter-wasms pack.
  const candidates = base
    ? [path.join(LOCAL_DIR, `tree-sitter-${base}.wasm`), path.join(WASMS_DIR, `tree-sitter-${base}.wasm`)]
    : [];
  const file = candidates.find((f) => fs.existsSync(f));
  let lang = null;
  if (file) {
    lang = await Parser.Language.load(new Uint8Array(fs.readFileSync(file)));
  }
  langCache.set(language, lang);
  return lang;
}

export function isParseable(language) {
  return !!GRAMMAR[language];
}

// Convert a tree-sitter node's offset to a CHARACTER index. web-tree-sitter
// reports UTF-16 code-unit indices that match JS string indexing for the BMP;
// astral chars (emoji) are rare in source — handled correctly here because we
// slice the same JS string with the same indexing.
function toNode(n) {
  // Keep only NAMED children (structural units). Anonymous nodes — operators,
  // punctuation, keywords — are glue handled by coverage, so dropping them keeps
  // the stored tree small without changing chunking.
  const children = [];
  const count = n.childCount;
  for (let i = 0; i < count; i++) {
    const c = n.child(i);
    if (c.isNamed) children.push(toNode(c));
  }
  return {
    type: n.type,
    start: n.startIndex,
    end: n.endIndex,
    ...(children.length ? { children } : {}),
  };
}

// Returns the root parse node, or null if the language has no grammar / parse fails.
export async function parseToTree(text, language) {
  if (!isParseable(language)) return null;
  try {
    await ensureInit();
    const lang = await loadLanguage(language);
    if (!lang) return null;
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(text);
    const root = toNode(tree.rootNode);
    tree.delete?.();
    parser.delete?.();
    return root;
  } catch {
    return null;
  }
}

// Memoized + disk-persisted: parse a file's tree at most once ever (per content
// version). Returns the cached tree on every later call / server run.
const memCache = new Map(); // hash -> tree

// Wipe both layers of the tree cache: the in-memory memo and every persisted
// .tree-cache/*.json. Returns the number of disk files removed. Next chunk
// request for any file re-parses from scratch.
export function clearTreeCache() {
  memCache.clear();
  let removed = 0;
  try {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      if (!name.endsWith('.json')) continue;
      try { fs.unlinkSync(path.join(CACHE_DIR, name)); removed += 1; } catch { /* skip */ }
    }
  } catch {
    /* dir doesn't exist yet → nothing cached, nothing to remove */
  }
  return removed;
}

export async function loadTree(content, language) {
  if (!isParseable(language)) return null;
  const key = crypto.createHash('sha1').update(language + '\0' + content).digest('hex');
  if (memCache.has(key)) return memCache.get(key);

  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    const tree = JSON.parse(fs.readFileSync(file, 'utf8'));
    memCache.set(key, tree);
    return tree;
  } catch {
    /* cache miss → parse below */
  }

  const tree = await parseToTree(content, language);
  if (tree) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(tree));
    } catch {
      /* non-fatal: just skip persisting */
    }
    memCache.set(key, tree);
  }
  return tree;
}
