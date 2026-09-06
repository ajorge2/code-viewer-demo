// RAG meaning engine. A question about a selected chunk is answered against a
// recursively-built "meaning" of that chunk:
//
//   bare(node)         = what this unit means WITHOUT outside context
//                        — a pure function of its text → cached by content hash,
//                          so identical spans anywhere reuse it.
//   contextualized(n)  = what it means WITH outside context
//                        = fold(bare(n), contextualized(nearest semantic parent))
//                        — recurses up to the file root → cached by node id,
//                          so the shared ancestor prefix is computed once and
//                          reused across every chunk in the file (trie-like).
//
// Synthetic balancing groups are skipped (semanticParentId), so the recursion
// depth tracks real nesting, not the binary tree's inflated depth. The final
// answer is a separate call that uses the contextualized meaning as context.
import 'dotenv/config';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import {
  fileNodes, semanticParentId, semanticPath,
  childrenIndex, semanticChildren, maxSemanticDepth, minimalFrontier,
} from '../ingest/tree.js';
import { getProjectTree, folderChainTo, folderChainToDir } from '../ingest/projectTree.js';
import { assignCoverage } from '../ingest/frontier.js';
import { cacheGet, cacheSet } from './cache.js';

// bare → Haiku (many cheap summaries, incl. the whole-project eager pass).
// folds / classify / answer keep the smarter default. All env-overridable.
const BARE_MODEL = process.env.BARE_MODEL || 'claude-haiku-4-5';
const MEANING_MODEL = process.env.MEANING_MODEL || 'claude-opus-4-8';
const ANSWER_MODEL = process.env.ANSWER_MODEL || 'claude-opus-4-8';

// The `effort` parameter is Opus-4.5+/Sonnet-4.6 only — it 400s on Haiku 4.5.
// Spread this so bare calls (Haiku) omit it while Opus calls keep it.
const supportsEffort = (m) => m.includes('opus') || m === 'claude-sonnet-4-6';
const effortCfg = (m, level) => (supportsEffort(m) ? { output_config: { effort: level } } : {});

// Fixed char cap for the code snippets shown to the answer/edit/folder models (clip()).
const MAX_SNIPPET = 48000;
// A small selection the reader literally highlighted (not the resolved box) gets quoted
// verbatim into the answer prompt so the answer can be precise about those few chars.
// Only when it's short — past this it's a region, better served by the surrounding unit.
const HIGHLIGHT_QUOTE_CAP = 200;
// Default bare-window size: the char budget above which a unit's bare is computed by
// a windowed map-reduce (bareSummary) instead of one call. Per-project overridable via
// the active project's tab slider; this is the fallback (sample / unset). Distinct from
// MAX_SNIPPET so the slider never changes how much code the answer model sees.
const DEFAULT_BARE_WINDOW = Number(process.env.BARE_WINDOW_CHARS) || 48000;
const MAX_WINDOWS = 24; // cap on map-reduce windows (bounds fan-out + the combine input)

// Slice to the cap, but make truncation EXPLICIT — a blind .slice() hands the
// model a file that just stops mid-token, and it then confidently guesses at code
// it was never shown. The marker lets it say "I can't see the rest" instead.
function clip(s) {
  if (s.length <= MAX_SNIPPET) return s;
  return `${s.slice(0, MAX_SNIPPET)}\n\n…[truncated: showing first ${MAX_SNIPPET} of ${s.length} chars]`;
}

// Global cap on simultaneous model calls (rate-limit friendly). Everything routes
// through withSlot, so the eager whole-project pass and interactive requests share
// one ceiling instead of each spawning unbounded fan-out.
const CONCURRENCY = 8;
let activeSlots = 0;
const slotQueue = [];
async function withSlot(fn) {
  if (activeSlots >= CONCURRENCY) await new Promise((r) => slotQueue.push(r));
  activeSlots += 1;
  try { return await fn(); } finally { activeSlots -= 1; slotQueue.shift()?.(); }
}

// Persistent memo (see cache.js). Key namespaces:
//   bare → `b:<hash>`            content-addressed (node text, file content, or a
//                                folder's child-hash digest) — shared everywhere.
//   ctx  → `c:<ctxNS>:<id>`      ctxNS = hash(folderChain · fileHash) so a node's
//                                contextual meaning is keyed by its FULL upward
//                                context (folders included), not just its file.
//   dir  → `c:dir:<folderHash>`  a folder's own contextual meaning.
const fileHashOf = (content) => crypto.createHash('sha1').update(content).digest('hex').slice(0, 16);

let _client = null;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const e = new Error('ANTHROPIC_API_KEY is not set (add it to .env).');
    e.status = 503;
    throw e;
  }
  if (!_client) _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return _client;
}

const textOf = (msg) => msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

const BARE_SYSTEM =
  'You explain a single unit of source code in isolation. In 1-3 sentences, say what '
  + 'this unit does and what role it plays, judging only from the code shown — do not '
  + 'guess about callers or surrounding scope. Respond with only the explanation, no preamble.';

const CTX_SYSTEM =
  'You explain a unit of source code given (a) what it means in isolation and (b) a '
  + 'summary of its surrounding scope. The unit\'s own isolated meaning is the core of '
  + 'your explanation — keep it the subject and let it carry most of the weight. Use the '
  + 'surrounding scope only to situate and lightly refine that meaning, never to '
  + 'overtake it or shift the focus onto neighbors or the parent. In 1-3 sentences, '
  + 'explain what the unit is, with just enough context to place it. Respond with only '
  + 'the explanation.';

