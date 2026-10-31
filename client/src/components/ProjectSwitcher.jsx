import { Fragment, forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { readFolderUpload, readDirectoryHandle, readDroppedEntries } from '../lib/uploadFolder.js'
import { humanizeError } from '../lib/humanizeError.js'

// Bare-window slider bounds (chars). The server clamps to a wider [4k, 200k]; the UI
// exposes the useful middle band.
const WIN_MIN = 8000
const WIN_MAX = 128000
const WIN_STEP = 8000

// Top-bar control: shows open projects as tabs and provides a compact folder picker
// for adding another one (read in the browser and uploaded — works locally and in
// hosted deploys). Clicking the active tab opens its context-detail slider instead.
const ProjectSwitcher = forwardRef(function ProjectSwitcher({ projects, activeId, onSwitch, onUpload, onRemove, onBareWindow, onClearContext, welcome, onExitWelcome, sandbox = false }, forwardedRef) {
  const [open, setOpen] = useState(false)         // the add-folder menu
  const [settingsOpen, setSettingsOpen] = useState(false) // the active project's window-size slider
  const [winLocal, setWinLocal] = useState(WIN_MIN) // live slider value while dragging
  const [error, setError] = useState('')
  // Upload lifecycle for the picker button: '' idle, 'reading' (browser reading the
  // chosen folder — the slow part for big trees), 'uploading' (POSTing to the server).
  const [phase, setPhase] = useState('')
  const [dragOver, setDragOver] = useState(false) // a folder is being dragged over the dropzone
  const [pendingUpload, setPendingUpload] = useState(null)
  const [contextSlot, setContextSlot] = useState(null)
  // Fixed left-to-right order of the open folder tabs. Tabs keep their slot for
  // life — selecting one only brings it forward (z-index), it never moves. New
  // projects append to the right; removed ones drop out.
  const [order, setOrder] = useState([])
  const [draggingId, setDraggingId] = useState(null)
  const [dropLeft, setDropLeft] = useState(null) // x (px in switch) of the drop indicator
  const ref = useRef(null)
  const folderInputRef = useRef(null) // hidden <input webkitdirectory> for picking a folder
  const tabEls = useRef({})       // id -> tab DOM node, for midpoint hit-testing
  const dragRef = useRef(null)    // { id, startX, boundary } while a drag is in progress
  const suppressClick = useRef(false) // swallow the click that ends a real drag

  useEffect(() => {
    setContextSlot(document.getElementById('topbar-context-slot'))
  }, [activeId])

  // Reconcile the order with the live project list: drop removed projects and
  // append newly-added ones. Existing entries keep their position.
  useEffect(() => {
    setOrder((prev) => {
      const ids = projects.map((p) => p.id)
      const next = prev.filter((id) => ids.includes(id))
      for (const id of ids) if (!next.includes(id)) next.push(id)
      return next
    })
  }, [projects])

  // In the welcome state, collapse to a single tab (just the active project) and
  // drop the "+" chooser — the bar is a clean greeting, not a workspace yet.
  const allTabs = order.map((id) => projects.find((p) => p.id === id)).filter(Boolean)
  const stackTabs = welcome ? allTabs.filter((p) => p.id === activeId) : allTabs
  const activeIndex = stackTabs.findIndex((p) => p.id === activeId)

  // The active project's current bare-window size; the slider reflects it whenever the
  // popover opens or the stored value changes (after a confirmed change reloads it).
  const activeProj = projects.find((p) => p.id === activeId)
  const bareWindow = activeProj?.bareWindow ?? 48000
  useEffect(() => { setWinLocal(bareWindow) }, [bareWindow, settingsOpen])

  // Commit on release: if the size changed, hand it up (App confirms + applies);
  // either way close the popover so a cancelled change doesn't leave a stale slider.
  const commitWin = () => {
    setSettingsOpen(false)
    if (winLocal !== bareWindow) onBareWindow?.(winLocal)
  }

  // The "+" chooser, rendered in-flow so it takes its own slot and pushes the
  // following tab to the right (a normal tab-to-tab overlap) rather than covering
  // it. It trails immediately after the active tab. Hidden once we're at the cap
  // of 4 open projects — you can't add a 5th until one is removed.
  const MAX_PROJECTS = 4
  const canAdd = stackTabs.length < MAX_PROJECTS
  // Always rendered so the folder picker stays reachable. Adding is disabled at the
  // cap until the user closes a project from its tab in the main view.
  const chooser = (
    <button
      className={`proj-tab proj-chooser${sandbox ? ' sandbox-locked' : ''}`}
      disabled={sandbox}
      onClick={() => { setOpen((o) => !o); setSettingsOpen(false) }}
      title={sandbox ? 'Adding folders is disabled in this sandbox' : 'Open folder'}
      aria-label={sandbox ? 'Adding folders is disabled in this sandbox' : 'Open folder'}
      aria-expanded={open}
    >
      <svg className={`proj-caret${open ? ' open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
  )

  const settingsTrigger = activeProj && (
    <button
      type="button"
      className={`proj-context-btn${settingsOpen ? ' active' : ''}`}
      onClick={() => { setSettingsOpen((value) => !value); setOpen(false) }}
      aria-expanded={settingsOpen}
      title="Project context settings"
    >
      <span className="proj-context-icon" aria-hidden="true">◎</span>
      <span>Context</span>
    </button>
  )

  // --- Drag-to-reorder the active tab ---------------------------------------
  // Only the tab you're on is draggable. Nothing actually moves during the drag:
  // we just draw a blue insertion line at the gap the tab would land in, and only
  // commit the reorder on release. The "+" chooser is rendered right after the
  // active tab, so it follows the tab to its new spot after the drop.
  const onTabPointerDown = (e, id) => {
    if (welcome) return // no dragging/reordering while the welcome bar is up
    if (id !== activeId || (e.button != null && e.button !== 0)) return
    if (e.target.closest('.proj-current-remove')) return // let the × do its thing
    dragRef.current = { id, startX: e.clientX, boundary: null }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* unsupported */ }
    setDraggingId(id)
  }

  // Where would the dragged tab drop, given the pointer x? Returns the boundary
  // index in the current order (gap before tab `b`) plus the indicator's x, or
  // null when the pointer is over the dragged tab's own slot (a no-op move).
  const computeDrop = (pointerX) => {
    const container = ref.current
    const st = dragRef.current
    if (!container || !st) return null
    const di = order.indexOf(st.id)
    const rectOf = (id) => tabEls.current[id]?.getBoundingClientRect()
    let b = 0
    for (let k = 0; k < order.length; k++) {
      const r = rectOf(order[k])
      if (r && pointerX > r.left + r.width / 2) b = k + 1
    }
    if (b === di || b === di + 1) return null // back where it started
    let clientX
    if (b <= 0) clientX = rectOf(order[0]).left
    else if (b >= order.length) clientX = rectOf(order[order.length - 1]).right
    else clientX = (rectOf(order[b - 1]).right + rectOf(order[b]).left) / 2
    return { b, left: clientX - container.getBoundingClientRect().left }
  }

  const onTabPointerMove = (e) => {
    const st = dragRef.current
    if (!st) return
    if (Math.abs(e.clientX - st.startX) > 5) suppressClick.current = true
    const drop = computeDrop(e.clientX)
    st.boundary = drop ? drop.b : null
    setDropLeft(drop ? drop.left : null)
  }

  const endDrag = (e) => {
    const st = dragRef.current
    if (!st) return
    const b = st.boundary
    dragRef.current = null
    setDraggingId(null)
    setDropLeft(null)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* unsupported */ }
    if (b == null) return
    setOrder((prev) => {
      const di = prev.indexOf(st.id)
      if (di === -1) return prev
      const next = prev.slice()
      next.splice(di, 1)
      next.splice(b > di ? b - 1 : b, 0, st.id)
      return next
    })
  }

  // Close either popover on an outside click.
  useEffect(() => {
    if (!open && !settingsOpen) return
    const onDoc = (e) => {
      if (ref.current?.contains(e.target) || e.target.closest?.('#topbar-context-slot')) return
      setOpen(false)
      setSettingsOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, settingsOpen])

  // Shared tail for all three pick paths: read produced { name, files }, hand it up.
  const finishUpload = async (result) => {
    if (!result || result.files.length === 0) { setError('No source files found in that folder.'); setPhase(''); return }
    setPhase('')
    setPendingUpload(result)
    setOpen(true)
  }

  const uploadPreview = useMemo(() => {
    if (!pendingUpload) return null
    const totalBytes = pendingUpload.files.reduce((total, file) => total + new Blob([file.content]).size, 0)
    const languages = new Map()
    for (const file of pendingUpload.files) {
      const ext = file.relPath.includes('.') ? file.relPath.split('.').pop().toLowerCase() : 'other'
      languages.set(ext, (languages.get(ext) || 0) + 1)
    }
    return {
      totalBytes,
      typeCount: languages.size,
      languages: [...languages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    }
  }, [pendingUpload])

  const confirmUpload = async () => {
    if (!pendingUpload || phase) return
    setError('')
    setPhase('uploading')
    try {
      await onUpload(pendingUpload.name, pendingUpload.files, { truncated: !!pendingUpload.truncated })
      setPendingUpload(null)
      setOpen(false)
    } catch (err) {
      setError(humanizeError(err, 'Failed to open folder'))
    } finally {
      setPhase('')
    }
  }

  // The webkitdirectory <input> fallback (Firefox/Safari, or no FS Access). Snapshot
  // e.target.files FIRST — it's a live FileList that the `value=''` reset empties.
  const onFolderChosen = async (e) => {
    const fileList = Array.from(e.target.files || [])
    e.target.value = '' // let the same folder be re-picked later
    if (!fileList.length) return
    setError(''); setPhase('reading')
    try { await finishUpload(await readFolderUpload(fileList)) }
    catch (err) { setError(humanizeError(err, 'Failed to load folder')); setPhase('') }
  }

  // Primary pick button: the File System Access API where supported (a light "view
  // files?" prompt, no "Upload N files to this site?" dialog), else the input fallback.
  const canFSA = typeof window !== 'undefined' && 'showDirectoryPicker' in window
    && (() => { try { return window.self === window.top } catch { return false } })()
  const openFolderPick = async () => {
    if (!canFSA) { folderInputRef.current?.click(); return }
    let handle
    try { handle = await window.showDirectoryPicker({ mode: 'read' }) }
    catch (err) { if (err?.name !== 'AbortError') setError(humanizeError(err, 'Could not open folder')); return }
    setError(''); setPhase('reading')
    try { await finishUpload(await readDirectoryHandle(handle)) }
    catch (err) { setError(humanizeError(err, 'Failed to read folder')); setPhase('') }
  }

  // Drag-and-drop a folder — no browser dialog at all. Entries must be captured
  // SYNCHRONOUSLY (the DataTransferItemList is invalid once this handler returns).
  const onFolderDrop = async (e) => {
    e.preventDefault()
    setDragOver(false)
    const entries = Array.from(e.dataTransfer?.items || [])
      .map((it) => (it.kind === 'file' ? it.webkitGetAsEntry?.() : null))
      .filter(Boolean)
    if (!entries.length) return
    setError(''); setPhase('reading')
    try { await finishUpload(await readDroppedEntries(entries)) }
    catch (err) { setError(humanizeError(err, 'Failed to read folder')); setPhase('') }
  }

  // The explicit empty-state CTA reuses this exact flow. Calling the picker from
  // the exposed method preserves the original user gesture required by browsers.
  useImperativeHandle(forwardedRef, () => ({
    openFolder: () => {
      if (sandbox) return
      setOpen(true)
      setSettingsOpen(false)
      openFolderPick()
    },
  }))

  return (
    <div className="proj-switch" ref={ref}>
      {/* No projects: in the welcome view this is the blank placeholder tab; once
          collapsed it's dropped entirely so only the "+" chooser remains. */}
      {stackTabs.length === 0 && welcome && (
        <button
          className="proj-tab proj-current proj-tab-welcome"
          onClick={() => onExitWelcome?.()}
        >
          <span className="proj-name">No project</span>
        </button>
      )}
      {/* Staggered stack of open folder tabs in a FIXED order — a tab never moves.
          Selecting one only lifts it to the front (active z-index sits above all
          others). New projects append on the right. The "+" chooser is rendered
          right after the active tab, taking its own slot. */}
      {stackTabs.map((p, i) => {
        const isActive = p.id === activeId
        const className = `proj-tab proj-stack-tab${isActive ? ' proj-current has-remove' : ''}${welcome ? ' proj-tab-welcome' : ''}`
        const projectName = <span className="proj-name">{p.name}</span>
        return (
          <Fragment key={p.id}>
            {isActive ? (
              <div className={className} style={{ zIndex: 100 }} title={p.absPath}>
                <span
                  className={`proj-current-remove${sandbox ? ' sandbox-locked' : ''}`}
                  role={sandbox ? undefined : 'button'}
                  tabIndex={sandbox ? -1 : 0}
                  title={sandbox ? 'Removing this project is disabled in the sandbox' : 'Remove from list'}
                  aria-label={sandbox ? undefined : `Remove ${p.name}`}
                  aria-hidden={sandbox ? 'true' : undefined}
                  onClick={sandbox ? undefined : (e) => { e.stopPropagation(); onRemove(p.id) }}
                  onKeyDown={sandbox ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onRemove(p.id) } }}
                >
                  ×
                </span>
                {projectName}
              </div>
            ) : (
              <button
                ref={(el) => { tabEls.current[p.id] = el }}
                className={className}
                style={{ zIndex: 2 + i }}
                onClick={() => onSwitch(p.id)}
                title={p.absPath}
              >
                {projectName}
              </button>
            )}
            {isActive && !welcome && chooser}
          </Fragment>
        )
      })}
      {/* When nothing is active (no projects, or active not in the stack), trail
          the chooser at the end. */}
      {activeIndex === -1 && !welcome && chooser}

      {/* Insertion indicator shown while dragging: a blue line at the gap where the
          dragged tab will land on release. Rendered last (and absolutely
          positioned) so it overlays without disturbing the tab layout. */}
      {dropLeft != null && <div className="proj-drop-line" style={{ left: dropLeft }} />}

      {open && (
        <div className="proj-menu">
          {pendingUpload ? (
            <div className="proj-preflight">
              <h2>{pendingUpload.name}</h2>
              <p>
                CodeArchitect will index source and documentation files only. Generated
                folders, dependencies, lockfiles, binaries, and files over 1 MB stay out.
              </p>
              <div className="proj-preflight-stats">
                <span><strong>{pendingUpload.files.length}</strong> files</span>
                <span><strong>{(uploadPreview.totalBytes / 1_000_000).toFixed(1)}</strong> MB</span>
                <span><strong>{uploadPreview.typeCount}</strong> types</span>
              </div>
              <div className="proj-preflight-types">
                {uploadPreview.languages.map(([ext, count]) => <span key={ext}>.{ext} · {count}</span>)}
              </div>
              {pendingUpload.truncated && (
                <div className="proj-coverage-warning">
                  Coverage limit reached. The first {pendingUpload.files.length} matching files will be indexed.
                </div>
              )}
              <div className="proj-preflight-actions">
                <button
                  type="button"
                  className="proj-preflight-cancel"
                  onClick={() => { setPendingUpload(null); setError('') }}
                  disabled={!!phase}
                >
                  Choose another
                </button>
                <button type="button" className="proj-preflight-confirm" onClick={confirmUpload} disabled={!!phase}>
                  {phase === 'uploading' ? 'Opening project…' : 'Open project'}
                </button>
              </div>
            </div>
          ) : (
            <div
              className={`proj-add${dragOver ? ' drag-over' : ''}${!canAdd ? ' disabled' : ''}`}
              onDragOver={(e) => { if (canAdd && !phase) { e.preventDefault(); setDragOver(true) } }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { if (canAdd && !phase) onFolderDrop(e); else e.preventDefault() }}
            >
              <input
                type="file"
                multiple
                hidden
                ref={(el) => {
                  folderInputRef.current = el
                  // webkitdirectory/directory aren't standard React props; set them
                  // on the node so the picker selects a whole folder.
                  if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', '') }
                }}
                onChange={onFolderChosen}
              />
              {canAdd && (
                <div className="proj-drop-hint">{dragOver ? 'Drop to open this folder' : 'Drag a folder here, or'}</div>
              )}
              <button
                className="proj-pick-btn"
                type="button"
                onClick={openFolderPick}
                disabled={!!phase || !canAdd}
                title={!canAdd ? `At most ${MAX_PROJECTS} projects — remove one to add another.` : undefined}
              >
                {phase ? (
                  <span className="proj-pick-spinner" aria-hidden="true" />
                ) : null}
                {!canAdd ? `Max ${MAX_PROJECTS} projects` : phase === 'reading' ? 'Reading files…' : phase === 'uploading' ? 'Uploading…' : 'Open folder…'}
              </button>
            </div>
          )}
          {error && <div className="proj-error">{error}</div>}
        </div>
      )}

      {contextSlot && createPortal(<>
        {settingsTrigger}
        {settingsOpen && (
        <div className="proj-menu proj-settings">
          <div className="proj-settings-title">Context detail</div>
          <p className="proj-settings-hint">
            How finely large files are summarized for the chat. Smaller windows mean
            more, finer passes over big files. Changing this re-summarizes this project.
          </p>
            <label className="slider-wrap">
            <span className="slider-label">Window</span>
            <input
              type="range"
              min={WIN_MIN}
              max={WIN_MAX}
              step={WIN_STEP}
              value={Math.max(WIN_MIN, Math.min(WIN_MAX, winLocal))}
              style={{ '--pct': `${((Math.max(WIN_MIN, Math.min(WIN_MAX, winLocal)) - WIN_MIN) / (WIN_MAX - WIN_MIN)) * 100}%` }}
              onChange={(e) => setWinLocal(Number(e.target.value))}
              onPointerUp={commitWin}
              onKeyUp={(e) => { if (e.key.startsWith('Arrow')) commitWin() }}
            />
              <span className="slider-val">{Math.round(winLocal / 1000)}k</span>
            </label>
            <button
              type="button"
              className="proj-settings-clear"
              onClick={() => { setSettingsOpen(false); onClearContext?.() }}
            >
              Clear context cache
            </button>
          </div>
        )}
      </>, contextSlot)}
    </div>
  )
})

export default ProjectSwitcher
