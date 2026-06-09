# CodeArchitect

> See the shape of a codebase, zoom in and out of it like a map, and ask any part of it what it does.

By Andrew Jorge.

---

## What it does

Point CodeArchitect at a codebase and it draws the **structure of the code right over the source**: every file is broken into meaningful pieces — a function, a loop, a single expression — shown as colored bands on the code itself.

A single slider acts like a **zoom level**. Slide one way and the whole file collapses into one piece; slide the other and it opens up into functions, then statements, then individual names and values. The pieces redraw as you drag, so you can dial in exactly how coarse or fine a view you want.

Then you can **talk to the code**:

- **Select any piece and ask about it.** The answer isn't based on that snippet in isolation — it's grounded in everything around it, from the lines next to it, up through the function and file it lives in, all the way to the folder and the project as a whole.
- **Ask a whole folder what it's for** — how its files relate, where to look for something. The answer comes with buttons that jump you straight into the files and subfolders it mentions.
- **Highlight a region** and it finds the fewest pieces that isolate exactly what you selected.
- **Edit by conversation.** Describe the change you want and it proposes a revision, dropped into a diff you can review — with a history of every edit.
- **Attach another file as context** for a question that spans two places.

It works on its own code out of the box (so it self-demoes), and you can point it at any folder on your machine — or, when it's hosted, open a folder right from your browser.

---

## The ideas that make it work

Most of what's interesting about CodeArchitect is in a handful of design decisions. Each one is the answer to a question that sounds simple but isn't.

### 1. Chunk by structure, not by line count

The obvious way to split a file into pieces is to cut it every *N* lines. It's also the wrong way — it slices through the middle of functions and glues unrelated code together. CodeArchitect instead **parses each file into a tree** (the same kind of tree a compiler builds) and treats chunking as a question of *where to cut that tree*. The boundaries land on real seams in the code — the start of a function, the edge of a block — never mid-thought.

That's why "zoom" is the right mental model. Zooming out merges a function's pieces back into the function; zooming in cracks it open into its parts. You're moving up and down a hierarchy that's actually there in the code, not sliding an arbitrary window.

### 2. One engine, every language

Code, JSON, and plain-text formats are wildly different to parse — but they're identical once you stop looking at syntax and start looking at *nesting*. So CodeArchitect parses each kind with its own front end (a full grammar for real programming languages, a small purpose-built reader for JSON, and an indentation-and-bracket reader for everything else), and then hands all three to **one shared engine** that knows nothing about any specific language. It only understands a generic tree of nested boxes.

The payoff: the slider, the zoom behavior, the meanings, and the question-answering all work the same way on a Python file, a config file, or a SQL script — because below the surface they're all the same shape. New languages plug in by adding a front end, not by touching the engine.

A small but deliberate detail: **every character gets a home.** The punctuation and whitespace between pieces is attached to a neighbor on a consistent rule, so the pieces are always contiguous and tile the file perfectly — no orphaned gaps, no overlaps.

### 3. A slider that feels like a zoom, not a guess

Two design choices make the zoom feel direct rather than fiddly:

- **One notch, one piece.** Each step of the slider changes the number of pieces by exactly one. There are no dead zones where dragging does nothing and no jumps where it suddenly doubles. The number on the slider *is* the number of pieces on screen.
- **A second control for *how* it zooms.** When you zoom in, do you want the detail spread evenly across the whole file, or do you want to dive deep into one part while the rest stays coarse? A "depth" control lets you choose — even attention versus a focused drill-down.

### 4. Every piece has a name that survives re-chunking — the keystone

This is the quiet decision that everything else leans on.

When the engine builds the tree, it gives **every box a stable identity** — a fingerprint derived purely from *where that box sits in the structure and what's inside it*. Crucially, that identity has nothing to do with the slider. Zooming in and out changes which boxes are *shown*, but never the boxes themselves or their names.

Why this matters: it means a given region of code — say, one specific function — is the *same thing* to the system no matter how the file is currently sliced. So anything the system learns about that function can be filed under its identity and found again later, even after you've re-chunked the file ten times. Without this, every adjustment to the slider would throw away everything the system knew. With it, understanding accumulates.