// Shared voice for the user-facing answers (file chat + folder chat). The goal is
// plain, committed, concrete explanation that reads like a person who knows the code
// talking to a peer — not the even-handed, hedged, summary-closing register an LLM
// falls into by default. The bans below target the autopilot reflexes (stance
// adverbs, "-ing" tails, both-sides hedging, summary wrap-ups), not real rhetoric.
const VOICE =
  'How to write the answer:\n'
  + '- Lead with the answer. The first sentence is the thing they asked for — the '
  + 'verdict, the what, the why. Supporting detail comes after. Cut preamble, cut '
  + 'restating the question.\n'
  + '- Explain it the way you would say it out loud to a friend who codes. Plain words: '
  + '"use" not "leverage", "handle" not "navigate", "solid" not "robust", "builds" not '
  + '"fosters", "full" not "comprehensive". If you would not say a word out loud, do not '
  + 'type it.\n'
  + '- Commit. You can see the code, so state what it does — drop "it seems", "this '
  + 'likely", "one could argue", "may potentially". Steel-man a tradeoff once if it '
  + 'matters, then land a verdict; do not balance every point with its counter.\n'
  + '- Name concrete things: the actual function, variable, branch, or value, not "the '
  + 'logic" or "the implementation".\n'
  + '- Build intuition for WHY the code works the way it does, not just what it does.\n'
  + '- Vary the rhythm. A short blunt sentence next to a longer one reads human; a wall '
  + 'of same-length sentences reads like a machine.\n'
  + 'Avoid the tells that make writing read as AI-generated:\n'
  + '- No flattery or agreement-openers ("Great question", "You\'re right", "Good catch"). '
  + 'Just answer.\n'
  + '- No stance adverbs ("Notably", "Importantly", "Interestingly", "It is worth noting", '
  + '"Crucially"). Let the fact land on its own.\n'
  + '- No "-ing" tack-on tails that bolt significance onto a sentence instead of a fact '
  + '("…, highlighting a broader pattern"). Make it its own plain sentence or cut it.\n'
  + '- No "it is not just X, it is Y" contrast shape. No "In essence / Ultimately / At '
  + 'its core / To summarize" wrap-up — end on the sharpest concrete line, never a recap.\n'
  + '- No "Moreover / Furthermore / Additionally" signposting. Use "and", "but", "so", or '
  + 'nothing. Go easy on em-dashes.\n'
  + '- Every sentence adds a new fact or turn. If a sentence only restates the previous '
  + 'one in fresher words, cut it.\n'
  + 'Warm, but write across to a peer — never down to them, never fawning. Prose, not '
  + 'bulleted lists or bolded keywords (a short inline `code` reference is fine).';

const ANSWER_SYSTEM =
  'You help someone understand a specific unit of source code. Use the supplied '
  + 'contextual meaning, any sub-part breakdown, and the code itself. Treat all of that '
  + 'as your OWN understanding — it is internal scaffolding the reader never sees, so '
  + 'never refer to it. Do not mention "the summary", "the contextual meaning", "the '
  + 'breakdown", "the provided context", or similar; just speak about the code directly, '
  + 'as if you simply know it. If the answer is not determinable from what is shown, say '
  + 'so plainly.\n\n'
  + VOICE
  + '\n\nAim for the fewest words that fully answer the question, ideally within about '
  + '500 characters or less.';

const CLASSIFY_SYSTEM =
  'Classify the user\'s newest message relative to the conversation. Answer "deepen" '
  + 'if it expresses dissatisfaction with the previous answer or asks for more detail / '
  + 'specificity about the SAME thing. Answer "new" if it is a different question. '
  + 'Reply with exactly one word: deepen or new.';

const FOLDER_BARE_SYSTEM =
  'You summarize what a directory in a codebase is for, given short summaries of its '
  + 'immediate contents (files and subdirectories). In 1-3 sentences, say what this '
  + 'directory holds and the role it plays. Respond with only the summary, no preamble.';

