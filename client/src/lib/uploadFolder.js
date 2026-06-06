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

// `fileList` is the FileList from a webkitdirectory input. Each File carries a
// `webkitRelativePath` like "<chosen-folder>/src/App.jsx".
export async function readFolderUpload(fileList) {
  const all = Array.from(fileList || [])
  if (!all.length) return null

  const top = (all[0].webkitRelativePath || all[0].name).split('/')[0] || 'project'

  const picked = []
  for (const f of all) {
    const rel = f.webkitRelativePath || f.name
    const segs = rel.split('/')
    if (segs.some((s) => SKIP_DIRS.has(s))) continue
    const base = segs[segs.length - 1]
    if (!isSource(base)) continue
    if (f.size > MAX_FILE_BYTES) continue
    // Strip the chosen-folder prefix so paths are relative to the project root
    // (matching how a server-side disk scan returns them).
    picked.push({ file: f, relPath: segs.slice(1).join('/') || base })
  }
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

  return { name: top, files, truncated }
}
