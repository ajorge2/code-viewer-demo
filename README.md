# CodeArchitect — Engineering Reference

> Point it at a codebase; it parses every file into a structural box tree, lets you
> "zoom" that tree with a slider or a highlight, and answers questions about any
> piece by folding a recursively-cached, content-addressed "meaning" out of the
> code around it. No vector database, no daemon.

---

**This document is the implementation-level reference, not a user guide.** It is
deliberately verbose and assumes you are reading it next to the source. For the
short, conceptual pitch see the *Concept recap* at the very bottom, or the git
history of this file. Everything here describes the code as it actually stands in
the working tree (client + server), including the parts that supersede earlier
write-ups (notably: the question-answering path now uses a **frontier-peers**
context model, not only the vertical ancestor fold described in
`docs/highlight-to-chunk.md`).

## Table of contents

1. [Stack & dependencies](#1-stack--dependencies)
2. [Repository layout](#2-repository-layout)
3. [Runtime topology](#3-runtime-topology-dev-vs-prod)
4. [The core data model: box trees & identity](#4-the-core-data-model-box-trees--identity)
5. [Ingest: file discovery, language routing, caps](#5-ingest-file-discovery-language-routing-caps)
6. [The parse-tree layer (`parseTree.js`)](#6-the-parse-tree-layer-parsetreejs)
7. [The three structure front-ends](#7-the-three-structure-front-ends)
8. [The chunking engine (`frontier.js`)](#8-the-chunking-engine-frontierjs)
9. [Node resolution & frontier algebra (`tree.js`)](#9-node-resolution--frontier-algebra-treejs)
10. [The folder/project tree (`projectTree.js`)](#10-the-folderproject-tree-projecttreejs)
11. [The meaning / RAG engine (`meaning.js`)](#11-the-meaning--rag-engine-meaningjs)
12. [The cache (`cache.js`) and invalidation](#12-the-cache-cachejs-and-invalidation)
13. [The project registry / store (`store.js`)](#13-the-project-registry--store-storejs)
14. [Search-based references (`references.js`)](#14-search-based-references-referencesjs)
15. [HTTP API reference (`index.js`)](#15-http-api-reference-indexjs)
16. [The client](#16-the-client)
17. [Configuration: env, models, caps](#17-configuration-env-models-caps)
18. [Performance characteristics](#18-performance-characteristics)
19. [Known limitations & honest caveats](#19-known-limitations--honest-caveats)
20. [Roadmap](#20-roadmap)
21. [Concept recap](#21-concept-recap)

---

## 1. Stack & dependencies

| Layer | Choice | Notes |
| --- | --- | --- |
| Server runtime | Node ≥ 20 (developed on v23), ES modules (`"type": "module"`) | single process, no worker threads |
| HTTP | `express@4` + `cors` | `express.json({ limit: '50mb' })` for folder uploads |
| Parsing | `web-tree-sitter@0.22` (WASM) + `tree-sitter-wasms@0.1` | no native addon, no node-gyp, no grammar-ABI conflicts |
| LLM | `@anthropic-ai/sdk@0.100` | two model tiers (see §11.8) |
| Config | `dotenv` | `.env` at repo root |
| Client | React 19 + Vite 6 | `@vitejs/plugin-react`; no router, no state library, no CSS framework |
| Dev orchestration | `concurrently` | `npm run dev` runs server (`node --watch`) + Vite together |

There is **no automated test suite** in the repo today. Several pure functions are
written to be test-friendly and a few are exported for that purpose
(`boxFromParse` in `codeTree.js`), but CI/tests are not wired up.

`Procfile` (`web: npm start`) + the `build`/`start` scripts make the repo
deployable to a Heroku-style PaaS or a container: `build` installs and Vite-builds
the client into `client/dist`, and `start` runs the server, which serves that
static bundle from the same origin (see §3).

---

## 2. Repository layout

```
.
├── package.json            # root: server deps + dev/build/start scripts
├── Procfile                # web: npm start
├── .env / .env.example     # ANTHROPIC_API_KEY, PROJECT_DIR, PORT, model + window overrides
├── .tree-cache/            # gitignored: one JSON per parsed file (content-addressed)
├── .meaning-cache/         # gitignored: append-only meanings.jsonl
├── docs/
│   └── highlight-to-chunk.md   # deep-dive on highlight→tightest-box→path (still accurate
│                                #   for the box mechanics; superseded for the *meaning* fold)
├── server/
│   ├── index.js            # Express app: every route, warm-up, static-serve, clamps
│   ├── store.js            # in-memory multi-project registry (LRU), sample file, bare-window
│   ├── ingest/
│   │   ├── code.js         # walkProject, language map, source-file filter, ingest caps, line chunker
│   │   ├── parseTree.js    # web-tree-sitter → plain JSON tree; mem + disk cache
│   │   ├── codeTree.js     # parse tree  → box tree (drops anonymous nodes) → frontier
│   │   ├── json.js         # hand-rolled JSONC parser → box tree → frontier
│   │   ├── genericTree.js  # grammar-less indent/bracket/separator chunker → frontier
│   │   ├── frontier.js     # THE shared engine: balance, identity, coverage, granularity cut, tightest box
│   │   ├── tree.js         # fileNodes (flat id→node map), semantic walks, minimalFrontier
│   │   ├── projectTree.js  # folder tree above the files; content-addressed folder hashing
│   │   └── references.js   # search-based find-references (tree-sitter identifiers + text fallback)
│   └── llm/
│       ├── meaning.js      # the RAG engine: bare/ctx/peers, marks, drill, folder chat, prompts, model routing
│       └── cache.js        # append-only JSONL memo; two-tier drop-by-fileHash
└── client/
    ├── index.html          # fonts (Inter / JetBrains Mono / Crete Round / Roboto Slab), #root
    ├── vite.config.js      # port 5174, proxy /api → :8799
    └── src/
        ├── main.jsx        # createRoot
        ├── App.jsx         # top-level state, views (main/help), modals, localStorage, welcome animation
        ├── index.css       # ~1.65k lines: the entire design system (no framework)
        ├── components/
        │   ├── CodeViewer.jsx     # ~1.2k lines: viewer, chunking modes, chat, edits/diff, refs peek
        │   ├── Library.jsx        # file tree + per-folder chat + inline ref linking
        │   ├── ProjectSwitcher.jsx# manila-tab project bar, drag-reorder, 3 upload paths, window slider
        │   └── ContextAttach.jsx  # 📎 attach-one-file-as-context picker
        └── lib/
            ├── api.js        # thin fetch wrappers for every endpoint
            ├── richText.jsx  # minimal Markdown renderer + clickable mentions/symbols
            └── uploadFolder.js# read a browser-picked folder (3 APIs) into {relPath, content}[]
```

---

## 3. Runtime topology (dev vs prod)

**Development** (`npm run dev`): two processes.

- Vite dev server on **:5174** serves the React app and HMRs it.
- Express API on **:8799** (`PORT`).
- `client/vite.config.js` proxies `/api/*` from 5174 → 8799, so the browser only
  ever talks to one origin and there's no CORS in the loop during dev.

**Production** (`npm run build && npm start`): one process.

- `build` runs `vite build` → `client/dist` (content-hashed `assets/*`, an unhashed
  `index.html`).
- `start` runs `server/index.js`. At boot it checks `fs.existsSync(client/dist)`;
  if present it mounts `express.static` and an SPA fallback:
  - `assets/*` (content-hashed) → `Cache-Control: public, max-age=31536000, immutable`.
  - everything else incl. `index.html` → `Cache-Control: no-cache` (so a redeploy
    can't pin a stale `index.html` pointing at asset hashes that no longer exist).
  - A non-API path **with a file extension** that misses static → `404` (fail loud)
    rather than returning `index.html` (which would make the browser try to execute
    HTML as a script). Extensionless paths → `index.html` (client routing).

The server boots by `loadProject(PROJECT_DIR)` (default = this repo, so it
self-demoes), then kicks off the background warm pass (§11.3). The console prints
the resolved project dir, file count, total bytes, and any cap hits.

---

## 4. The core data model: box trees & identity

Everything downstream — chunking, retrieval, caching — is defined over one
structure: the **box tree**. A box is

```js
{ start, end, depth, label, kind: 'container' | 'leaf', children, rank?, synthetic?,
  id, hash, semantic, /* non-enumerable: */ parent }
```

`start`/`end` are **character offsets** into the file text (half-open `[start, end)`).
The root box is the whole file; its children are the file's top-level units, and so
on down to tokens/operands. The three front-ends (§7) each emit a *raw* box tree;
`buildTree` (§8) then decorates it identically regardless of source language.

### 4.1 Two identities per box

`assignIdentity(node, text, parentId)` stamps every box with **two** hashes — this
separation is the keystone the whole cache leans on:

- **`id` — path identity.** `shortHash("${parentId}:${start}:${end}")`, 12 hex
  chars. Because `parentId` is itself a hash of *its* parent's id, the id is a
  rolling hash of the **entire root→node chain**. Two boxes with the same span but
  different ancestry get different ids; a single-child chain that shares a span with
  its parent is disambiguated by the `parentId` prefix. The `id` is the client
  handle and the key for "meaning **with** outside context."
- **`hash` — content identity.** `shortHash(text.slice(start, end))`, 16 hex chars.
  Identical spans anywhere in the project collide **on purpose**, so "meaning
  **without** outside context" (the bare summary) is computed once and shared across
  every copy of that exact code.

Both identities are a pure function of `(file text, parse shape)`. **The sliders
never reshape the tree** — they only choose a different *cut* through the same fixed
tree — so ids/hashes are identical across every chunking of a file. That is what
lets the meaning cache key on structure instead of on the (settings-dependent)
emitted chunks.

`parent` is defined non-enumerable so the tree never self-serializes (and so the
disk parse-cache and `nodes` closures stay finite/acyclic).

### 4.2 Semantic vs. synthetic

`balance` (§8.1) inserts **synthetic grouping boxes** to cap branching. These are
marked `semantic: false` (everything else is `true`). Synthetic boxes are pure
scaffolding: the meaning recursion and the breadcrumb walks **skip through them**
(`semanticParentId`, `semanticChildren`, `semanticPath`), so an LLM is never asked
to summarize "statements 1–20 of 40" — only real units. They still carry ids and
participate in coverage, so they cost a slightly larger `nodes` map and nothing else.

### 4.3 Coverage / delimiter attachment

A *frontier* is a set of boxes that don't tile the file by themselves — there's glue
(whitespace, operators, punctuation, closing brackets) in the gaps. `assignCoverage`
turns a frontier into contiguous, non-overlapping **chunks** that tile the file
end-to-end by deciding, for each gap `[a, b)`, a split point:

- characters in `LEFT_ATTACH = { } ] ) , ; : }` "ride left" (attach to the preceding
  box); everything else (openers, identifiers, indentation) "rides right."
- `splitGap` scans the gap and puts the boundary just past the last left-attaching
  char.

So `}` and `,` stay with the unit they close, and the next unit's indentation/opener
starts the next chunk. Result: **every character has exactly one home**, chunks are
flat and contiguous, and boundaries land on structural seams. This superset rule
covers JSON (`} ] : ,`) and code (`) ;` too) with one table.

---

## 5. Ingest: file discovery, language routing, caps

`server/ingest/code.js` owns disk-side ingest and the language map.

- **`walkProject(dir)`** recursively collects relative paths of source files,
  pruning `SKIP_DIRS` (`node_modules`, `.git`, `dist`, `build`, `.next`, `out`,
  `coverage`, `.venv`/`venv`, `__pycache__`, caches, `.idea`/`.vscode`, `target`,
  `vendor`, `.turbo`, …). Dotfolders are skipped only if in `SKIP_DIRS` (so
  `.github` is allowed). Entries are sorted for deterministic ordering.
- **`languageFor(filename)`** maps extension → language label via `LANGS` (js/jsx/
  mjs/cjs→javascript, ts/tsx→typescript, py→python, plus ruby, go, rust, java, c/h,
  cpp/cc/hpp, csharp, php, swift, kotlin, scala, css/scss, html, vue, svelte, json,
  yml/yaml, toml, markdown, bash/sh, sql, r). Unknown ext → `null` (non-source).
- **`isSourceFile`** additionally rejects `SKIP_FILES` (lockfiles:
  `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `composer.lock`, `poetry.lock`,
  `Cargo.lock`, `Gemfile.lock`) — they match a source extension but drown out real
  code.
- **Caps (no silent truncation):** `MAX_FILE_BYTES = 1_000_000` (skip >1 MB files),
  `MAX_FILES = 4000`, `MAX_TOTAL_BYTES = 150_000_000` (~150 MB summed text). Each cap
  hit is *recorded* (`skipped`, `truncatedByCount`, `truncatedByBytes`) and surfaced
  through `/api/files` → the UI warns rather than under-reporting.

`chunkByLines` also lives here — the original line-based chunker — but it's legacy:
the live endpoints route every file through one of the three structural front-ends
(§7). It survives as a fallback shape and for the `start/end` char-span convention.

### 5.1 Effective language support

The endpoint routes by language in a fixed order (see §15, `/chunks`):

1. **JSON** → the hand-rolled JSONC parser (`json.js`), *not* tree-sitter, even
   though a json grammar exists in the pack.
2. **Tree-sitter-parseable** (`isParseable`) → CST chunking (`codeTree.js`). The
   `GRAMMAR` map in `parseTree.js` lists 22 labels, but two of them (`r`, `sql`)
   resolve only to a **local** `server/grammars/*.wasm` that is **not checked into
   the repo**, and they aren't in the `tree-sitter-wasms` pack either — so today
   they fall through to the generic chunker. `yaml` is deliberately **excluded** from
   `GRAMMAR` (its packed grammar is broken for this runtime). Net: ~20 languages get
   true CST chunking (js, ts, python, go, rust, java, c, cpp, csharp, ruby, php, css,
   html, bash, scala, swift, kotlin, lua, toml, vue).
3. **Everything else** with a recognized source extension (yaml, scss, svelte,
   markdown, sql, r, …) → the **generic** indentation/bracket/separator chunker
   (`genericTree.js`).

So *every* ingested file gets a real component hierarchy; there is no flat-lines
mode in the live path.

---

## 6. The parse-tree layer (`parseTree.js`)

Turns `(text, language)` into a plain, serializable parse tree
`{ type, start, end, children? }` with **character** offsets, via web-tree-sitter.

- **WASM, lazy, cached.** `Parser.init()` once; `Language.load` per language, cached
  in `langCache`. `loadLanguage` prefers `server/grammars/tree-sitter-<base>.wasm`
  (local override dir), else the `tree-sitter-wasms/out` pack. Missing wasm → `null`
  → caller falls back to generic.
- **Named nodes only.** `toNode` keeps `n.isNamed` children and drops anonymous nodes
  (operators, punctuation, keywords like `&&`, `(`, `;`, `const`). Those become the
  *gaps* coverage attaches to a neighbor — which is exactly why the deepest
  granularity bottoms out at operands/identifiers (~word level) without operators
  ever being their own boxes. Dropping them also shrinks the persisted tree.
- **Offset caveat.** web-tree-sitter reports UTF-16 code-unit indices; JS string
  indexing matches for the BMP, and the same JS string is sliced with the same
  indices everywhere, so astral chars (emoji) stay consistent.

### 6.1 Two-layer parse cache

Parsing is the expensive structural step, and it's invariant across the sliders, so
it's parsed **at most once ever per content version**:

- **In-memory** `memCache: Map<sha1(language\0content), tree>`.
- **On disk** `.tree-cache/<sha1>.json` (in *this* repo, never the inspected project;
  gitignored). On miss, `loadTree` reads the disk file; on disk miss it parses, then
  writes the JSON (best-effort; persistence failure is non-fatal).

The key is `sha1(language\0content)`, so a single edited character yields a new key
and the stale tree is simply never read again — **no invalidation logic**. Helpers:
`treeCacheKey`, `clearTreeCache` (wipe both layers), `clearTreeCacheForKeys` (drop a
specific project's trees on close).

---

## 7. The three structure front-ends

Each front-end's only job is to produce a *raw* box tree; they all hand off to
`buildTreeCached` + `cutTree` (§8) so granularity / depth-spread / coverage behave
identically across languages.

### 7.1 `codeTree.js` (tree-sitter code)

`boxFromParse` recurses the parse tree, keeps named children, and marks a node
`container` iff it has child boxes (else `leaf`). `label = node.label || node.type`.
Box-built tree is memoized under `code:${hashKey(text)}`.

### 7.2 `json.js` (hand-rolled JSONC)

A small recursive-descent parser (`parseJsonTree`) that tolerates `//` and `/* */`
comments and trailing commas, emitting nodes with char spans. `buildBox` turns it
into boxes with a deliberate **rank** (split priority, lower cracks first):

- object/array container → `rank 0`
- a member whose value is itself a container → `rank 1`
- a scalar member (the `key | value` colon split) → `rank 2`

So nested structure is always revealed before scalar key/value pairs are split apart
by their colon. Object members become a `container` of `[keyBox, valueBox]`; array
elements each become a box. Labels build a `parent ▸ key` / `parent ▸ index` path.
Memoized under `json:${hashKey(text)}`.

### 7.3 `genericTree.js` (grammar-less universal fallback)

For any file without a (working) grammar. Builds a hierarchy from the three signals
reliable across *all* languages, no per-language rules:

1. **Indentation** → line nesting (a more-indented line is a child; maintained with
   a stack keyed on `_indent`).
2. **Brackets** `() [] {}` → nested groups inside a line (`matchBracket`,
   best-effort, depth-counted).
3. **Separators** `; ,` → segment boundaries inside a line (`splitInline`).

`finalize` assigns depth, sets container/leaf, and unions child spans. It skips `//`
and `/* */` comments but deliberately **does not** treat quotes as strings
(apostrophes in prose would wreck it). Memoized under `generic:${hashKey(text)}`.

---

## 8. The chunking engine (`frontier.js`)

Source-agnostic. Takes any raw box tree and the three controls and emits flat
chunks. `buildTree` is the **build** step (slider-invariant, cached);
`cutTree` is the **cut** step (per request).

### 8.1 `buildTree(text, root)` — build once per file

1. **`balance`** — cap each node's branching to `MAX_BRANCH = 2` (binary). A node
   with 40 statements becomes a small balanced binary subtree of synthetic grouping
   boxes instead of a 40-way fan-out. **Why binary:** each crack then splits one box
   into exactly two, so each granularity notch adds exactly one chunk — chunk count
   == granularity across the whole range, no dead zones, no doublings. (Higher branch
   caps plateau at the low end.) The cost is deeper synthetic nesting over wide
   nodes, paid only in the `nodes` map, never in LLM calls (synthetics are skipped).
2. **`setDepth`** — number every node by tree depth.
3. **`assignIdentity`** — the id/hash/semantic stamping from §4.1.

Returns `{ root, maxBoxes: countLeaves(root) }`. Memoized by
`buildTreeCached(key, text, makeRoot)` in `builtCache` (keyed
`${kind}:${contentHash}`), so `/chunks` ticks and `fileNodes` calls share one built
tree; a content change yields a new key (self-invalidating, unbounded but bounded by
distinct file contents).

### 8.2 `cutTree(text, built, opts)` — cut per request

Read-only on `built`, so one built tree serves any number of cuts. Two modes:

**Highlight mode** (`opts.around = { start, end }`):
`tightestBox(root, start, end)` walks down from the root, at each level descending
into the unique child that fully contains `[start, end)`; it stops when no single
child contains the range (the range straddles a gap). Returns **just that one box** —
the rest of the file is intentionally left unchunked, because the answer is about
that box alone. (Guards: a collapsed caret is widened to 1 char; the range is clamped
inside the file.) `targetNodeId` = that box's id. This is the descent that guarantees
exactly one root→target path (see `docs/highlight-to-chunk.md` for the full proof).

**Granularity mode** (`opts.granularity`, `opts.depthSpread`):
target box count = `clamp(granularity, 1, maxBoxes)`. Start `frontier = [root]` and
repeatedly **crack the chosen box** until `frontier.length == target`:

- `splittable` = frontier boxes that are containers with children.
- `minDepth` = shallowest splittable depth; `limit = minDepth + depthSpread`
  (`depthSpread === Infinity` ⇒ no limit). `eligible` = splittable within `limit`.
- **Pick:** lowest `rank` wins (e.g. JSON braces before colons); size (`end - start`)
  is the tiebreaker (largest first). `rank` defaults to 0.
- Replace the picked box in-place with its children.

`depthSpread` (D) shapes *how* detail spreads: **D = 0** ⇒ even breadth (the whole
file refines uniformly); **D = ∞** ⇒ pure largest-first drill-down (dive deep into
one part while the rest stays coarse). The client exposes D on `0..6` where `6` maps
to `50` (≈∞).

Finally `frontier.sort(by start)` and `assignCoverage` (§4.3) tiles the file.
Returns `{ maxBoxes, chunks, nodes: collectNodes(frontier), targetNodeId }`.

`collectNodes` walks each frontier box up to the root via `parent`, recording each
ancestor once (the `while` stops at the first already-seen ancestor), producing the
**minimal closure** the client needs to reconstruct any chunk's full ancestry —
shared prefixes stored once.

---

## 9. Node resolution & frontier algebra (`tree.js`)

The chunking endpoints return only the closure for the chunks they emitted. The
meaning engine needs to resolve an arbitrary `nodeId` and walk around it, so
`tree.js` rebuilds the **complete** flat node map.

- **`fileNodes(file)`** re-runs the *same* front-end selection as `/chunks` but at
  `FULL = { granularity: 1_000_000, depthSpread: 50 }`, i.e. expanded to every leaf,
  so the returned `nodes` closure spans the whole tree (every node is an ancestor of
  some leaf). The ids are byte-for-byte identical to the ones the client already
  holds. Result: a flat, stateless `id → { id, parent, label, start, end, depth,
  semantic, hash }` map, resolvable with no tree plumbing.
- **`childrenIndex(nodes)`** inverts `parent` pointers into a `Map<id, childId[]>`
  (the flat map only stores `parent`).
- **Semantic walks** (skip synthetic groups): `semanticParentId` (nearest real
  ancestor), `semanticPath` (root-first breadcrumb of real labels),
  `semanticChildren` (nearest real descendants on each branch, source-sorted),
  `maxSemanticDepth` (how many real levels exist below a node — bounds "more detail"
  drilling).

### 9.1 `minimalFrontier(nodes, idx, rootId, markIds)` — the retrieval primitive

Given a set of **marks** (the boxes the user has asked about), return the *coarsest*
tiling antichain in which every mark still appears as its own box, and every
mark-free stretch is one big box. This is the inverse of the per-highlight
tightest-box descent: that finds one box; this fills the rest of the file around a
*set* of them with as few boxes as possible.

1. Resolve each mark up to its nearest semantic box; drop stale ids (from an older
   file version, absent from `nodes`).
2. **Finer wins:** drop any mark that is a proper ancestor of another mark (keep only
   the antichain of deepest marks).
3. `splitThrough` = the union of all proper ancestors of the effective marks (the
   boxes that must be cracked open to expose a mark).
4. Emit top-down from the root: keep a box whole unless it's in `splitThrough`, in
   which case recurse into its children.
5. Sort by source position. Zero / all-stale marks ⇒ `[root]` (the whole file is one
   box).

This is what makes retrieval *steerable and visible*: the frontier you see banded in
the viewer is exactly the partition the answer is read against (§11.2).

---

## 10. The folder/project tree (`projectTree.js`)

The layer **above** the per-file box trees: files are leaves, directories are
internal nodes, the project root is the top. This is what lets a file's "meaning"
keep climbing past the file into its folders, up to the whole project.

Content-addressed, like everything else:

- **file leaf hash** = `sha1(file content)` — *identical to the in-file root node's
  hash*, so a file's folder-level bare and its whole-file bare share one cache key
  (`bareKey = b:<hash>`).
- **folder hash** = `sha1(sorted child hashes joined by '|')` — changes if any
  descendant changes, so a future edit would invalidate a folder and its ancestors
  (the keys are ready for edit-invalidation even though edits are out of scope today).

`buildProjectTree(rootName, files)` is a **pure** function (hashes depend only on
content + structure, not the root name), so it can rebuild a *background* project's
tree just to compute its cache hashes on close. `setProjectTree`/`getProjectTree`
hold the single active tree module-level. Chain helpers return the root→target node
list a file or folder inherits context from: `folderChainTo(relPath)` (root →
dir-of-file, for a file's chunks), `folderChainToDir(dirPath)` (root → the folder
itself, for chatting about a folder).

---

## 11. The meaning / RAG engine (`meaning.js`)

The largest and most important module (~800 lines). It answers a question about a
selected unit by building a recursively-cached "meaning" of that unit and handing it,
plus the code, to an answer model. **There are two distinct context models in the
codebase — know which is which:**

### 11.1 The vertical fold (ancestor chain) — `contextualizedMeaning`

```
bare(node)          = meaning WITHOUT outside context
                      = summarize(node text)            — keyed by content hash  (b:<hash>)
contextualized(n)   = meaning WITH outside context
                      = fold(bare(n), contextualized(semanticParent(n)))
                      — recurses up to the file root, then folds in folder context
                      — keyed by node id within a context namespace  (c:<ctxNS>:<id>)
```

The recursion skips synthetic groups, so depth tracks real nesting. At the file root
(no semantic parent) it folds into `rootContext` (the folder chain's context),
continuing the climb into the folders. **Trie-like reuse:** every chunk in a file
shares the same ancestor prefix, so those ancestors' contextual meanings are computed
once and reused. This is the model `docs/highlight-to-chunk.md` describes. Today it
is used to describe **sub-parts when drilling** (`drillDetail`), not as the primary
context for the asked node.

### 11.2 The horizontal fold (frontier peers) — `frontierPeersMeaning` *(primary)*

This is what `ask()` and `suggestEdits()` actually use for the selected unit's
contextual meaning. Instead of folding the ancestor chain, it interprets the asked
node against the **other regions of the minimal frontier** — i.e. against the other
things you've asked about in this file. The *distribution itself* is the context.

- **Marks** are per-file, in-memory for the session: `fileMarks: Map<ctxNS, Set<id>>`.
  Asking about a node `record`s its id as a mark (`suggestEdits` passes
  `record: false` — an edit isn't a question).
- `minimalFrontier(nodes, idx, rootId, marks)` (§9.1) gives the current tiling.
- `foldPeers(node, selfBare, peerBares, rootContext)` folds the asked node's bare
  against the bares of the **other** frontier members (its "peers"), with the folder
  `rootContext` as low-weight background. Model = `MEANING_MODEL` (Opus).
- **Cache key** `cp:<ctxNS>:<askedId>:<frontierSig>` where `frontierSig =
  sha1(frontierIds)`. A new mark changes the signature and recomputes exactly **one**
  `foldPeers` call; the peer bares stay cached (content-addressed), so a fresh mark is
  cheap on a warm file. Cached kind `ctxpeers`.

The viewer mirrors this exactly: after each answered question it bumps
`marksVersion`, refetches the highlight-mode chunks, and re-bands the file with the
*refined* frontier — so you watch retrieval get finer where you've looked.

### 11.3 The eager warm pass — `warmProjectBares`

On project load/upload (and on a window-size change), a **detached, background**
bottom-up pass computes every file's bare and every folder's bare up to the root.
It's idempotent (re-runs are cache hits), slot-bounded (§11.9), and a no-op without
an API key. So by the time you ask, the *cheap* building blocks (bares) are usually
already warm and only the *contextual* fold is computed on demand. `bareFile` keys a
file's bare under its content hash (== its folder-leaf `bareKey`); `bareFolder`
summarizes its direct children's bares under the folder hash.

### 11.4 `ctxNS` — the contextual namespace

`ctxNSForFile(file, tree) = sha1( sha1(folderChain bareKeys) : sha1(file content) )`.
So a node's contextual meaning is keyed by its **full upward context** (the folder
chain *and* the file content), not just its file. Editing the file — or moving it
under different folders — yields a new `ctxNS`, so its contextual/peers entries and
its marks self-invalidate. The marks store is keyed by `ctxNS` for the same reason.

### 11.5 Oversized units → windowed map-reduce (`bareSummary`, the "bare window")

A unit longer than the **bare window** (`DEFAULT_BARE_WINDOW = 48_000` chars,
per-project overridable, server-clamped to `[4_000, 200_000]`) can't be summarized in
one shot, so:

- **map:** `splitWindows` cuts it into the fewest line-aligned windows that each fit
  (`n = ceil(len / window)`, capped at `MAX_WINDOWS = 24`; a single over-long line is
  hard-split at char boundaries — the minified-blob fallback). Each window gets its
  own content-addressed bare (`b:<hash(window)>`, kind `barewindow`), so identical
  windows reuse the cache.
- **reduce:** `foldWindows` merges the ordered per-window summaries into one unified
  bare, cached under the unit's own `b:<hash>` (kind `bare`).

Windows are ephemeral scaffolding for *one* summary — never chunks, never in the
tree. Within the window the unit takes a single `computeBare` call. The window size
only changes how big files are *summarized*; it never changes how much code the
**answer** model sees (that's the separate fixed `MAX_SNIPPET = 48_000`, with
explicit `…[truncated]` marking so the model never silently guesses past a cut).

### 11.6 Drilling: depth & intent (`drillDetail`, `classifyIntent`)

A question is answered at the level of the selected unit by default. A follow-up can
push *deeper into the same unit*:

- **Explicit** "More detail" button ⇒ `intent: 'deepen'` ⇒ `effDepth =
  min(depth + 1, maxDepth)`.
- **Typed** message ⇒ `classifyIntent(transcript, question)` (a 1-word Opus call,
  `effort: low`, max 8 tokens) decides `deepen` (dissatisfaction / "more specific
  about the same thing") vs `new` (resets to depth 0).

`drillDetail` descends `effDepth` semantic levels, then describes that level's units
concurrently — each via the *vertical* `contextualizedMeaning` (§11.1), folding off
the already-warm parent. Semantic leaves contribute raw code (≤600 chars) instead of
a too-thin "meaning." Fan-out is bounded by `DRILL_CAP = 24` and surfaced as
`truncated` (no silent caps). The reader can also highlight part of the previous
*answer* (`focus`) to steer the elaboration at exactly that phrase.

### 11.7 Public entry points

| Function | Used by | Returns |
| --- | --- | --- |
| `ask({file, nodeId, question, depth, intent, transcript, contextFile, bareWindow, focus, highlight})` | `POST /api/files/:id/ask` | `{ answer, meaning, path, depth, atBottom, maxDepth }` |
| `suggestEdits({file, nodeId, instruction, transcript, baseCode, contextFile, bareWindow})` | `POST /api/files/:id/suggest-edits` | `{ code, original, path }` |
| `askFolder({dirPath, question, transcript, contextFile})` | `POST /api/folders/ask` | `{ answer, summary, path }` |
| `frontierChunks(file, around)` | `GET /chunks?rangeStart&rangeEnd` | `{ kind, maxBoxes, chunks, nodes, targetNodeId, chunkCount }` |
| `fileFrontier(file)` | `GET /api/files/:id/frontier` | `{ marks, frontier }` (debug/demo, no LLM) |
| `warmProjectBares`, `projectCacheHashes`, `ctxNSForFile` | `index.js` warm-up / cache mgmt | — |

**`ask` flow, in order:** resolve `fileNodes` and validate `nodeId` → compute
`ctxNS` and `rootContext` (folder fold) → decide `effDepth` (intent/classify) →
`meaning = frontierPeersMeaning(..., record: true)` → `path = semanticPath` →
`snippet = clip(node code)` → optional `drill = drillDetail(effDepth)` → optional
short literal `highlight` quote (≤ `HIGHLIGHT_QUOTE_CAP = 200`) → assemble the
answer prompt (recap of last 4 turns, file path, location breadcrumb, the contextual
meaning, the sub-part breakdown, the code, any attached context file, any
answer-focus, any highlight quote, the question) → `ANSWER_MODEL` call with
`thinking: { type: 'adaptive' }` and `effort: medium`.

**`suggestEdits`** reuses the same frontier-peers context (but `record: false`),
revises `baseCode` if supplied (so iterative edits stack) else the unit's source,
and returns the full revised unit with any stray code fences stripped
(`stripFences`). It never edits the attached context file (prompt says so explicitly).

**`askFolder`** folds the folder chain to its `ctx` (`chainContext`), lists the
folder's direct children's bares, and answers. `dirPath = ''` is the project root.

**`frontierChunks`** is the highlight-mode chunker that the *viewer* hits (not
`cutTree`'s highlight branch — that's the fallback): it unions the session marks with
`highlightMarks(range)` (the topmost semantic boxes the range overlaps, so a
cross-unit highlight isolates those units instead of collapsing to the whole file),
builds the `minimalFrontier`, tiles it with `assignCoverage`, and returns the band
the highlight's start lands in as `targetNodeId`, plus a lean ancestor closure and
`maxBoxes` (leaf count). The viewer auto-selects `targetNodeId`.

### 11.8 Model routing

| Role | Default model | Knobs |
| --- | --- | --- |
| `bare` / window / folder bares / combine | `BARE_MODEL = claude-haiku-4-5` | cheap, no `effort` (Haiku 400s on it) |
| `classify` / vertical fold / peers fold | `MEANING_MODEL = claude-opus-4-8` | `effort: low` |
| user-facing answers / edits / folder answers | `ANSWER_MODEL = claude-opus-4-8` | `thinking: adaptive`, `effort: medium` |

`supportsEffort(m)` gates the `output_config.effort` and `thinking` params to
Opus-4.5+/Sonnet-4.6 (Haiku omits them). Every system prompt is sent with
`cache_control: { type: 'ephemeral' }` to hit Anthropic prompt caching. Cost goes
where it's visible: the many small "what does this mean" passes are cheap; the one
answer you read is the strongest model.

### 11.9 Concurrency & dedup

- **Global slot ceiling** `CONCURRENCY = 8`: every model call routes through
  `withSlot`, so the eager whole-project pass and interactive requests share one
  ceiling instead of each spawning unbounded fan-out.
- **In-flight dedup** `barePending` / `ctxPending`: concurrent requests for the same
  cache key share one promise (and one model call), so parallel sibling drills can't
  each kick off the same shared-ancestor computation. Keyed identically to the
  persistent cache.

### 11.10 Prompt design — the `VOICE` block

The answer/folder system prompts embed a long, deliberate `VOICE` style guide whose
goal is "a person who knows the code talking to a peer," not the hedged,
summary-closing register an LLM defaults to. It bans the autopilot tells: stance
adverbs ("Notably/Crucially"), "-ing" tack-on tails, "it's not just X, it's Y",
"In essence/Ultimately" wrap-ups, "Moreover/Furthermore" signposting, flattery
openers, both-sides hedging, and restating sentences. The internal scaffolding
(contextual meaning, sub-part breakdown) is explicitly framed as the model's *own*
understanding it must never refer to ("the summary", "the provided context"). Answers
target ≤ ~500 chars.

---

## 12. The cache (`cache.js`) and invalidation

A persistent memo table for every meaning. Same philosophy as the tree cache —
in-memory Map in front, disk behind, no daemon — but **one append-only JSONL file**
(`.meaning-cache/meanings.jsonl`) instead of file-per-entry, because meanings are
many and small.

- **Append-only.** A cache miss is the only write, and it's an O(1) append of
  `{ k: key, v: value, f: fileHash, t: kind }`. Crash-tolerant: a torn final line is
  skipped on load. `load()` reads the whole log into the Map on first access (last
  write wins).
- **Content/identity keys** mean a changed file produces new keys; stale lines simply
  stop being read. **There is no invalidation logic in the hot path** — only explicit
  GC (below).

### 12.1 Key namespaces & kinds

| Kind (`t`) | Key shape | `f` (fileHash) | What it is |
| --- | --- | --- | --- |
| `bare` | `b:<contentHash>` | ctxNS (in-file) / contentHash (file) | unit/file meaning without context |
| `barewindow` | `b:<windowHash>` | ctxNS | one window of an oversized bare |
| `folderbare` | `b:<folderHash>` | folderHash | a directory's own summary |
| `ctx` | `c:<ctxNS>:<id>` | ctxNS | vertical contextual meaning |
| `ctxpeers` | `cp:<ctxNS>:<askedId>:<sig>` | ctxNS | horizontal frontier-peers meaning |
| `dirctx` | `c:dir:<folderHash>` | folderHash | a folder's folded contextual meaning |

### 12.2 Two-tier drop (`cacheDropByFileHash`, `clearProjectAnalysis`)

`projectCacheHashes(files, tree)` collects every `f` a project's entries were stored
under: each file's `ctxNS` (covers in-file bares, windows, `ctx`, `ctxpeers`) plus
every folder/file node hash in the tree (covers file bares, folder bares, `dirctx`).
`cacheDropByFileHash(hashSet, dropKinds?)` rewrites the JSONL without the matching
lines (temp-file + atomic rename) and drops them from memory.

- **"Clear cache"** (`DELETE /api/tree-cache`, `full: false`): `dropKinds =
  CTX_KINDS = { ctx, ctxpeers, dirctx }`. Drops only the per-chunk in-context reads
  (what answers are built from). **Keeps** parse trees and all bares — the durable,
  expensive building blocks. The next question just re-folds context off the kept
  bares, so it's fast. This is the UI's reset.
- **"Close project"** (`DELETE /api/projects/:id`, `full: true`): `dropKinds = null`
  (everything) **and** `clearTreeCacheForKeys` for the parse trees. Works for a
  background (non-active) project too, by rebuilding its folder tree from its files
  (hashes are name-independent).

A window-size change (`PUT /bare-window`) drops the project's *entire* meaning set
(all kinds) and re-warms, because the bares were built at the old window.

---

## 13. The project registry / store (`store.js`)

In-memory, multi-project, single active project. The file endpoints operate on the
active one, so a single-project client works unchanged.

- **Registry** `Map<projectId, { id, absPath, name, files: Map|null, scan, lastUsed,
  uploaded?, bareWindow }>`. `files === null` ⇒ registered but evicted (re-scan on
  activate). `makeProjectId` = `slug(basename)-sha1(absPath)[:8]` (stable across
  sessions, so the client can namespace `localStorage` by it).
- **Two residency caps.** `MAX_RESIDENT = 3` projects keep their file *text* in
  memory (LRU; `evictLRU` never evicts the active or an uploaded project — uploads
  have no disk to re-scan). `MAX_PROJECTS = 50` caps registry *metadata*
  (`enforceRegistryCap` drops the oldest non-active).
- **Disk projects** (`registerProject`/`activateProject`): `scanInto` walks +
  reads with the same caps as ingest, recording skip/truncate stats.
- **Uploaded projects** (`registerUploadedProject`): built from posted
  `{ relPath, content }[]` with the ingest filters **re-applied server-side**
  (`buildFilesFromUpload` — never trust the upload). The id is a *content
  fingerprint* (`upload-<slug>-<sha1>[:8]`), so re-uploading the same folder reuses
  its `localStorage` namespace (chunk-size overrides survive).
- **Per-project bare window** (`getBareWindow`/`setBareWindow`, clamped
  `[4_000, 200_000]`), threaded into every `ask`/`suggestEdits`/warm call.
- **Built-in sample file** (`sample/rate-limiter.js`, a tiny rate limiter) is always
  resolvable via `getFile` regardless of the active project, so the help/demo page
  works before anything is loaded. `countLines` counts newlines without allocating.

---

## 14. Search-based references (`references.js`)

"Find references" without a language server — the approach GitHub code-nav,
Sourcegraph search-based intel, and aider's repo map use.

- For a parseable file: walk the cached parse tree, push a hit for every **identifier
  leaf** whose text exactly equals the name, **excluding** literals/comments
  (`EXCLUDED` set: strings, chars, comments, numbers, regex, escapes). Classify each
  hit from its parent node type: `definition` (`DEF_PARENTS`: function/class/method/
  struct/enum/trait/const/… declarations), `call` (`CALL_PARENTS`: call/new/method-
  invocation), `import` (`IMPORT_TYPES`), else `reference`.
- For a non-parseable / parse-failed file: a word-boundary regex text scan
  (`(?<![\w$])name(?![\w$])`), kind `text` — like an IDE's plain-text search.
- Approximate by design: name-based, not scope-resolved, so unrelated same-named
  symbols match too — which is why the **definition** hits are flagged separately.
  Bounded by `MAX_HITS = 500` (surfaced as `truncated`). `from` orders the origin
  file first; results group by file, hits sorted by offset, each carrying
  `{ offset, line, kind, lineText }`.

This quietly delivers the roadmap's old "project-wide where-is-this-used" item via
search rather than vectors (see §19).

---

## 15. HTTP API reference (`index.js`)

All JSON unless noted. Errors are `{ error }` with an appropriate status (handlers
honor an `e.status` set by the lower layers, e.g. `503` when `ANTHROPIC_API_KEY` is
missing, `404` for an unknown/stale `nodeId`).

| Method | Route | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ ok, projectDir, files, scan }` |
| GET | `/api/sample` | — | `{ file: { id, relPath, language } }` (demo file) |
| GET | `/api/files` | — | `{ projectDir, projectId, files[], scan }` (metadata only) |
| GET | `/api/files/:id/raw` | — | `text/plain` source |
| GET | `/api/files/:id/chunks` | `granularity`, `depthSpread` **or** `rangeStart`,`rangeEnd` | `{ kind, maxBoxes, chunks, nodes, targetNodeId, chunkCount, … }` |
| GET | `/api/files/:id/frontier` | — | `{ marks, frontier }` (debug, no LLM) |
| GET | `/api/references` | `name` (2+ chars), `from?` | `{ name, count, truncated, definitions[], files[] }` |
| POST | `/api/files/:id/ask` | `{ nodeId, question, depth, intent, transcript, contextFileId, focus, highlight }` | `{ answer, meaning, path, depth, atBottom, maxDepth }` |
| POST | `/api/files/:id/suggest-edits` | `{ nodeId, instruction, transcript, baseCode, contextFileId }` | `{ code, original, path }` |
| POST | `/api/folders/ask` | `{ dirPath, question, transcript, contextFileId }` | `{ answer, summary, path }` |
| GET | `/api/projects` | — | `{ activeId, projects[] }` |
| POST | `/api/projects` | `{ path }` (local abs/rel dir) | `{ project, activeId, projects }` |
| POST | `/api/projects/upload` | `{ name, files: [{ relPath, content }] }` | `{ project, activeId, projects }` |
| POST | `/api/projects/:id/activate` | — | `{ project, activeId, projects }` |
| DELETE | `/api/projects/:id` | — | `{ activeId, projects }` (also full cache wipe) |
| PUT | `/api/projects/:id/bare-window` | `{ chars }` (active project only) | `{ ok, bareWindow, dropped, projects }` |
| DELETE | `/api/tree-cache` | — | `{ ok, trees, meanings }` (CTX-kinds-only drop) |

`/chunks` clamps `granularity` to `[1, 1_000_000]` and `depthSpread` to `[0, 50]`;
`rangeStart`/`rangeEnd` are clamped into the file. Mode precedence inside the handler:
**highlight** (`rangeStart`/`rangeEnd` present → `frontierChunks`, falls back to
structural on error) → **json** → **tree-sitter code** → **generic**. Every project
mutation re-runs `warmActiveProject()` (rebuild folder tree + detached warm pass).

---

## 16. The client

React 19, no router/state-lib. One source of truth in `App.jsx`; the viewer and
library own their local interaction state. All server I/O goes through `lib/api.js`.

### 16.1 `App.jsx`

- **State:** `files`, `projectDir`, `activeProjectId`, `projects`, `selectedId`,
  `projectLoading`/`loadingName`, the `view` (`'main'` | `'help'`), the sample file +
  its chunk slider, several modal flags (demo intro pager, "how caching works",
  clear-cache confirm, window-size confirm), and two persisted maps:
  - **`chunkSizes`** — per-file granularity override, `localStorage` namespaced by
    project (`cv:chunkSizes:<projectId>`), with a guard against writing back the value
    just loaded.
  - **`edits`** — per-chunk edits keyed `${fileId}::${nodeId}`, each storing the
    edited text + the slider/location config at edit time (so the history carousel can
    jump back to that exact chunk), persisted under `cv:edits`.
- **Welcome→work animation:** a two-phase collapse (`viewerLocked` horizontal fill,
  then `topbarBig` vertical collapse, then `controlsReady`) driven by timers, so the
  greeting opens into the workspace smoothly. One-way (re-expand only by refresh).
- **Cross-component signals:** `jumpTarget` (edit-history jump or a reference jump
  carrying a raw char offset), `fileChatSignal` (open a file *with its chat already
  open*, used when a folder-chat answer links a file), `openReference`.
- Project switch/upload/remove all funnel through `loadActiveFiles()` and surface the
  loading state on the stage.

### 16.2 `CodeViewer.jsx` (~1.2k lines)

The heart of the UI. Notable mechanics:

- **Three chunking modes**, last action wins: default (whole file = one chunk),
  **highlight** (`pendingRange` → `fetchChunksAround`), **manual** (`manualMode` →
  granularity/depth sliders, now only exposed on the demo page). Re-chunk fires from
  one effect debounced ~80 ms on `[file.id, pendingRange, manualMode, chunkSize,
  depthSpread, marksVersion]`; `marksVersion` bumps after every answered question so
  the bands follow the refined frontier.
- **Highlight → char offsets:** every rendered `.seg` carries `data-cs` (its absolute
  char start) and — by render invariant — exactly one text node, so a DOM
  `Selection` endpoint maps to a file offset by `Number(seg.dataset.cs) +
  offsetInNode` (`segOffset`). `onCodeMouseUp` resolves both endpoints (falls back to
  whichever resolves), drops the native selection, and sets `pendingRange`. A plain
  click clears the selection back to whole-file.
- **Rendering:** `segmentsFor(k)` builds runs of same-chunk-index segments per line
  via a binary-search `chunkAt(pos)` over the sorted `[start,end)` intervals (no
  per-char array). `splitSegByHighlight` overlays the user's blue highlight band
  independently of chunk bands. Chunk bands use three muted alternating hues, with a
  vivid variant for the selected chunk; bands are off by default and revealed when the
  chat opens.
- **Q&A chat:** per-file transcripts (`chatLogs[file.id]`), a genie-animated panel +
  FAB, "More detail" drill button (with optional answer-text `focus`), an attach-file
  control, and a "Suggest edits" toggle that turns messages into edit instructions.
- **Edits drawer + diff:** a transparent `textarea` over a backdrop that renders a
  **char-level LCS diff** (`charDiff`: trims common prefix/suffix, LCS only the
  changed middle, falls back to whole-replace past 4M cells) — inserted chars
  highlighted, a red gutter dot on lines with deletions. Below it, an **edit-history
  carousel** scoped to the file. Edits live in `App` state + `localStorage`; they
  never touch the real file.
- **References peek:** clicking a clean single-identifier `code` span in an answer
  (`linkCode` gates to `/^[A-Za-z_$][\w$]*$/`) opens a portal listing every
  definition/use across the project, each row jumping to the offset (in-file scroll,
  or hand off to `App` to switch files).

### 16.3 `Library.jsx`

The file tree (built from flat relPaths, rendered with `└/├` guide cells) plus
**per-folder chat**. Folder navigation has back/forward history; each folder keeps
its own conversation (`chatLogs[cwd]`). Answers get two kinds of linkification: a row
of jump-to buttons for every child file/folder the answer named (`refsInText`), and
inline clickable mentions where names appear in prose/`code` (via `richText`).
Ambiguous basenames resolve to the target closest to the current folder.

### 16.4 `ProjectSwitcher.jsx`

The top-bar **manila-folder tabs**. Tabs hold a fixed left-to-right order (selecting
only changes z-index); the active tab is **drag-reorderable** (draws a blue insertion
line, commits on release). Clicking the active tab opens its **"Context detail"**
window-size slider (8k–128k, step 8k). Adding a project opens a folder via three
paths in `uploadFolder.js`:

1. **File System Access API** (`showDirectoryPicker`, when same-origin top-level) —
   lightest prompt;
2. **`<input webkitdirectory>`** fallback (Firefox/Safari);
3. **drag-and-drop** (older FileSystem Entries API; entries captured synchronously).

All three mirror the server's ingest filters client-side (skip dirs, lockfiles,
non-source ext, `MAX_FILE_BYTES`, and a 50 MB POST cap) so `node_modules`/binaries
never go over the wire. Capped at 4 open projects in the UI.

### 16.5 `richText.jsx`

A deliberately small Markdown renderer (not a library): ```` ```fences```` → `<pre>`,
`**bold**` → `<strong>`, `` `code` `` → `<code>`, `#`-prefixed lines → headings.
Everything else (including newlines, via CSS `white-space: pre-wrap`) is left intact.
Optional `mentions` make known file/folder names clickable wherever they appear
(longest-name-first alternation so `app.test.js` beats `app.js`); optional `linkCode`
makes inline `code` a clickable symbol (the references peek).

### 16.6 Design system (`index.css`, ~1.65k lines, no framework)

Hand-written. A fixed gradient "mesh" backdrop; warm off-white surfaces; the manila
folder-tab motif (clip-path shapes with directional pseudo-element shadows) reused for
project tabs and the chunk-list drawer handle; genie-unfurl animations for the chat
panels; gradient-bordered "glass" help modals **portaled to `<body>`** so their blur
covers the top bar too. Fonts: Inter (UI, ExtraLight default), JetBrains Mono
(code/paths), Crete Round + Roboto Slab (display).

---

## 17. Configuration: env, models, caps

### 17.1 Environment (`.env`)

| Var | Default | Effect |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | required for chat / edits / folder summaries (chunking + viewer work without it) |
| `PROJECT_DIR` | this repo | the codebase to inspect on local runs |
| `PORT` | `8799` | API port (Vite proxies `/api` here in dev) |
| `ANSWER_MODEL` | `claude-opus-4-8` | user-facing answers + edits |
| `MEANING_MODEL` | `claude-opus-4-8` | classify + context folds |
| `BARE_MODEL` | `claude-haiku-4-5` | the many small bare passes (incl. the eager project pass) |
| `BARE_WINDOW_CHARS` | `48000` | default bare-window (per-project overridable in UI) |

### 17.2 Constants worth knowing

| Constant | Value | Where | Meaning |
| --- | --- | --- | --- |
| `MAX_BRANCH` | 2 | frontier.js | binary balancing ⇒ granularity == chunk count |
| `MAX_FILE_BYTES` | 1 MB | code.js | per-file skip threshold |
| `MAX_FILES` | 4000 | code.js | per-project file cap |
| `MAX_TOTAL_BYTES` | 150 MB | code.js | per-project summed-text cap (client upload caps at 50 MB) |
| `MAX_RESIDENT` / `MAX_PROJECTS` | 3 / 50 | store.js | resident text LRU / registry metadata cap |
| `CONCURRENCY` | 8 | meaning.js | global model-call slot ceiling |
| `MAX_SNIPPET` | 48000 | meaning.js | code shown to the answer model (explicit truncation) |
| `DEFAULT_BARE_WINDOW` | 48000 | meaning.js/store.js | map-reduce threshold (clamp 4k–200k) |
| `MAX_WINDOWS` / `DRILL_CAP` | 24 / 24 | meaning.js | map-reduce window cap / drill fan-out cap |
| `HIGHLIGHT_QUOTE_CAP` | 200 | meaning.js | max literal-highlight quote into the answer prompt |
| `MAX_HITS` | 500 | references.js | reference result cap |
| `GRAN_CAP` | 500 | CodeViewer.jsx | generic-file granularity slider cap |
| UI open-project cap | 4 | ProjectSwitcher.jsx | tabs |

The caches (`.tree-cache/`, `.meaning-cache/`) live in **this** repo, are gitignored,
and rebuild on demand — safe to delete anytime.

---

## 18. Performance characteristics

- **Dragging never re-parses and never re-builds the tree.** Parse → disk/mem cache;
  box-build → `builtCache`. A slider tick only re-runs `cutTree` (a frontier walk +
  coverage) on an already-built tree.
- **Meaning is computed lazily and reused along structure.** Bares are
  content-addressed (identical code summarized once, project-wide). Contextual reads
  are keyed by node id within `ctxNS`, so shared ancestor prefixes (vertical) and
  unchanged peer bares (horizontal) are reused; a new mark recomputes exactly one
  fold.
- **The expensive work is front-loaded off-thread.** The eager bare pass warms the
  cheap layer in the background under one concurrency ceiling; interactive requests
  then mostly pay for a single fold + a single answer.
- **The client doesn't window the code** (it relies on contiguous chunk intervals +
  binary search), so very large files render as plain DOM; the drawer/animation costs
  are mitigated with `will-change`/GPU-layer hints in CSS rather than virtualization.
- **One ~75 KB-gzipped bundle**, single origin in production, immutable-cached assets.

---

## 19. Known limitations & honest caveats

- **No automated tests.** Pure functions are written to be testable; nothing is wired.
- **`r` / `sql` don't actually CST-chunk yet.** They're declared in `GRAMMAR` but
  their wasms aren't bundled (no `server/grammars/`) and aren't in the pack, so they
  use the generic chunker. `yaml` is intentionally generic (broken packed grammar).
- **Marks are in-memory and per-session.** The frontier-peers context resets on
  server restart (the bares/ctx it folds are still persisted). Keyed by `ctxNS`, so a
  file edit self-invalidates them.
- **Edit-invalidation is plumbed but not active.** Folder hashes change with content
  and `cacheSet` stores `fileHash` for later GC, but the app doesn't write edits back
  to disk, so meanings aren't recomputed from edits today.
- **Why no vector DB.** Retrieval here is *exact-key lookup along a path you pointed
  at*, not similarity search over an unknown location — so a vector index would be
  answering a question nobody asked, at the cost of an index to build/sync/host. The
  one place vectors would genuinely earn their keep — project-wide "where is this
  used?" — is now served well enough by **search-based references** (§14); a true
  semantic index remains a future option, not a present need.
- **Why no daemon.** The same reasoning rules out Redis/Postgres: an in-memory Map in
  front of a plain file (per-entry JSON trees; one append-only JSONL for meanings)
  matches a tool meant to start instantly on one laptop. Content-addressed keys mean
  there's no invalidation logic to get wrong.

---

## 20. Roadmap

- [x] Structure-aware chunking with a stable identity per piece (id + content hash)
- [x] Layered, cached meanings (vertical ancestor fold **and** horizontal
      frontier-peers fold) that pull in folder + project context
- [x] Steerable, per-file and per-folder question answering with depth drilling
- [x] Edit-by-conversation with a char-level diff editor + per-file history
- [x] Multi-project registry (local path + browser folder upload) with LRU residency
- [x] Search-based project-wide "find references" (definition/call/import/text)
- [ ] Auto-named pieces; files clustered into modules
- [ ] A navigable map of how the project's parts depend on each other
- [ ] Write edits back + activate the already-plumbed edit cache invalidation
- [ ] Optional semantic index for fuzzy "find code like this" (the one real vector use)

---

## 21. Concept recap

Stripped of implementation: CodeArchitect parses each file into a structural tree,
gives every node a slider-invariant identity, and treats "zoom" as choosing a cut
through that fixed tree (one notch = one chunk). You point at a piece — by dragging
the slider or, in the main app, by highlighting — and ask about it. The system reads
that piece against the **fewest other pieces that still cover everything you've
asked about** (the minimal frontier of your marks), folds in folder/project context,
and answers with a strong model — while a cheap model has already summarized every
unit in the background. Each result is cached by a fingerprint of the exact code it
describes, so identical code is understood once, shared context is computed once, and
a changed line just misses the cache and recomputes. No vector database, no daemon —
because the access pattern is "walk from here," not "search for something like this."

---

*Build:* `npm install && npm install --prefix client && cp .env.example .env` (add
`ANTHROPIC_API_KEY`), then `npm run dev` and open <http://localhost:5174>. Viewer +
chunking need no key; chat / edits / folder summaries do.