// Decide whether a follow-up wants more detail on the same thing (ratchet depth
// up) or is a fresh question (reset to true granularity). Only called when there
// is prior conversation and the selection is unchanged.
async function classifyIntent(transcript, message) {
  const convo = transcript.map((t) => `${t.role}: ${t.text}`).join('\n');
  const msg = await withSlot(() => client().messages.create({
    model: MEANING_MODEL,
    max_tokens: 8,
    ...effortCfg(MEANING_MODEL, 'low'),
    system: [{ type: 'text', text: CLASSIFY_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Conversation:\n${convo}\n\nNewest message: "${message}"\n\nOne word: deepen or new.` }],
  }));
  return textOf(msg).toLowerCase().includes('deepen') ? 'deepen' : 'new';
}

// Batch helper (still handy for fan-out); the real ceiling is withSlot above.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// In-flight dedup: concurrent requests for the same key share one computation
// (and one model call), so parallel sibling drills can't each kick off the same
// shared-ancestor ctx. Keyed identically to the persistent cache.
const barePending = new Map();
const ctxPending = new Map();

// Shared context-free summarizer (Haiku). Used by in-file bares, file-leaf bares,
// and folder bares — content-addressed by `key`, deduped, and slot-bounded.
async function computeBare(key, label, body, meta) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  if (barePending.has(key)) return barePending.get(key);
  const p = (async () => {
    const out = textOf(await withSlot(() => client().messages.create({
      model: BARE_MODEL,
      max_tokens: 512,
      ...effortCfg(BARE_MODEL, 'low'),
      system: [{ type: 'text', text: meta.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: body }],
    })));
    cacheSet(key, out, { fileHash: meta.fileHash, kind: meta.kind });
    return out;
  })();
  barePending.set(key, p);
  try { return await p; } finally { barePending.delete(key); }
}

// Split oversized text into the fewest windows that each fit one bare call: n =
// ceil(len/target), then ~n even pieces (avg ≈ len/n ≤ target) cut on line
// boundaries; a single line longer than a window is hard-split at char boundaries
// (the grammar-free fallback for minified blobs). With target ~48k chars a normal
// multi-line file packs thousands of words per window. There is NO enforced minimum,
// though — an odd layout (a tiny line right before a near-target one, or a giant
// single line) can emit a small window. That's harmless: one cheap extra summary the
// combine step absorbs, so no floor is worth enforcing. Pure function.
function splitWindows(text, target = MAX_SNIPPET, maxWindows = MAX_WINDOWS) {
  const n = Math.min(Math.ceil(text.length / target), maxWindows);
  if (n <= 1) return [text];
  const size = Math.ceil(text.length / n);
  const windows = [];
  let buf = '';
  for (const line of text.split(/(?<=\n)/)) { // keep each line's trailing \n
    if (line.length > size) {
      if (buf) { windows.push(buf); buf = ''; } // flush, then hard-split the long line
      for (let p = 0; p < line.length; p += size) windows.push(line.slice(p, p + size));
      continue;
    }
    if (buf && buf.length + line.length > size) { windows.push(buf); buf = ''; }
    buf += line;
  }
  if (buf) windows.push(buf);
  return windows;
}

// Reduce step: merge the ordered per-window summaries into one unified bare.
const BARE_COMBINE_SYSTEM =
  'You are given ordered summaries of consecutive parts of a single source unit (a '
  + 'file or a large code/text blob), in order. Produce ONE unified explanation of '
  + 'the whole unit in 1-3 sentences — what it is and the role it plays — as if you '
  + 'had read it end to end. Respond with only the explanation, no preamble.';

async function foldWindows(headline, parts) {
  const listing = parts.map((p, i) => `Part ${i + 1}/${parts.length}: ${p}`).join('\n');
  const msg = await withSlot(() => client().messages.create({
    model: BARE_MODEL,
    max_tokens: 512,
    ...effortCfg(BARE_MODEL, 'low'),
    system: [{ type: 'text', text: BARE_COMBINE_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Summaries of consecutive parts of ${headline}, in order:\n${listing}\n\nGive one unified 1-3 sentence summary of the whole.` }],
  }));
  return textOf(msg);
}

// Context-free summary of a unit, content-addressed by `key`. A unit within the cap
// takes one call (computeBare). An oversized unit is MAPPED (one bare per window,
// each content-addressed so identical spans reuse the cache) then REDUCED
// (foldWindows), with the unified result cached under `key`. The windows are
// ephemeral scaffolding for this one summary — never chunks, never in the tree.
// Replaces clip-and-truncate for bares.
async function bareSummary(key, headline, rawText, meta, windowChars = DEFAULT_BARE_WINDOW) {
  const clipW = (s) => (s.length <= windowChars ? s
    : `${s.slice(0, windowChars)}\n\n…[truncated: showing first ${windowChars} of ${s.length} chars]`);
  const frame = (head, t) => `${head}:\n\n\`\`\`\n${clipW(t)}\n\`\`\``;
  if (rawText.length <= windowChars) return computeBare(key, headline, frame(headline, rawText), meta);
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  if (barePending.has(key)) return barePending.get(key);
  const p = (async () => {
    const windows = splitWindows(rawText, windowChars);
    const parts = await mapLimit(windows, CONCURRENCY, (win, i) => computeBare(
      `b:${fileHashOf(win)}`,
      `${headline} part ${i + 1}/${windows.length}`,
      frame(`Part ${i + 1}/${windows.length} of ${headline}`, win),
      { system: meta.system, fileHash: meta.fileHash, kind: 'barewindow' },
    ));
    const out = await foldWindows(headline, parts);
    cacheSet(key, out, { fileHash: meta.fileHash, kind: meta.kind });
    return out;
  })();
  barePending.set(key, p);
  try { return await p; } finally { barePending.delete(key); }
}

// The fold: combine a unit's context-free meaning with its surrounding scope.
async function foldMeaning(node, bare, outer) {
  const msg = await withSlot(() => client().messages.create({
    model: MEANING_MODEL,
    max_tokens: 512,
    ...effortCfg(MEANING_MODEL, 'low'),
    system: [{ type: 'text', text: CTX_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `The unit (${node.label}) in isolation — this is the subject, anchor on it:\n${bare}\n\n`
        + `Surrounding scope (background, to situate it only):\n${outer}\n\n`
        + 'Explain what this unit is, keeping its own isolated meaning as the core and '
        + 'using the surrounding scope only to lightly situate it.',
    }],
  }));
  return textOf(msg);
}

