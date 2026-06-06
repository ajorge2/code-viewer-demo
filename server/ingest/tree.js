// Node resolution for the meaning recursion. Given a file, rebuild the SAME
// identified node set the /chunks endpoint produces — but at MAXIMUM granularity,
// where the frontier expands to every leaf, so the returned `nodes` closure spans
// the entire box tree (every node is an ancestor of some leaf). That gives us a
// flat, stateless map we can resolve any nodeId against, with no separate tree
// plumbing: the ids are a pure function of file content, identical to the ones the
// client already holds for the chunks it rendered.
import { languageFor } from './code.js';
import { chunkJson } from './json.js';
import { chunkCode } from './codeTree.js';
import { chunkGeneric } from './genericTree.js';
import { isParseable, loadTree } from './parseTree.js';

// Granularity past any real maxBoxes → chunkTree expands until nothing is left to
// split (all leaves). depthSpread ∞ so the depth limit never stalls expansion.
const FULL = { granularity: 1_000_000, depthSpread: 50 };

// Build the complete id->node map for a file, mirroring the endpoint's kind
// selection (json → tree-sitter code → generic fallback) so ids match exactly.
export async function fileNodes(file) {
  const lang = languageFor(file.relPath);

  if (lang === 'json') {
    try { return { kind: 'json', nodes: chunkJson(file.content, FULL).nodes }; }
    catch { /* malformed JSON → fall through, same as the endpoint */ }
  }

  if (lang && lang !== 'json' && isParseable(lang)) {
    const tree = await loadTree(file.content, lang);
    if (tree) {
      try { return { kind: 'code', nodes: chunkCode(file.content, tree, FULL).nodes }; }
      catch { /* box-build failure → fall through */ }
    }
  }

  return { kind: 'generic', nodes: chunkGeneric(file.content, FULL).nodes };
}

// Nearest semantic ancestor id, skipping synthetic balancing groups (which carry
// no standalone meaning — they're passed through). Returns null at the file root.
export function semanticParentId(nodes, id) {
  let pid = nodes[id]?.parent;
  while (pid && nodes[pid] && !nodes[pid].semantic) pid = nodes[pid].parent;
  return pid && nodes[pid] ? pid : null;
}

// Root-first chain of structural ancestor labels (for prompts / breadcrumbs).
export function semanticPath(nodes, id) {
  const out = [];
  for (let cur = id; cur && nodes[cur]; cur = nodes[cur].parent) {
    if (nodes[cur].semantic && nodes[cur].parent !== null) out.push(nodes[cur].label);
  }
  return out.reverse();
}

// ── Downward drilling (the inverse of the parent walk) ──────────────────────
// The flat `nodes` map only carries `parent`; invert it once to get children.
export function childrenIndex(nodes) {
  const idx = new Map();
  for (const id of Object.keys(nodes)) {
    const p = nodes[id].parent;
    if (p == null) continue;
    (idx.get(p) || idx.set(p, []).get(p)).push(id);
  }
  return idx;
}

// Nearest *semantic* descendants of a node — descend through synthetic balancing
// groups until the first real unit on each branch. Sorted by source position.
export function semanticChildren(nodes, idx, id) {
  const out = [];
  const visit = (cid) => {
    if (nodes[cid].semantic) out.push(cid);
    else for (const g of (idx.get(cid) || [])) visit(g);
  };
  for (const c of (idx.get(id) || [])) visit(c);
  out.sort((a, b) => nodes[a].start - nodes[b].start);
  return out;
}

// How many semantic levels exist below a node (0 = a semantic leaf). Bounds how
// deep "more detail" can drill before it hits the bottom of the tree.
export function maxSemanticDepth(nodes, idx, id) {
  const kids = semanticChildren(nodes, idx, id);
  if (!kids.length) return 0;
  let m = 0;
  for (const k of kids) m = Math.max(m, maxSemanticDepth(nodes, idx, k));
  return 1 + m;
}
