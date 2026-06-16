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
  childrenIndex, semanticChildren, maxSemanticDepth,
} from '../ingest/tree.js';
import { getProjectTree, folderChainTo, folderChainToDir } from '../ingest/projectTree.js';
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

const MAX_SNIPPET = 48000; // char cap per unit (~12k tokens), to bound token cost on huge nodes

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

const ANSWER_SYSTEM =
  'You are a helpful, encouraging tutor helping someone understand a specific unit '
  + 'of source code. Use the supplied contextual meaning, any sub-part breakdown, and '
  + 'the code itself. Treat all of that as your OWN understanding — it is internal '
  + 'scaffolding the reader never sees, so never refer to it. Do not mention "the '
  + 'summary", "the contextual meaning", "the breakdown", "the provided context", or '
  + 'similar; just speak about the code directly, as if you simply know it. '
  + 'Explain things clearly in plain language, build intuition for '
  + 'WHY the code works the way it does (not just what it does), and meet the reader '
  + 'where they are — warm and approachable, never condescending. If the answer is not '
  + 'determinable from what is shown, say so honestly. '
  + 'Still get straight to the heart of what is actually being asked and answer it as '
  + 'directly as possible — lead with the answer, cut preamble, hedging, and restating '
  + 'the question. Aim for the fewest words that fully answer it, ideally within about '
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

async function drillDetail(nodes, idx, nodeId, depth, text, ctxNS, rootContext) {
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
    return `- ${node.label}: ${await contextualizedMeaning(nodes, cid, text, ctxNS, rootContext)}`;
  });
  return { detail: parts.join('\n'), units: pick.length, truncated, reached };
}

// In-file node bare — context-free meaning of the node's own text.
function bareMeaning(nodes, id, text, ctxNS) {
  const node = nodes[id];
  return computeBare(`b:${node.hash}`, node.label,
    `Unit (${node.label}):\n\n\`\`\`\n${clip(text.slice(node.start, node.end))}\n\`\`\``,
    { system: BARE_SYSTEM, fileHash: ctxNS, kind: 'bare' });
}

// File-leaf bare for the folder pass — same key as the in-file root node, so a
// file's folder-level summary and its whole-file summary are one cached value.
function bareFile(node, content) {
  return computeBare(node.bareKey, node.name,
    `File (${node.name}):\n\n\`\`\`\n${clip(content)}\n\`\`\``,
    { system: BARE_SYSTEM, fileHash: node.contentHash, kind: 'bare' });
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
export async function warmProjectBares(files) {
  const tree = getProjectTree();
  if (!tree || !process.env.ANTHROPIC_API_KEY) return;
  const contentByPath = new Map(files.map((f) => [f.relPath.replace(/\\/g, '/'), f.content]));
  const warm = async (node) => {
    if (node.kind === 'file') return bareFile(node, contentByPath.get(node.path) ?? '');
    const childBares = await Promise.all(node.children.map(warm));
    return bareFolder(node, childBares);
  };
  await warm(tree.root);
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
    cacheSet(ctxKey, ctx, { kind: 'dirctx' });
  }
  return ctx;
}

// Part 2 — folder context for a FILE: the chain root → the file's directory.
const folderContext = (relPath) => chainContext(folderChainTo(relPath));

// `ctxNS` namespaces a node's contextual meaning by its FULL upward context (the
// folder chain + file content), and `rootContext` is the folder ctx folded in at
// the file root. So in-file folds proceed as before, and the topmost in-file node
// continues up into the folders instead of stopping.
async function contextualizedMeaning(nodes, id, text, ctxNS, rootContext) {
  const key = `c:${ctxNS}:${id}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  if (ctxPending.has(key)) return ctxPending.get(key);
  const p = (async () => {
    const parentId = semanticParentId(nodes, id);
    const [bare, outer] = await Promise.all([
      bareMeaning(nodes, id, text, ctxNS),
      parentId ? contextualizedMeaning(nodes, parentId, text, ctxNS, rootContext) : null,
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

// Answer a question about a selected chunk.
//   depth      true (0) granularity carried by the client for this line of Qs.
//   intent     'deepen' (explicit "more detail" button → ratchet down one level)
//              or 'infer' (typed message → classify deepen vs. new).
//   transcript recent [{role,text}] turns, for classification + answer context.
// Returns { answer, meaning, path, depth, atBottom, maxDepth }.
export async function ask({ file, nodeId, question, depth = 0, intent = 'infer', transcript = [], contextFile = null }) {
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

  // Folder context (Part 2): the file's directory chain, folded to the project
  // root, off the eager folder bares. ctxNS keys this node's ctx by its FULL
  // upward context (folders + file content), so folder context is baked into it.
  const chain = folderChainTo(file.relPath);
  const folderChainHash = chain.length
    ? crypto.createHash('sha1').update(chain.map((n) => n.bareKey).join('|')).digest('hex').slice(0, 16)
    : '';
  const ctxNS = fileHashOf(`${folderChainHash}:${fileHashOf(text)}`);
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

  const meaning = await contextualizedMeaning(nodes, nodeId, text, ctxNS, rootContext);
  const path = semanticPath(nodes, nodeId);
  const snippet = clip(text.slice(node.start, node.end));
  const drill = effDepth >= 1
    ? await drillDetail(nodes, idx, nodeId, effDepth, text, ctxNS, rootContext)
    : { detail: '', truncated: false };

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
export async function suggestEdits({ file, nodeId, instruction = '', transcript = [], baseCode = '', contextFile = null }) {
  const { nodes } = await fileNodes(file);
  if (!nodes[nodeId]) {
    const e = new Error('Unknown nodeId for this file (it may be stale — re-chunk and retry).');
    e.status = 404;
    throw e;
  }
  const text = file.content;
  const node = nodes[nodeId];

  // Same contextual setup as ask(): fold the folder chain + file context so the
  // model edits with full awareness of the surrounding scope.
  const chain = folderChainTo(file.relPath);
  const folderChainHash = chain.length
    ? crypto.createHash('sha1').update(chain.map((n) => n.bareKey).join('|')).digest('hex').slice(0, 16)
    : '';
  const ctxNS = fileHashOf(`${folderChainHash}:${fileHashOf(text)}`);
  const rootContext = await folderContext(file.relPath);
  const meaning = await contextualizedMeaning(nodes, nodeId, text, ctxNS, rootContext);
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
  + 'code directly, as if you simply know it. Be '
  + 'concrete and concise; if the answer is not determinable from what is shown, say so.';

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