// Drill `depth` semantic levels into a node's subtree and describe that level's
// units. Reuses the cache: each descendant's ctx folds off its (warm) parent.
// Semantic leaves contribute raw code (their "meaning" is too thin); the bottom
// of the tree is the most granular view, exactly as intended.
const DRILL_CAP = 24; // bound fan-out; surfaced as `truncated` (no silent caps)

async function drillDetail(nodes, idx, nodeId, depth, text, ctxNS, rootContext, windowChars) {
  let frontier = [nodeId];
  let reached = 0;
  for (let level = 1; level <= depth; level++) {
    const next = frontier.flatMap((pid) => semanticChildren(nodes, idx, pid));
    if (!next.length) break; // bottomed out before the requested depth
    frontier = next;
    reached = level;
  }
  if (reached === 0) return { detail: '', units: 0, truncated: false, reached: 0 };
  const truncated = frontier.length > DRILL_CAP;
  const pick = frontier.slice(0, DRILL_CAP);
  // Siblings are independent (each folds off the already-warm selected node), so
  // describe them concurrently; the in-flight dedup absorbs any shared ancestors.
  const parts = await mapLimit(pick, CONCURRENCY, async (cid) => {
    const node = nodes[cid];
    if (semanticChildren(nodes, idx, cid).length === 0) {
      return `- ${node.label} (code):\n\`\`\`\n${text.slice(node.start, node.end).slice(0, 600)}\n\`\`\``;
    }
    return `- ${node.label}: ${await contextualizedMeaning(nodes, cid, text, ctxNS, rootContext, windowChars)}`;
  });
  return { detail: parts.join('\n'), units: pick.length, truncated, reached };
}

// In-file node bare — context-free meaning of the node's own text.
function bareMeaning(nodes, id, text, ctxNS, windowChars) {
  const node = nodes[id];
  return bareSummary(`b:${node.hash}`, `Unit (${node.label})`, text.slice(node.start, node.end),
    { system: BARE_SYSTEM, fileHash: ctxNS, kind: 'bare' }, windowChars);
}

// File-leaf bare for the folder pass — same key as the in-file root node, so a
// file's folder-level summary and its whole-file summary are one cached value.
function bareFile(node, content, windowChars) {
  return bareSummary(node.bareKey, `File (${node.name})`, content,
    { system: BARE_SYSTEM, fileHash: node.contentHash, kind: 'bare' }, windowChars);
}

// Folder bare — summarize the (already-computed) bares of its direct children.
function bareFolder(node, childBares) {
  const listing = node.children
    .map((c, i) => `- ${c.name}${c.kind === 'dir' ? '/' : ''}: ${childBares[i]}`)
    .join('\n');
  return computeBare(node.bareKey, node.name || '(project root)',
    `Directory "${node.name || '(project root)'}" contains:\n${listing}`,
    { system: FOLDER_BARE_SYSTEM, fileHash: node.hash, kind: 'folderbare' });
}

// Part 1 — eager bottom-up bare pass over the whole project, run on upload. File
// bares (parallel) then folder summaries up to the root. Idempotent via the cache
// (re-runs are hits); slot-bounded; no key → no-op.
export async function warmProjectBares(files, windowChars = DEFAULT_BARE_WINDOW) {
  const tree = getProjectTree();
  if (!tree || !process.env.ANTHROPIC_API_KEY) return;
  const contentByPath = new Map(files.map((f) => [f.relPath.replace(/\\/g, '/'), f.content]));
  const warm = async (node) => {
    if (node.kind === 'file') return bareFile(node, contentByPath.get(node.path) ?? '', windowChars);
    const childBares = await Promise.all(node.children.map(warm));
    return bareFolder(node, childBares);
  };
  await warm(tree.root);
}

// The cache-invalidation set for a project: every fileHash (`f`) under which any of
// its meanings were stored — per-node bares/windows + frontier ctx (keyed by ctxNS),
// whole-file bares (file content hash), and folder bares + folder ctx (folder hash).
// `tree` defaults to the active project's; pass a background project's tree (built via
// buildProjectTree) to clear it precisely on close. Used by cacheDropByFileHash.
export function projectCacheHashes(files, tree = getProjectTree()) {
  const set = new Set();
  for (const f of files) set.add(ctxNSForFile(f, tree)); // per-node bares + windows + frontier ctx (f = ctxNS)
  if (tree?.nodes) {
    for (const node of tree.nodes.values()) {
      if (node.hash) set.add(node.hash); // file bares (hash===contentHash) + folder bares + folder ctx
    }
  }
  return set;
}

// Fold a folder chain root → last, returning the last folder's ctx. Uses the
// eager folder bares; degrades to partial/null if not yet warm. Per-dir cached.
async function chainContext(chain) {
  let ctx = null;
  for (const node of chain) {
    const ctxKey = `c:dir:${node.hash}`;
    const cachedCtx = cacheGet(ctxKey);
    if (cachedCtx !== undefined) { ctx = cachedCtx; continue; }
    const bare = cacheGet(node.bareKey);
    if (bare === undefined) break; // not warmed yet → use what we have so far
    ctx = ctx === null ? bare : await foldMeaning(node, bare, ctx);
    cacheSet(ctxKey, ctx, { fileHash: node.hash, kind: 'dirctx' });
  }
  return ctx;
}

// Part 2 — folder context for a FILE: the chain root → the file's directory.
const folderContext = (relPath) => chainContext(folderChainTo(relPath));

