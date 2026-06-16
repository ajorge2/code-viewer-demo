import { useEffect, useMemo, useRef, useState } from 'react'
import { askFolder } from '../lib/api.js'
import { renderRich } from '../lib/richText.jsx'
import ContextAttach from './ContextAttach.jsx'

// Build a nested folder tree from flat relPaths.
function buildTree(files) {
  const root = { folders: new Map(), files: [] }
  for (const f of files) {
    const parts = f.relPath.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]
      if (!node.folders.has(p)) node.folders.set(p, { folders: new Map(), files: [] })
      node = node.folders.get(p)
    }
    node.files.push(f)
  }
  return root
}

// Flatten the tree into render rows. `prefix` carries, for each ancestor level,
// whether that ancestor was its parent's last child (→ no continuing vertical
// guide line at that column). `parentPath` is the folder path (relative to the
// scoped root) accumulated down to this node, used so a clicked folder row knows
// its full path.
function flatten(node, prefix, out, parentPath = '') {
  const folders = [...node.folders.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const files = [...node.files].sort((a, b) => a.relPath.localeCompare(b.relPath))
  const children = [
    ...folders.map(([name, n]) => ({ kind: 'folder', name, node: n })),
    ...files.map((f) => ({ kind: 'file', file: f })),
  ]
  children.forEach((child, idx) => {
    const isLast = idx === children.length - 1
    const depth = prefix.length
    if (child.kind === 'folder') {
      const path = parentPath ? `${parentPath}/${child.name}` : child.name
      out.push({ type: 'folder', name: child.name, path, depth, prefix: [...prefix], isLast })
      flatten(child.node, [...prefix, isLast], out, path)
    } else {
      out.push({ type: 'file', file: child.file, depth, prefix: [...prefix], isLast })
    }
  })
  return out
}

// The guide cells (vertical pass-through lines + the elbow connector).
function Guides({ depth, prefix, isLast }) {
  const cells = []
  for (let i = 0; i < depth; i++) {
    if (i < depth - 1) {
      // pass-through: vertical line continues only if that ancestor has siblings below
      cells.push(
        <span className="guide" key={i}>
          {!prefix[i] && <span className="g-vert" />}
        </span>,
      )
    } else {
      // the elbow connecting to this row
      cells.push(
        <span className="guide" key={i}>
          <span className={`g-elbow${isLast ? ' last' : ''}`} />
          <span className="g-horiz" />
        </span>,
      )
    }
  }
  return cells
}

// Escape a string for literal use inside a RegExp.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Which direct children (files/folders of the current folder) did the assistant
// name in its answer? Each becomes a one-click "jump to" button. Matching uses
// identifier boundaries so "tree.js" doesn't match inside "codeTree.js" and the
// folder "lib" doesn't match "library.js"; it's case-insensitive, and a "/" on
// either side is allowed so a path mention ("server/store.js") still resolves.
// Hits are returned in order of first appearance for natural reading order.
function mentionedRefs(text, directChildren) {
  const firstAt = (name) => {
    const m = new RegExp(`(?<![\\w-])${escapeRe(name)}(?![\\w-])`, 'i').exec(text)
    return m ? m.index : -1
  }
  const hits = []
  for (const f of directChildren.files) {
    const at = firstAt(f.name)
    if (at >= 0) hits.push({ kind: 'file', name: f.name, id: f.id, at })
  }
  for (const d of directChildren.folders) {
    const at = firstAt(d.name)
    if (at >= 0) hits.push({ kind: 'folder', name: d.name, path: d.path, at })
  }
  return hits.sort((a, b) => a.at - b.at)
}

export default function Library({
  files,
  projectDir,
  edits = {},
  loaded,
  selectedId,
  onSelect,
  onOpenFileChat,
}) {
  const [filter, setFilter] = useState('')
  // A file is "edited" if any chunk in it (the file root included) has an edit —
  // i.e. any edits key is prefixed with `${fileId}::`.
  const annotatedFiles = useMemo(() => {
    const set = new Set()
    for (const k of Object.keys(edits)) {
      const i = k.indexOf('::')
      if (i > 0) set.add(k.slice(0, i))
    }
    return set
  }, [edits])
  // Folder navigation history (relative to project root; '' = root). `histIdx`
  // points at the current entry so the chevrons can step back/forward in depth.
  const [history, setHistory] = useState([''])
  const [histIdx, setHistIdx] = useState(0)
  const cwd = history[histIdx]

  // Navigate to a folder: truncate any forward history, then push + advance.
  const setCwd = (next) => {
    if (next === cwd) return
    setHistory((h) => [...h.slice(0, histIdx + 1), next])
    setHistIdx((i) => i + 1)
  }
  const canBack = histIdx > 0
  const canFwd = histIdx < history.length - 1
  const goBack = () => canBack && setHistIdx((i) => i - 1)
  const goFwd = () => canFwd && setHistIdx((i) => i + 1)

  // Files under the current working folder, with the cwd prefix stripped so the
  // tree renders relative to it.
  const scoped = useMemo(() => {
    if (!cwd) return files
    const p = cwd + '/'
    return files
      .filter((f) => f.relPath.startsWith(p))
      .map((f) => ({ ...f, relPath: f.relPath.slice(p.length) }))
  }, [files, cwd])

  // Direct children of the current folder (files in it + immediate subfolders),
  // the candidate targets for a chat answer's jump-to buttons.
  const directChildren = useMemo(() => {
    const prefix = cwd ? `${cwd}/` : ''
    const folders = new Set()
    const filesOut = []
    for (const f of files) {
      if (prefix && !f.relPath.startsWith(prefix)) continue
      const rest = f.relPath.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) filesOut.push({ name: rest, id: f.id })
      else folders.add(rest.slice(0, slash))
    }
    return {
      files: filesOut,
      folders: [...folders].map((name) => ({ name, path: cwd ? `${cwd}/${name}` : name })),
    }
  }, [files, cwd])

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q ? scoped.filter((f) => f.relPath.toLowerCase().includes(q)) : scoped
    return flatten(buildTree(list), [], [])
  }, [scoped, filter])

  // Breadcrumb segments for the header: the project root plus each cwd part.
  const rootName = projectDir ? projectDir.replace(/^.*\//, '') : '…'
  const cwdParts = cwd ? cwd.split('/') : []

  // Folder chat — scoped to the current directory (cwd). Each folder keeps its own
  // conversation: history is stored per-cwd so navigating into a subfolder (or back
  // up to a parent via the chevrons) preserves that folder's chat rather than
  // wiping it. `busyDir` marks which folder has a request in flight.
  const [chatOpen, setChatOpen] = useState(false)
  // `chatClosing` keeps the panel mounted through its genie-out animation before
  // it unmounts (mirrors the file chat).
  const [chatClosing, setChatClosing] = useState(false)
  const [chatLogs, setChatLogs] = useState({})
  const [chatInput, setChatInput] = useState('')
  const [busyDir, setBusyDir] = useState(null)
  const [chatError, setChatError] = useState(null)
  // One optional project file attached as extra context for this folder's chat.
  const [ctxFileId, setCtxFileId] = useState(null)
  const chatScrollRef = useRef(null)
  const chatInputRef = useRef(null)
  const chatPanelRef = useRef(null)
  const chatFabRef = useRef(null)
  // Current folder's view of the per-folder state.
  const chatLog = chatLogs[cwd] || []
  const chatBusy = busyDir === cwd
  const setChatLog = (updater) =>
    setChatLogs((all) => {
      const cur = all[cwd] || []
      return { ...all, [cwd]: typeof updater === 'function' ? updater(cur) : updater }
    })
  // Open/close with the genie animation: closing keeps the panel mounted through
  // genie-out (see .lib-chat-panel.closing) before React unmounts it.
  const openChat = () => { setChatClosing(false); setChatOpen(true) }
  const closeChat = () => { if (!chatOpen) return; setChatOpen(false); setChatClosing(true) }
  // Navigating the MAIN folder view (top arrows, folder rows, breadcrumbs) dismisses
  // the folder chat — it's scoped to the folder you were looking at. The chat's own
  // in-head chevrons still re-scope it without closing, so they call goBack/goFwd
  // directly rather than through these wrappers.
  // The dismissal is INSTANT (no genie-out) — matching how the file chat vanishes on
  // a file switch. The × button and FAB still animate out via closeChat.
  const dropChat = () => { setChatOpen(false); setChatClosing(false) }
  const navBack = () => { dropChat(); goBack() }
  const navFwd = () => { dropChat(); goFwd() }
  const navToFolder = (next) => { dropChat(); setCwd(next) }
  // Input/error are transient, not part of history — clear them when the folder
  // changes; the conversation itself is preserved in chatLogs[cwd].
  useEffect(() => { setChatInput(''); setChatError(null); setCtxFileId(null) }, [cwd])
  // The panel stays open until explicitly dismissed via the × button (or the FAB
  // toggle) — clicking elsewhere on the page no longer closes it.
  useEffect(() => {
    const el = chatScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatLog, chatBusy])
  // Auto-grow the chat textarea to fit its content (capped by CSS max-height),
  // shrinking back when it's cleared after submit.
  useEffect(() => {
    const el = chatInputRef.current
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }
  }, [chatInput])

  // Jump from a chat answer to a mentioned child: open the file (closing the
  // folder chat so the file's own view/chat is visible). Subfolders just call
  // setCwd, which re-scopes this same chat to them (the cwd effect resets the log).
  // Clicking a file shortcut in a folder-chat answer opens that file AND its file
  // chat. The folder chat stays open — the two are meant to coexist.
  const openFileRef = (id) => { onOpenFileChat(id) }

  const folderLabel = cwd ? `${rootName}/${cwd}` : rootName
  const submitFolderChat = async () => {
    const q = chatInput.trim()
    if (!q || chatBusy) return
    // Pin the folder this request belongs to: setChatLog (captured from this
    // render) appends to chatLogs[dir], so the answer lands in the right folder
    // even if the user navigates away while it's in flight.
    const dir = cwd
    const ctxId = ctxFileId
    const transcript = chatLog.slice(-4).map((m) => ({ role: m.role, text: m.text }))
    setChatError(null)
    setBusyDir(dir)
    setChatLog((log) => [...log, { role: 'user', text: q }])
    setChatInput('')
    try {
      const { answer } = await askFolder(dir, q, transcript, ctxId)
      setChatLog((log) => [...log, { role: 'assistant', text: answer }])
    } catch (e) {
      setChatError(e.message || 'Something went wrong')
    } finally {
      setBusyDir((d) => (d === dir ? null : d))
    }
  }

  return (
    <aside className="library">
      <div className="lib-project" title={cwd ? `${rootName}/${cwd}` : projectDir}>
        <span className="lib-crumbs">
          {[rootName, ...cwdParts].map((part, i, arr) => (
            <span key={i}>
              {i > 0 && <span className="crumb-sep">/</span>}
              <span
                className="crumb"
                onClick={() => navToFolder(arr.slice(1, i + 1).join('/'))}
              >
                {part}
              </span>
            </span>
          ))}
          {/* Trailing slash — the folder path is written with one (matches the chat header). */}
          <span className="crumb-sep">/</span>
        </span>
        <div className="lib-nav">
          <button className="chev" onClick={navBack} disabled={!canBack} title="Back" aria-label="Back">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button className="chev" onClick={navFwd} disabled={!canFwd} title="Forward" aria-label="Forward">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      </div>
      <input
        className="filter"
        placeholder="Filter files…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="file-list">
        {!loaded && <div className="muted pad">Loading…</div>}
        {loaded && rows.length === 0 && <div className="muted pad">No matches.</div>}
        {rows.map((row, i) =>
          row.type === 'folder' ? (
            <button
              className="tree-row folder"
              key={`f-${i}`}
              onClick={() => navToFolder(cwd ? `${cwd}/${row.path}` : row.path)}
              title={`Open ${row.name}/`}
            >
              <Guides depth={row.depth} prefix={row.prefix} isLast={row.isLast} />
              <span className="tree-label">{row.name}/</span>
            </button>
          ) : (
            <button
              key={row.file.id}
              className={`tree-row file${row.file.id === selectedId ? ' active' : ''}`}
              onClick={() => onSelect(row.file.id)}
              title={row.file.relPath}
            >
              <Guides depth={row.depth} prefix={row.prefix} isLast={row.isLast} />
              <span className="tree-label">{row.file.relPath.split('/').pop()}</span>
              {annotatedFiles.has(row.file.id) && (
                <span className="mod-dot" title="Has edits" />
              )}
            </button>
          ),
        )}
      </div>

      {/* Chat about the CURRENT folder (cwd). Anchored to the folder column. */}
      <button
        ref={chatFabRef}
        className={`lib-chat-fab${chatOpen ? ' open' : ''}`}
        onClick={() => (chatOpen ? closeChat() : openChat())}
        title={`Ask about ${folderLabel}/`}
        aria-label="Ask about this folder"
      >
        {/* chat bubble with a folder glyph inside */}
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 4.5h16a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-9.5l-3.5 3v-3h-3a1.5 1.5 0 0 1-1.5-1.5V6a1.5 1.5 0 0 1 1.5-1.5z" />
          <path d="M9.4 8h1.8l.9 1h3v3.5h-5.7z" />
        </svg>
      </button>

      {(chatOpen || chatClosing) && (
        <div
          ref={chatPanelRef}
          className={`lib-chat-panel${chatClosing ? ' closing' : ''}`}
          role="dialog"
          aria-label="Ask about this folder"
          onAnimationEnd={() => { if (chatClosing) setChatClosing(false) }}
        >
          <div className="chat-head">
            <span className="chat-head-left">
              {/* Same folder history back/forward as the main UI's path chevrons —
                  navigating re-scopes this chat to the new folder. */}
              <button className="chev" onClick={goBack} disabled={!canBack} title="Back" aria-label="Back">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
              <button className="chev" onClick={goFwd} disabled={!canFwd} title="Forward" aria-label="Forward">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
              <span className="chat-title">{folderLabel}/</span>
            </span>
            <button className="chat-close" onClick={closeChat} aria-label="Close">×</button>
          </div>
          <div className="chat-body" ref={chatScrollRef}>
            {chatLog.map((m, i) => {
              const refs = m.role === 'assistant' ? mentionedRefs(m.text, directChildren) : []
              return (
                <div key={i} className={`chat-msg ${m.role}`}>
                  <div className="chat-bubble">{renderRich(m.text)}</div>
                  {refs.length > 0 && (
                    <div className="chat-refs">
                      {refs.map((r) =>
                        r.kind === 'file' ? (
                          <button
                            key={`fl-${r.id}`}
                            className="chat-ref file"
                            onClick={() => openFileRef(r.id)}
                            title={`Open ${r.name}`}
                          >
                            {r.name}
                          </button>
                        ) : (
                          <button
                            key={`fo-${r.path}`}
                            className="chat-ref folder"
                            onClick={() => setCwd(r.path)}
                            title={`Open ${r.name}/ chat`}
                          >
                            {r.name}/
                          </button>
                        ),
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {chatBusy && <div className="chat-msg assistant"><div className="chat-bubble thinking">Thinking…</div></div>}
            {chatError && <div className="chat-msg-error">{chatError}</div>}
          </div>
          <form className="chat-input-row" onSubmit={(e) => { e.preventDefault(); submitFolderChat() }}>
            <ContextAttach files={files} value={ctxFileId} onChange={setCtxFileId} disabled={chatBusy} />
            <textarea
              ref={chatInputRef}
              className="chat-input"
              rows={1}
              placeholder="Ask about this folder…"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter inserts a newline.
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitFolderChat() }
              }}
              disabled={chatBusy}
            />
            <button className="chat-send" type="submit" disabled={chatBusy || !chatInput.trim()} aria-label="Send">↑</button>
          </form>
        </div>
      )}
    </aside>
  )
}
