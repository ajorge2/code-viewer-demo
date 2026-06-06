import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';

import {
  loadProject, listFiles, getFile, fileCount, getScanStats,
  registerProject, registerUploadedProject, activateProject, removeProject, listProjects,
  activeProjectDir, activeProjectId,
} from './store.js';
import { chunkByLines, languageFor } from './ingest/code.js';
import { chunkJson } from './ingest/json.js';
import { chunkCode } from './ingest/codeTree.js';
import { chunkGeneric } from './ingest/genericTree.js';
import { isParseable, loadTree } from './ingest/parseTree.js';
import { setProjectTree } from './ingest/projectTree.js';
import { ask, askFolder, suggestEdits, warmProjectBares } from './llm/meaning.js';

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
    warmProjectBares(files).catch(() => {}); // detached
  } catch { /* non-fatal: questions still work via lazy compute */ }
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

// Unregister a project.
app.delete('/api/projects/:id', (req, res) => {
  const ok = removeProject(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Unknown project.' });
  res.json({ activeId: activeProjectId(), projects: listProjects() });
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

// RAG Q&A: answer a question about a selected chunk. The chunk is referenced by
// its stable `nodeId` (from the chunks endpoint), so the server reconstructs the
// node + its ancestor chain from file content alone — no chunking params needed.
app.post('/api/files/:id/ask', async (req, res) => {
  const file = getFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });
  const { nodeId, question, depth, intent, transcript, contextFileId } = req.body || {};
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
  const { nodeId, instruction, transcript, baseCode } = req.body || {};
  if (!nodeId) return res.status(400).json({ error: 'nodeId is required' });
  try {
    const result = await suggestEdits({
      file,
      nodeId,
      instruction: typeof instruction === 'string' ? instruction : '',
      transcript: Array.isArray(transcript) ? transcript.slice(-6) : [],
      baseCode: typeof baseCode === 'string' ? baseCode : '',
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
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
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