// `ctxNS` namespaces a node's contextual meaning by its FULL upward context (the
// folder chain + file content), and `rootContext` is the folder ctx folded in at
// the file root. So in-file folds proceed as before, and the topmost in-file node
// continues up into the folders instead of stopping.
async function contextualizedMeaning(nodes, id, text, ctxNS, rootContext, windowChars) {
  const key = `c:${ctxNS}:${id}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  if (ctxPending.has(key)) return ctxPending.get(key);
  const p = (async () => {
    const parentId = semanticParentId(nodes, id);
    const [bare, outer] = await Promise.all([
      bareMeaning(nodes, id, text, ctxNS, windowChars),
      parentId ? contextualizedMeaning(nodes, parentId, text, ctxNS, rootContext, windowChars) : null,
    ]);
    let out;
    if (parentId) out = await foldMeaning(nodes[id], bare, outer);
    else if (rootContext) out = await foldMeaning(nodes[id], bare, rootContext); // file root → folder
    else out = bare;
    cacheSet(key, out, { fileHash: ctxNS, kind: 'ctx' });
    return out;
  })();
  ctxPending.set(key, p);
  try { return await p; } finally { ctxPending.delete(key); }
}

// ── Highlight-driven "frontier peers" context ───────────────────────────────
// Instead of folding a chunk's full ancestor path, interpret it against the OTHER
// regions of a minimal frontier — the coarsest tiling of the file whose members
// are the boxes the user has actually ASKED about (recorded below). The
// distribution itself is the context. Marks are per-file, in-memory for the
// session, keyed by ctxNS so a file edit (new ctxNS) self-invalidates them.
const fileMarks = new Map(); // ctxNS -> Set<nodeId>

// ctxNS = hash(folderChain · fileContent): a file's FULL upward context. Factored
// out so the marks store, ask(), suggestEdits() and the /frontier endpoint agree.
export function ctxNSForFile(file, tree) {
  const chain = folderChainTo(file.relPath, tree);
  const folderChainHash = chain.length
    ? crypto.createHash('sha1').update(chain.map((n) => n.bareKey).join('|')).digest('hex').slice(0, 16)
    : '';
  return fileHashOf(`${folderChainHash}:${fileHashOf(file.content)}`);
}

const recordMark = (ctxNS, nodeId) => {
  let s = fileMarks.get(ctxNS);
  if (!s) { s = new Set(); fileMarks.set(ctxNS, s); }
  s.add(nodeId);
};
const getMarks = (ctxNS) => fileMarks.get(ctxNS) || new Set();
const rootIdOf = (nodes) => Object.keys(nodes).find((id) => nodes[id].parent == null);
const frontierSig = (ids) => crypto.createHash('sha1').update(ids.join('|')).digest('hex').slice(0, 16);

// Like CTX_SYSTEM, but the "outer" is a flat set of sibling regions (the frontier),
// not a single nested parent scope.
const CTX_PEERS_SYSTEM =
  'You explain a unit of source code given (a) what it means in isolation and (b) '
  + 'short summaries of the OTHER regions of the same file it sits among. The unit\'s '
  + 'own isolated meaning is the subject — keep it the core and let it carry the '
  + 'weight. Use the other regions only as the surrounding distribution that places '
  + 'the unit within the file; never let a neighbor take over or shift the focus onto '
  + 'it. In 1-3 sentences, explain what the unit is, situated within that '
  + 'distribution. Respond with only the explanation.';

// Fold a unit's context-free meaning against the bares of its frontier peers.
async function foldPeers(node, selfBare, peerBares, rootContext) {
  const peers = peerBares.length
    ? peerBares.map((b, i) => `- region ${i + 1}: ${b}`).join('\n')
    : '(this unit spans the whole file — there are no other regions)';
  const msg = await withSlot(() => client().messages.create({
    model: MEANING_MODEL,
    max_tokens: 512,
    ...effortCfg(MEANING_MODEL, 'low'),
    system: [{ type: 'text', text: CTX_PEERS_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `The unit (${node.label}) in isolation — this is the subject, anchor on it:\n${selfBare}\n\n`
        + `Other regions of this file (the distribution that situates it):\n${peers}\n\n`
        + (rootContext ? `Broader project background (low weight, for orientation only):\n${rootContext}\n\n` : '')
        + 'Explain what this unit is, keeping its own isolated meaning as the core and '
        + 'using the other regions only to place it within the file.',
    }],
  }));
  return textOf(msg);
}

// Contextual meaning via frontier peers. `record` adds the asked node to the file's
// marks first (the ask path); suggestEdits passes record:false (an edit isn't a
// question). Cached by (ctxNS, askedId, frontier signature): a new mark changes the
// signature and recomputes ONE foldPeers call — the peer bares stay cached
// (content-addressed), so a fresh mark is cheap on a warm file.
async function frontierPeersMeaning(nodes, idx, askedId, ctxNS, text, rootContext, { record = false } = {}, windowChars) {
  if (record) recordMark(ctxNS, askedId);
  const frontierIds = minimalFrontier(nodes, idx, rootIdOf(nodes), getMarks(ctxNS));
  const key = `cp:${ctxNS}:${askedId}:${frontierSig(frontierIds)}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  if (ctxPending.has(key)) return ctxPending.get(key);
  const p = (async () => {
    const peerIds = frontierIds.filter((id) => id !== askedId);
    const [selfBare, peerBares] = await Promise.all([
      bareMeaning(nodes, askedId, text, ctxNS, windowChars),
      mapLimit(peerIds, CONCURRENCY, (id) => bareMeaning(nodes, id, text, ctxNS, windowChars)),
    ]);
    const out = await foldPeers(nodes[askedId], selfBare, peerBares, rootContext);
    cacheSet(key, out, { fileHash: ctxNS, kind: 'ctxpeers' });
    return out;
  })();
  ctxPending.set(key, p);
  try { return await p; } finally { ctxPending.delete(key); }
}

