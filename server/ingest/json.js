// Structure-aware JSON chunking.
//
// This file is just the JSON *structure provider*: parse JSON → a box tree.
// The granularity / depth-spread / coverage engine lives in frontier.js and is
// shared with every other language (e.g. tree-sitter code in codeTree.js).
//
// 1. Parse JSON (JSONC-tolerant) into a tree of nodes carrying char-offset spans.
// 2. Turn it into a "box tree": objects crack into a key box + a value box per
//    member; arrays crack into an element box per element; scalars/keys are leaves.
// 3+4. Frontier expansion + coverage → see frontier.js (chunkTree).

import { buildTreeCached, cutTree, hashKey } from './frontier.js';

function isWs(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
}
function isDigit(c) {
  return c >= '0' && c <= '9';
}

// ---- parser ----
export function parseJsonTree(text) {
  let i = 0;
  const n = text.length;

  function skipTrivia() {
    while (i < n) {
      const c = text[i];
      if (isWs(c)) { i++; continue; }
      if (c === '/' && text[i + 1] === '/') { i += 2; while (i < n && text[i] !== '\n') i++; continue; }
      if (c === '/' && text[i + 1] === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
      break;
    }
  }

  function parseValue() {
    skipTrivia();
    if (i >= n) throw new Error('Unexpected end of input');
    const c = text[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (c === '-' || isDigit(c)) return parseNumber();
    if (text.startsWith('true', i)) { const s = i; i += 4; return { type: 'boolean', start: s, end: i }; }
    if (text.startsWith('false', i)) { const s = i; i += 5; return { type: 'boolean', start: s, end: i }; }
    if (text.startsWith('null', i)) { const s = i; i += 4; return { type: 'null', start: s, end: i }; }
    throw new Error(`Unexpected token '${c}' at ${i}`);
  }

  function parseString() {
    const s = i;
    i++; // opening quote
    while (i < n) {
      const c = text[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '"') { i++; break; }
      i++;
    }
    return { type: 'string', start: s, end: i };
  }

  function parseNumber() {
    const s = i;
    if (text[i] === '-') i++;
    while (i < n && isDigit(text[i])) i++;
    if (text[i] === '.') { i++; while (i < n && isDigit(text[i])) i++; }
    if (text[i] === 'e' || text[i] === 'E') { i++; if (text[i] === '+' || text[i] === '-') i++; while (i < n && isDigit(text[i])) i++; }
    return { type: 'number', start: s, end: i };
  }

  function parseObject() {
    const s = i;
    i++; // {
    const members = [];
    skipTrivia();
    while (i < n && text[i] !== '}') {
      skipTrivia();
      if (text[i] === '}') break; // trailing comma
      if (text[i] !== '"') throw new Error(`Expected key at ${i}`);
      const key = parseString();
      skipTrivia();
      if (text[i] !== ':') throw new Error(`Expected ':' at ${i}`);
      i++; // :
      const value = parseValue();
      members.push({ key, value });
      skipTrivia();
      if (text[i] === ',') { i++; skipTrivia(); continue; }
      break;
    }
    skipTrivia();
    if (text[i] !== '}') throw new Error(`Expected '}' at ${i}`);
    i++; // }
    return { type: 'object', start: s, end: i, members };
  }

  function parseArray() {
    const s = i;
    i++; // [
    const elements = [];
    skipTrivia();
    while (i < n && text[i] !== ']') {
      elements.push(parseValue());
      skipTrivia();
      if (text[i] === ',') { i++; skipTrivia(); continue; }
      break;
    }
    skipTrivia();
    if (text[i] !== ']') throw new Error(`Expected ']' at ${i}`);
    i++; // ]
    return { type: 'array', start: s, end: i, elements };
  }

  skipTrivia();
  const root = parseValue();
  return root;
}

// ---- box tree ----
function keyText(keyNode, text) {
  return text.slice(keyNode.start + 1, keyNode.end - 1);
}

// rank = split-type priority (lower cracks first): braces/brackets = 0, members
// whose value is itself a container = 1, scalar members (the key|value colon
// split) = 2. So nested structure is always revealed before scalar pairs are
// split by their colon.
function buildBox(node, text, depth, label) {
  if (node.type === 'object') {
    const members = node.members.map((m) => {
      const kt = keyText(m.key, text);
      const path = label ? `${label} ▸ ${kt}` : kt;
      const keyBox = { start: m.key.start, end: m.key.end, label: `${kt}:`, kind: 'leaf', children: null };
      const valBox = buildBox(m.value, text, depth + 2, path);
      const valIsContainer = m.value.type === 'object' || m.value.type === 'array';
      return {
        start: m.key.start,
        end: m.value.end,
        label: path,
        kind: 'container',
        children: [keyBox, valBox],
        rank: valIsContainer ? 1 : 2,
      };
    });
    return box(node, label, members, 0);
  }
  if (node.type === 'array') {
    const children = node.elements.map((el, idx) =>
      buildBox(el, text, depth + 1, label ? `${label} ▸ ${idx}` : String(idx)));
    return box(node, label, children, 0);
  }
  return { start: node.start, end: node.end, label: label || '(value)', kind: 'leaf', children: null };
}

function box(node, label, children, rank) {
  return {
    start: node.start,
    end: node.end,
    label: label || '(root)',
    kind: children.length ? 'container' : 'leaf',
    children: children.length ? children : null,
    rank,
  };
}

// ---- public API ----
export function chunkJson(text, opts = {}) {
  const built = buildTreeCached(`json:${hashKey(text)}`, text, () => buildBox(parseJsonTree(text), text, 0, ''));
  return cutTree(text, built, opts);
}
