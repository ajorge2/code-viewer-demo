// Two deliberately separate memo tables for the meaning recursion:
//   • basic summaries (`bare`, `barewindow`, `folderbare`) are content-addressed,
//     shared across users, and persisted to disk;
//   • focused summaries (`ctx`, `ctxpeers`, `dirctx`) depend on what one user has
//     explored, so they live only in that browser session's in-memory cache.
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
const FILE = path.join(DIR, 'basic-summaries.jsonl');
const LEGACY_FILE = path.join(DIR, 'meanings.jsonl');

const mem = new Map();
const kinds = new Map();
const focusedSessions = new Map(); // sessionId -> { values, kinds, fileHashes, touchedAt }
let loaded = false;
const FOCUSED_KINDS = new Set(['ctx', 'ctxpeers', 'dirctx']);
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SESSIONS = 100;

function inferredKind(key) {
  if (key.startsWith('cp:')) return 'ctxpeers';
  if (key.startsWith('c:dir:')) return 'dirctx';
  if (key.startsWith('c:')) return 'ctx';
  if (key.startsWith('b:')) return 'bare';
  return 'unknown';
}

const isFocusedKind = (kind) => FOCUSED_KINDS.has(kind);

function pruneFocusedSessions(now = Date.now()) {
  for (const [id, session] of focusedSessions) {
    if (now - session.touchedAt > SESSION_TTL_MS) focusedSessions.delete(id);
  }
  if (focusedSessions.size <= MAX_SESSIONS) return;
  const oldest = [...focusedSessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  for (let i = 0; i < oldest.length - MAX_SESSIONS; i++) focusedSessions.delete(oldest[i][0]);
}

function focusedSession(sessionId, create = false) {
  if (!sessionId) return null;
  pruneFocusedSessions();
  let session = focusedSessions.get(sessionId);
  if (!session && create) {
    session = { values: new Map(), kinds: new Map(), fileHashes: new Map(), touchedAt: Date.now() };
    focusedSessions.set(sessionId, session);
  }
  if (session) session.touchedAt = Date.now();
  return session;
}

// Lazy: read durable basics only. The legacy mixed log is accepted as a migration
// source, but its focused rows are intentionally ignored and never written again.
function load() {
  if (loaded) return;
  loaded = true;
  // Once the split cache exists, the old mixed file must not linger with historical
  // focused rows. Its durable basics were copied during the first migration.
  if (fs.existsSync(FILE) && fs.existsSync(LEGACY_FILE)) {
    try { fs.rmSync(LEGACY_FILE, { force: true }); } catch { /* best-effort scrub */ }
  }
  const usingLegacy = !fs.existsSync(FILE) && fs.existsSync(LEGACY_FILE);
  const source = usingLegacy ? LEGACY_FILE : FILE;
  let raw;
  try { raw = fs.readFileSync(source, 'utf8'); } catch { return; }
  const durableLines = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      const kind = e?.t || inferredKind(e?.k || '');
      if (e?.k && !isFocusedKind(kind)) {
        mem.set(e.k, e.v);
        kinds.set(e.k, kind);
        durableLines.push(JSON.stringify({ ...e, t: kind }));
      }
    } catch { /* skip torn line */ }
  }
  if (usingLegacy) {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(FILE, durableLines.length ? `${durableLines.join('\n')}\n` : '');
      fs.rmSync(LEGACY_FILE, { force: true });
    } catch { /* migration is best-effort; the in-memory cache still works */ }
  }
}

export function cacheGet(key, { sessionId } = {}) {
  let kind = inferredKind(key);
  let value;
  if (isFocusedKind(kind)) {
    const session = focusedSession(sessionId);
    value = session?.values.get(key);
    kind = session?.kinds.get(key) || kind;
  } else {
    load();
    value = mem.get(key);
    kind = kinds.get(key) || kind;
  }
  recordCacheAccess(kind, value !== undefined);
  return value;
}

// Best-effort persistence: the Map is authoritative for this process, so a disk
// failure degrades to in-memory rather than breaking the feature. `meta.fileHash`
// supports project-scoped invalidation in both cache lifecycles.
export function cacheSet(key, value, meta = {}) {
  const inferred = inferredKind(key);
  const kind = meta.kind || inferred;
  if (isFocusedKind(inferred) || isFocusedKind(kind)) {
    const focusedKind = isFocusedKind(kind) ? kind : inferred;
    const session = focusedSession(meta.sessionId, true);
    if (!session || session.values.get(key) === value) return;
    session.values.set(key, value);
    session.kinds.set(key, focusedKind);
    session.fileHashes.set(key, meta.fileHash);
    recordCacheSet(focusedKind);
    return;
  }
  load();
  if (mem.get(key) === value) return;
  mem.set(key, value);
  kinds.set(key, kind);
  recordCacheSet(kind);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, `${JSON.stringify({ k: key, v: value, f: meta.fileHash, t: kind })}\n`);
  } catch { /* keep serving from memory */ }
}

// Drop durable basic summaries belonging to a project (fileHash `f` in `hashSet`).
// Rewrites the JSONL without matching lines (temp + rename for atomicity) and deletes
// them from memory. Focused summaries use focusedCacheDropByFileHash instead.
export function cacheDropByFileHash(hashSet) {
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
      if (e && e.k && hashSet.has(e.f)) { droppedKeys.add(e.k); continue; }
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

// Drop focus-derived values only. With a session id, this is a user-session clear;
// without one, it is an integrity invalidation across all live sessions (used when
// changing the basic-summary window size).
export function focusedCacheDropByFileHash(hashSet, sessionId = null) {
  if (!hashSet || !hashSet.size) return 0;
  let dropped = 0;
  const sessions = sessionId
    ? [[sessionId, focusedSessions.get(sessionId)]]
    : [...focusedSessions.entries()];
  for (const [, session] of sessions) {
    if (!session) continue;
    for (const [key, fileHash] of session.fileHashes || []) {
      if (!hashSet.has(fileHash)) continue;
      session.values.delete(key);
      session.kinds.delete(key);
      session.fileHashes.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}

export function clearFocusedSession(sessionId) {
  const session = focusedSessions.get(sessionId);
  if (!session) return 0;
  const count = session.values.size;
  focusedSessions.delete(sessionId);
  return count;
}

// Benchmark-only full reset. The benchmark runner always points MEANING_CACHE_DIR
// at a temporary directory, so this cannot erase the app's normal cache by accident.
export function resetMeaningCacheForBenchmark() {
  if (process.env.CODEARCHITECT_BENCHMARK !== '1' || !process.env.MEANING_CACHE_DIR) {
    throw new Error('Benchmark cache reset requires CODEARCHITECT_BENCHMARK=1 and MEANING_CACHE_DIR.');
  }
  mem.clear();
  kinds.clear();
  focusedSessions.clear();
  loaded = true;
  try { fs.rmSync(FILE, { force: true }); } catch { /* no cache yet */ }
  try { fs.rmSync(LEGACY_FILE, { force: true }); } catch { /* no legacy cache */ }
}