// Debug / demo: the current marks + derived minimal frontier for a file (no LLM).
export async function fileFrontier(file) {
  const { nodes } = await fileNodes(file);
  const idx = childrenIndex(nodes);
  const ctxNS = ctxNSForFile(file);
  const frontierIds = minimalFrontier(nodes, idx, rootIdOf(nodes), getMarks(ctxNS));
  return {
    marks: [...getMarks(ctxNS)].filter((id) => nodes[id]).map((id) => ({ nodeId: id, label: nodes[id].label })),
    frontier: frontierIds.map((id) => ({ nodeId: id, start: nodes[id].start, end: nodes[id].end, label: nodes[id].label })),
  };
}

// Tightest box around a raw [start,end) range over the flat node map — the descent
// mirror of frontier.js's tightestBox, but on fileNodes' parent-linked map.
function tightestNodeId(nodes, idx, rootId, rawStart, rawEnd) {
  const root = nodes[rootId];
  let s = Math.min(rawStart, rawEnd);
  let e = Math.max(rawStart, rawEnd);
  if (e <= s) e = s + 1; // collapsed caret → 1-char range so containment holds
  s = Math.max(root.start, Math.min(s, root.end - 1));
  e = Math.max(s + 1, Math.min(e, root.end));
  let cur = rootId;
  for (;;) {
    const next = (idx.get(cur) || []).find((c) => nodes[c].start <= s && nodes[c].end >= e);
    if (!next) break;
    cur = next;
  }
  return cur;
}

// The semantic box(es) a highlight is "about". Normally the tightest semantic box that
// CONTAINS the range. But when the range straddles a unit boundary, the only box that
// contains it is the file root — so instead mark the topmost semantic boxes it OVERLAPS,
// so a cross-unit highlight isolates those units rather than collapsing to the whole file.
function highlightMarks(nodes, idx, rootId, rawStart, rawEnd) {
  const tight = tightestNodeId(nodes, idx, rootId, rawStart, rawEnd);
  let sem = tight;
  while (sem && nodes[sem] && !nodes[sem].semantic) sem = nodes[sem].parent; // up to nearest semantic
  if (sem && sem !== rootId) return [sem];
  let s = Math.min(rawStart, rawEnd);
  let e = Math.max(rawStart, rawEnd);
  if (e <= s) e = s + 1;
  const out = [];
  const visit = (id) => {
    const n = nodes[id];
    if (n.end <= s || n.start >= e) return; // disjoint from the highlight
    if (n.semantic && id !== rootId) { out.push(id); return; } // first semantic unit on this branch
    for (const c of (idx.get(id) || [])) visit(c);
  };
  visit(tight);
  return out.length ? out : (tight ? [tight] : []);
}

// The current ctx distribution as /chunks-shaped output: the file tiled into the minimal
// frontier of (the marks asked about so far) ∪ (the highlight's tightest box, if any),
// with the band the highlight lands in as `targetNodeId`. This is the SAME partition ctx
// is built from — surfaced so the viewer can band-highlight the whole distribution and
// count it, instead of showing the lone tightest box. Refines as more questions are asked.
export async function frontierChunks(file, around = null) {
  const { kind, nodes } = await fileNodes(file);
  const idx = childrenIndex(nodes);
  const rootId = rootIdOf(nodes);
  const ctxNS = ctxNSForFile(file);
  const marks = new Set(getMarks(ctxNS));
  if (around) for (const m of highlightMarks(nodes, idx, rootId, around.start, around.end)) marks.add(m);
  const frontierIds = minimalFrontier(nodes, idx, rootId, marks);
  // Coverage fills the glue between boxes (same as granularity-mode chunks) so the bands
  // tile the file with no un-highlighted slivers — the box's own [start,end] stays its id.
  const boxes = frontierIds.map((id) => ({ start: nodes[id].start, end: nodes[id].end, label: nodes[id].label, depth: nodes[id].depth ?? 0, id }));
  const chunks = assignCoverage(file.content, { start: nodes[rootId].start, end: nodes[rootId].end }, boxes);
  // The frontier tiles the file, so the highlight's start always lands in exactly one
  // member — that's the chunk the viewer auto-selects. No highlight → no target.
  let targetNodeId = null;
  if (around) {
    const probe = Math.max(nodes[rootId].start, Math.min(around.start, nodes[rootId].end - 1));
    targetNodeId = frontierIds.find((id) => nodes[id].start <= probe && probe < nodes[id].end) ?? null;
  }
  // Lean node closure the client needs to reconstruct paths/root: each frontier member
  // plus its ancestor chain (not the whole max-granularity map).
  const closure = {};
  for (const id of frontierIds) {
    let cur = id;
    while (cur && nodes[cur] && !(cur in closure)) { closure[cur] = nodes[cur]; cur = nodes[cur].parent; }
  }
  let maxBoxes = 0;
  for (const id of Object.keys(nodes)) if (!(idx.get(id) || []).length) maxBoxes += 1; // leaves = max granularity
  return { kind, maxBoxes: Math.max(1, maxBoxes), chunks, nodes: closure, targetNodeId, chunkCount: chunks.length };
}

