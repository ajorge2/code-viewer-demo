// In-memory project registry. Several projects can be registered (by absolute
// path); their file text is loaded lazily and only the few most-recently-used
// stay resident (LRU) to bound memory. Chunking is still computed on demand from
// the cached text. One project is "active" at a time; the file endpoints operate
// on it, so the existing single-project client keeps working unchanged.
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import {
  walkProject, readSourceFile, languageFor, isSourceFile, SKIP_DIRS,
  MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES,
} from './ingest/code.js';

const MAX_RESIDENT = 3;   // projects kept resident in memory at once (LRU)
const MAX_PROJECTS = 50;  // registry cap (metadata only; cheap)

// Per-project bare-window size: the char budget above which a unit's bare summary
// is computed by map-reduce over windows instead of one call (see meaning.js). Set
// via the active project's tab slider; in-memory (resets on restart). Env override
// is the default for new projects / the sample.
const DEFAULT_BARE_WINDOW = Number(process.env.BARE_WINDOW_CHARS) || 48000;
const BARE_WINDOW_MIN = 4000;
const BARE_WINDOW_MAX = 200000;

const EMPTY_SCAN = {
  count: 0, skipped: 0, totalBytes: 0,
  truncatedByCount: false, truncatedByBytes: false, truncatedByClient: false,
};

// projectId -> { id, absPath, name, files: Map|null, scan, lastUsed }
//   files === null  ⇒  registered but evicted (re-scan on activate)
const projects = new Map();
let activeId = null;

// Stable, deterministic id from the absolute path (slug + short hash so distinct
// paths that slugify the same don't collide; stable across sessions for use as a
// client-side localStorage namespace).
function makeProjectId(absPath) {
  const slug = (path.basename(absPath).replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '').toLowerCase()) || 'root';
  const hash = crypto.createHash('sha1').update(absPath).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

