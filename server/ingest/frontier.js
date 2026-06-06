import crypto from 'crypto';

// Shared chunking engine — turns ANY "box tree" into flat chunks driven by the
// three controls. A box tree is a hierarchy of nodes:
//   { start, end, depth, label, kind: 'container'|'leaf', children }
// where start/end are CHARACTER offsets. JSON builds one from its parser; code
// builds one from a tree-sitter parse. Everything below is source-agnostic.
//
//  • Granularity → frontier expansion: start at the root and repeatedly crack
//    the LARGEST eligible box into its children.
//  • Depth-spread D → how uneven the frontier may get (0 = even, Infinity =
//    pure largest-first). Leaves are terminal and exempt.
//  • Coverage → every character gets a home via delimiter attachment (openers
//    ride right, closers/neutrals ride left), so boxes are flat, contiguous,
//    and land on structural seams.

// Characters that "ride left" (attach to the preceding box): closing brackets
// and separators. Everything else (openers, identifiers, whitespace) rides
// right. This superset covers JSON (`} ] : ,`) and code (`) ; ,` too).
const LEFT_ATTACH = new Set(['}', ']', ')', ',', ';', ':']);

export function countLeaves(box) {
  if (box.kind === 'leaf' || !box.children) return 1;
  let s = 0;
  for (const c of box.children) s += countLeaves(c);
  return s;
}

// Cap each node's branching factor by grouping runs of siblings into balanced
// sub-containers. Without this, a wide node (a module's 40 statements, a YAML
// list of 2000 items) would crack into all its children in one step — making
// granularity jumpy and depth-spread meaningless.
//
// MAX_BRANCH = 2 (binary) makes every crack split one box into exactly two, so
// each step of the granularity slider adds exactly one chunk: chunk count ==
// granularity across the whole range, no dead zones. (Higher values plateau at
// the low end — e.g. with 8, granularity 2..8 all yield 8 chunks, because the
// first crack of the root reveals up to 8 balanced groups at once.) The cost is
// deeper synthetic nesting over wide nodes, but those group nodes are marked
// non-semantic and passed through by the meaning recursion, so there's no LLM
// cost — only a slightly larger `nodes` map.
const MAX_BRANCH = 2;

function balance(node) {
  if (!node.children || !node.children.length) return;
  let kids = node.children;
  if (kids.length > MAX_BRANCH) {
    const groupSize = Math.ceil(kids.length / MAX_BRANCH);
    const grouped = [];
    for (let i = 0; i < kids.length; i += groupSize) {
      const slice = kids.slice(i, i + groupSize);
      if (slice.length === 1) { grouped.push(slice[0]); continue; }
      grouped.push({
        start: slice[0].start,
        end: slice[slice.length - 1].end,
        kind: 'container',
        children: slice,
        label: `${(slice[0].label || '').slice(0, 24)} … (${slice.length})`,
        rank: Math.min(...slice.map((c) => c.rank ?? 0)),
        synthetic: true, // a balancing group, not a real structural unit
      });
    }
    node.children = grouped;
  }
  for (const c of node.children) balance(c);
}

function setDepth(node, depth) {
  node.depth = depth;
  if (node.children) for (const c of node.children) setDepth(c, depth + 1);
}

// Short hex digest of an arbitrary key string — the building block for node ids.
function shortHash(s, len = 12) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, len);
}

// Give every box a STABLE identity. Crucially this is a function of the tree
// alone — granularity / depth-spread only move the frontier *cut*, they never
// reshape the tree — so these ids are identical across every chunking of the
// same file. That's what lets the meaning cache key on structure instead of on
// the (settings-dependent) emitted chunks.
//
//   • id   — path identity: hash(parentId : start : end). Unique per node (the
//            parentId prefix disambiguates single-child chains that share a span).
//            Used as the client handle and as the key for the "meaning WITH
//            outside context" cache, since a node's ancestor chain is fixed.
//   • hash — content identity: hash(node text). Identical spans anywhere in the
//            project collide on purpose, so the context-free "meaning WITHOUT
//            outside context" cache is reused across copies.
//   • semantic — false for synthetic balancing groups (pass-through scaffolding,
//            not real structural units); true for genuine boxes.
//
// `parent` is a non-enumerable back-pointer so the tree never self-serializes.
function assignIdentity(node, text, parentId) {
  node.id = shortHash(`${parentId}:${node.start}:${node.end}`);
  node.hash = shortHash(text.slice(node.start, node.end), 16);
  node.semantic = !node.synthetic;
  if (node.children) {
    for (const c of node.children) {
      Object.defineProperty(c, 'parent', { value: node, enumerable: false, configurable: true, writable: true });
      assignIdentity(c, text, node.id);
    }
  }
}

