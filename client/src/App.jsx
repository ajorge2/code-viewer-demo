import { useEffect, useState } from 'react'
import {
  fetchHealth, fetchFiles, fetchProjects,
  uploadProject, activateProject, removeProject, clearTreeCache, fetchSample,
} from './lib/api.js'
import Library from './components/Library.jsx'
import CodeViewer from './components/CodeViewer.jsx'
import ProjectSwitcher from './components/ProjectSwitcher.jsx'

// Per-project localStorage namespace for chunk-size overrides.
const keyFor = (projectId) => `cv:chunkSizes:${projectId}`
function loadChunkSizes(projectId) {
  if (!projectId) return {}
  try {
    return JSON.parse(localStorage.getItem(keyFor(projectId)) || '{}')
  } catch {
    return {}
  }
}

export default function App() {
  const [files, setFiles] = useState([])
  const [projectDir, setProjectDir] = useState('')
  const [activeProjectId, setActiveProjectId] = useState(null)
  const [projects, setProjects] = useState([])
  const [health, setHealth] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  // True while a project is being uploaded or switched in — i.e. it's registered
  // on the server but its files aren't in the viewer yet. Drives a loading state
  // in the stage so the main area isn't blank (or showing the old project).
  const [projectLoading, setProjectLoading] = useState(false)
  // Name of the project being loaded, so the stage spinner can say which one.
  const [loadingName, setLoadingName] = useState('')

  // 'main' is the normal app; 'help' is the standalone demo page (a sample file in
  // the code view with the chunking sliders, reached via the ⊙? button).
  const [view, setView] = useState('main')
  const [sampleFile, setSampleFile] = useState(null)
  const [sampleChunk, setSampleChunk] = useState(1)
  useEffect(() => {
    fetchSample().then((s) => setSampleFile(s.file)).catch(() => {})
  }, [])

  // Clear-tree-cache confirmation modal. `clearing` guards against a double-submit
  // while the DELETE is in flight.
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const handleClearTreeCache = async () => {
    setClearing(true)
    try {
      await clearTreeCache()
      setConfirmClear(false)
    } catch {
      /* surfaced below would be nicer; for now keep the modal open on failure */
    } finally {
      setClearing(false)
    }
  }

  // Per-file chunk size for the active project. Defaults to the file's original;
  // a per-file override is stored only when the user moves that file's slider.
  // Persisted per-project to localStorage so changes survive a refresh and don't
  // bleed across projects.
  const [chunkSizes, setChunkSizes] = useState({})
  useEffect(() => {
    if (!activeProjectId) return
    try {
      const next = JSON.stringify(chunkSizes)
      // This effect also fires on activeProjectId change, which happens right after
      // loadActiveFiles() reads sizes from storage — so guard against writing back
      // the value we just loaded (or any other no-op write).
      if ((localStorage.getItem(keyFor(activeProjectId)) ?? '{}') === next) return
      localStorage.setItem(keyFor(activeProjectId), next)
    } catch {
      /* ignore quota / unavailable storage */
    }
  }, [chunkSizes, activeProjectId])

  // Per-chunk edits, keyed `${fileId}::${nodeId}`. Each value records the edited
  // text + the slider config and location at edit time, so the edit-history
  // carousel can jump back to that exact chunk/config. Persisted to localStorage.
  const [edits, setEdits] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cv:edits')) || {} } catch { return {} }
  })
  useEffect(() => {
    try { localStorage.setItem('cv:edits', JSON.stringify(edits)) } catch { /* ignore */ }
  }, [edits])

  // A jump requested from the edit history: switch to the edit's file, restore its
  // granularity, and hand the rest (depth/sub + select-the-chunk) to the viewer.
  const [jumpTarget, setJumpTarget] = useState(null)
  // Bumped when a file should open WITH its chat already open (e.g. clicking a file
  // shortcut in a folder-chat answer). The viewer watches this signal.
  const [fileChatSignal, setFileChatSignal] = useState(0)
  const openFileWithChat = (id) => { setSelectedId(id); setFileChatSignal((n) => n + 1) }
  // Welcome state (both true on load). Clicking the content collapses it in two
  // phases: first the viewer fills horizontally (viewerLocked → false), then a
  // beat later the top bar collapses vertically (topbarBig → false).
  const [topbarBig, setTopbarBig] = useState(true)
  const [viewerLocked, setViewerLocked] = useState(true)
  // Granularity controls stay hidden until the whole collapse finishes, so the
  // slider doesn't pop in mid-animation.
  const [controlsReady, setControlsReady] = useState(false)
  const collapseWelcome = () => {
    if (!viewerLocked) return // already collapsing / collapsed
    setViewerLocked(false) // phase 1: horizontal fill (~0.22s)
    setTimeout(() => setTopbarBig(false), 240) // phase 2: vertical collapse (~0.4s)
    setTimeout(() => setControlsReady(true), 680) // reveal controls once settled
  }
  const jumpToEdit = (entry) => {
    if (!entry) return
    setSelectedId(entry.fileId)
    if (entry.gran != null) setChunkSizes((m) => ({ ...m, [entry.fileId]: entry.gran }))
    setJumpTarget({ ...entry })
  }

  const selectedFile = files.find((f) => f.id === selectedId) || null
  // Welcome state with nothing to show: the stage goes transparent (gradient on the
  // right) and the placeholder renders as a left-half white card (see .stage-bare).
  const bareEmpty = viewerLocked && !selectedFile && !projectLoading
  // Every file chunks structurally now (grammar tree, JSON, or the indent
  // fallback), so the baseline is always granularity 1 (whole file = one box);
  // a per-file override wins when present. Later an LLM pass may choose this per file.
  const chunkSize = chunkSizes[selectedId] ?? 1
  const setChunkSize = (val) =>
    setChunkSizes((m) => ({ ...m, [selectedId]: val }))
  // Reload: drop all overrides so every file's slider returns to its original.
  const resetChunkSizes = () => setChunkSizes({})

  // Load the active project's file list + its saved chunk sizes. Called on mount
  // and after any project change so the view follows the active project.
  async function loadActiveFiles() {
    const f = await fetchFiles().catch(() => ({ files: [], projectDir: '', projectId: null }))
    setFiles(f.files)
    setProjectDir(f.projectDir || '')
    setActiveProjectId(f.projectId || null)
    setChunkSizes(loadChunkSizes(f.projectId))
    setSelectedId(f.files.length ? f.files[0].id : null)
    setLoaded(true)
  }

  useEffect(() => {
    ;(async () => {
      const [h, p] = await Promise.all([
        fetchHealth().catch(() => null),
        fetchProjects().catch(() => ({ projects: [], activeId: null })),
      ])
      setHealth(h)
      setProjects(p.projects)
      await loadActiveFiles()
    })()
  }, [])

  const switchProject = async (id) => {
    if (id === activeProjectId) return
    setLoadingName(projects.find((p) => p.id === id)?.name || '')
    setProjectLoading(true)
    try {
      const r = await activateProject(id)
      setProjects(r.projects)
      await loadActiveFiles()
      collapseWelcome() // make the switched-in project fully visible
    } finally {
      setProjectLoading(false)
      setLoadingName('')
    }
  }

  // Open the native folder picker and load the chosen project. Throws on
  // failure (caller surfaces the message); a no-op if the user cancels.
  // Load a project from a browser folder upload (works in hosted deploys, where
  // the server can't read the user's filesystem).
  const handleUploadProject = async (name, files) => {
    setLoadingName(name)
    setProjectLoading(true)
    try {
      const r = await uploadProject(name, files)
      setProjects(r.projects)
      await loadActiveFiles()
      collapseWelcome() // drop the welcome banner so the new project is visible
    } finally {
      setProjectLoading(false)
      setLoadingName('')
    }
  }

  const handleRemoveProject = async (id) => {
    const r = await removeProject(id)
    setProjects(r.projects)
    await loadActiveFiles()
  }

  return (
    <div className="app">
      <header className={`topbar${view === 'main' && topbarBig ? ' big' : ''}`}>
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <rect x="2.5" y="17.4" width="4.6" height="1.7" rx="0.85" />
              <rect x="6.5" y="14.4" width="4.6" height="1.7" rx="0.85" />
              <rect x="10.5" y="11.4" width="4.6" height="1.7" rx="0.85" />
              <rect x="14.5" y="8.4" width="4.6" height="1.7" rx="0.85" />
              <rect x="18.5" y="5.4" width="4.6" height="1.7" rx="0.85" />
            </svg>
          </span>
          <div>
            <h1>CodeArchitect</h1>
            <p className="byline">By Andrew Jorge</p>
          </div>
        </div>
        {view === 'main' && (
          <ProjectSwitcher
            projects={projects}
            activeId={activeProjectId}
            onSwitch={switchProject}
            onUpload={handleUploadProject}
            onRemove={handleRemoveProject}
          />
        )}
        <div className="topbar-right">
          {view === 'main' ? (
            <>
              <button className="reload-btn" title="Reset all chunk sizes" aria-label="Reset all chunk sizes" onClick={resetChunkSizes}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="1.3"
                     strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
              <button className="reload-btn" title="Clear tree cache" aria-label="Clear tree cache" onClick={() => setConfirmClear(true)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="1.3"
                     strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
              <button className="reload-btn" title="Open the demo page" aria-label="Open the demo page" onClick={() => setView('help')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="1.5"
                     strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9.5" />
                  <path d="M9.1 9.2a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </button>
            </>
          ) : (
            <button className="reload-btn" title="Back to the app" aria-label="Back to the app" onClick={() => setView('main')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="1.5"
                   strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
            </button>
          )}
        </div>
        {/* Greeting shown only while the bar is expanded (right after refresh). */}
        {view === 'main' && (
          <div className="topbar-welcome" aria-hidden={!topbarBig}>Welcome Back!</div>
        )}
      </header>

      {view === 'main' ? (
        // Clicking anywhere in the content below collapses the welcome state
        // (one-way — it can only be re-expanded by refreshing the page).
        <div className="app-body" onClick={collapseWelcome}>
        <Library
          files={files}
          projectDir={projectDir}
          edits={edits}
          loaded={loaded}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onOpenFileChat={openFileWithChat}
        />
        {/* In the welcome state with no project loaded, drop the stage's opaque
            white so the gradient backdrop shows through on the right — matching
            the opened-up look the locked viewer gives once a project is loaded. */}
        <main className={`stage${bareEmpty ? ' stage-bare' : ''}`}>
          {projectLoading ? (
            <div className="empty empty-loading">
              <span className="empty-spinner" aria-hidden="true" />
              {loadingName ? `Loading ${loadingName}…` : 'Loading project…'}
            </div>
          ) : selectedFile ? (
            <CodeViewer
              file={selectedFile}
              files={files}
              chunkSize={chunkSize}
              onChunkSize={setChunkSize}
              locked={viewerLocked}
              controlsReady={controlsReady}
              edits={edits}
              setEdits={setEdits}
              jumpTarget={jumpTarget}
              onJumpConsumed={() => setJumpTarget(null)}
              onJumpToEdit={jumpToEdit}
              openChatSignal={fileChatSignal}
            />
          ) : bareEmpty ? (
            // Welcome state, no project: the message lives in a white card that
            // mirrors the locked viewer (left half, rounded top-right) so the
            // white/gradient split matches a loaded project instead of leaving a
            // bare 300px library edge against the gradient.
            <div className="empty-bare-card">
              {loaded ? 'No source files found in this project.' : 'Loading…'}
            </div>
          ) : (
            <div className="empty">
              {loaded ? 'No source files found in this project.' : 'Loading…'}
            </div>
          )}
        </main>
        </div>
      ) : (
        // Demo page: just the sample file in the code view with the chunking sliders.
        <div className="app-body">
          <main className="stage stage-demo">
            {sampleFile && (
              <CodeViewer
                file={sampleFile}
                files={[sampleFile]}
                chunkSize={sampleChunk}
                onChunkSize={setSampleChunk}
                locked={false}
                controlsReady
                edits={edits}
                setEdits={setEdits}
                jumpTarget={null}
                onJumpConsumed={() => {}}
                onJumpToEdit={() => {}}
                openChatSignal={0}
              />
            )}
          </main>
        </div>
      )}

      {confirmClear && (
        <div
          className="modal-overlay"
          onClick={() => { if (!clearing) setConfirmClear(false) }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-cache-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="clear-cache-title" className="modal-title">Clear tree cache?</h2>
            <p className="modal-body">
              This deletes every parsed tree on the server. The next time each file
              is viewed it will be re-parsed from scratch — safe, just slower for a
              moment.
            </p>
            <div className="modal-actions">
              <button
                className="modal-btn ghost"
                onClick={() => setConfirmClear(false)}
                disabled={clearing}
              >
                Cancel
              </button>
              <button
                className="modal-btn danger"
                onClick={handleClearTreeCache}
                disabled={clearing}
              >
                {clearing ? 'Clearing…' : 'Clear cache'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
