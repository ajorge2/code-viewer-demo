// Persistent memo table for the meaning recursion. Same philosophy as
// parseTree.js's tree cache: an in-memory Map in front, disk behind, no daemon —
// but one append-only JSONL file instead of a file-per-entry, since meanings are
// many and small (one per node, grown lazily by usage).
//
// Why append-only: a cache miss is the only time we write, writes are O(1)
// appends (crash-tolerant — a torn final line is just skipped on load), and the
// keys are content/identity hashes so a changed file produces new keys and the
// stale lines simply stop being read. Lives in this tool's repo, not the
// inspected project (like .tree-cache/).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/llm
const DIR = path.join(HERE, '..', '..', '.meaning-cache');
const FILE = path.join(DIR, 'meanings.jsonl');

const mem = new Map();
let loaded = false;

// Lazy: read the whole log into the Map on first access (last write wins).
function load() {
  if (loaded) return;
  loaded = true;
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch { return; /* no cache yet */ }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { const e = JSON.parse(line); if (e && e.k) mem.set(e.k, e.v); } catch { /* skip torn line */ }
  }
}

export function cacheGet(key) {
  load();
  return mem.get(key);
}

// Best-effort persistence: the Map is authoritative for this process, so a disk
// failure degrades to in-memory rather than breaking the feature. `meta.fileHash`
// is stored (unused for now) to enable later GC of a changed file's dead entries.
export function cacheSet(key, value, meta = {}) {
  load();
  if (mem.get(key) === value) return;
  mem.set(key, value);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, `${JSON.stringify({ k: key, v: value, f: meta.fileHash, t: meta.kind })}\n`);
  } catch { /* keep serving from memory */ }
}

// Drop cached entries belonging to a project (fileHash `f` in `hashSet`). `dropKinds`,
// if given, restricts the drop to those kinds (`t`) — so "clear cache" can wipe the
// contextual reads while keeping the bare summaries, while "close project" passes null
// to drop everything. Rewrites the JSONL without the matching lines (temp + rename for
// atomicity) and deletes them from memory. Returns how many distinct keys were dropped.
export function cacheDropByFileHash(hashSet, dropKinds = null) {
  load();
  if (!hashSet || !hashSet.size) return 0;
  const droppedKeys = new Set();
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const kept = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { kept.push(line); continue; }
      if (e && e.k && hashSet.has(e.f) && (!dropKinds || dropKinds.has(e.t))) { droppedKeys.add(e.k); continue; }
      kept.push(line);
    }
    for (const k of droppedKeys) mem.delete(k);
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '');
    fs.renameSync(tmp, FILE);
  } catch { /* no file yet / IO error: nothing persisted to drop */ }
  return droppedKeys.size;
}
