# From a highlight to a chunk (and its one chunk path)

This explains two things: how highlighting a stretch of code turns into a single
chunk, and why that chunk has exactly **one** "chunk path" through the file's
structure. The relevant code lives in `server/ingest/frontier.js` (the chunking
engine) and `server/ingest/tree.js` (the path helpers).

## The box tree comes first

Before any highlight happens, the file is parsed into a **box tree**. A box is a
node with a character span and some children:

```
{ start, end, depth, label, kind: 'container' | 'leaf', children }
```

The root box is the whole file. Its children are the file's top-level units
(imports, a class, a function), each of those splits into its own members, and so
on down to individual tokens. `buildTree` (frontier.js) takes the raw parse and
does three things to it, once per file:

1. **Balance** — cap each node's branching to two children (`MAX_BRANCH = 2`).
   A node with 40 statements becomes a small binary sub-tree of synthetic
   "grouping" boxes instead of one 40-way fan-out. These grouping boxes are
   marked `semantic: false` so they're scaffolding, not real units.
2. **Set depth** — number every node by how deep it sits.
3. **Assign identity** — give every box a stable `id` and `hash`.

The key property: this tree is a pure function of the file's text and parse
shape. The granularity/depth sliders and the highlight **never reshape it** —
they only pick a different *cut* through the same fixed tree. That's what makes
the ids stable across every chunking of the file.

## What a highlight does

When you highlight code, the client sends the raw character range to the chunks
endpoint, which calls `cutTree(text, builtTree, { around: { start, end } })`.
That takes the **highlight branch** in `cutTree`, which does exactly one thing:

```js
const target = tightestBox(root, around.start, around.end)
return { chunks: [ /* just this one box */ ], nodes: collectNodes([target]), targetNodeId: target.id }
```

No granularity, no depth spread, no surrounding chunks. The highlight only ever
needs its own box — the answer is about that box alone — so the rest of the file
is left unchunked on purpose.

### `tightestBox`: a single walk down

`tightestBox` finds the **smallest box that fully contains the highlighted
range** by walking down from the root:

```js
let target = root
while (target.children && target.children.length) {
  const next = target.children.find((c) => c.start <= s && c.end >= e)
  if (!next) break          // no child contains the range → we've found it
  target = next             // descend into the one child that does
}
return target
```

A box contains the range `[s, e)` when `box.start <= s && box.end >= e`. At each
level the walk asks: does any single child fully contain the range? If yes,
descend into that child. If no — because the range straddles the gap between two
children — the current box is the tightest fit and the walk stops.

(Two guards run first: a collapsed caret is widened to a 1-char range so
containment still holds, and the range is clamped inside the file so it can't
point past the root.)

## Why there's exactly one chunk, and one path

The walk down is **deterministic and never branches**, for one reason: a box's
children are contiguous and non-overlapping (coverage splits the file into
side-by-side spans). A range can be fully contained by **at most one** child —
if it spanned two children it would cross the gap between them, and then *no*
child contains it and the walk stops at the parent. So `find` returns one child
or none, never a choice. The descent traces a single line from the root straight
down to the target box.

That single line **is** the chunk path:

```
root → … → grandparent → parent → target
```

Every box on it is the target's ancestry, and the target sits at exactly one spot
in the tree, so there is one and only one root-to-target path. Nothing about a
chunk's path depends on the highlight, the sliders, or how the box was reached —
it's fixed by where the box lives in the tree.

### The path is baked into the id

This isn't just true in practice; it's encoded in the identity. `assignIdentity`
builds each box's id from its parent's id plus its own span:

```js
node.id = shortHash(`${parentId}:${node.start}:${node.end}`)
```

Because `parentId` is itself `hash(grandparentId : … )`, the id is a rolling hash
of the **entire chain** from the root down. Two boxes with the same span but
different ancestors get different ids. So a `nodeId` doesn't just name a box — it
names a box *at one specific path*. That's why the same `nodeId` refers to the
same chunk under any granularity setting, and why the meaning cache can key on it.

### Reconstructing the path

`collectNodes([target])` walks the chosen box up to the root via `parent`
back-pointers, recording each ancestor once, so the client receives the target
plus its full ancestry — the minimal slice of the tree needed to redraw that one
path.

For display and for prompts, `semanticPath` (tree.js) walks the same chain but
skips the synthetic grouping boxes, leaving the human-meaningful breadcrumb:

```
ClassName › methodName › if-block
```

## Why one path matters downstream

The single path is also what the RAG meaning engine folds along
(`server/llm/meaning.js`). A chunk's "meaning in context" is built by combining
its own isolated meaning with its parent's contextual meaning, recursing **up the
chunk path** to the file root (and on into the folder chain). Because the path is
unique and fixed, that fold is well-defined and its intermediate results — one
per box on the path — are cached and shared by every other chunk that passes
through the same ancestor. One highlight, one box, one path, one chain of context
to fold.
