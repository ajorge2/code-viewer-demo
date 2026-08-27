// Read a user-selected folder (from an <input webkitdirectory>) into the shape the
// upload endpoint wants: { name, files: [{ relPath, content }], truncated }.
//
// The server can't see the user's filesystem in a hosted deploy, so the browser
// reads the folder client-side and uploads the file contents. We mirror the
// server's ingest filters here so we don't ship node_modules, lockfiles, binaries,
// or oversized files over the wire.

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.idea', '.vscode', 'target', '.cache', 'vendor', '.turbo',
  '.tree-cache', '.claude', '.codex', '.agents', 'benchmark-results',
])
const SKIP_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock',
  'poetry.lock', 'Cargo.lock', 'Gemfile.lock',
])
// Extensions the server knows how to chunk (mirrors LANGS in server/ingest/code.js).
const SOURCE_EXT = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'php', 'swift', 'kt', 'scala',
  'css', 'scss', 'html', 'vue', 'svelte', 'json', 'yml', 'yaml', 'toml',
  'md', 'sh', 'bash', 'sql', 'r',
])
const MAX_FILE_BYTES = 1_000_000
const MAX_FILES = 4000
const MAX_TOTAL_BYTES = 50_000_000 // keep the POST body reasonable

function isSource(name) {
  if (SKIP_FILES.has(name)) return false
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return SOURCE_EXT.has(name.slice(dot + 1).toLowerCase())
}

// A relative path (split into segments) + size is worth keeping iff it's a source
// file, not under a skipped dir, and within the per-file size cap.
function keepFile(segs, size) {
  if (segs.some((s) => SKIP_DIRS.has(s))) return false
  if (!isSource(segs[segs.length - 1])) return false
  return size <= MAX_FILE_BYTES
}

// Sort the candidates, read their text up to the count/byte caps, and return the
// upload-endpoint shape. Shared by all three pick paths below.
async function assemble(top, picked) {
  picked.sort((a, b) => a.relPath.localeCompare(b.relPath))
  const files = []
  let total = 0
  let truncated = false
  for (const { file, relPath } of picked) {
    if (files.length >= MAX_FILES) { truncated = true; break }
    if (total + file.size > MAX_TOTAL_BYTES) { truncated = true; break }
    let content
    try { content = await file.text() } catch { continue }
    total += file.size
    files.push({ relPath, content })
  }
  return { name: top || 'project', files, truncated }
}

// (1) webkitdirectory input fallback. `fileList`'s File objects carry a
// `webkitRelativePath` like "<chosen-folder>/src/App.jsx"; strip the chosen-folder
// prefix so paths are relative to the project root (matching a server disk scan).
export async function readFolderUpload(fileList) {
  const all = Array.from(fileList || [])
  if (!all.length) return null
  const top = (all[0].webkitRelativePath || all[0].name).split('/')[0] || 'project'
  const picked = []
  for (const f of all) {
    const segs = (f.webkitRelativePath || f.name).split('/')
    if (!keepFile(segs, f.size)) continue
    picked.push({ file: f, relPath: segs.slice(1).join('/') || segs[segs.length - 1] })
  }
  return assemble(top, picked)
}

// (2) File System Access API. `dirHandle` (from showDirectoryPicker) IS the project
// root, so paths are relative to it. Skipped dirs are pruned during the walk.
async function collectHandle(dirHandle, prefix, picked) {
  for await (const entry of dirHandle.values()) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.kind === 'directory') {
      if (SKIP_DIRS.has(entry.name)) continue
      await collectHandle(entry, rel, picked)
    } else {
      let file
      try { file = await entry.getFile() } catch { continue }
      if (keepFile(rel.split('/'), file.size)) picked.push({ file, relPath: rel })
    }
    if (picked.length >= MAX_FILES * 3) break // guard before the read-time cap
  }
}
export async function readDirectoryHandle(dirHandle) {
  const picked = []
  await collectHandle(dirHandle, '', picked)
  return assemble(dirHandle.name, picked)
}

// (3) Drag-and-drop. The dropped items use the older FileSystem Entries API
// (webkitGetAsEntry). `entries` must be captured SYNCHRONOUSLY in the drop handler
// (the DataTransferItemList is invalid afterwards) and passed in here.
const readEntries = (reader) => new Promise((res, rej) => reader.readEntries(res, rej))
const entryFile = (e) => new Promise((res, rej) => e.file(res, rej))
async function collectEntry(entry, prefix, picked) {
  const rel = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isDirectory) {
    if (SKIP_DIRS.has(entry.name)) return
    const reader = entry.createReader()
    let batch // readEntries returns ≤~100 per call — loop until empty
    do { batch = await readEntries(reader); for (const c of batch) await collectEntry(c, rel, picked) }
    while (batch.length)
  } else if (entry.isFile) {
    let file
    try { file = await entryFile(entry) } catch { return }
    if (keepFile(rel.split('/'), file.size)) picked.push({ file, relPath: rel })
  }
}
export async function readDroppedEntries(entries) {
  const list = (entries || []).filter(Boolean)
  if (!list.length) return null
  const dirs = list.filter((e) => e.isDirectory)
  const picked = []
  if (dirs.length === 1 && list.length === 1) {
    // The common case: one folder dropped → its children are the project root.
    const reader = dirs[0].createReader()
    let batch
    do { batch = await readEntries(reader); for (const c of batch) await collectEntry(c, '', picked) }
    while (batch.length)
    return assemble(dirs[0].name, picked)
  }
  // Multiple items (or loose files) → keep each under its own name.
  for (const e of list) await collectEntry(e, '', picked)
  return assemble(dirs[0]?.name || 'dropped-files', picked)
}
