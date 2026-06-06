// Generic, grammar-less structural categorizer — the universal fallback for any
// file without a tree-sitter grammar (sql, r, yaml, markdown, plain text, …).
//
// It breaks text into a hierarchy from the structure signals that are reliable
// across *all* languages, no per-language rules:
//   1. Indentation  → nesting of lines (a more-indented line is a child).
//   2. Brackets () [] {} → nested groups inside a line.
//   3. Separators ; , → segment boundaries inside a line.
// Fed to the shared frontier engine, so granularity / depth-spread / sub-split
// all work, and biggest components crack first.
//
// Deliberately does NOT skip quotes as strings (apostrophes in prose would
// wreck it); it only skips // and /* */ comments, which don't occur in the
// grammar-less languages' prose. Bracket matching is best-effort.

import { buildTreeCached, cutTree, hashKey } from './frontier.js';

const OPEN = { '(': ')', '[': ']', '{': '}' };
const isWsChar = (c) => /\s/.test(c);

function indentOf(line) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

function skipComment(text, i, n) {
  if (text[i] === '/' && text[i + 1] === '/') { i += 2; while (i < n && text[i] !== '\n') i++; return i; }
  if (text[i] === '/' && text[i + 1] === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++; return Math.min(n, i + 2); }
  return i;
}

function matchBracket(text, open, n) {
  let depth = 0;
  let i = open;
  while (i < n) {
    const j = skipComment(text, i, n);
    if (j !== i) { i = j; continue; }
    const c = text[i];
    if (OPEN[c]) depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return n - 1;
}

function trim(text, s, e) {
  while (s < e && isWsChar(text[s])) s++;
  while (e > s && isWsChar(text[e - 1])) e--;
  return [s, e];
}

const label = (text, s, e) => text.slice(s, e).replace(/\s+/g, ' ').trim().slice(0, 60);

// Split a single region into bracket groups + ;/, -separated segments.
function splitInline(text, lo, hi) {
  const children = [];
  let segStart = lo;
  let i = lo;
  const flush = (end) => {
    const [s, e] = trim(text, segStart, end);
    if (e > s) children.push({ start: s, end: e, label: label(text, s, e), children: null });
  };
  while (i < hi) {
    const j = skipComment(text, i, hi);
    if (j !== i) { i = j; continue; }
    const c = text[i];
    if (OPEN[c]) {
      flush(i);
      const close = Math.min(matchBracket(text, i, hi), hi - 1);
      const inner = splitInline(text, i + 1, close);
      const [gs, ge] = trim(text, i, close + 1);
      children.push({ start: gs, end: ge, label: label(text, gs, ge), children: inner.length ? inner : null });
      i = close + 1; segStart = i; continue;
    }
    if (c === ',' || c === ';') { flush(i); i++; segStart = i; continue; }
    i++;
  }
  flush(hi);
  return children;
}

function buildGenericTree(text) {
  const lines = text.split('\n');
  const n = lines.length;
  const lineStart = new Array(n + 1);
  lineStart[0] = 0;
  for (let k = 0; k < n; k++) lineStart[k + 1] = lineStart[k] + lines[k].length + 1;

  const root = { start: 0, end: text.length, label: '(file)', children: [], _indent: -1 };
  const stack = [root];
  for (let k = 0; k < n; k++) {
    const line = lines[k];
    if (line.trim() === '') continue;
    const ind = indentOf(line);
    const node = {
      start: lineStart[k],
      end: lineStart[k] + line.length,
      label: label(text, lineStart[k], lineStart[k] + line.length),
      children: [],
      _indent: ind,
    };
    while (stack.length > 1 && stack[stack.length - 1]._indent >= ind) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  finalize(root, 0, text);
  return root;
}

function finalize(node, depth, text) {
  node.depth = depth;
  delete node._indent;
  if (node.children && node.children.length) {
    // A line with indented body → nest by indentation.
    for (const c of node.children) finalize(c, depth + 1, text);
    node.end = Math.max(node.end, ...node.children.map((c) => c.end));
    node.kind = 'container';
    return;
  }
  // A leaf line → break it up by brackets/separators.
  const inline = splitInline(text, node.start, node.end);
  if (inline.length > 1) {
    for (const c of inline) finalize(c, depth + 1, text);
    node.children = inline;
    node.kind = 'container';
  } else {
    node.children = null;
    node.kind = 'leaf';
  }
}

export function chunkGeneric(text, opts = {}) {
  const built = buildTreeCached(`generic:${hashKey(text)}`, text, () => buildGenericTree(text));
  return cutTree(text, built, opts);
}
