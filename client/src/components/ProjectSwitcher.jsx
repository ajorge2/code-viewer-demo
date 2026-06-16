import { Fragment, useEffect, useRef, useState } from 'react'
import { readFolderUpload } from '../lib/uploadFolder.js'

// Top-bar control: shows the active project and a dropdown to switch between
// registered projects or add a new one by picking a folder from your machine
// (read in the browser and uploaded — works locally and in hosted deploys).
export default function ProjectSwitcher({ projects, activeId, onSwitch, onUpload, onRemove }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  // Upload lifecycle for the picker button: '' idle, 'reading' (browser reading the
  // chosen folder — the slow part for big trees), 'uploading' (POSTing to the server).
  const [phase, setPhase] = useState('')
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

  const stackTabs = order.map((id) => projects.find((p) => p.id === id)).filter(Boolean)
  const activeIndex = stackTabs.findIndex((p) => p.id === activeId)

  // The "+" chooser, rendered in-flow so it takes its own slot and pushes the
  // following tab to the right (a normal tab-to-tab overlap) rather than covering
  // it. It trails immediately after the active tab. Hidden once we're at the cap
  // of 4 open projects — you can't add a 5th until one is removed.
  const MAX_PROJECTS = 4
  const canAdd = stackTabs.length < MAX_PROJECTS
  const chooser = canAdd ? (
    <button
      className="proj-tab proj-chooser"
      onClick={() => setOpen((o) => !o)}
      title="Choose project"
      aria-label="Choose project"
      aria-expanded={open}
    >
      <svg className={`proj-caret${open ? ' open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
  ) : null

  // --- Drag-to-reorder the active tab ---------------------------------------
  // Only the tab you're on is draggable. Nothing actually moves during the drag:
  // we just draw a blue insertion line at the gap the tab would land in, and only
  // commit the reorder on release. The "+" chooser is rendered right after the
  // active tab, so it follows the tab to its new spot after the drop.
  const onTabPointerDown = (e, id) => {
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

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // The user picked a folder: read it in the browser (filtered to source files)
  // and hand the contents up for upload.
  const onFolderChosen = async (e) => {
    // Snapshot into a real array FIRST: e.target.files is a live FileList, so the
    // `e.target.value = ''` reset below empties the very reference we'd keep —
    // which previously made length 0 and bailed before uploading. The File objects
    // themselves stay readable after the reset.
    const fileList = Array.from(e.target.files || [])
    e.target.value = '' // let the same folder be re-picked later
    if (!fileList.length) return
    setError('')
    setPhase('reading')
    try {
      const result = await readFolderUpload(fileList)
      if (!result || result.files.length === 0) {
        setError('No source files found in that folder.')
        return
      }
      setPhase('uploading')
      await onUpload(result.name, result.files)
      setOpen(false)
    } catch (err) {
      setError(err.message || 'Failed to load folder')
    } finally {
      setPhase('')
    }
  }

  return (
    <div className="proj-switch" ref={ref}>
      {stackTabs.length === 0 && (
        <button
          className="proj-tab proj-current"
          onClick={() => setOpen((o) => !o)}
          title="No project"
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
        return (
          <Fragment key={p.id}>
            <button
              ref={(el) => { tabEls.current[p.id] = el }}
              className={`proj-tab proj-stack-tab${isActive ? ' proj-current has-remove' : ''}${draggingId === p.id ? ' dragging' : ''}`}
              style={{ zIndex: isActive ? 100 : 2 + i }}
              onPointerDown={(e) => onTabPointerDown(e, p.id)}
              onPointerMove={onTabPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onClick={() => {
                if (!isActive) { onSwitch(p.id); return }
                if (suppressClick.current) { suppressClick.current = false; return }
                setOpen((o) => !o)
              }}
              title={p.absPath}
            >
              {isActive && (
                <span
                  className="proj-current-remove"
                  role="button"
                  tabIndex={0}
                  title="Remove from list"
                  aria-label={`Remove ${p.name}`}
                  onClick={(e) => { e.stopPropagation(); onRemove(p.id) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onRemove(p.id) } }}
                >
                  ×
                </span>
              )}
              <span className="proj-name">{p.name}</span>
            </button>
            {isActive && chooser}
          </Fragment>
        )
      })}
      {/* When nothing is active (no projects, or active not in the stack), trail
          the chooser at the end. */}
      {activeIndex === -1 && chooser}

      {/* Insertion indicator shown while dragging: a blue line at the gap where the
          dragged tab will land on release. Rendered last (and absolutely
          positioned) so it overlays without disturbing the tab layout. */}
      {dropLeft != null && <div className="proj-drop-line" style={{ left: dropLeft }} />}

      {open && (
        <div className="proj-menu">
          <div className="proj-list">
            {projects.length === 0 && <div className="proj-empty">No projects yet.</div>}
            {projects.map((p) => (
              <div key={p.id} className={`proj-item${p.id === activeId ? ' active' : ''}`}>
                <button
                  className="proj-item-main"
                  onClick={() => { onSwitch(p.id); setOpen(false) }}
                  title={p.absPath}
                >
                  <span className="proj-item-name">{p.name}</span>
                  <span className="proj-item-meta">
                    {p.fileCount != null ? `${p.fileCount} files` : '—'}
                    {p.resident ? '' : ' · idle'}
                  </span>
                </button>
                <button
                  className="proj-remove"
                  title="Remove from list"
                  aria-label={`Remove ${p.name}`}
                  onClick={() => onRemove(p.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div className="proj-add">
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
            <button
              className="proj-pick-btn"
              type="button"
              onClick={() => folderInputRef.current?.click()}
              disabled={!!phase}
            >
              {phase ? (
                <span className="proj-pick-spinner" aria-hidden="true" />
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
              )}
              {phase === 'reading' ? 'Reading files…' : phase === 'uploading' ? 'Uploading…' : 'Open folder…'}
            </button>
          </div>
          {error && <div className="proj-error">{error}</div>}
        </div>
      )}
    </div>
  )
}