// Answer a question about a selected chunk.
//   depth      true (0) granularity carried by the client for this line of Qs.
//   intent     'deepen' (explicit "more detail" button → ratchet down one level)
//              or 'infer' (typed message → classify deepen vs. new).
//   transcript recent [{role,text}] turns, for classification + answer context.
// Returns { answer, meaning, path, depth, atBottom, maxDepth }.
export async function ask({ file, nodeId, question, depth = 0, intent = 'infer', transcript = [], contextFile = null, bareWindow = DEFAULT_BARE_WINDOW, focus = '', highlight = '', traceContext = null }) {
  const { nodes } = await fileNodes(file);
  if (!nodes[nodeId]) {
    const e = new Error('Unknown nodeId for this file (it may be stale — re-chunk and retry).');
    e.status = 404;
    throw e;
  }
  const text = file.content;
  const idx = childrenIndex(nodes);
  const node = nodes[nodeId];
  const maxDepth = maxSemanticDepth(nodes, idx, nodeId);

  // Folder context: the file's directory chain, folded to the project root off the
  // eager folder bares, passed as low-weight background. ctxNS keys this file's
  // marks + peer-ctx by its FULL upward context (folders + file content).
  const ctxNS = ctxNSForFile(file);
  const rootContext = await folderContext(file.relPath); // null if no tree / not warm

  // Effective depth: explicit button ratchets down; a typed message deepens only
  // if it reads as dissatisfaction, else snaps back to true (0).
  let effDepth;
  if (intent === 'deepen') {
    effDepth = Math.min(depth + 1, maxDepth);
  } else {
    const cls = transcript.length ? await classifyIntent(transcript, question) : 'new';
    effDepth = cls === 'deepen' ? Math.min(depth + 1, maxDepth) : 0;
  }

  const meaning = await frontierPeersMeaning(nodes, idx, nodeId, ctxNS, text, rootContext, { record: true }, bareWindow);
  const path = semanticPath(nodes, nodeId);
  const snippet = clip(text.slice(node.start, node.end));
  const drill = effDepth >= 1
    ? await drillDetail(nodes, idx, nodeId, effDepth, text, ctxNS, rootContext, bareWindow)
    : { detail: '', truncated: false };

  // A short literal selection (the exact chars highlighted, not the resolved box) →
  // quote it so the answer can zero in on those words. Ignored when long (it's a region).
  const hl = highlight && highlight.trim() && highlight.length <= HIGHLIGHT_QUOTE_CAP ? highlight : '';

  const recap = transcript.slice(-4).map((t) => `${t.role}: ${t.text}`).join('\n');
  const msg = await withSlot(() => client().messages.create({
    model: ANSWER_MODEL,
    max_tokens: 4096,
    ...(supportsEffort(ANSWER_MODEL) ? { thinking: { type: 'adaptive' } } : {}),
    ...effortCfg(ANSWER_MODEL, 'medium'),
    system: [{ type: 'text', text: ANSWER_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: (recap ? `Earlier in this conversation:\n${recap}\n\n` : '')
        + `File: ${file.relPath}\n`
        + (path.length ? `Location: ${path.join(' › ')}\n` : '')
        + `\nWhat this unit means in context:\n${meaning}\n`
        + (drill.detail ? `\nSub-part breakdown (detail level ${effDepth}${drill.truncated ? ', partial' : ''}):\n${drill.detail}\n` : '')
        + `\nThe code:\n\`\`\`\n${snippet}\n\`\`\`\n\n`
        + (contextFile
          ? `The reader attached another project file as extra context — ${contextFile.relPath}:\n\`\`\`\n${clip(contextFile.content)}\n\`\`\`\n\n`
          : '')
        + (focus
          ? `The reader highlighted this part of your previous answer and wants more detail on exactly that — center your elaboration there, expanding what it means and why:\n"${clip(focus)}"\n\n`
          : '')
        + (hl
          ? `The reader highlighted these exact characters in the code and is asking specifically about them — be precise about this snippet in particular, not just the unit around it:\n"${hl}"\n\n`
          : '')
        + (traceContext
          ? `The application's Trace tab currently shows this UI context:\n${clip(JSON.stringify(traceContext, null, 2))}\nWhen useful, you may explicitly direct the reader to the Trace tab and describe what they will find there. Do not claim that Trace shows anything outside this snapshot.\n\n`
          : '')
        + `Question: ${question}`,
    }],
  }));

  return { answer: textOf(msg), meaning, path, depth: effDepth, atBottom: effDepth >= maxDepth, maxDepth };
}

const EDIT_SYSTEM =
  'You propose a concrete revision of a single unit of source code. You are given what '
  + 'the unit means in context, the code itself, and a conversation in which the reader '
  + 'has been discussing it. Infer the change the reader wants from that conversation '
  + '(and any explicit instruction), then rewrite the code to make exactly that change — '
  + 'nothing more. Preserve the existing indentation, style, and conventions, and keep '
  + 'the edit minimal and focused. Return ONLY the full revised code for this unit: no '
  + 'markdown fences, no commentary, no explanation, no surrounding prose. If the '
  + 'conversation does not call for a code change, return the code unchanged.';

