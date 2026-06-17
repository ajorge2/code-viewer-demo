// Search-based "find references" — the no-LSP approach used by GitHub code navigation,
// Sourcegraph's search-based intel, and aider's repo map: walk tree-sitter parse trees for
// identifier nodes matching a name (skipping strings/comments), classify definition vs use
// from node context, and group by file. It's approximate — name-based, not scope-resolved,
// so unrelated same-named symbols match too — which is why the definition is marked. Files
// with no grammar fall back to a word-boundary text scan, like an IDE's plain text search.
import { isParseable, loadTree } from './parseTree.js';

// Leaf node types that are literals/comments, not identifiers — excluded so a name that
// happens to appear inside a string or comment isn't counted as a code reference.
const EXCLUDED = new Set([
  'string', 'string_fragment', 'string_content', 'template_string', 'raw_string_literal',
  'char', 'char_literal', 'comment', 'line_comment', 'block_comment', 'doc_comment',
  'escape_sequence', 'number', 'integer', 'float', 'regex', 'regex_pattern',
]);

// Parent node types that make an identifier a DEFINITION (covers the common grammars).
const DEF_PARENTS = new Set([
  'function_declaration', 'function_definition', 'generator_function_declaration',
  'method_definition', 'method_declaration', 'class_declaration', 'class_definition', 'class',
  'variable_declarator', 'field_definition', 'public_field_definition',
  'type_alias_declaration', 'interface_declaration', 'enum_declaration',
  'function_item', 'struct_item', 'enum_item', 'trait_item', 'const_item', 'static_item',
  'function_signature', 'namespace_definition',
]);
const CALL_PARENTS = new Set([
  'call_expression', 'call', 'function_call', 'function_call_expression',
  'method_invocation', 'new_expression', 'method_call',
]);
const IMPORT_TYPES = new Set([
  'import_statement', 'import_declaration', 'import_from_statement', 'import_specifier',
  'import_clause', 'use_declaration', 'require', 'using_directive', 'preproc_include',
]);

const MAX_HITS = 500; // bound the result set (surfaced as `truncated`, no silent cap)

// offset -> 1-based line + the line's [start, end), via a precomputed line-start array
// (same shape as CodeViewer's lineStart/lineOf).
function lineMapper(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) starts.push(i + 1);
  return (off) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, lineStart: starts[lo], lineEnd: starts[lo + 1] ?? content.length };
  };
}

const classify = (parentType, inImport) => {
  if (inImport) return 'import';
  if (DEF_PARENTS.has(parentType)) return 'definition';
  if (CALL_PARENTS.has(parentType)) return 'call';
  return 'reference';
};

// Walk the cached JSON parse tree ({type,start,end,children?}, named nodes only), pushing a
// hit for every identifier leaf whose text === name (exact, like an IDE).
function walkTree(root, content, name, push) {
  const visit = (node, parentType, inImport) => {
    const imp = inImport || IMPORT_TYPES.has(node.type);
    if (!node.children) {
      if (!EXCLUDED.has(node.type) && content.slice(node.start, node.end) === name) {
        push(node.start, classify(parentType, imp));
      }
      return;
    }
    for (const c of node.children) visit(c, node.type, imp);
  };
  visit(root, null, false);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// files: [{ id, relPath, content, language }]. fromId orders the origin file first.
export async function findReferences(name, files, fromId = null) {
  if (!name || name.length < 2) return { name, count: 0, truncated: false, definitions: [], files: [] };
  const textRe = new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`, 'g');
  const groups = [];
  let count = 0;
  let truncated = false;
  for (const f of files) {
    if (count >= MAX_HITS) { truncated = true; break; }
    const content = f.content || '';
    const toLine = lineMapper(content);
    const hits = [];
    const push = (offset, kind) => {
      if (count >= MAX_HITS) { truncated = true; return; }
      const { line, lineStart, lineEnd } = toLine(offset);
      hits.push({ offset, line, kind, lineText: content.slice(lineStart, lineEnd).replace(/\n$/, '').trim().slice(0, 200) });
      count += 1;
    };
    let usedTree = false;
    if (isParseable(f.language)) {
      const tree = await loadTree(content, f.language);
      if (tree) { usedTree = true; walkTree(tree, content, name, push); }
    }
    if (!usedTree) { // non-parseable / parse failed → text fallback
      textRe.lastIndex = 0;
      let m;
      while ((m = textRe.exec(content)) !== null) push(m.index, 'text');
    }
    if (hits.length) {
      hits.sort((a, b) => a.offset - b.offset);
      groups.push({ fileId: f.id, relPath: f.relPath, hits });
    }
  }
  groups.sort((a, b) => {
    if (a.fileId === fromId) return -1;
    if (b.fileId === fromId) return 1;
    return a.relPath.localeCompare(b.relPath);
  });
  const definitions = groups.flatMap((g) => g.hits
    .filter((h) => h.kind === 'definition')
    .map((h) => ({ fileId: g.fileId, relPath: g.relPath, line: h.line, offset: h.offset, lineText: h.lineText })));
  return { name, count, truncated, definitions, files: groups };
}
