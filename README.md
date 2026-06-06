# CodeArchitect

> Point it at a codebase, **see how it chunks**, tune the chunking live, and **chat
> with any file or folder** to understand what it does.

By Andrew Jorge.

CodeArchitect renders every source file with its structural chunks drawn as colored
bands, and gives you sliders to reshape that chunking in real time — from "whole
file as one box" down to operand/identifier level. On top of that sits a
retrieval-style **Q&A chat**, scoped to a single file *or* a whole folder, where the
chunk you select *is* the retrieval unit.

It chunks by **structure**, not lines: a shared frontier engine turns a tree-sitter
parse (for code), a JSON parse, or an indentation/bracket parse (for everything
else) into one "box tree", then cuts a frontier out of it. Every box gets a stable
identity that's invariant across slider settings, which is what lets meanings be
cached and reused as you re-chunk.

## Quick start

```bash
npm install
npm install --prefix client

cp .env.example .env
#   ANTHROPIC_API_KEY=sk-ant-...   ← required only for the chat / Q&A features
#   PROJECT_DIR=/path/to/a/repo    ← optional; defaults to this repo (self-demoing)

npm run dev
```

Open the client at <http://localhost:5174>. The API runs on `:8799` and the Vite dev
server proxies `/api` to it.

Chunking and the file viewer work with no API key. The chat, "suggest edits", and the
background folder-summary pass need `ANTHROPIC_API_KEY`.

## Features

- **Structural, multi-language chunking** — tree-sitter grammars for code, a
  hand-rolled JSON parser, and an indentation/bracket fallback so *every* file gets a
  real component hierarchy, not flat lines.
- **Live chunking controls** — a granularity slider (chunk count, 1:1), a depth-spread
  slider (how uneven the cut may get), and a sub-splitter for breaking a box into
  word-sized pieces. Boundaries re-draw as you drag.
- **Highlight to chunk** — select a range in the code and it produces the fewest
  chunks that isolate the smallest box containing your selection.
- **Q&A chat, per file and per folder** — ask about the selected chunk (or the whole
  file), or about a directory. Answers are built from a recursive *meaning* of the
  node folded with its surrounding scope, up through the folder tree to the project
  root. "↡ More detail" drills deeper into the node's subtree.
- **Attach a file as context** — pin one project file into a chat for cross-file
  questions.
- **Folder chat navigation** — answers surface clickable buttons to jump straight into
  the files/folders they mention; back/forward chevrons walk the folder history, and
  each folder keeps its own conversation.
- **Suggest edits** — drive code edits by chatting; revisions land in an Edits drawer
  with an edit-history carousel, persisted across reloads.
- **Multi-project** — register several codebases (native folder picker) and switch
  between them; per-project chunk-size overrides persist to `localStorage`.

## How it works

### Ingest & chunking (`server/ingest/`)

- **`parseTree.js`** — tree-sitter (WASM) parse, memoized in-process and persisted to
  `.tree-cache/` (content-hash keyed).
- **`codeTree.js` / `json.js` / `genericTree.js`** — language *providers*. Each turns
  its source into a generic **box tree** `{ start, end, kind, children, … }`.
- **`frontier.js`** — the shared engine. `buildTree` balances branching, sets depths,
  and assigns every box a **stable identity** (`id` = path hash, `hash` = content
  hash) — a pure function of the tree, so ids are identical across every chunking of a
  file. `cutTree` then cuts a frontier by granularity/depth-spread, or *around* a
  highlighted range. Built trees are cached (`buildTreeCached`) so only the cut reruns
  per slider tick.
- **`projectTree.js`** — the directory hierarchy above file roots, content-addressed,
  so folder context can be folded into answers.
- **`tree.js`** — `fileNodes()` resolves any `nodeId` to its node + ancestor chain
  from file content alone (chunks at full granularity), so Q&A needs no separate tree
  plumbing.

### Meaning & Q&A (`server/llm/`)

- **`meaning.js`** — the retrieval logic. Two cacheable layers per node:
  `bare(node)` (meaning of its own text, keyed by content hash) and
  `contextualized(node)` = fold of `bare(node)` into `contextualized(parent)`, recursing
  up through the file and folder tree. `ask()`/`askFolder()` assemble that context plus
  the code and answer; `suggestEdits()` proposes a revision. Models are
  `claude-opus-4-8` for answers and `claude-haiku-4-5` for the many small bare passes
  (all env-overridable).
- **`cache.js`** — append-only JSONL memo table (`.meaning-cache/meanings.jsonl`),
  in-memory Map in front. Keys are content/identity hashes, so editing a file just
  produces new keys and the stale lines stop being read.

### Server & client

- **`server/index.js`** — Express API (endpoints below) + a background pass that warms
  folder/file summaries on startup and on every project change.
- **`server/store.js`** — in-memory project registry and the source-file scan.
- **`client/`** — React + Vite. `App.jsx` owns project/file/edit state and
  persistence; `CodeViewer.jsx` is the file view, sliders, and file chat;
  `Library.jsx` is the folder tree and folder chat; `ContextAttach.jsx` and
  `ProjectSwitcher.jsx` are shared controls.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness |
| GET | `/api/files` | active project's file list + scan stats |
| GET | `/api/files/:id/raw` | raw source |
| GET | `/api/files/:id/chunks` | chunk the file (`granularity`, `depthSpread`, or `rangeStart`/`rangeEnd`) |
| POST | `/api/files/:id/ask` | Q&A about a chunk (`nodeId`, `question`, `depth`, `transcript`, `contextFileId`) |
| POST | `/api/files/:id/suggest-edits` | chat-driven code edit |
| POST | `/api/folders/ask` | Q&A about a directory (`dirPath`, `question`, `contextFileId`) |
| GET | `/api/projects` · POST `/api/projects` · POST `/api/projects/pick` · POST `/api/projects/:id/activate` · DELETE `/api/projects/:id` | project registry |

## Environment

| Var | Default | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | required for chat / suggest-edits / folder warming |
| `PROJECT_DIR` | this repo | codebase to inspect |
| `PORT` | `8799` | API port |
| `ANSWER_MODEL` / `MEANING_MODEL` | `claude-opus-4-8` | answer & ctx-fold model |
| `BARE_MODEL` | `claude-haiku-4-5` | per-node bare-meaning model (set to Haiku to cut cost) |

Caches live in this repo (not the inspected project) and are gitignored:
`.tree-cache/` (parse trees) and `.meaning-cache/` (meanings).

## Roadmap

- [x] AST / tree-sitter structural chunking instead of lines
- [x] Retrieval + Q&A over the codebase (per file and per folder)
- [x] Recursive, cached chunk meanings folded with folder context
- [ ] Auto-named chunks / cluster files into modules
- [ ] Dependency graph → navigable architecture map
- [ ] Cross-file retrieval (vectors) for "where is this used?" questions
- [ ] Cache compaction / GC for stale meaning entries
