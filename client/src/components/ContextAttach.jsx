import { useEffect, useRef, useState } from 'react'

// Minimal stroke paperclip, matching the app's other line icons (currentColor so
// it inherits the button/chip colour and hover state).
function Paperclip({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

// Attach a single project file as extra context for a chat. `value` is the
// attached file's id (or null); `onChange(id | null)` sets or clears it. Limited
// to one file for now: once one is attached we show a chip instead of the picker.
export default function ContextAttach({ files, value, onChange, disabled = false }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef(null)

  // Close the picker on a click outside it.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const selected = value ? files.find((f) => f.id === value) : null
  if (selected) {
    const name = selected.relPath.split('/').pop()
    return (
      <div className="ctx-attach">
        <span className="ctx-chip" title={`Context: ${selected.relPath}`}>
          <Paperclip size={13} />
          <span className="ctx-chip-name">{name}</span>
          <button
            type="button"
            className="ctx-chip-x"
            onClick={() => onChange(null)}
            aria-label="Remove context file"
          >×</button>
        </span>
      </div>
    )
  }

  // Cap the visible rows so the popover can't overgrow and get clipped by the
  // chat panel; surplus files are reachable by typing to narrow the search.
  const MAX_ROWS = 8
  const needle = q.trim().toLowerCase()
  const filtered = needle ? files.filter((f) => f.relPath.toLowerCase().includes(needle)) : files
  const matches = filtered.slice(0, MAX_ROWS)
  const more = filtered.length - matches.length
  return (
    <div className="ctx-attach" ref={ref}>
      <button
        type="button"
        className="ctx-add"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title="Attach a project file as context"
        aria-label="Attach a project file as context"
      ><Paperclip /></button>
      {open && (
        <div className="ctx-menu">
          <input
            className="ctx-search"
            placeholder="Attach a file as context…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
          <div className="ctx-list">
            {filtered.length === 0 && <div className="ctx-empty">No files match.</div>}
            {matches.map((f) => (
              <button
                key={f.id}
                type="button"
                className="ctx-item"
                onClick={() => { onChange(f.id); setOpen(false); setQ('') }}
                title={f.relPath}
              >{f.relPath}</button>
            ))}
            {more > 0 && (
              <div className="ctx-more">+{more} more — type to narrow</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
