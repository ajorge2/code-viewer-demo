import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  fetchHealth, fetchFiles, fetchProjects,
  uploadProject, activateProject, removeProject, clearTreeCache, fetchSample,
  setProjectBareWindow,
} from './lib/api.js'
import Library from './components/Library.jsx'
import CodeViewer from './components/CodeViewer.jsx'
import ProjectSwitcher from './components/ProjectSwitcher.jsx'
import { humanizeError } from './lib/humanizeError.js'

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

function ProjectOverview({ project, files, scan, onOpenFile }) {
  const languages = useMemo(() => {
    const counts = new Map()
    for (const file of files) {
      const label = file.language || file.relPath.split('.').pop() || 'other'
      counts.set(label, (counts.get(label) || 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [files])

  const topFolders = useMemo(() => {
    const counts = new Map()
    for (const file of files) {
      const folder = file.relPath.includes('/') ? file.relPath.split('/')[0] : 'Project root'
      counts.set(folder, (counts.get(folder) || 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  }, [files])

  const starterFile = useMemo(() => {
    const preferred = ['client/src/App.jsx', 'src/App.jsx', 'README.md', 'package.json']
    for (const relPath of preferred) {
      const match = files.find((file) => file.relPath === relPath)
      if (match) return match
    }
    return files.find((file) => {
      const segments = file.relPath.split('/')
      return !segments.some((segment) => segment.startsWith('.')) &&
        !/(secret|credential|token|\.env|config\.local)/i.test(file.relPath)
    }) || null
  }, [files])

  const coverageLimited = scan?.truncatedByCount || scan?.truncatedByBytes || scan?.truncatedByClient

  return (
    <div className="project-overview-shell">
      <section className="project-overview">
        <div className="overview-heading-row">
          <h2>{project?.name || 'Active project'}</h2>
        </div>

        <div className="overview-metrics">
          <div><span>Files</span><strong>{files.length}</strong></div>
          <div><span>Languages</span><strong>{languages.length}</strong></div>
        </div>

        {coverageLimited && (
          <div className="coverage-card warning">
            <span><strong>Coverage limit reached</strong>The overview reflects the indexed subset.</span>
          </div>
        )}

        <div className="overview-grid">
          <section>
            <div className="overview-section-head"><h3>Languages</h3><span>indexed files</span></div>
            <div className="overview-bars">
              {languages.slice(0, 6).map(([name, count]) => (
                <div key={name} className="overview-bar-row">
                  <span>{name}</span>
                  <span className="overview-bar"><i style={{ width: `${Math.max(8, (count / files.length) * 100)}%` }} /></span>
                  <span>{count}</span>
                </div>
              ))}
            </div>
          </section>
          <section>
            <div className="overview-section-head"><h3>Largest areas</h3><span>by file count</span></div>
            <div className="overview-folder-list">
              {topFolders.map(([name, count]) => <div key={name}><span>{name}/</span><span>{count} files</span></div>)}
            </div>
          </section>
        </div>

        {starterFile && (
          <button className="overview-primary" onClick={() => onOpenFile(starterFile.id)}>
            Open {starterFile.relPath.split('/').pop()}
          </button>
        )}
      </section>

      <aside className="overview-insight">
        <div className="overview-insight-body">
          <div className="overview-insight-intro">
            <div>
              <h3>Choose evidence</h3>
              <p>Select a file for exact code, or ask at project scope from Explorer.</p>
            </div>
          </div>
        </div>
      </aside>
    </div>
  )
}

function EmptyWorkspace({ onOpenProject }) {
  return (
    <div className="empty-workspace">
      <h2>Understand a codebase without losing your place.</h2>
      <p>Open a folder to map its structure, inspect exact code, ask scoped questions, and keep proposed changes safely in drafts.</p>
      <button className="overview-primary" onClick={onOpenProject}>Open a project folder</button>
      <div className="empty-workspace-steps">
        <span><b>1</b> Choose a folder</span>
        <span><b>2</b> Review coverage</span>
        <span><b>3</b> Explore safely</span>
      </div>
    </div>
  )
}

export default function App() {
  const [files, setFiles] = useState([])
  const [projectDir, setProjectDir] = useState('')
  const [activeProjectId, setActiveProjectId] = useState(null)
  const [projects, setProjects] = useState([])
  // undefined = the first check is still pending; null = a completed check failed.
  const [health, setHealth] = useState(undefined)
  const [scan, setScan] = useState(null)
  const [startupError, setStartupError] = useState('')
  const [systemNotice, setSystemNotice] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [explorerOpen, setExplorerOpen] = useState(false)
  const [folderInsightOpen, setFolderInsightOpen] = useState(false)
  const [closeFolderChatSignal, setCloseFolderChatSignal] = useState(0)
  const [explorerWidth, setExplorerWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('cv:explorerWidth'))
      return Number.isFinite(saved) && saved >= 232 && saved <= 380 ? saved : 288
    } catch {
      return 288
    }
  })
  const projectSwitcherRef = useRef(null)
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
      setSystemNotice('Context cache cleared.')
    } catch (error) {
      setSystemNotice(humanizeError(error, 'The context cache could not be cleared.'))
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
      setSystemNotice('Context detail updated; summaries are rebuilding.')
    } catch (error) {
      setSystemNotice(humanizeError(error, 'Context detail could not be changed.'))
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
    try { return JSON.parse(sessionStorage.getItem('cv:edits')) || {} } catch { return {} }
  })
  useEffect(() => {
    try { sessionStorage.setItem('cv:edits', JSON.stringify(edits)) } catch { /* ignore */ }
  }, [edits])

  // Draft keys predating project namespaces cannot identify their owner. Assign
  // them once to the project that was active when this version first loads, then
  // persist the migration so they can never appear in every similarly shaped
  // project. Legacy objects that already carry an owner keep that owner.
  useEffect(() => {
    if (!activeProjectId) return
    setEdits((current) => {
      let changed = false
      const next = { ...current }
      for (const [key, value] of Object.entries(current)) {
        if (key.split('::').length !== 2) continue
        const owner = (typeof value === 'object' && value?.projectId) || activeProjectId
        const namespacedKey = `${owner}::${key}`
        if (!(namespacedKey in next)) {
          next[namespacedKey] = typeof value === 'string'
            ? { text: value, projectId: owner }
            : { ...value, projectId: owner }
        }
        delete next[key]
        changed = true
      }
      return changed ? next : current
    })
  }, [activeProjectId])

  // A jump requested from the edit history: switch to the edit's file, restore its
  // granularity, and hand the rest (depth/sub + select-the-chunk) to the viewer.
  const [jumpTarget, setJumpTarget] = useState(null)
  // Bumped when a file should open WITH its chat already open (e.g. clicking a file
  // shortcut in a folder-chat answer). The viewer watches this signal.
  const [fileChatSignal, setFileChatSignal] = useState(0)
  const openFileWithChat = (id) => {
    setSelectedId(id)
    setExplorerOpen(false)
    setCloseFolderChatSignal((n) => n + 1)
    setFileChatSignal((n) => n + 1)
  }
  // The workspace is immediately usable. Orientation now comes from the stable
  // Explorer / Code / Insight shell rather than a one-way welcome animation.
  const viewerLocked = false
  const controlsReady = true
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
  const activeProject = projects.find((p) => p.id === activeProjectId) || null
  const draftCount = Object.entries(edits).filter(([key, value]) => {
    const parts = key.split('::')
    return parts.length >= 3 ? parts[0] === activeProjectId : value?.projectId === activeProjectId
  }).length
  const coverageLimited = !!(scan?.truncatedByCount || scan?.truncatedByBytes || scan?.truncatedByClient)
  const statusText = projectLoading
    ? 'Indexing project'
    : systemNotice || (view === 'help' ? 'Chunking demo' : '')
  const showStatusbar = !!(statusText || draftCount > 0 || (selectedFile && coverageLimited))

  const selectFile = (id) => {
    setSelectedId(id)
    setExplorerOpen(false)
  }

  const beginExplorerResize = (event) => {
    if (window.innerWidth < 1180) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = explorerWidth
    const move = (moveEvent) => {
      setExplorerWidth(Math.max(232, Math.min(380, startWidth + moveEvent.clientX - startX)))
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      setExplorerWidth((width) => {
        try { localStorage.setItem('cv:explorerWidth', String(width)) } catch { /* storage unavailable */ }
        return width
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
  }
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
    try {
      const f = await fetchFiles()
      setFiles(f.files)
      setProjectDir(f.projectDir || '')
      setActiveProjectId(f.projectId || null)
      setScan(f.scan || null)
      setChunkSizes(loadChunkSizes(f.projectId))
      setSelectedId(null)
      setStartupError('')
    } catch (error) {
      setFiles([])
      setProjectDir('')
      setScan(null)
      setStartupError(humanizeError(error, 'The workspace could not be loaded.'))
    } finally {
      setLoaded(true)
    }
  }

  async function initializeWorkspace(isCancelled = () => false) {
    let [nextHealth, nextProjects] = await Promise.all([
      fetchHealth().catch(() => null),
      fetchProjects().catch(() => ({ projects: [], activeId: null })),
    ])
    // The API begins listening before its default project scan completes. Follow
    // the server's explicit initialization state instead of guessing a timeout;
    // large repositories can legitimately take longer than a few seconds.
    while (nextHealth?.ok && nextHealth.initializing) {
      setHealth(nextHealth)
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (isCancelled()) return false
      ;[nextHealth, nextProjects] = await Promise.all([
        fetchHealth().catch(() => null),
        fetchProjects().catch(() => nextProjects),
      ])
    }
    if (isCancelled()) return false
    setHealth(nextHealth)
    if (!nextHealth) {
      setStartupError('CodeArchitect cannot reach its analysis service. Check the connection and retry.')
      setLoaded(true)
      return false
    }
    if (nextHealth.startupError && nextProjects.projects.length === 0) {
      setStartupError(humanizeError(nextHealth.startupError, 'The initial project could not be indexed.'))
      setLoaded(true)
      return false
    }
    setProjects(nextProjects.projects)
    await loadActiveFiles()
    return true
  }

  useEffect(() => {
    let cancelled = false
    initializeWorkspace(() => cancelled)
    return () => { cancelled = true }
  }, [])

  // Keep the service indicator honest after startup and recover it automatically
  // after a transient outage.
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      const next = await fetchHealth().catch(() => null)
      if (!cancelled) setHealth(next)
    }
    const timer = window.setInterval(check, 15_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  const retryWorkspace = async () => {
    setLoaded(false)
    setStartupError('')
    await initializeWorkspace()
  }

  const switchProject = async (id) => {
    if (id === activeProjectId) return
    setLoadingName(projects.find((p) => p.id === id)?.name || '')
    setProjectLoading(true)
    try {
      const r = await activateProject(id)
      setProjects(r.projects)
      await loadActiveFiles()
      setSystemNotice(`Opened ${r.project?.name || projects.find((p) => p.id === id)?.name || 'project'}`)
    } catch (error) {
      setSystemNotice(humanizeError(error, 'The project could not be opened.'))
    } finally {
      setProjectLoading(false)
      setLoadingName('')
    }
  }

  // Open the native folder picker and load the chosen project. Throws on
  // failure (caller surfaces the message); a no-op if the user cancels.
  // Load a project from a browser folder upload (works in hosted deploys, where
  // the server can't read the user's filesystem).
  const handleUploadProject = async (name, files, uploadScan = {}) => {
    setLoadingName(name)
    setProjectLoading(true)
    try {
      const r = await uploadProject(name, files, uploadScan)
      setProjects(r.projects)
      await loadActiveFiles()
      setSystemNotice(`Indexed ${files.length} files from ${name}`)
    } finally {
      setProjectLoading(false)
      setLoadingName('')
    }
  }

  const handleRemoveProject = async (id) => {
    try {
      const removedName = projects.find((project) => project.id === id)?.name || 'project'
      const r = await removeProject(id)
      setProjects(r.projects)
      await loadActiveFiles()
      setSystemNotice(`Removed ${removedName} from the workspace.`)
    } catch (error) {
      setSystemNotice(humanizeError(error, 'The project could not be removed.'))
    }
  }

  return (
    <div className="app" style={{ '--statusbar-size': showStatusbar ? '26px' : '0px' }}>
      <header className="topbar workspace-topbar">
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
          <button
            type="button"
            className={`mobile-pane-toggle${explorerOpen ? ' active' : ''}`}
            onClick={() => setExplorerOpen((open) => !open)}
            aria-expanded={explorerOpen}
          >
            Explorer
          </button>
        )}
        {view === 'main' && (
          <ProjectSwitcher
            ref={projectSwitcherRef}
            projects={projects}
            activeId={activeProjectId}
            onSwitch={switchProject}
            onUpload={handleUploadProject}
            onRemove={handleRemoveProject}
            onBareWindow={handleBareWindow}
            onClearContext={() => setConfirmClear(true)}
            welcome={false}
            sandbox
          />
        )}
        <div className="topbar-right"><a href="/privacy" target="_blank" rel="noreferrer" style={{fontSize: 11, color: "inherit"}}>Questions use OpenAI · Privacy</a>
          {view === 'main' ? (
            <>
              {activeProject && (
                <span id="topbar-context-slot" className="topbar-context-slot" />
              )}
            </>
          ) : (
            <button className="reload-btn text-btn" title="Back to the app" aria-label="Back to the app" onClick={() => setView('main')}>
              Back to workspace
            </button>
          )}
        </div>
      </header>

      {view === 'main' ? (
        <div className={`app-body workspace-body${explorerOpen ? ' explorer-open' : ''}${folderInsightOpen ? ' folder-insight-open' : ''}`}>
        <div className="workspace-explorer" style={{ width: explorerWidth }}>
          <Library
            projectId={activeProjectId}
            files={files}
            projectDir={projectDir}
            edits={edits}
            loaded={loaded}
            selectedId={selectedId}
            onSelect={selectFile}
            onOpenFileChat={openFileWithChat}
            closeChatSignal={closeFolderChatSignal}
            onFolderInsightChange={setFolderInsightOpen}
            noProject={!activeProject}
          />
        </div>
        <div className="workspace-resizer explorer-resizer" onPointerDown={beginExplorerResize} role="separator" aria-label="Resize Explorer" />
        <main className="stage workspace-stage">
          {!loaded ? (
            <div className="project-loading-state">
              <span className="empty-spinner" aria-hidden="true" />
              <div>
                <strong>Preparing workspace</strong>
                <span>Scanning supported source files and checking coverage…</span>
              </div>
            </div>
          ) : projectLoading ? (
            <div className="project-loading-state">
              <span className="empty-spinner" aria-hidden="true" />
              <div>
                <strong>{loadingName ? `Reading ${loadingName}` : 'Reading project'}</strong>
                <span>Filtering generated files and building the structural index…</span>
              </div>
            </div>
          ) : startupError ? (
            <div className="workspace-error-state">
              <h2>Workspace unavailable</h2>
              <p>{startupError}</p>
              <button className="overview-primary" onClick={retryWorkspace}>Try again</button>
            </div>
          ) : selectedFile ? (
            <CodeViewer
              projectId={activeProjectId}
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
              folderChatOpen={folderInsightOpen}
              onOpenFileChat={() => setCloseFolderChatSignal((n) => n + 1)}
              onOpenDemo={() => setView('help')}
              onOpenCaching={() => setCachingOpen(true)}
              onOpenReference={openReference}
            />
          ) : activeProject && files.length > 0 ? (
            <ProjectOverview project={activeProject} files={files} scan={scan} onOpenFile={selectFile} />
          ) : !activeProject ? (
            <EmptyWorkspace onOpenProject={() => projectSwitcherRef.current?.openFolder()} />
          ) : (
            <div className="workspace-error-state quiet">
              <h2>No supported source files found</h2>
              <p>This folder may contain only generated, binary, locked, or unsupported files.</p>
              <button className="overview-primary" onClick={() => projectSwitcherRef.current?.openFolder()}>Choose another folder</button>
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

      {showStatusbar && (
        <footer className="workspace-statusbar" aria-live="polite">
          {statusText && <span className={projectLoading ? 'status-primary busy' : 'status-primary'}>{statusText}</span>}
          {view === 'main' && selectedFile && coverageLimited && (
            <span className="status-warning">Coverage limited{scan?.skipped > 0 ? ` · ${scan.skipped} skipped` : ''}</span>
          )}
          {view === 'main' && draftCount > 0 && <span>{draftCount} {draftCount === 1 ? 'draft' : 'drafts'}</span>}
        </footer>
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
                <p className="chunk-help-text">Use these controls to adjust how the file is divided:</p>
                <ul className="demo-intro-list">
                  <li><b>Granularity.</b> Sets the maximum split depth.</li>
                  <li><b>Depth spread.</b> Sets the allowed depth difference when larger chunks split first.</li>
                </ul>
                <p className="chunk-help-text">
                  Both controls adjust boundaries within the same fixed syntax tree. Each chunk
                  maps to a single path, so cached results remain valid as settings change.
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
                  CodeArchitect maps your selection to the smallest chunk that fully contains it.
                </p>
              </>
            )}

            {demoIntroPage === 2 && (
              <>
                <h2 className="demo-intro-title">Finding the right context</h2>
                <p className="chunk-help-text">
                  CodeArchitect uses the smallest set of chunks that covers your selection, with
                  more detail near the highlighted code.
                </p>
              </>
            )}

            <div className="demo-intro-nav">
              {demoIntroPage > 0 && (
                <button className="demo-intro-back" onClick={() => setDemoIntroPage((p) => p - 1)}>Back</button>
              )}
              <span className="demo-intro-dots" aria-hidden="true">
                {[0, 1, 2].map((i) => <span key={i} className={`demo-intro-dot${i === demoIntroPage ? ' on' : ''}`} />)}
              </span>
              {demoIntroPage < 2 ? (
                <button className="chunk-help-demo" onClick={() => setDemoIntroPage((p) => p + 1)}><span>Next</span></button>
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
              This will clear the detailed context generated for this project. It will be
              rebuilt automatically the next time you ask a question. Project structure
              and base summaries will not be affected.
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
                className="modal-btn primary"
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
            <p className="chunk-help-text">CodeArchitect uses two cached summary layers:</p>
            <ul className="demo-intro-list">
              <li>
                <b>Gists.</b> Short summaries generated once for each code segment and reused
                wherever the same code appears.
              </li>
              <li>
                <b>Context summaries.</b> Detailed summaries generated when you ask a question.
                They combine relevant gists with the surrounding code selected by your highlights.
              </li>
            </ul>
            <p className="chunk-help-text">
              Cache entries are tied to the source code and active context. Gists are regenerated
              when code changes. Context summaries are regenerated when the relevant code or
              highlights change.
            </p>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