// Walk each frontier box up to the root, collecting a flat id->meta map of every
// node on any emitted chunk's ancestor path. Shared prefixes are stored once (the
// `while` stops as soon as it hits an already-recorded ancestor), so this is the
// minimal closure the client needs to reconstruct any chunk's full ancestry.
function collectNodes(frontier) {
  const nodes = {};
  for (const box of frontier) {
    let cur = box;
    while (cur && !nodes[cur.id]) {
      nodes[cur.id] = {
        id: cur.id,
        parent: cur.parent ? cur.parent.id : null,
        label: cur.label,
        start: cur.start,
        end: cur.end,
        depth: cur.depth,
        semantic: cur.semantic,
        hash: cur.hash,
      };
      cur = cur.parent;
    }
  }
  return nodes;
}

// Split point in the gap [a, b): everything up to and including the last
// left-attaching char belongs to the left box; the rest (indentation + openers)
// belongs to the right box.
function splitGap(text, a, b) {
  let boundary = a; // default: nothing left-attaching → all to the right box
  for (let p = a; p < b; p++) {
    if (LEFT_ATTACH.has(text[p])) boundary = p + 1;
  }
  return boundary;
}

function assignCoverage(text, rootBox, frontier) {
  const lo = rootBox.start;
  const hi = rootBox.end;
  const n = frontier.length;
  const bounds = [];
  for (let j = 0; j < n - 1; j++) {
    bounds.push(splitGap(text, frontier[j].end, frontier[j + 1].start));
  }
  const chunks = [];
  for (let k = 0; k < n; k++) {
    chunks.push({
      index: k,
      start: k === 0 ? lo : bounds[k - 1],
      end: k === n - 1 ? hi : bounds[k],
      label: frontier[k].label,
      depth: frontier[k].depth,
      nodeId: frontier[k].id, // stable handle into `nodes` (the box's ancestry)
    });
  }
  return chunks;
}

// "Chunk around a highlighted range" — the inverse of the granularity slider.
// Instead of a target box COUNT, the caller hands us a character range they care
// about, and we produce the FEWEST chunks that still isolate it:
//
//   1. Descend to the smallest box that fully contains [start, end) — the
//      "tightest-fit" chunk. (No semantic snapping: a synthetic balancing box is
//      a valid chunk and still has a stable id.)
//   2. Path-decompose: walk root → that box; at every node on the path keep each
//      OFF-path sibling subtree as one whole chunk, and only descend along the
//      path. The result `{target} ∪ {off-path siblings at each level}` is a
//      partition of the file, and it is provably the minimum-size frontier that
//      contains `target` (any coarser cut would have to merge target with a
//      sibling).
//
// Runs on the already balanced + identified tree, so ids match every other
// chunking of the file.
function frontierAround(root, rawStart, rawEnd) {
  let s = Math.min(rawStart, rawEnd);
  let e = Math.max(rawStart, rawEnd);
  if (e <= s) e = s + 1; // collapsed caret → a 1-char range so containment holds
  s = Math.max(root.start, Math.min(s, root.end - 1));
  e = Math.max(s + 1, Math.min(e, root.end));

  // 1. Smallest box fully containing the range. A box contains [s,e) iff
  //    box.start <= s && box.end >= e. If the range straddles a gap between two
  //    children, no child contains it and the current node is the tightest fit.
  let target = root;
  while (target.children && target.children.length) {
    const next = target.children.find((c) => c.start <= s && c.end >= e);
    if (!next) break;
    target = next;
  }

  // 2. Path decomposition: emit every off-path sibling whole, descend the path.
  const path = [];
  for (let cur = target; cur; cur = cur.parent) path.push(cur);
  path.reverse(); // [root, …, target]
  const frontier = [];
  for (let i = 0; i < path.length - 1; i++) {
    for (const child of path[i].children) {
      if (child !== path[i + 1]) frontier.push(child);
    }
  }
  frontier.push(target);
  return { frontier, targetBox: target };
}

