// Code structure provider — consumes a parse tree (from tree-sitter, produced at
// ingest with CHARACTER offsets) and feeds the shared frontier engine, so the
// granularity / depth-spread / sub-split controls work on code exactly like JSON.
//
// Expected node shape (the ingest/upload session emits this per file):
//   { type, start, end, children?, named?, label? }   // start/end = char offsets
//
// We keep only NAMED nodes as boxes (the structural units: module → function →
// statement → expression → operand → identifier). Anonymous nodes — operators,
// punctuation, keywords (`&&`, `(`, `;`, `const`) — are dropped here and become
// the GAPS between sibling boxes, which frontier.js's coverage step attaches to a
// neighbor (just like JSON's `:`/`,`). That makes the deepest granularity bottom
// out at operands / identifiers ≈ word level, without operators being their own
// boxes.

import { buildTreeCached, cutTree, hashKey } from './frontier.js';

function boxFromParse(node, depth = 0) {
  // Drop anonymous nodes (operators/punctuation/keywords) — they're glue, not boxes.
  const kids = (node.children || []).filter((c) => c.named !== false);
  const childBoxes = kids.map((c) => boxFromParse(c, depth + 1));
  const isContainer = childBoxes.length > 0;
  return {
    start: node.start,
    end: node.end,
    depth,
    label: node.label || node.type || '(node)',
    kind: isContainer ? 'container' : 'leaf',
    children: isContainer ? childBoxes : null,
  };
}

// `parseTree` is the root node of the ingest-produced tree (character offsets).
export function chunkCode(text, parseTree, opts = {}) {
  const built = buildTreeCached(`code:${hashKey(text)}`, text, () => boxFromParse(parseTree, 0));
  return cutTree(text, built, opts);
}

// Exported for tests / reuse.
export { boxFromParse };
