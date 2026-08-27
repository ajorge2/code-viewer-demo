// Code ingestion: walk a project directory, pick source files, and chunk each
// file by *lines*. A chunk carries its line range { startLine, endLine } — the
// code analogue of Lumen's PDF bounding rects, so the viewer can highlight the
// exact region a chunk occupies.
import fs from 'fs/promises';
import path from 'path';

// Directories we never descend into.
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.idea', '.vscode', 'target', '.cache', 'vendor', '.turbo',
  '.tree-cache', '.claude', '.codex', '.agents', 'benchmark-results',
]);

// Extension → language label (drives a future syntax highlighter; for now just
// a tag shown in the UI and used to filter to "source" files).
const LANGS = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala',
  css: 'css', scss: 'scss', html: 'html', vue: 'vue', svelte: 'svelte',
  json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  md: 'markdown', sh: 'bash', bash: 'bash', sql: 'sql', r: 'r',
};

export const MAX_FILE_BYTES = 1_000_000;    // skip files larger than ~1 MB
export const MAX_FILES = 4000;              // safety cap for huge repos
export const MAX_TOTAL_BYTES = 150_000_000; // ~150 MB summed text per project

export function languageFor(filename) {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  return LANGS[ext] || null;
}

// Noisy generated/lock files we treat as non-source even though the extension
// matches (they drown out real code).
const SKIP_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock',
  'poetry.lock', 'Cargo.lock', 'Gemfile.lock',
]);

export function isSourceFile(filename) {
  if (SKIP_FILES.has(filename)) return false;
  return languageFor(filename) !== null;
}

// Recursively collect source-file paths under `dir` (relative paths returned).
export async function walkProject(dir) {
  const found = [];
  async function recur(abs, rel) {
    if (found.length >= MAX_FILES) return;
    let entries = [];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_FILES) return;
      if (entry.name.startsWith('.') && entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) { /* allow e.g. .github */ }
        else continue;
      }
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await recur(childAbs, childRel);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        found.push(childRel);
      }
    }
  }
  await recur(dir, '');
  return found;
}

// Read a source file; returns null if missing or too large.
export async function readSourceFile(absPath) {
  const stat = await fs.stat(absPath).catch(() => null);
  if (!stat || !stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
  return fs.readFile(absPath, 'utf8');
}

// The core chunker: group `size` *non-empty* lines per chunk. A chunk's range
// is trimmed to its first and last non-empty line, so:
//   - blank lines INSIDE a chunk (between code lines) are part of it (highlighted),
//   - blank lines BETWEEN chunks, ABOVE the first chunk, or BELOW the last chunk
//     belong to no chunk (the viewer leaves those un-highlighted / unrendered).
// Blank lines never count toward `size`. Line numbers are 1-indexed inclusive.
// This is the single source of truth for chunk boundaries — the slider just
// changes `size`. (`overlap` is accepted for API stability but not applied.)
export function chunkByLines(text, size = 40, overlap = 0) {
  const lines = text.split('\n');
  const n = lines.length;
  const span = Math.max(1, Math.floor(size));
  const isEmpty = (s) => s.trim() === '';
  const chunks = [];

  // Char offset where each line begins (lineStart[k+1] counts the '\n').
  const lineStart = new Array(n + 1);
  lineStart[0] = 0;
  for (let k = 0; k < n; k++) lineStart[k + 1] = lineStart[k] + lines[k].length + 1;

  let firstNon = -1; // first non-empty line index in the current chunk
  let lastNon = -1;  // last non-empty line index in the current chunk
  let counted = 0;

  const flush = () => {
    if (counted === 0) return;
    chunks.push({
      index: chunks.length,
      startLine: firstNon + 1,
      endLine: lastNon + 1,
      lineCount: counted,
      // Char-offset span (so the viewer can use one char-span model everywhere).
      start: lineStart[firstNon],
      end: lineStart[lastNon] + lines[lastNon].length,
      label: `L${firstNon + 1}–${lastNon + 1}`,
    });
    firstNon = -1;
    lastNon = -1;
    counted = 0;
  };

  for (let i = 0; i < n; i++) {
    if (!isEmpty(lines[i])) {
      if (firstNon === -1) firstNon = i;
      lastNon = i;
      counted++;
      if (counted >= span) flush();
    }
  }
  flush(); // final partial chunk

  return chunks;
}
