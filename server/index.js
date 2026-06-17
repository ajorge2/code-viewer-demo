import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';

import {
  loadProject, listFiles, getFile, fileCount, getScanStats,
  registerProject, registerUploadedProject, activateProject, removeProject, listProjects,
  activeProjectDir, activeProjectId, sampleFileMeta,
  getBareWindow, setBareWindow, getProjectFiles,
} from './store.js';
import { chunkByLines, languageFor } from './ingest/code.js';
import { chunkJson } from './ingest/json.js';
import { chunkCode } from './ingest/codeTree.js';
import { chunkGeneric } from './ingest/genericTree.js';
import { isParseable, loadTree, clearTreeCache, treeCacheKey, clearTreeCacheForKeys } from './ingest/parseTree.js';
import { setProjectTree, getProjectTree, buildProjectTree } from './ingest/projectTree.js';
import { ask, askFolder, suggestEdits, warmProjectBares, fileFrontier, frontierChunks, projectCacheHashes } from './llm/meaning.js';
import { cacheDropByFileHash } from './llm/cache.js';
import { findReferences } from './ingest/references.js';

// Build the active project's folder tree and kick off the eager bottom-up bare
// pass in the BACKGROUND (don't block the response on thousands of model calls).
// Idempotent — re-runs hit the content-addressed cache. No-ops without an API key.
function warmActiveProject() {
  try {
    const files = listFiles()
      .map((f) => getFile(f.id))
      .filter(Boolean)
      .map((f) => ({ relPath: f.relPath, content: f.content }));
    const name = (activeProjectDir() || '').split('/').filter(Boolean).pop() || '(project)';
    setProjectTree(name, files);
    warmProjectBares(files, getBareWindow(activeProjectId())).catch(() => {}); // detached
  } catch { /* non-fatal: questions still work via lazy compute */ }
}

// Meaning-cache kinds: the bare summaries (expensive building blocks) vs. the
// contextual reads folded off them. "Clear cache" drops the contextual reads + parse
// trees but keeps bares; closing a project drops everything.
const CTX_KINDS = new Set(['ctx', 'ctxpeers', 'dirctx']);

// Clear a project's cached analysis. Two modes:
//   • full=false ("clear cache") — drop ONLY the per-chunk in-context summaries (the
//     contextual reads). The parse trees and bare summaries stay; they're the durable,
//     expensive building blocks and only the contextual fold is re-derived (on next ask).
//   • full=true (closing the project) — also drop the parse trees AND every bare.
// `tree` supplies the folder tree the cache hashes derive from: the active project's
// (getProjectTree) or a background one rebuilt via buildProjectTree.
function clearProjectAnalysis(files, tree, { full }) {
  if (!files || !files.length) return { trees: 0, meanings: 0 };
  let trees = 0;
  if (full) {
    const treeKeys = new Set();
    for (const f of files) {
      const lang = languageFor(f.relPath);
      if (isParseable(lang)) treeKeys.add(treeCacheKey(f.content, lang));
    }
    trees = clearTreeCacheForKeys(treeKeys);
  }
  const meanings = cacheDropByFileHash(projectCacheHashes(files, tree), full ? null : CTX_KINDS);
  return { trees, meanings };
}