// Granularity = target box count. The tree is balanced first so each crack
// reveals at most MAX_BRANCH boxes; we then repeatedly crack the LARGEST box
// within `depthSpread` of the shallowest still-splittable box until we reach the
// target. Small cracks mean granularity ≈ chunk count (smooth) AND depth-spread
// shapes every step (even breadth at D=0 → deep dives at D=∞).
//
// Alternatively, pass `around: { start, end }` to chunk around a highlighted
// range (see frontierAround) instead of by count — granularity/depthSpread are
// then ignored.
// Build the identified box tree from a raw box tree: balance branching, set
// depths, assign stable ids/hashes (a SHA over every node's text). This is a pure
// function of (text, tree shape) — granularity/depth/around never reshape the
// tree, they only move the cut — so the result is cached per file (see
// buildTreeCached) and only cutTree below reruns per request.
export function buildTree(text, root) {
  balance(root);
  setDepth(root, 0);
  assignIdentity(root, text, '');
  return { root, maxBoxes: countLeaves(root) };
}

// Cut a frontier out of an ALREADY-built tree. Read-only on `built` (the frontier
// is a local array; coverage/collect only read the nodes), so one cached built
// tree can serve any number of cuts at different settings.
export function cutTree(text, { root, maxBoxes }, { granularity = 1, depthSpread = 0, around = null } = {}) {
  let frontier;
  let targetBox = null;
  if (around) {
    ({ frontier, targetBox } = frontierAround(root, around.start, around.end));
  } else {
    const target = Math.max(1, Math.min(granularity, maxBoxes));
    frontier = [root];
    while (frontier.length < target) {
      const splittable = frontier.filter((b) => b.kind === 'container' && b.children && b.children.length);
      if (!splittable.length) break;
      const minDepth = Math.min(...splittable.map((b) => b.depth));
      const limit = depthSpread === Infinity ? Infinity : minDepth + depthSpread;
      const eligible = splittable.filter((b) => b.depth <= limit);
      if (!eligible.length) break;
      // Among eligible boxes: lower `rank` (split type, e.g. braces before colons)
      // wins first; size is only the tiebreaker. rank defaults to 0.
      let pick = eligible[0];
      for (const b of eligible) {
        const rb = b.rank ?? 0;
        const rp = pick.rank ?? 0;
        if (rb < rp || (rb === rp && b.end - b.start > pick.end - pick.start)) pick = b;
      }
      const at = frontier.indexOf(pick);
      frontier.splice(at, 1, ...pick.children);
    }
  }

  frontier.sort((a, b) => a.start - b.start);
  return {
    maxBoxes,
    chunks: assignCoverage(text, root, frontier),
    nodes: collectNodes(frontier),
    targetNodeId: targetBox ? targetBox.id : null,
  };
}

// Per-file cache of built trees, keyed by `${kind}:${contentHash}`. Building a
// tree is invariant across the sliders yet /chunks reran it on every tick and
// fileNodes on every Q&A — this memoizes it so only the cut reruns. Unbounded,
// like the parse-tree memCache; entries are small and bounded by distinct file
// contents (a content change yields a new key, so this self-invalidates).
const builtCache = new Map();
export function buildTreeCached(key, text, makeRoot) {
  let built = builtCache.get(key);
  if (!built) { built = buildTree(text, makeRoot()); builtCache.set(key, built); }
  return built;
}

// Content key for buildTreeCached. Callers namespace it by provider kind so two
// different files with identical text but different parsers can't collide.
export function hashKey(s) { return shortHash(s, 16); }

// Back-compat one-shot (build + cut, uncached). Providers use buildTreeCached +
// cutTree directly so the build is shared across requests.
export function chunkTree(text, root, opts = {}) {
  return cutTree(text, buildTree(text, root), opts);
}
