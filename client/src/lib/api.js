// Thin client for the Express API.

export async function fetchHealth() {
  const res = await fetch('/api/health')
  if (!res.ok) throw new Error('Server unreachable')
  return res.json()
}

export async function fetchFiles() {
  const res = await fetch('/api/files')
  if (!res.ok) throw new Error('Failed to load files')
  return res.json() // { projectDir, projectId, files, scan }
}

// ── Project registry ────────────────────────────────────────────────────────
export async function fetchProjects() {
  const res = await fetch('/api/projects')
  if (!res.ok) throw new Error('Failed to load projects')
  return res.json() // { activeId, projects: [...] }
}

// Register a project from a browser folder upload. `files` is [{ relPath, content }]
// read from the user's chosen directory (see lib/uploadFolder.js).
export async function uploadProject(name, files, scan = {}) {
  const res = await fetch('/api/projects/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, files, scan }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Failed to upload folder')
  return data // { project, activeId, projects }
}

export async function activateProject(id) {
  const res = await fetch(`/api/projects/${id}/activate`, { method: 'POST' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Failed to switch project')
  return data // { project, activeId, projects }
}

export async function removeProject(id) {
  const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Failed to remove project')
  return data // { activeId, projects }
}

// Wipe the server's tree cache (disk + in-memory). Returns { ok, removed }.
export async function clearTreeCache() {
  const res = await fetch('/api/tree-cache', { method: 'DELETE' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Failed to clear tree cache')
  return data
}

// Find where a code symbol is defined/used across the active project (search-based).
// Returns { name, count, truncated, definitions, files: [{ fileId, relPath, hits }] }.
export async function fetchReferences(name, fromFileId) {
  const q = new URLSearchParams({ name })
  if (fromFileId) q.set('from', fromFileId)
  const res = await fetch(`/api/references?${q.toString()}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Failed to find references')
  return data
}

// Set a project's bare-window size (chars). Resets that project's meaning cache and
// re-warms it server-side. Returns { ok, bareWindow, dropped, projects }.
export async function setProjectBareWindow(id, chars) {
  const res = await fetch(`/api/projects/${id}/bare-window`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chars }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Failed to set window size')
  return data
}

// Metadata for the built-in sample file shown on the help/demo page.
export async function fetchSample() {
  const res = await fetch('/api/sample')
  if (!res.ok) throw new Error('Failed to load sample')
  return res.json() // { file: { id, relPath, language } }
}

export async function fetchRaw(id) {
  const res = await fetch(`/api/files/${id}/raw`)
  if (!res.ok) throw new Error('Failed to load file')
  return res.text()
}

// RAG Q&A: ask about a selected chunk (by stable nodeId). `opts` carries the
// per-line drill state: { depth, intent: 'infer'|'deepen', transcript }.
// Returns { answer, meaning, path, depth, atBottom, maxDepth }.
export async function askQuestion(fileId, nodeId, question, opts = {}) {
  const { depth = 0, intent = 'infer', transcript = [], contextFileId = null, focus = '', highlight = '', traceContext = null } = opts
  const res = await fetch(`/api/files/${fileId}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, question, depth, intent, transcript, contextFileId, focus, highlight, traceContext }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Failed to get an answer')
  return data
}

// Ask the LLM to propose edits to a chunk's code, using the Q&A conversation as
// direction. Returns { code, original, path } — `code` is the full revised unit.
export async function suggestEdits(fileId, nodeId, opts = {}) {
  const { instruction = '', transcript = [], baseCode = '', contextFileId = null } = opts
  const res = await fetch(`/api/files/${fileId}/suggest-edits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, instruction, transcript, baseCode, contextFileId }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Failed to suggest edits')
  return data
}

// RAG Q&A about a folder (the current directory). `dirPath` is relative to the
// project root ('' = root). Returns { answer, summary, path }.
export async function askFolder(dirPath, question, transcript = [], contextFileId = null) {
  const res = await fetch('/api/folders/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dirPath, question, transcript, contextFileId }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Failed to get an answer')
  return data
}

// `value` is the slider value: chunk size (lines) for line files, or granularity
// (target box count) for JSON. The server reads whichever applies to the file type.
export async function fetchChunks(id, value, depthSpread = 0) {
  const res = await fetch(
    `/api/files/${id}/chunks?size=${value}&granularity=${value}&depthSpread=${depthSpread}`,
  )
  if (!res.ok) throw new Error('Failed to chunk file')
  return res.json() // { kind, chunks, maxBoxes?, lineCount?, ... }
}

// Highlight-mode chunking: chunk the file around a character range [start, end).
// The server returns the current ctx distribution — the minimal frontier of the marks
// asked about so far plus this highlight's tightest box — as a full set of chunks, with
// `targetNodeId` being the band the highlight lands in.
export async function fetchChunksAround(id, start, end) {
  const res = await fetch(
    `/api/files/${id}/chunks?rangeStart=${start}&rangeEnd=${end}`,
  )
  if (!res.ok) throw new Error('Failed to chunk file')
  return res.json() // { kind, chunks, nodes, targetNodeId, ... }
}