// Tree is parsed at most once ever (memoized + persisted to .tree-cache/),
// so slider moves and server restarts both reuse it. See parseTree.js.
async function getTree(file) {
  return loadTree(file.content, languageFor(file.relPath));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8799;

// The codebase to inspect. Defaults to this tool's own repo (zero-config,
// self-demoing); override with PROJECT_DIR=/path/to/your/project.
const PROJECT_DIR = path.resolve(process.env.PROJECT_DIR || path.join(__dirname, '..'));

const app = express();
app.use(cors());
// Folder uploads (browser-picked projects) post all file contents in one body, so
// allow a generous limit; per-file and total caps are enforced during ingest.
app.use(express.json({ limit: '50mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, projectDir: activeProjectDir(), files: fileCount(), scan: getScanStats() });
});

// Metadata for the built-in sample file used by the help/demo page. The file
// content + chunks come through the normal /api/files/:id endpoints (getFile
// resolves the sample regardless of the active project).
app.get('/api/sample', (req, res) => {
  res.json({ file: sampleFileMeta() });
});

// File tree / list (metadata only) for the active project. `scan` reports
// anything skipped/truncated by the ingest caps so the UI can warn rather than
// silently under-report.
app.get('/api/files', (req, res) => {
  res.json({
    projectDir: activeProjectDir(),
    projectId: activeProjectId(),
    files: listFiles(),
    scan: getScanStats(),
  });
});

// "Clear cache" for the ACTIVE project: drop ONLY the per-chunk in-context summaries
// (the contextual reads answers are built from). The parse trees and the bare summaries
// stay — they're the durable building blocks. The next question just re-folds context
// off the kept bares. Parse + bares are wiped only when the project is closed (the ×
// handler below) or its window size changes.
app.delete('/api/tree-cache', (req, res) => {
  const id = activeProjectId();
  const files = id ? getProjectFiles(id) : null;
  if (!files) return res.json({ ok: true, trees: 0, meanings: 0 });
  res.json({ ok: true, ...clearProjectAnalysis(files, getProjectTree(), { full: false }) });
});

// ── Project registry ────────────────────────────────────────────────────────
// List registered projects (active flag, resident flag, file counts).
app.get('/api/projects', (req, res) => {
  res.json({ activeId: activeProjectId(), projects: listProjects() });
});

// Register (and activate) a project by absolute/relative local path.
app.post('/api/projects', async (req, res) => {
  const inputPath = (req.body && req.body.path) || '';
  if (!inputPath.trim()) return res.status(400).json({ error: 'Missing "path".' });
  try {
    const project = await registerProject(inputPath);
    warmActiveProject();
    res.json({ project, activeId: activeProjectId(), projects: listProjects() });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Register (and activate) a project from an uploaded folder. The browser reads the
// user's chosen directory and posts { name, files: [{ relPath, content }] }; the
// server holds it in memory. This is how hosted deploys load a user's local code —
// the server can't reach their filesystem, so the browser brings it the files.
app.post('/api/projects/upload', (req, res) => {
  const { name, files } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'No files in the uploaded folder.' });
  }
  try {
    const project = registerUploadedProject(name, files);
    warmActiveProject();
    res.json({ project, activeId: activeProjectId(), projects: listProjects() });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Failed to load uploaded folder' });
  }
});

// Switch the active project (re-scans if it was evicted from memory).
app.post('/api/projects/:id/activate', async (req, res) => {
  try {
    const project = await activateProject(req.params.id);
    warmActiveProject();
    res.json({ project, activeId: activeProjectId(), projects: listProjects() });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Unregister a project. Closing it fully wipes its cache — parse trees AND every bare
// summary — since they're no longer needed. Works for a background project too: its
// cache hashes derive from its folder tree, which we rebuild from its files (hashes are
// name-independent) when it isn't the active one. (An evicted project whose files aren't
// resident can't be hashed; its content-addressed entries age out, harmless and reused.)
app.delete('/api/projects/:id', (req, res) => {
  const id = req.params.id;
  const files = getProjectFiles(id);
  if (files) {
    const tree = id === activeProjectId() ? getProjectTree() : buildProjectTree('', files);
    clearProjectAnalysis(files, tree, { full: true });
  }
  const ok = removeProject(id);
  if (!ok) return res.status(404).json({ error: 'Unknown project.' });
  res.json({ activeId: activeProjectId(), projects: listProjects() });
});

// Set a project's bare-window size (the char budget above which a unit's summary is
// computed by map-reduce over windows). Resets that project's meaning cache — the
// per-node summaries it folds were built at the old size — then re-warms in the
// background. Operates on the active project (the slider lives on the active tab).
app.put('/api/projects/:id/bare-window', (req, res) => {
  const { id } = req.params;
  if (id !== activeProjectId()) {
    return res.status(409).json({ error: 'Switch to this project before changing its window size.' });
  }
  const chars = Number((req.body || {}).chars);
  if (!Number.isFinite(chars)) return res.status(400).json({ error: 'chars (a number) is required' });
  const applied = setBareWindow(id, chars);
  if (applied == null) return res.status(404).json({ error: 'Unknown project.' });
  const files = getProjectFiles(id) || [];
  const dropped = cacheDropByFileHash(projectCacheHashes(files));
  warmProjectBares(files.map((f) => ({ relPath: f.relPath, content: f.content })), applied).catch(() => {}); // detached re-warm
  res.json({ ok: true, bareWindow: applied, dropped, projects: listProjects() });
});

// Raw source text for the viewer to render.
app.get('/api/files/:id/raw', (req, res) => {
  const file = getFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(file.content);
});

// Chunk boundaries for a file at a given size. The slider drives `size`
// (and optional `overlap`); this re-chunks the cached text on demand.
app.get('/api/files/:id/chunks', async (req, res) => {
  const file = getFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });
  const lang = languageFor(file.relPath);

  // Two chunking modes:
  //   • highlight mode — `rangeStart`/`rangeEnd` given: chunk around that range
  //     (fewest chunks isolating the tightest-fit box). granularity/depth ignored.
  //   • manual mode — granularity + depthSpread (the Advanced sliders).
  const granularity = clampInt(req.query.granularity, 1, 1000000, 1);
  const depthSpread = clampInt(req.query.depthSpread, 0, 50, 0);
  const hasRange = req.query.rangeStart != null && req.query.rangeEnd != null;
  const around = hasRange
    ? {
      start: clampInt(req.query.rangeStart, 0, file.content.length, 0),
      end: clampInt(req.query.rangeEnd, 0, file.content.length, 0),
    }
    : null;
  const opts = around ? { around } : { granularity, depthSpread };
  const meta = { fileId: file.id, relPath: file.relPath, granularity, depthSpread };

  // Highlight mode → the marks-driven minimal frontier (the current ctx distribution),
  // with the highlight's tightest box as the target. The whole distribution is returned
  // so the viewer band-highlights and counts it; it refines as more questions are asked.
  if (around) {
    try {
      return res.json({ ...meta, ...(await frontierChunks(file, around)) });
    } catch (e) {
      // Frontier build failed → fall through to structural chunking below.
    }
  }

  // JSON files chunk structurally (hand-rolled key/value box model).
  if (lang === 'json') {
    try {
      const { maxBoxes, chunks, nodes, targetNodeId } = chunkJson(file.content, opts);
      return res.json({ kind: 'json', ...meta, maxBoxes, targetNodeId, chunkCount: chunks.length, chunks, nodes });
    } catch (e) {
      // Malformed JSON → fall back to line chunking below.
    }
  }

  // Other code/markup with a tree-sitter grammar → structural (CST) chunking,
  // down to operand/token level. Falls through to lines if parsing fails.
  if (lang && lang !== 'json' && isParseable(lang)) {
    try {
      const tree = await getTree(file);
      if (tree) {
        const { maxBoxes, chunks, nodes, targetNodeId } = chunkCode(file.content, tree, opts);
        return res.json({ kind: 'code', ...meta, maxBoxes, targetNodeId, chunkCount: chunks.length, chunks, nodes });
      }
    } catch (e) {
      // Parse failure → fall back to line chunking below.
    }
  }

  // No grammar (yaml, sql, r, markdown, plain text, …) → generic structural
  // chunking from indentation + brackets + separators, so every file still gets
  // a real component hierarchy (not flat lines).
  {
    const { maxBoxes, chunks, nodes, targetNodeId } = chunkGeneric(file.content, opts);
    res.json({ kind: 'generic', ...meta, maxBoxes, targetNodeId, chunkCount: chunks.length, chunks, nodes });
  }
});

// Debug / demo: the file's current highlight-derived marks and the minimal
// frontier they produce. Read-only, no LLM calls — used to verify the
// frontier-peers context and to drive the demo visualization.
app.get('/api/files/:id/frontier', async (req, res) => {
  const file = getFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });
  try {
    res.json(await fileFrontier(file));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Failed to derive frontier' });
  }
});

// Find references: where a code symbol (named in a chat answer) is defined/used across
// the whole active project. Search-based (tree-sitter identifier match + text fallback),
// like IDE/GitHub code navigation without a language server. `from` orders the origin file first.
app.get('/api/references', async (req, res) => {
  const name = (req.query.name || '').toString();
  const fromId = req.query.from ? req.query.from.toString() : null;
  if (!name || name.length < 2) return res.status(400).json({ error: 'name (2+ chars) is required' });
  try {
    const files = listFiles().map((f) => {
      const file = getFile(f.id);
      return { id: f.id, relPath: f.relPath, content: file?.content ?? '', language: f.language };
    });
    res.json(await findReferences(name, files, fromId));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Failed to find references' });
  }
});

// RAG Q&A: answer a question about a selected chunk. The chunk is referenced by
// its stable `nodeId` (from the chunks endpoint), so the server reconstructs the
// node + its ancestor chain from file content alone — no chunking params needed.
app.post('/api/files/:id/ask', async (req, res) => {
  const file = getFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });
  const { nodeId, question, depth, intent, transcript, contextFileId, focus, highlight } = req.body || {};
  if (!nodeId || !question || !String(question).trim()) {
    return res.status(400).json({ error: 'nodeId and a non-empty question are required' });
  }
  try {
    const ctx = contextFileId ? getFile(contextFileId) : null;
    const result = await ask({
      file,
      nodeId,
      question: String(question),
      depth: Number.isFinite(depth) ? depth : 0,
      intent: intent === 'deepen' ? 'deepen' : 'infer',
      transcript: Array.isArray(transcript) ? transcript.slice(-6) : [],
      contextFile: ctx ? { relPath: ctx.relPath, content: ctx.content } : null,
      bareWindow: getBareWindow(activeProjectId()),
      focus: typeof focus === 'string' ? focus : '',
      highlight: typeof highlight === 'string' ? highlight : '',
    });
    res.json(result); // { answer, meaning, path, depth, atBottom, maxDepth }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Failed to answer' });
  }
});