### 5. Understanding is computed once and reused everywhere

When you ask about a piece of code, CodeArchitect needs to know what it *means*. It builds that understanding in two layers:

- **What the piece means on its own** — read in isolation, ignoring everything around it.
- **What the piece means *here*** — the meaning above, folded together with the meaning of the thing that contains it, which is folded with the thing that contains *that*, all the way up.

Both layers are remembered, and they're remembered against the stable identities from idea #4. Two consequences fall out of this, and they're the kind of thing that makes the whole system feel cheap to run:

- **Identical code is understood once.** A snippet that appears in three files has the same content fingerprint in all three, so its standalone meaning is computed a single time and shared.
- **Two ways of slicing a file share their common ancestors.** Whether a function is shown whole or cracked into ten pieces, it has the same parents up the tree — and those parents' meanings are computed once and reused by every slicing. The expensive work near the top of the tree is done exactly once.

In effect, the system fills in a map of meaning lazily, as questions arrive, and never recomputes a square of that map it has already filled.

### 6. Context flows downhill

A line of code rarely means much by itself; it means something *because of where it lives*. CodeArchitect makes that literal. Understanding rolls **upward** at rest — each file is summarized, those summaries combine into a summary of their folder, and so on up to the whole project — and then flows **downhill** into every answer. Ask about one line and the system can draw on its function, its file, its folder, and the project's overall purpose, automatically, because that context was already folded in on the way up.

This is why an answer about a single helper can correctly mention the sibling file it mirrors, or the config layer it depends on — information that simply isn't in the snippet you're looking at.

### 7. You decide what gets retrieved

Most code assistants answer questions by guessing which parts of the codebase are relevant and pulling them in for you. CodeArchitect flips that around: **the piece you select is the unit of retrieval.** You point at what you care about, and you set how finely it's broken down with the same slider you use to look at it. Retrieval stops being a black box and becomes something you steer directly.

And you can go deeper without losing your place. By default a question is answered at the level of the piece you picked. Ask a follow-up and the system works out whether you're pushing for *more detail* on the same thing or asking something *new* — and if it's the former, it drills one level further into that piece's internals, reusing everything it already computed on the way down.

### 8. Why there's no vector database

This is the decision that's easiest to get wrong by following the crowd, so it's worth stating plainly.

The standard recipe for "chat with your code" is to chop everything into fragments, convert each into a vector, store them in a specialized database, and at question time search for the fragments most *similar* to the question. That's exactly the right tool **when you don't know where the answer is** and have to go find it.

Here, you *do* know — you pointed at it. The access pattern isn't "search the whole codebase for something like this"; it's "walk from this exact piece up to the root, reusing what I've already worked out." That's not similarity search, it's **exact-key lookup along a single path**. A vector database would be answering a question nobody asked — and it would bring real costs: an index to build, keep in sync, and host.

So CodeArchitect deliberately doesn't use one. (The honest caveat: vectors *would* earn their place the day this tool grows project-wide questions like "where is this function called?" — that genuinely is similarity-style retrieval. It just isn't what a structure-first, you-point-at-it tool needs today.)

### 9. A cache that never needs invalidating

Cache invalidation is famously one of the hardest problems in software — usually because you have to *remember to throw things away* when the underlying data changes, and the bugs live in the cases you forgot.

CodeArchitect sidesteps the problem instead of solving it. **Every cached result is keyed by a fingerprint of the exact code it describes.** Change a line, and that code gets a new fingerprint — so the next lookup asks for a key that doesn't exist yet, computes a fresh result, and stores it. The stale entry is never consulted again; it just sits there, harmlessly unreferenced. There is no invalidation logic to get wrong, because there is no invalidation.

And the storage itself is deliberately humble: a plain file on disk with a fast in-memory layer in front of it. **No database server, no Redis, nothing extra to run.** For a tool meant to start instantly on one person's machine, a background service would be weight without benefit. The same reasoning that ruled out the vector database rules out the daemon: match the machinery to the actual need.

### 10. Built to feel instant, and to be cheap to run

Performance here isn't an afterthought; several choices exist purely so the thing feels alive:

