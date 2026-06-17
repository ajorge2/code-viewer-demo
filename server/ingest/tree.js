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

// All proper ancestors of a node (raw parent chain, synthetic groups included).
function properAncestors(nodes, id) {
  const out = [];
  let p = nodes[id]?.parent;
  while (p && nodes[p]) { out.push(p); p = nodes[p].parent; }
  return out;
}

// The MINIMAL frontier that contains a set of marked boxes. A frontier is a tiling
// antichain — boxes that cover the whole file end-to-end, none an ancestor of
// another. Given the marks the user has asked about, this returns the coarsest such
// tiling in which every mark still appears as its own box, so each marked box is
// isolated and every mark-free stretch stays as one big box. It's the inverse of the
// per-highlight tightest-box descent: that finds one box, this fills the rest of the
// file around a SET of them with as few boxes as possible.
//
//   • Synthetic balancing groups carry no standalone meaning, so a mark on one
//     resolves UP to its nearest real (semantic) box — same rule as semanticParentId.
//   • Stale marks (ids from an older file version, absent from `nodes`) are dropped.
//   • Finer wins: if one mark properly contains another, the coarser one is split
//     open rather than kept whole, so only the deepest (antichain) marks are members.
//
// Returns frontier node ids sorted by source position. Zero/all-stale marks → [root].
export function minimalFrontier(nodes, idx, rootId, markIds) {
  // 1. Resolve each mark to its nearest semantic box; drop stale ids.
  const resolved = new Set();
  for (const raw of markIds) {
    let cur = raw;
    while (cur && nodes[cur] && !nodes[cur].semantic) cur = nodes[cur].parent;
    if (cur && nodes[cur]) resolved.add(cur);
  }
  // 2. Finer wins: keep only marks that aren't a proper ancestor of another mark.
  const ancestorUnion = new Set();
  for (const id of resolved) for (const a of properAncestors(nodes, id)) ancestorUnion.add(a);
  const effective = [...resolved].filter((id) => !ancestorUnion.has(id));
  // 3. The boxes that must be cracked open to expose a mark = ancestors of effectives.
  const splitThrough = new Set();
  for (const id of effective) for (const a of properAncestors(nodes, id)) splitThrough.add(a);
  // 4. Emit top-down: keep a box whole unless it must be split through to reach a mark.
  const frontier = [];
  const expand = (id) => {
    const kids = idx.get(id) || [];
    if (splitThrough.has(id) && kids.length) { for (const c of kids) expand(c); }
    else frontier.push(id);
  };
  expand(rootId);
  // 5. Source order.
  frontier.sort((a, b) => nodes[a].start - nodes[b].start);
  return frontier;
}