// File id within a project (unique per project; requests are project-scoped).
// Line count without allocating an array of every line (which split('\n') would).
// Equals split('\n').length: newline count + 1.
function countLines(s) {
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function makeFileId(relPath) {
  return relPath.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

// Scan a directory into a fresh files Map, honoring the ingest caps and
// recording what was skipped/truncated (no silent caps).
async function scanInto(absPath) {
  const files = new Map();
  const rels = await walkProject(absPath);
  const truncatedByCount = rels.length >= MAX_FILES;
  let skipped = 0;
  let totalBytes = 0;
  let truncatedByBytes = false;
  for (const rel of rels) {
    const abs = path.join(absPath, rel);
    const content = await readSourceFile(abs); // null = too large / vanished
    if (content == null) { skipped++; continue; }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (totalBytes + bytes > MAX_TOTAL_BYTES) { truncatedByBytes = true; break; }
    totalBytes += bytes;
    const id = makeFileId(rel);
    files.set(id, {
      id,
      relPath: rel,
      absPath: abs,
      language: languageFor(rel),
      content,
      lineCount: countLines(content),
      bytes,
    });
  }
  return { files, scan: { count: files.size, skipped, totalBytes, truncatedByCount, truncatedByBytes } };
}

// Build a files Map from uploaded { relPath, content } entries (a browser folder
// upload), honoring the same caps as a disk scan. Used by hosted deploys where the
// server can't read the user's filesystem.
function buildFilesFromUpload(entries, clientScan = {}) {
  const files = new Map();
  let skipped = 0;
  let totalBytes = 0;
  let truncatedByBytes = false;
  const list = Array.isArray(entries) ? entries.slice(0, MAX_FILES) : [];
  const truncatedByCount = Array.isArray(entries) && entries.length > MAX_FILES;
  for (const e of list) {
    const relPath = e && typeof e.relPath === 'string' ? e.relPath : null;
    const content = e && typeof e.content === 'string' ? e.content : null;
    // Defensive: re-apply the ignored-dir + source-file + size filters server-side
    // too (the client already filters, but never trust the upload).
    if (!relPath || content == null) { skipped++; continue; }
    const segs = relPath.split('/');
    if (segs.some((s) => SKIP_DIRS.has(s)) || !isSourceFile(segs[segs.length - 1])) { skipped++; continue; }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) { skipped++; continue; }
    if (totalBytes + bytes > MAX_TOTAL_BYTES) { truncatedByBytes = true; break; }
    totalBytes += bytes;
    const id = makeFileId(relPath);
    files.set(id, {
      id, relPath, absPath: null, language: languageFor(relPath),
      content, lineCount: countLines(content), bytes,
    });
  }
  return {
    files,
    scan: {
      count: files.size,
      skipped,
      totalBytes,
      truncatedByCount,
      truncatedByBytes,
      truncatedByClient: clientScan?.truncated === true,
    },
  };
}

// Drop resident text from the least-recently-used projects beyond MAX_RESIDENT.
// Never evicts the active project. Registry metadata is retained.
function evictLRU() {
  const resident = [...projects.values()].filter((p) => p.files);
  let over = resident.length - MAX_RESIDENT;
  if (over <= 0) return;
  const victims = resident
    // Uploaded projects live only in memory (no disk to re-scan), so never evict
    // their text — evicting would lose them.
    .filter((p) => p.id !== activeId && !p.uploaded)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  for (const p of victims) {
    if (over <= 0) break;
    p.files = null;
    over--;
  }
}

// Drop oldest *registered* (non-active) projects beyond MAX_PROJECTS.
function enforceRegistryCap() {
  let over = projects.size - MAX_PROJECTS;
  if (over <= 0) return;
  const victims = [...projects.values()]
    .filter((p) => p.id !== activeId)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  for (const p of victims) {
    if (over <= 0) break;
    projects.delete(p.id);
    over--;
  }
}

function projectMeta(p) {
  return {
    id: p.id,
    name: p.name,
    absPath: p.absPath,
    active: p.id === activeId,
    resident: !!p.files,
    fileCount: p.files ? p.files.size : (p.scan ? p.scan.count : null),
    lastUsed: p.lastUsed,
    scan: p.scan,
    bareWindow: p.bareWindow ?? DEFAULT_BARE_WINDOW,
  };
}

// Register a project by path (and make it active). Idempotent per absolute path.
export async function registerProject(inputPath) {
  const absPath = path.resolve(inputPath);
  const stat = await fs.stat(absPath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    const e = new Error(`Not a directory: ${absPath}`);
    e.status = 400;
    throw e;
  }
  const id = makeProjectId(absPath);
  if (!projects.has(id)) {
    projects.set(id, { id, absPath, name: path.basename(absPath) || absPath, files: null, scan: null, lastUsed: 0, bareWindow: DEFAULT_BARE_WINDOW });
    enforceRegistryCap();
  }
  return activateProject(id);
}

// Register a project from uploaded file contents (a browser folder upload) and
// make it active. No disk involved — the text is held in memory. The id is a
// content fingerprint so re-uploading the same folder reuses its localStorage
// namespace (chunk-size overrides survive).
export function registerUploadedProject(name, entries, clientScan = {}) {
  const safeName = (typeof name === 'string' && name.trim()) || 'uploaded-project';
  const { files, scan } = buildFilesFromUpload(entries, clientScan);
  const fp = crypto.createHash('sha1')
    .update(`${safeName}|${[...files.values()].map((f) => `${f.relPath}:${f.bytes}`).join('|')}`)
    .digest('hex').slice(0, 8);
  const slug = safeName.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'project';
  const id = `upload-${slug}-${fp}`;
  projects.set(id, { id, absPath: safeName, name: safeName, files, scan, lastUsed: Date.now(), uploaded: true, bareWindow: DEFAULT_BARE_WINDOW });
  enforceRegistryCap();
  activeId = id;
  evictLRU();
  return projectMeta(projects.get(id));
}

// Make a registered project active, (re)scanning it if it was evicted.
export async function activateProject(id) {
  const p = projects.get(id);
  if (!p) {
    const e = new Error(`Unknown project: ${id}`);
    e.status = 404;
    throw e;
  }
  if (!p.files) {
    if (p.uploaded) {
      const e = new Error('Uploaded project is no longer in memory — re-upload the folder.');
      e.status = 410;
      throw e;
    }
    const { files, scan } = await scanInto(p.absPath);
    p.files = files;
    p.scan = scan;
  }
  activeId = id;
  p.lastUsed = Date.now();
  evictLRU();
  return projectMeta(p);
}

// Remove a project from the registry. If it was active, the active project
// becomes the most-recently-used remaining one (or null).
export function removeProject(id) {
  if (!projects.has(id)) return false;
  projects.delete(id);
  if (activeId === id) {
    const next = [...projects.values()].sort((a, b) => b.lastUsed - a.lastUsed)[0];
    activeId = next ? next.id : null;
  }
  return true;
}

export function listProjects() {
  return [...projects.values()].map(projectMeta).sort((a, b) => b.lastUsed - a.lastUsed);
}

// ── Built-in sample file (for the help / demo page) ──────────────────────────
// Always available, independent of the active project, so the demo page works even
// before any project is loaded. Served through the normal file endpoints via the
// getFile() fallback below.
const SAMPLE_RELPATH = 'sample/rate-limiter.js';
const SAMPLE_CONTENT = `// A tiny in-memory rate limiter — a friendly file to explore how CodeArchitect
// chunks code. Drag the granularity slider and the whole file, the class, each
// method, and the nested blocks each become selectable units.

const now = () => Date.now();

class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;       // max calls allowed per window
    this.windowMs = windowMs; // sliding window length, in ms
    this.hits = new Map();    // key -> array of call timestamps
  }

  // Drop timestamps older than the window so the map never grows unbounded.
  prune(key) {
    const cutoff = now() - this.windowMs;
    const kept = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (kept.length) this.hits.set(key, kept);
    else this.hits.delete(key);
  }

  // Record a call and report whether it's allowed (false once over the limit).
  allow(key) {
    this.prune(key);
    const times = this.hits.get(key) || [];
    if (times.length >= this.limit) return false;
    times.push(now());
    this.hits.set(key, times);
    return true;
  }

  // How many calls remain for \`key\` in the current window.
  remaining(key) {
    this.prune(key);
    return Math.max(0, this.limit - (this.hits.get(key)?.length || 0));
  }
}

function demo() {
  const limiter = new RateLimiter(3, 1000);
  for (let i = 0; i < 5; i++) {
    const ok = limiter.allow('alice');
    console.log(\`call \${i}: \${ok ? 'allowed' : 'blocked'} (\${limiter.remaining('alice')} left)\`);
  }
}

demo();
`;
const SAMPLE_ID = makeFileId(SAMPLE_RELPATH);
const sampleFile = {
  id: SAMPLE_ID, relPath: SAMPLE_RELPATH, absPath: null,
  language: languageFor(SAMPLE_RELPATH),
  content: SAMPLE_CONTENT,
  lineCount: countLines(SAMPLE_CONTENT),
  bytes: Buffer.byteLength(SAMPLE_CONTENT),
};
const samples = new Map([[SAMPLE_ID, sampleFile]]);

export function sampleFileMeta() {
  return { id: sampleFile.id, relPath: sampleFile.relPath, language: sampleFile.language };
}

// ── Active-project accessors (used by the existing file endpoints) ───────────
function active() {
  return activeId ? projects.get(activeId) : null;
}

// Falls back to the built-in sample so the demo page's file resolves regardless of
// which (if any) project is active.
export function getFile(fileId) {
  return active()?.files?.get(fileId) || samples.get(fileId);
}

export function listFiles() {
  const p = active();
  if (!p?.files) return [];
  return [...p.files.values()]
    .map((f) => ({ id: f.id, relPath: f.relPath, language: f.language, lineCount: f.lineCount, bytes: f.bytes }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

export function fileCount() {
  const p = active();
  return p?.files ? p.files.size : 0;
}

export function getScanStats() {
  return active()?.scan ?? EMPTY_SCAN;
}

export function activeProjectDir() {
  return active()?.absPath ?? null;
}

export function activeProjectId() {
  return activeId;
}

// Per-project bare-window size (chars). Unknown/sample → the default.
export function getBareWindow(id) {
  return projects.get(id)?.bareWindow ?? DEFAULT_BARE_WINDOW;
}

// Set + clamp a project's bare-window size; returns the clamped value (or null if
// the project doesn't exist).
export function setBareWindow(id, chars) {
  const p = projects.get(id);
  if (!p) return null;
  const n = Math.round(Number(chars));
  p.bareWindow = Number.isFinite(n) ? Math.max(BARE_WINDOW_MIN, Math.min(BARE_WINDOW_MAX, n)) : DEFAULT_BARE_WINDOW;
  return p.bareWindow;
}

// A project's resident files as { relPath, content } (null if not resident). Used to
// re-warm and to compute its cache-invalidation hash set on a window-size change.
export function getProjectFiles(id) {
  const p = projects.get(id);
  if (!p?.files) return null;
  return [...p.files.values()].map((f) => ({ relPath: f.relPath, content: f.content }));
}

// Backward-compatible startup loader: register + activate the initial dir.
export async function loadProject(projectDir) {
  await registerProject(projectDir);
  return getScanStats();
}
