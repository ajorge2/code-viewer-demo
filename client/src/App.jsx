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

function ProjectOverview({ project, files, scan, edits, onOpenFile }) {
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

  const editedFiles = new Set(Object.entries(edits).flatMap(([key, value]) => {
    const parts = key.split('::')
    if (parts.length >= 3) return parts[0] === project?.id ? [parts[1]] : []
    return value?.projectId === project?.id ? [parts[0]] : []
  })).size
  const coverageLimited = scan?.truncatedByCount || scan?.truncatedByBytes || scan?.truncatedByClient

  return (
    <div className="project-overview-shell">
      <section className="project-overview">
        <div className="overview-kicker">Project overview</div>
        <h2>{project?.name || 'Active project'}</h2>
        <p className="overview-lede">Start with the shape of the system, then follow evidence into a file. Nothing here changes your source.</p>

        <div className="overview-metrics">
          <div><strong>{files.length}</strong><span>indexed files</span></div>
          <div><strong>{languages.length}</strong><span>file types</span></div>
          <div><strong>{editedFiles}</strong><span>drafted files</span></div>
        </div>

        {coverageLimited && (
          <div className="coverage-card warning">
            <strong>Coverage limit reached</strong>
            <span>The overview reflects the indexed subset. Review the status bar before drawing project-wide conclusions.</span>
          </div>
        )}

        <div className="overview-grid">
          <section>
            <h3>Languages</h3>
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
            <h3>Largest areas</h3>
            <div className="overview-folder-list">
              {topFolders.map(([name, count]) => <div key={name}><span>{name}/</span><span>{count} files</span></div>)}
            </div>
          </section>
        </div>

        {files[0] && <button className="overview-primary" onClick={() => onOpenFile(files[0].id)}>Open the first file</button>}
      </section>

      <aside className="overview-insight">
        <div className="insight-rail-label"><span>Insight</span><span>Project scope</span></div>
        <div className="overview-insight-body">
          <div className="overview-scope-icon">◎</div>
          <h3>Choose evidence to investigate</h3>
          <p>Select a file to ask about exact code, or use <strong>Ask project</strong> in Explorer for a repository-wide question.</p>
          <div className="scope-mini-ledger">
            <span><i className="scope-dot project" /> Scope · entire project</span>
            <span><i className="scope-dot support" /> Context · indexed files</span>
            <span><i className="scope-dot safe" /> Actions · drafts only</span>
          </div>
        </div>
      </aside>
    </div>
  )
}

function EmptyWorkspace({ onOpenProject }) {
  return (
    <div className="empty-workspace">
      <div className="empty-workspace-mark" aria-hidden="true">⌁</div>
      <div className="overview-kicker">Context workbench</div>
      <h2>Understand a codebase without losing your place.</h2>
      <p>Open a folder to map its structure, inspect exact code, ask scoped questions, and keep proposed changes safely in drafts.</p>
      <button className="overview-primary" onClick={onOpenProject}>Open a project folder</button>
      <div className="empty-workspace-steps">
        <span><b>1</b> Choose a folder</span>
        <span><b>2</b> Review coverage</span>
        <span><b>3</b> Explore safely</span>
      </div>
      <small>Read-only exploration · generated folders and binaries are skipped</small>
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
      setSystemNotice('Context cache cleared. Structure and base summaries were kept.')
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
      setSystemNotice('Context detail updated. Project summaries are warming in the background.')
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
    try { return JSON.parse(localStorage.getItem('cv:edits')) || {} } catch { return {} }
  })
  useEffect(() => {
    try { localStorage.setItem('cv:edits', JSON.stringify(edits)) } catch { /* ignore */ }
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
  const openFileWithChat = (id) => { setSelectedId(id); setExplorerOpen(false); setFileChatSignal((n) => n + 1) }
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
      setSystemNotice(`Removed ${removedName} from the workspace. Source files were not changed.`)
    } catch (error) {
      setSystemNotice(humanizeError(error, 'The project could not be removed.'))
    }
  }

  return (
    <div className="app">
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
            welcome={false}
          />
        )}
        <div className="topbar-right">
          {view === 'main' ? (
            <>
              <span className={`service-state${health?.ok ? ' online' : health === undefined ? ' pending' : ' offline'}`}>
                <i />{health?.initializing ? 'Preparing analysis' : health?.ok ? 'Analysis ready' : health === undefined ? 'Checking analysis' : 'Analysis offline'}
              </span>
              {activeProject && (
                <button className="reload-btn text-btn" title="Clear derived answer context" onClick={() => setConfirmClear(true)}>
                  Clear context cache
                </button>
              )}
            </>
          ) : (
            <button className="reload-btn text-btn" title="Back to the app" aria-label="Back to the app" onClick={() => setView('main')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="1.5"
                   strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
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
              <span aria-hidden="true">!</span>
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
              onOpenDemo={() => setView('help')}
              onOpenCaching={() => setCachingOpen(true)}
              onOpenReference={openReference}
            />
          ) : activeProject && files.length > 0 ? (
            <ProjectOverview project={activeProject} files={files} scan={scan} edits={edits} onOpenFile={selectFile} />
          ) : !activeProject ? (
            <EmptyWorkspace onOpenProject={() => projectSwitcherRef.current?.openFolder()} />
          ) : (
            <div className="workspace-error-state quiet">
              <span aria-hidden="true">∅</span>
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

      <footer className="workspace-statusbar" aria-live="polite">
        <span className={`status-primary${projectLoading ? ' busy' : ''}`}>
          <i />{projectLoading ? 'Indexing project' : systemNotice || (view === 'help' ? 'Chunking demo' : activeProject ? 'Ready to explore' : 'Open a project to begin')}
        </span>
        {view === 'main' && activeProject && <span>{activeProject.name}</span>}
        {view === 'main' && activeProject && <span>{files.length} indexed</span>}
        {view === 'main' && scan?.skipped > 0 && <span className="status-warning">{scan.skipped} skipped</span>}
        {view === 'main' && (scan?.truncatedByCount || scan?.truncatedByBytes || scan?.truncatedByClient) && <span className="status-warning">Coverage limited</span>}
        {view === 'main' && <span>{draftCount} {draftCount === 1 ? 'draft' : 'drafts'} · source unchanged</span>}
      </footer>

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