// Propose edits to a chunk's code, driven by the Q&A conversation. Returns the
// full revised code for the unit so the client can drop it into the editor.
app.post('/api/files/:id/suggest-edits', async (req, res) => {
  const file = getFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });
  const { nodeId, instruction, transcript, baseCode, contextFileId } = req.body || {};
  if (!nodeId) return res.status(400).json({ error: 'nodeId is required' });
  try {
    const ctx = contextFileId ? getFile(contextFileId) : null;
    const result = await suggestEdits({
      file,
      nodeId,
      instruction: typeof instruction === 'string' ? instruction : '',
      transcript: Array.isArray(transcript) ? transcript.slice(-6) : [],
      baseCode: typeof baseCode === 'string' ? baseCode : '',
      contextFile: ctx ? { relPath: ctx.relPath, content: ctx.content } : null,
      bareWindow: getBareWindow(activeProjectId()),
    });
    res.json(result); // { code, original, path }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Failed to suggest edits' });
  }
});

// RAG Q&A about a FOLDER (the current directory in the file browser). `dirPath`
// is relative to the project root ('' = root). Uses the folder's eager bare +
// folded folder context, plus its direct contents.
app.post('/api/folders/ask', async (req, res) => {
  const { dirPath, question, transcript, contextFileId } = req.body || {};
  if (!question || !String(question).trim()) {
    return res.status(400).json({ error: 'A non-empty question is required' });
  }
  try {
    const ctx = contextFileId ? getFile(contextFileId) : null;
    const result = await askFolder({
      dirPath: typeof dirPath === 'string' ? dirPath : '',
      question: String(question),
      transcript: Array.isArray(transcript) ? transcript.slice(-6) : [],
      contextFile: ctx ? { relPath: ctx.relPath, content: ctx.content } : null,
    });
    res.json(result); // { answer, summary, path }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Failed to answer' });
  }
});

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// ── Static client (production) ────────────────────────────────────────────────
// When the client has been built (client/dist exists — e.g. in the Docker image),
// serve it from the same origin and SPA-fallback non-API GETs to index.html. In
// local dev this dir doesn't exist, so Vite serves the client and proxies /api here.
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  // Vite emits content-hashed files under /assets — the name changes whenever the
  // content does, so they're safe to cache forever. index.html is NOT hashed, so it
  // must be revalidated on every load; otherwise after a deploy the browser keeps an
  // old index.html that points at asset hashes the new build no longer has, and the
  // page renders blank until a hard refresh.
  app.use(express.static(clientDist, {
    index: false, // let "/" fall through to the no-cache index.html handler below
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    // A path with a file extension is a missing static asset (e.g. a stale
    // index-OLDHASH.js after a redeploy). 404 it rather than returning index.html,
    // so the browser fails loudly instead of trying to run HTML as a script.
    if (path.extname(req.path)) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.listen(PORT, async () => {
  console.log(`\n  Code Viewer API  →  http://localhost:${PORT}`);
  console.log(`  Project: ${PROJECT_DIR}`);
  console.log('  Scanning source files …');
  const s = await loadProject(PROJECT_DIR);
  warmActiveProject(); // build folder tree + background eager bare pass
  console.log(`  ${s.count} source file(s) ready (${(s.totalBytes / 1e6).toFixed(1)} MB).`);
  if (s.skipped) console.log(`  ⚠ ${s.skipped} file(s) skipped (too large, >1 MB).`);
  if (s.truncatedByCount) console.log('  ⚠ File-count cap (4000) hit — some files not loaded.');
  if (s.truncatedByBytes) console.log('  ⚠ Total-text cap (~150 MB) hit — some files not loaded.');
  console.log('  Tip: set PROJECT_DIR=/path/to/a/repo to inspect another codebase.\n');
});
