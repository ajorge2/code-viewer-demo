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
import { recordCacheAccess, recordCacheSet } from '../benchmark/telemetry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/llm
const DIR = process.env.MEANING_CACHE_DIR
  ? path.resolve(process.env.MEANING_CACHE_DIR)
  : path.join(HERE, '..', '..', '.meaning-cache');
const FILE = path.join(DIR, 'meanings.jsonl');

const mem = new Map();
const kinds = new Map();
let loaded = false;

function inferredKind(key) {
  if (key.startsWith('cp:')) return 'ctxpeers';
  if (key.startsWith('c:dir:')) return 'dirctx';
  if (key.startsWith('c:')) return 'ctx';
  if (key.startsWith('b:')) return 'bare';
  return 'unknown';
}

// Lazy: read the whole log into the Map on first access (last write wins).
function load() {
  if (loaded) return;
  loaded = true;
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch { return; /* no cache yet */ }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.k) {
        mem.set(e.k, e.v);
        kinds.set(e.k, e.t || inferredKind(e.k));
      }
    } catch { /* skip torn line */ }
  }
}

export function cacheGet(key) {
  load();
  const value = mem.get(key);
  recordCacheAccess(kinds.get(key) || inferredKind(key), value !== undefined);
  return value;
}

// Best-effort persistence: the Map is authoritative for this process, so a disk
// failure degrades to in-memory rather than breaking the feature. `meta.fileHash`
// is stored (unused for now) to enable later GC of a changed file's dead entries.
export function cacheSet(key, value, meta = {}) {
  load();
  if (mem.get(key) === value) return;
  mem.set(key, value);
  kinds.set(key, meta.kind || inferredKind(key));
  recordCacheSet(meta.kind || inferredKind(key));
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
    for (const k of droppedKeys) {
      mem.delete(k);
      kinds.delete(k);
    }
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '');
    fs.renameSync(tmp, FILE);
  } catch { /* no file yet / IO error: nothing persisted to drop */ }
  return droppedKeys.size;
}

// Benchmark-only full reset. The runner always points MEANING_CACHE_DIR at a
// temporary directory, so this cannot erase the application's normal cache.
export function resetMeaningCacheForBenchmark() {
  if (process.env.CODEARCHITECT_BENCHMARK !== '1' || !process.env.MEANING_CACHE_DIR) {
    throw new Error('Benchmark cache reset requires CODEARCHITECT_BENCHMARK=1 and MEANING_CACHE_DIR.');
  }
  mem.clear();
  kinds.clear();
  loaded = true;
  try { fs.rmSync(FILE, { force: true }); } catch { /* no cache yet */ }
}