// Strip a single leading ```lang fence and trailing ``` if the model wrapped its
// output in a code block despite being asked not to.
function stripFences(s) {
  const t = s.trim();
  if (!t.startsWith('```')) return t;
  return t.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
}

// Propose an edited version of a chunk's code, driven by the Q&A conversation.
// Returns { code, original, path } — `code` is the full revised unit, ready to
// drop straight into the editor.
export async function suggestEdits({ file, nodeId, instruction = '', transcript = [], baseCode = '', contextFile = null, bareWindow = DEFAULT_BARE_WINDOW }) {
  const { nodes } = await fileNodes(file);
  if (!nodes[nodeId]) {
    const e = new Error('Unknown nodeId for this file (it may be stale — re-chunk and retry).');
    e.status = 404;
    throw e;
  }
  const text = file.content;
  const node = nodes[nodeId];

  // Same contextual setup as ask(): situate the unit against its frontier peers.
  // Read-only on marks — suggesting an edit isn't a question, so it doesn't add one.
  const idx = childrenIndex(nodes);
  const ctxNS = ctxNSForFile(file);
  const rootContext = await folderContext(file.relPath);
  const meaning = await frontierPeersMeaning(nodes, idx, nodeId, ctxNS, text, rootContext, { record: false }, bareWindow);
  const path = semanticPath(nodes, nodeId);
  // Revise the current draft if one was supplied (iterative edits build on what's
  // already in the editor), otherwise the original source of this unit.
  const code = (typeof baseCode === 'string' && baseCode.length) ? baseCode : text.slice(node.start, node.end);
  const snippet = clip(code);

  const recap = transcript.slice(-6).map((t) => `${t.role}: ${t.text}`).join('\n');
  const msg = await withSlot(() => client().messages.create({
    model: ANSWER_MODEL,
    max_tokens: 8192,
    ...(supportsEffort(ANSWER_MODEL) ? { thinking: { type: 'adaptive' } } : {}),
    ...effortCfg(ANSWER_MODEL, 'medium'),
    system: [{ type: 'text', text: EDIT_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: (recap ? `Conversation so far:\n${recap}\n\n` : '')
        + (instruction ? `Explicit instruction: ${instruction}\n\n` : '')
        + `File: ${file.relPath}\n`
        + (path.length ? `Location: ${path.join(' › ')}\n` : '')
        + `\nWhat this unit means in context:\n${meaning}\n`
        + `\nThe code to revise:\n\`\`\`\n${snippet}\n\`\`\`\n\n`
        + (contextFile
          ? `The reader attached another project file as a reference to compare against — ${contextFile.relPath}. Do NOT return or edit this file; it is context only:\n\`\`\`\n${clip(contextFile.content)}\n\`\`\`\n\n`
          : '')
        + 'Return the full revised code for this unit, and nothing else.',
    }],
  }));

  return { code: stripFences(textOf(msg)), original: code, path };
}

const FOLDER_ANSWER_SYSTEM =
  'You answer questions about a directory in a codebase. Use the supplied contextual '
  + 'summary of the folder and the one-line summaries of its direct contents. Treat '
  + 'these as your OWN understanding — they are internal scaffolding the reader never '
  + 'sees, so never refer to them. Do not mention "the summary", "the provided '
  + 'context", "the contents listing", or similar; just speak about the folder and its '
  + 'code directly, as if you simply know it. If the answer is not determinable from '
  + 'what is shown, say so plainly.\n\n'
  + VOICE;

// Answer a question about a FOLDER (the current directory in the file browser).
// dirPath '' = project root. Returns { answer, summary, path }.
export async function askFolder({ dirPath = '', question, transcript = [], contextFile = null }) {
  const tree = getProjectTree();
  if (!tree) { const e = new Error('No project is loaded yet.'); e.status = 503; throw e; }
  const path = dirPath.replace(/\\/g, '/').replace(/\/$/, '');
  const node = tree.nodes.get(path);
  if (!node || node.kind !== 'dir') { const e = new Error(`Unknown folder: ${path || '(root)'}`); e.status = 404; throw e; }

  const summary = await chainContext(folderChainToDir(path)); // ctx of this folder
  const contents = node.children
    .map((c) => `- ${c.name}${c.kind === 'dir' ? '/' : ''}: ${cacheGet(c.bareKey) ?? '(summary pending)'}`)
    .join('\n');
  const recap = transcript.slice(-4).map((t) => `${t.role}: ${t.text}`).join('\n');

  const msg = await withSlot(() => client().messages.create({
    model: ANSWER_MODEL,
    max_tokens: 4096,
    ...(supportsEffort(ANSWER_MODEL) ? { thinking: { type: 'adaptive' } } : {}),
    ...effortCfg(ANSWER_MODEL, 'medium'),
    system: [{ type: 'text', text: FOLDER_ANSWER_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: (recap ? `Earlier in this conversation:\n${recap}\n\n` : '')
        + `Folder: ${path || '(project root)'}\n`
        + `\nWhat this folder is, in context:\n${summary || '(summary still warming up)'}\n`
        + `\nDirect contents:\n${contents}\n\n`
        + (contextFile
          ? `The reader attached a project file as extra context — ${contextFile.relPath}:\n\`\`\`\n${clip(contextFile.content)}\n\`\`\`\n\n`
          : '')
        + `Question: ${question}`,
    }],
  }));

  return { answer: textOf(msg), summary, path };
}
