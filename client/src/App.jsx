import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  fetchHealth, fetchFiles, fetchProjects,
  uploadProject, activateProject, removeProject, clearTreeCache, fetchSample,
  setProjectBareWindow,
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
  // Intro modal that greets you each time the chunking demo page opens. When opened
  // via the demo-page ? button it's dismissable (× + click-out); the auto-pop on
  // entering the demo is not (Continue only).
  const [demoIntroOpen, setDemoIntroOpen] = useState(false)
  const [demoIntroDismissable, setDemoIntroDismissable] = useState(false)
  const [demoIntroPage, setDemoIntroPage] = useState(0) // 0=sliders, 1=highlight, 2=context
  const [cachingOpen, setCachingOpen] = useState(false) // "how caching works" modal (opened from two places)
  useEffect(() => { if (view === 'help') { setDemoIntroOpen(true); setDemoIntroDismissable(false); setDemoIntroPage(0) } }, [view])
  const openDemoIntro = () => { setDemoIntroOpen(true); setDemoIntroDismissable(true); setDemoIntroPage(0) }
  // Load the sample on mount, and retry whenever the demo page is opened (so a
  // failed initial fetch — e.g. the server wasn't up yet — recovers without a refresh).
  useEffect(() => {
    if (sampleFile) return
    fetchSample().then((s) => setSampleFile(s.file)).catch(() => {})
  }, [view, sampleFile])

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

  // Per-project bare-window size change. The slider commits a pending value; we
  // confirm (it re-summarizes the project) before applying.
  const [pendingWindow, setPendingWindow] = useState(null) // chars awaiting confirm
  const [applyingWindow, setApplyingWindow] = useState(false)
  const handleBareWindow = (chars) => setPendingWindow(chars)
  const confirmBareWindow = async () => {
    if (pendingWindow == null || !activeProjectId) return
    setApplyingWindow(true)
    try {
      const r = await setProjectBareWindow(activeProjectId, pendingWindow)
      if (r.projects) setProjects(r.projects)
      setPendingWindow(null)
    } catch {
      /* keep the modal open on failure */
    } finally {
      setApplyingWindow(false)
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

  // Open a reference result: switch to its file and scroll to the offset (the viewer
  // applies the offset jump once that file's text renders).
  const openReference = (fileId, offset) => {
    setSelectedId(fileId)
    setJumpTarget({ fileId, offset })
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
          </div>
        </div>
        {view === 'main' && (
          <ProjectSwitcher
            projects={projects}
            activeId={activeProjectId}
            onSwitch={switchProject}
            onUpload={handleUploadProject}
            onRemove={handleRemoveProject}
            onBareWindow={handleBareWindow}
            welcome={topbarBig}
            onExitWelcome={collapseWelcome}
          />
        )}
        <div className="topbar-right">
          {view === 'main' ? (
            // Only meaningful once a project is loaded — there's nothing to clear otherwise.
            projects.length > 0 && (
            <button className="reload-btn" title="Clear cache" aria-label="Clear cache" onClick={() => setConfirmClear(true)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="1.3"
                   strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            </button>
            )
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
          <div className="topbar-welcome" aria-hidden={!topbarBig}>
            {projects.length === 0 ? 'Welcome!' : 'Welcome Back!'}
          </div>
        )}
      </header>

      {view === 'main' ? (
        // Clicking anywhere in the content below collapses the welcome state
        // (one-way — it can only be re-expanded by refreshing the page).
        <div className={`app-body${viewerLocked ? ' welcome' : ''}`} onClick={collapseWelcome}>
        {/* Centered call-to-action over the blank welcome card; fades out as the
            welcome state collapses (driven by the .welcome class above). */}
        <div className="welcome-cta" aria-hidden={!viewerLocked}>
          {projects.length === 0 ? 'Click here to start' : 'Click here to resume'}
        </div>
        <Library
          files={files}
          projectDir={projectDir}
          edits={edits}
          loaded={loaded}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onOpenFileChat={openFileWithChat}
          noProject={projects.length === 0}
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
              onOpenDemo={() => setView('help')}
              onOpenCaching={() => setCachingOpen(true)}
              onOpenReference={openReference}
            />
          ) : bareEmpty ? (
            // Welcome state, no project: a blank white card that mirrors the locked
            // viewer (left half, rounded top-right) so the white/gradient split
            // matches a loaded project instead of leaving a bare 300px library edge
            // against the gradient. No message — the welcome card stays empty; the
            // "no source files" text shows once the welcome collapses (.empty below).
            <div className="empty-bare-card" />
          ) : (
            <div className="empty">
              {/* With no project uploaded at all, show nothing here — the library's
                  upload prompt is the only message. */}
              {projects.length === 0 ? '' : loaded ? 'No source files found in this folder' : 'Loading…'}
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
                demo
                onOpenInfo={openDemoIntro}
              />
            )}
          </main>
        </div>
      )}

      {view === 'help' && demoIntroOpen && (
        <div className={`modal-overlay ${demoIntroDismissable ? 'dim' : 'glass'}`} onClick={demoIntroDismissable ? () => setDemoIntroOpen(false) : undefined}>
          <div className="chunk-help demo-intro" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            {demoIntroDismissable && (
              <button className="chunk-help-x" onClick={() => setDemoIntroOpen(false)} aria-label="Close">×</button>
            )}

            {demoIntroPage === 0 && (
              <>
                <h2 className="demo-intro-title">How chunking works</h2>
                <p className="chunk-help-text">Two sliders control how this file splits into chunks:</p>
                <ul className="demo-intro-list">
                  <li><b>Granularity</b> — how deep the splits can go.</li>
                  <li><b>Depth spread</b> — when bigger chunks split first, how far apart their depths can land.</li>
                </ul>
                <p className="chunk-help-text">
                  Both just move a cut through the same fixed tree, so every chunk is a real
                  node with exactly one chunking path — cached results stay valid no matter
                  how you move the sliders.
                  <button
                    className="caching-q"
                    onClick={() => setCachingOpen(true)}
                    title="How caching works"
                    aria-label="How caching works"
                  >?</button>
                </p>
              </>
            )}

            {demoIntroPage === 1 && (
              <>
                <h2 className="demo-intro-title">Chunking around a highlight</h2>
                <p className="chunk-help-text">
                  Highlight code and the system picks your chunk for you — the <b>tightest</b> piece
                  that still wraps your whole selection. There's always exactly one.
                </p>
              </>
            )}

            {demoIntroPage === 2 && (
              <>
                <h2 className="demo-intro-title">Finding the right context</h2>
                <p className="chunk-help-text">
                  To answer, the system reads your chunk against the <b>fewest chunks that still
                  reach everything you've highlighted</b> — fine where you've looked, broad
                  elsewhere. It's the same two dials, set by your highlights for the richest context.
                </p>
              </>
            )}

            <div className="demo-intro-nav">
              {demoIntroPage > 0 && (
                <button className="demo-intro-back" onClick={() => setDemoIntroPage((p) => p - 1)}>← Back</button>
              )}
              <span className="demo-intro-dots" aria-hidden="true">
                {[0, 1, 2].map((i) => <span key={i} className={`demo-intro-dot${i === demoIntroPage ? ' on' : ''}`} />)}
              </span>
              {demoIntroPage < 2 ? (
                <button className="chunk-help-demo" onClick={() => setDemoIntroPage((p) => p + 1)}><span>Next →</span></button>
              ) : (
                <button className="chunk-help-demo" onClick={() => setDemoIntroOpen(false)}><span>Got it</span></button>
              )}
            </div>
          </div>
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
            <h2 id="clear-cache-title" className="modal-title">Clear the cache?</h2>
            <p className="modal-body">
              This resets the finer, in-context read of each chunk in this project — the
              part answers are built from. It rebuilds the next time you ask. The structure
              and base summaries stay, so it's quick — totally safe.
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

      {pendingWindow != null && (
        <div
          className="modal-overlay"
          onClick={() => { if (!applyingWindow) setPendingWindow(null) }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="window-size-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="window-size-title" className="modal-title">Change context detail?</h2>
            <p className="modal-body">
              This re-summarizes {projects.find((p) => p.id === activeProjectId)?.name || 'this project'} from
              scratch at the new window size (~{Math.round(pendingWindow / 1000)}k). Each
              file is re-analyzed in the background — safe, just slower for a moment.
            </p>
            <div className="modal-actions">
              <button
                className="modal-btn ghost"
                onClick={() => setPendingWindow(null)}
                disabled={applyingWindow}
              >
                Cancel
              </button>
              <button
                className="modal-btn danger"
                onClick={confirmBareWindow}
                disabled={applyingWindow}
              >
                {applyingWindow ? 'Applying…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* "How caching works" — opened from the demo intro's ? and from the help
          modal's link. Portaled to body and layered above both. */}
      {cachingOpen && createPortal(
        <div className="modal-overlay dim caching-overlay" onClick={() => setCachingOpen(false)}>
          <div className="chunk-help demo-intro" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <button className="chunk-help-x" onClick={() => setCachingOpen(false)} aria-label="Close">×</button>
            <h2 className="demo-intro-title">How caching works</h2>
            <p className="chunk-help-text">Answers run on two different kinds of summary:</p>
            <ul className="demo-intro-list">
              <li>
                <b>Gists</b> <i>— cheap, done up front.</i> Every piece of code gets a quick
                standalone summary, computed once for the whole project on a fast model and
                reused anywhere that exact code appears.
              </li>
              <li>
                <b>In context</b> <i>— heavier, on demand.</i> When you ask, a piece's gist is
                folded together — on a stronger model — with the gists of the pieces your
                highlights pull in around it. This is what the answer is actually built from.
              </li>
            </ul>
            <p className="chunk-help-text">
              Both are saved by the exact code they describe. So the cheap gists are computed
              once across the whole project, and the heavier in-context reads are only redone
              when your highlights change what's nearby.
            </p>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