- **Dragging the slider never re-parses.** A file's structural skeleton is computed once and cached, so a drag only recomputes *which* pieces to show — the genuinely expensive work is already done.
- **Only what's on screen does layout work.** When panels slide or the view reshapes, off-screen code is skipped, so a 2,000-line file animates as smoothly as a 20-line one.
- **The answer's independent parts are computed at the same time**, and two questions that share context don't pay for it twice.
- **The whole interface is a single ~75 KB-gzipped bundle** — viewer, live re-chunking, and chat included — so first load is quick and interaction stays snappy.
- **Cheap model for the grunt work, capable model for the payoff.** The many small "what does this mean" passes use a fast, inexpensive model; the final answer you actually read uses the strongest one. Cost goes where it's visible.

### 11. One codebase, your laptop or the cloud

CodeArchitect runs two ways from the same code. On your machine, it reads whatever folder you point it at directly. Hosted on a server, that's impossible — a server can't reach the files on your computer — so the **browser** reads the folder you choose and sends just the source files up. Either way the experience is identical; only the path the files travel changes. The hosted version asks for nothing more than the code you decide to share.

### 12. No silent truncation

A principle that runs through the whole system: wherever there's a limit — a cap on file size, on how many files load, on how much code a single answer considers — it **tells you what it left out** rather than quietly trimming and pretending it saw everything. Honesty about the edges is part of being trustworthy about the middle.

---

## Quick start

```bash
npm install
npm install --prefix client

cp .env.example .env
#   ANTHROPIC_API_KEY=sk-ant-...   ← needed for the chat / Q&A features
#   PROJECT_DIR=/path/to/a/repo    ← optional; defaults to this repo

npm run dev
```

Open <http://localhost:5174>. Looking at the structure and dragging the slider needs no API key; the chat, folder summaries, and edit-by-conversation features do.

---

## Architecture at a glance

For anyone who wants to map the ideas above onto the code:

| Idea | Where it lives |
| --- | --- |
| Parse each language into a tree | `server/ingest/parseTree.js` (code), `json.js`, `genericTree.js` |
| The one shared chunking engine + stable identities | `server/ingest/frontier.js` |
| Roll folder/project structure up the tree | `server/ingest/projectTree.js` |
| Layered, reused meaning + question answering | `server/llm/meaning.js` |
| The self-invalidating meaning cache | `server/llm/cache.js` (parse-tree cache: `parseTree.js`) |
| API + background warm-up | `server/index.js`, `server/store.js` |
| The viewer, sliders, and chat | `client/src/` |

---

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/files` · `/api/files/:id/raw` | the active project's files and their source |
| GET | `/api/files/:id/chunks` | the pieces at a given zoom (`granularity`, `depthSpread`) or around a highlight (`rangeStart`/`rangeEnd`) |
| POST | `/api/files/:id/ask` | ask about a piece |
| POST | `/api/files/:id/suggest-edits` | edit by conversation |
| POST | `/api/folders/ask` | ask about a folder |
| GET/POST/DELETE | `/api/projects…` · `/api/projects/upload` | switch, add (by path or browser upload), or remove projects |

## Environment

| Var | Default | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | required for chat, edits, and folder summaries |
| `PROJECT_DIR` | this repo | the codebase to inspect (local runs) |
| `PORT` | `8799` | API port |
| `ANSWER_MODEL` / `MEANING_MODEL` | `claude-opus-4-8` | the model that writes answers and folds context |
| `BARE_MODEL` | `claude-haiku-4-5` | the fast model for the many small meaning passes |

The caches (`.tree-cache/`, `.meaning-cache/`) live in this repo, are gitignored, and rebuild themselves on demand — safe to delete anytime.

## Roadmap

- [x] Structure-aware chunking with a stable identity per piece
- [x] Layered, cached meanings that fold in folder and project context
- [x] Question answering you steer, per file and per folder
- [x] Edit by conversation, with history
- [ ] Auto-named pieces and files clustered into modules
- [ ] A navigable map of how the project's parts depend on each other
- [ ] Project-wide "where is this used?" retrieval (the one place vectors *would* earn their keep)
