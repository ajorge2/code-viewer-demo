import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchRaw, fetchChunks, fetchChunksAround, askQuestion, suggestEdits } from '../lib/api.js'
import { renderRich } from '../lib/richText.jsx'
import ContextAttach from './ContextAttach.jsx'

// Map a DOM Selection endpoint (node + offset) to an absolute file char offset.
// Each rendered `.seg` carries its absolute char start in data-cs, and — by the
// render's invariant — holds exactly one text node, so the selection's offset
// within that node is a direct char delta. Returns null for points outside the
// code (gutter, padding), so the caller can fall back to the other endpoint.
function segOffset(node, offsetInNode) {
  const el = node && node.nodeType === 3 ? node.parentElement : node
  const seg = el && el.closest ? el.closest('.seg') : null
  if (!seg || seg.dataset.cs == null) return null
  return Number(seg.dataset.cs) + offsetInNode
}

// Subtle alternating bands so consecutive chunks are visually distinct. Muted,
// desaturated tones (dusty-plum / pine / sand) keep things calm and
// business-formal rather than candy-bright.
const BANDS = [
  'rgba(138,106,142,0.22)', // dusty plum (between slate-blue and maroon)
  'rgba(72,150,127,0.22)',  // dusty pine
  'rgba(206,168,82,0.22)',  // sand
]
const bandFor = (i) => BANDS[i % BANDS.length]
// Selected = the same hue but VIVID — no longer dusty — and a bit brighter, so the
// picked chunk clearly pops out of the muted unselected bands. Higher alpha lets
// the saturated hue read through instead of washing toward grey.
const BANDS_SELECTED = [
  'rgba(198,108,250,0.55)', // plum → lighter + more saturated
  'rgba(50,218,150,0.55)',  // pine → lighter + more saturated
  'rgba(255,200,52,0.58)',  // sand → lighter + more saturated
]
const bandSelectedFor = (i) => BANDS_SELECTED[i % BANDS_SELECTED.length]
// The user's own highlighted range — persists (over the code, and over any chunk
// bands) until they drag a new selection. A calm accent-blue marker.
const USER_HL = 'rgba(59, 180, 240, 0.26)'

// Split a line segment at a highlight range [hs, he), tagging the overlapping
// piece with `hl: true`. Lets the user's selection paint independently of the
// chunk segmentation. Returns 1–3 segments; non-overlapping segs pass through.
function splitSegByHighlight(s, hs, he) {
  const ce = s.cs + s.text.length
  if (he <= s.cs || hs >= ce) return [s]
  const a = Math.max(hs, s.cs)
  const b = Math.min(he, ce)
  const out = []
  if (a > s.cs) out.push({ text: s.text.slice(0, a - s.cs), ci: s.ci, cs: s.cs })
  out.push({ text: s.text.slice(a - s.cs, b - s.cs), ci: s.ci, cs: a, hl: true })
  if (b < ce) out.push({ text: s.text.slice(b - s.cs), ci: s.ci, cs: b })
  return out
}
// Glossy per-band gradients (light → deep, same muted hue) for the legend dots.
const DOT_GRADS = [
  'linear-gradient(135deg, #a78faf, #6e5573)', // dusty plum
  'linear-gradient(135deg, #74a896, #44746a)', // dusty pine
  'linear-gradient(135deg, #d3bd86, #a8893f)', // sand
]
const dotGradFor = (i) => DOT_GRADS[i % DOT_GRADS.length]

// A "word" is a maximal run of word-characters (letters, digits, underscore, $).
// Every other character (whitespace, punctuation, brackets, …) is a boundary.
const WORD_CHAR = /[\p{L}\p{N}_$]/u
const isWordChar = (ch) => ch !== undefined && WORD_CHAR.test(ch)

// An edit entry is { text, gran, depthSpread, … } (legacy entries were a bare
// string); pull the edited text out of either shape.
const editTextOf = (e) => (typeof e === 'string' ? e : e?.text)

// Character-level diff (LCS) of the original chunk code vs. the edited buffer.
// Returns the EDITED text split into lines: [{ segments: [{text, added}], dot }],
// where `added` chars are the inserted ones (blue highlight) and `dot` marks a line
// where something was removed (red gutter dot). Common prefix/suffix are trimmed
// first so a normal edit only LCS-es the small changed middle.
function charDiff(orig, edited) {
  const lim = Math.min(orig.length, edited.length);
  let p = 0;
  while (p < lim && orig[p] === edited[p]) p++;
  let s = 0;
  while (s < lim - p && orig[orig.length - 1 - s] === edited[edited.length - 1 - s]) s++;
  const a = orig.slice(p, orig.length - s);
  const b = edited.slice(p, edited.length - s);

  let mid; // ops over the changed middle: { t: 'same'|'add'|'del', ch }
  if (!a.length) mid = [...b].map((ch) => ({ t: 'add', ch }));
  else if (!b.length) mid = [...a].map((ch) => ({ t: 'del', ch }));
  else if (a.length * b.length > 4_000_000) {
    // too large to LCS — coarse fallback: whole middle removed, whole middle added
    mid = [...a].map((ch) => ({ t: 'del', ch })).concat([...b].map((ch) => ({ t: 'add', ch })));
  } else {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    mid = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) { mid.push({ t: 'same', ch: b[j] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { mid.push({ t: 'del', ch: a[i] }); i++; }
      else { mid.push({ t: 'add', ch: b[j] }); j++; }
    }
    while (i < m) { mid.push({ t: 'del', ch: a[i] }); i++; }
    while (j < n) { mid.push({ t: 'add', ch: b[j] }); j++; }
  }

  const ops = [];
  for (const ch of orig.slice(0, p)) ops.push({ t: 'same', ch });
  for (const o of mid) ops.push(o);
  for (const ch of orig.slice(orig.length - s)) ops.push({ t: 'same', ch });

  const lines = [{ segments: [], dot: false }];
  let cur = lines[0];
  const push = (ch, added) => {
    const last = cur.segments[cur.segments.length - 1];
    if (last && last.added === added) last.text += ch;
    else cur.segments.push({ text: ch, added });
  };
  for (const o of ops) {
    if (o.t === 'del') { cur.dot = true; continue; } // removed → dot on this edited line
    if (o.ch === '\n') { lines.push({ segments: [], dot: false }); cur = lines[lines.length - 1]; }
    else push(o.ch, o.t === 'add');
  }
  return lines;
}

export default function CodeViewer({
  file, files = [], chunkSize, onChunkSize, edits, setEdits, jumpTarget, onJumpConsumed, onJumpToEdit,
  locked = false, controlsReady = true,
}) {
  const [text, setText] = useState('')
  const [resp, setResp] = useState(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  // Chunking mode. Default (both null/false) = whole file as one chunk. Highlight
  // a region → `pendingRange` drives "chunk around that range". Moving an Advanced
  // slider → `manualMode` drives the granularity/depth chunking. Last action wins.
  const [pendingRange, setPendingRange] = useState(null) // { start, end } | null
  const [manualMode, setManualMode] = useState(false)
  // edits are lifted to App (shared with the Library dot + history); keyed by
  // `${fileId}::${nodeId}`. Each value is { text, gran, depthSpread, subOn,
  // subWords, fileId, relPath, nodeId, label, ts } — config captured at edit time.
  const [historyIdx, setHistoryIdx] = useState(0) // edit-history carousel position
  const pendingJumpRef = useRef(null) // nodeId to select once chunks reflect a jump
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Chunk band highlights are off by default — usually you don't need to see the
  // other chunks, just work with your highlighted target. Toggle in the toolbar.
  const [showChunks, setShowChunks] = useState(false)
  // Show/hide the bottom half of the toolbar (toggle + depth/sub sliders).
  // Collapsed by default — the extra controls are revealed via the chevron.
  const [bottomOpen, setBottomOpen] = useState(false)
  // RAG Q&A chat panel (scaffold — backend wired later). `chatClosing` keeps the
  // panel mounted through its genie close animation before it unmounts.
  const [chatOpen, setChatOpen] = useState(false)
  const [chatClosing, setChatClosing] = useState(false)
  const chatPanelRef = useRef(null)
  const chatFabRef = useRef(null)
  // Opening the Q&A reveals the chunk highlights — the chunking is configured
  // (around your highlight) and you're ready to ask. Closing returns to the clean
  // view. The toolbar toggle still overrides while the chat is closed.
  const openChat = () => { setChatClosing(false); setChatOpen(true); setShowChunks(true) }
  const closeChat = () => { setChatOpen(false); setChatClosing(true); setShowChunks(false) }
  // Q&A transcript for the current file: [{ role, text, path?, depth?, atBottom? }].
  const [chatLog, setChatLog] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [chatError, setChatError] = useState(null)
  // One optional project file attached as extra context for this file's Q&A.
  const [ctxFileId, setCtxFileId] = useState(null)
  const [suggestBusy, setSuggestBusy] = useState(false) // an edit request in flight
  // "Suggest edits" mode: while on, messages you send are treated as edit
  // instructions — the LLM revises the file in the Edits drawer instead of answering.
  const [editMode, setEditMode] = useState(false)
  const chatScrollRef = useRef(null)
  const chatInputRef = useRef(null)
  // Per-line drill state: the depth reached, which node the line is about (a
  // selection change is a hard reset), and the last question (for the "More
  // detail" button to re-ask deeper).
  const [chatDepth, setChatDepth] = useState(0)
  const [chatNodeId, setChatNodeId] = useState(null)
  const [lastQuestion, setLastQuestion] = useState('')

  // Close the Q&A panel on a click anywhere outside it (the FAB handles its own
  // toggle, so ignore clicks on it to avoid double-firing).
  useEffect(() => {
    if (!chatOpen) return
    const onDown = (e) => {
      if (chatPanelRef.current?.contains(e.target)) return
      if (chatFabRef.current?.contains(e.target)) return
      // Don't close just because the user opened/clicked the folder chat — the two
      // are meant to coexist. Only true outside clicks dismiss this panel.
      if (e.target.closest?.('.lib-chat-panel, .lib-chat-fab')) return
      closeChat()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [chatOpen])
  // Sub-splitter: when on, break each chunk into pieces of `subWords` words.
  // Off by default; resets whenever the granularity slider moves.
  const [subOn, setSubOn] = useState(false)
  const [subWords, setSubWords] = useState(500)
  // Depth-spread tolerance D for JSON frontier expansion: 0 = even depth, up to
  // 5, and 6 on the slider = ∞ (pure largest-first / size priority).
  const [depthSpread, setDepthSpread] = useState(1)
  // Show the scrollbar while scrolling, then fade it out after a quiet spell.
  const [scrolling, setScrolling] = useState(false)
  const hideTimer = useRef(null)
  const scrollRef = useRef(null)
  const lineEls = useRef({}) // line index -> element
  const editBackRef = useRef(null) // diff backdrop behind the Edits textarea

  const onScroll = () => {
    setScrolling(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setScrolling(false), 3000)
  }
  useEffect(() => () => clearTimeout(hideTimer.current), [])

  const baseChunks = resp?.chunks ?? []
  // id -> { id, parent, label, start, end, depth, semantic, hash }. Stable across
  // granularity changes; lets us reconstruct any chunk's structural ancestry.
  const nodes = resp?.nodes ?? {}
  // The file's root node (parent === null). Its contextual meaning has no outside
  // context to fold in, so it IS the whole-file meaning — that's what a question
  // with no chunk selected targets.
  const rootNodeId = Object.keys(nodes).find((id) => nodes[id].parent === null) || null

  // Root-first ancestor path for a node id, kept to real structural units: drop
  // synthetic balancing groups, the file root (implied), and collapse the
  // consecutive duplicate labels JSON's key/value boxes produce.
  const nodePath = (nodeId) => {
    const chain = []
    let id = nodeId
    while (id && nodes[id]) { chain.push(nodes[id]); id = nodes[id].parent }
    chain.reverse()
    return chain.filter((n, i) => n.semantic && n.parent !== null && n.label !== chain[i - 1]?.label)
  }

  // Displayed chunks: optionally the base chunks split further by WORD count.
  // Words are counted (runs of word-chars); the non-word characters between them
  // stay part of the chunk but don't add to the count. Cuts fall at word starts
  // so coverage stays contiguous.
  const chunks = useMemo(() => {
    if (!subOn) return baseChunks
    const out = []
    let idx = 0
    for (const c of baseChunks) {
      // Offsets where a word begins within this chunk.
      const wordStarts = []
      for (let p = c.start; p < c.end; p++) {
        if (isWordChar(text[p]) && (p === c.start || !isWordChar(text[p - 1]))) wordStarts.push(p)
      }
      const numWords = wordStarts.length
      // Sub-chunks are sub-regions of one box node, so they all inherit its
      // nodeId — their structural ancestry (and cached meaning) is the node's.
      if (numWords <= subWords) {
        out.push({ index: idx++, start: c.start, end: c.end, label: c.label, nodeId: c.nodeId })
        continue
      }
      const total = Math.ceil(numWords / subWords)
      const bounds = [c.start]
      for (let k = subWords; k < numWords; k += subWords) bounds.push(wordStarts[k])
      bounds.push(c.end)
      for (let i = 0; i < bounds.length - 1; i++) {
        out.push({ index: idx++, start: bounds[i], end: bounds[i + 1], label: `${c.label} (${i + 1}/${total})`, nodeId: c.nodeId })
      }
    }
    return out
  }, [baseChunks, subOn, subWords, text])

  // The node a question targets: the selected chunk, or the whole file (root) when
  // nothing is selected. At granularity 1 the only chunk IS the root, so selecting
  // it and asking about the whole file are the same request.
  const targetNodeId = (selected != null && chunks[selected]?.nodeId) || rootNodeId

  // What the Edits pane operates on: the selected chunk, or — when nothing is
  // selected — the whole file (its root node), which is just a chunk too. So you
  // can always edit something: a chunk, or the entire file.
  const selChunk = selected != null ? chunks[selected] : null
  const editNode = selChunk
    ? { nodeId: selChunk.nodeId, label: selChunk.label, code: text.slice(selChunk.start, selChunk.end) }
    : (rootNodeId && text ? { nodeId: rootNodeId, label: 'Whole file', code: text } : null)
  const editKey = editNode ? `${file.id}::${editNode.nodeId}` : null
  // `selCode` is the target's exact source — the starting point the Edits pane
  // falls back to.
  const selCode = editNode ? editNode.code : ''
  // Edits buffer (falls back to the original code) + its char-diff against it.
  const editBuf = editKey ? (editTextOf(edits[editKey]) ?? selCode) : ''
  const isEdited = editKey != null && edits[editKey] !== undefined && editTextOf(edits[editKey]) !== selCode
  const editLines = useMemo(
    () => (editKey ? charDiff(selCode, editBuf) : []),
    [editKey, selCode, editBuf],
  )
  // Edits for THIS file (keys are `${fileId}::${nodeId}`), newest first — the
  // carousel's contents. Scoped per-file so the history follows the open file.
  const editHistory = useMemo(
    () => Object.entries(edits)
      .filter(([key]) => key.startsWith(`${file.id}::`))
      .map(([key, v]) => (typeof v === 'string' ? { key, text: v } : { key, ...v }))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0)),
    [edits, file.id],
  )
  const histIdx = editHistory.length ? Math.min(historyIdx, editHistory.length - 1) : 0
  const histEntry = editHistory[histIdx]

  // Reset the sub-splitter (called when granularity changes or the file changes).
  const resetSub = () => { setSubOn(false); setSubWords(500) }
  // Switch to manual (Advanced-slider) chunking, leaving highlight mode.
  const enterManual = () => { setManualMode(true); setPendingRange(null) }

  // Ask about the selected chunk. Sends its stable nodeId (resolves regardless of
  // granularity) plus the per-line drill state. A selection change vs. the line's
  // node is a hard reset (depth 0, no carried transcript).
  const runAsk = async ({ question, intent, userBubble }) => {
    if (!targetNodeId || chatBusy) return
    const sameNode = targetNodeId === chatNodeId
    const depth = sameNode ? chatDepth : 0
    const transcript = sameNode ? chatLog.slice(-4).map((m) => ({ role: m.role, text: m.text })) : []
    setChatError(null)
    setChatBusy(true)
    if (userBubble) setChatLog((log) => [...log, userBubble])
    try {
      const r = await askQuestion(file.id, targetNodeId, question, { depth, intent, transcript, contextFileId: ctxFileId })
      setChatDepth(r.depth ?? 0)
      setChatNodeId(targetNodeId)
      setLastQuestion(question)
      setChatLog((log) => [...log, {
        role: 'assistant', text: r.answer, path: r.path, depth: r.depth ?? 0, atBottom: !!r.atBottom,
      }])
    } catch (e) {
      setChatError(e.message || 'Something went wrong')
    } finally {
      setChatBusy(false)
    }
  }

  const submitChat = () => {
    const q = chatInput.trim()
    if (!q || chatBusy || suggestBusy) return
    setChatInput('')
    if (editMode) runSuggest(q)
    else runAsk({ question: q, intent: 'infer', userBubble: { role: 'user', text: q } })
  }

  // "More detail": re-ask the last question one level deeper (deterministic).
  const deepen = () => {
    if (!lastQuestion || chatBusy) return
    runAsk({ question: lastQuestion, intent: 'deepen', userBubble: { role: 'user', text: 'More detail', deepen: true } })
  }

  // Toggle "Suggest edits" mode. Turning it on opens the Edits drawer so the
  // changes your next message makes are visible.
  const toggleEditMode = () => {
    if (!editKey) return
    setEditMode((on) => {
      if (!on) setDrawerOpen(true)
      return !on
    })
  }

  // In edit mode, a submitted message is an instruction: the LLM revises the
  // edit target (selected chunk, or the whole file) and the result lands in the
  // Edits drawer. The conversation is carried along for context.
  const runSuggest = async (instruction) => {
    if (!editKey || !editNode || suggestBusy || chatBusy) return
    setSuggestBusy(true)
    setChatError(null)
    setDrawerOpen(true)
    const transcript = chatLog.slice(-6).map((m) => ({ role: m.role, text: m.text }))
    const base = editBuf // revise the current draft, so edits stack across messages
    setChatLog((log) => [...log, { role: 'user', text: instruction, edit: true }])
    try {
      const r = await suggestEdits(file.id, editNode.nodeId, { instruction, transcript, baseCode: base })
      const proposed = typeof r.code === 'string' ? r.code : ''
      if (proposed && proposed !== base) {
        setEdits((m) => {
          const c = { ...m }
          if (proposed === selCode) delete c[editKey] // back to the original → no edit
          else c[editKey] = {
            text: proposed,
            around: pendingRange, gran: chunkSize, depthSpread, subOn, subWords,
            fileId: file.id, relPath: file.relPath, nodeId: editNode.nodeId, label: editNode.label,
            ts: Date.now(),
          }
          return c
        })
        setChatLog((log) => [...log, { role: 'assistant', text: `Updated ${editNode.label === 'Whole file' ? 'the file' : editNode.label} in the editor →`, edits: true }])
      } else {
        setChatLog((log) => [...log, { role: 'assistant', text: 'That didn\'t call for a code change, so I left it as is.', edits: true }])
      }
    } catch (e) {
      setChatError(e.message || 'Failed to suggest edits')
    } finally {
      setSuggestBusy(false)
    }
  }

  // Keep the Q&A transcript pinned to the latest message.
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

  // Load raw source when the file changes; clear the Q&A transcript (new context).
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setSelected(null)
    resetSub()
    setPendingRange(null); setManualMode(false) // new file opens as one whole-file chunk
    setChatLog([]); setChatInput(''); setChatError(null); setCtxFileId(null)
    setChatDepth(0); setChatNodeId(null); setLastQuestion(''); setEditMode(false)
    setHistoryIdx(0) // restart the edit-history carousel for the new file
    fetchRaw(file.id).then((t) => !cancelled && setText(t)).catch(() => {})
    return () => { cancelled = true }
  }, [file.id])

  // (Re)chunk on any change to the chunking inputs — debounced so dragging stays
  // smooth. Three modes: highlight (chunk around the selected range), manual (the
  // Advanced granularity/depth sliders), or the default whole-file single chunk.
  useEffect(() => {
    let cancelled = false
    const sendD = depthSpread >= 6 ? 50 : depthSpread // 6 on the slider = ∞
    const t = setTimeout(() => {
      const req = pendingRange
        ? fetchChunksAround(file.id, pendingRange.start, pendingRange.end)
        : (manualMode ? fetchChunks(file.id, chunkSize, sendD) : fetchChunks(file.id, 1, 0))
      req
        .then((r) => {
          if (cancelled) return
          setResp(r); setLoading(false)
          // Highlight mode: auto-select the tightest-fit chunk by its stable id.
          if (r.targetNodeId) {
            const idx = (r.chunks || []).findIndex((c) => c.nodeId === r.targetNodeId)
            if (idx >= 0) setSelected(idx)
          }
        })
        .catch(() => !cancelled && setLoading(false))
    }, 80)
    return () => { cancelled = true; clearTimeout(t) }
  }, [file.id, pendingRange, manualMode, chunkSize, depthSpread])

  // Edit-history jump: restore the chunking that produced the edit, then remember
  // the nodeId to select once the re-chunk lands. (Runs after the file-load effect
  // above, so it wins over the reset on a switch.) Highlight-mode edits carry an
  // `around` range; older edits carry gran/depth/sub (legacy manual fallback).
  useEffect(() => {
    if (!jumpTarget || jumpTarget.fileId !== file.id) return
    if (jumpTarget.around) {
      setManualMode(false)
      resetSub()
      setPendingRange(jumpTarget.around)
    } else {
      setManualMode(true)
      setPendingRange(null)
      setDepthSpread(jumpTarget.depthSpread ?? 1)
      setSubOn(!!jumpTarget.subOn)
      setSubWords(jumpTarget.subWords ?? 500)
    }
    pendingJumpRef.current = jumpTarget.nodeId
    onJumpConsumed?.()
    // Immediate try (same-config jumps won't re-chunk); the effect below catches
    // jumps that do re-chunk. A short window lets selection track the settling
    // chunk list (selection is by index, which shifts as the frontier changes).
    const idx = chunks.findIndex((c) => c.nodeId === jumpTarget.nodeId)
    if (idx >= 0) setSelected(idx)
    const t = setTimeout(() => { pendingJumpRef.current = null }, 700)
    return () => clearTimeout(t)
  }, [jumpTarget, file.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // While a jump is settling, re-select the jumped-to node whenever the frontier
  // updates, so the right chunk stays selected across the re-chunk(s).
  useEffect(() => {
    if (!pendingJumpRef.current || loading) return
    const idx = chunks.findIndex((c) => c.nodeId === pendingJumpRef.current)
    if (idx >= 0) setSelected(idx)
  }, [chunks, loading]) // eslint-disable-line react-hooks/exhaustive-deps

  const lines = useMemo(() => text.split('\n'), [text])

  // Char offset where each line starts (lineStart[k+1] counts the '\n').
  const lineStart = useMemo(() => {
    const arr = new Array(lines.length + 1)
    arr[0] = 0
    for (let k = 0; k < lines.length; k++) arr[k + 1] = arr[k] + lines[k].length + 1
    return arr
  }, [lines])

  function lineOf(offset) {
    let lo = 0, hi = lines.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStart[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  // char index -> chunk index (or -1 if it belongs to no chunk). Chunks are a
  // flat, sorted, non-overlapping cover of the file (tree boxes / their contiguous
  // sub-splits), so a binary search over [start, end) intervals answers this
  // without allocating and filling a per-character array across the whole file.
  const chunkAt = useMemo(() => {
    const ivs = chunks
      .map((c) => ({ start: c.start, end: c.end, index: c.index }))
      .sort((a, b) => a.start - b.start)
    return (pos) => {
      let lo = 0, hi = ivs.length - 1, ans = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (ivs[mid].start <= pos) { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
      }
      // The candidate is the last interval starting at/before pos; it only owns
      // pos if pos is also before its end (otherwise pos sits in a gap → -1).
      return ans !== -1 && pos < ivs[ans].end ? ivs[ans].index : -1
    }
  }, [chunks])

  // Only render the lines the chunks actually cover (drop leading/trailing slack).
  const firstLine = chunks.length ? lineOf(chunks[0].start) : 0
  const lastLine = chunks.length
    ? lineOf(Math.max(chunks[0].start, chunks[chunks.length - 1].end - 1))
    : -1

  // Line numbers whose chunk has a real edit → blue margin dot.
  const annotatedLines = new Set()
  for (const c of chunks) {
    if (!c.nodeId) continue
    const ed = edits[`${file.id}::${c.nodeId}`]
    const t = editTextOf(ed)
    if (t !== undefined && t !== text.slice(c.start, c.end)) annotatedLines.add(lineOf(c.start))
  }

  // Slider semantics depend on the chunking kind. "Structural" = tree-based
  // (JSON or tree-sitter code): granularity = box count, depth-spread applies.
  const kind = resp?.kind ?? (file.language === 'json' ? 'json' : 'generic')
  const isStructural = kind === 'json' || kind === 'code' || kind === 'generic'
  const maxBoxes = Math.max(1, resp?.maxBoxes ?? 1)
  // Grammar-based (json/code) → full granularity, down to token level. The generic
  // (grammar-less) fallback → capped, so huge files don't get an absurdly sensitive slider.
  const GRAN_CAP = 500
  const sliderMax =
    kind === 'json' || kind === 'code'
      ? maxBoxes
      : Math.min(GRAN_CAP, maxBoxes)
  // In highlight mode the Advanced sliders reflect the chunking actually in use:
  // granularity = the current chunk count, and the minimal path-decomposition is a
  // maximally-uneven cut, so depth-spread reads as ∞. (Display only — grabbing a
  // slider switches to manual mode from these values.)
  const shownSize = pendingRange ? Math.min(chunks.length, sliderMax) : Math.min(chunkSize, sliderMax)
  const shownDepth = pendingRange ? 6 : depthSpread

  // Scroll to a chunk's first line when selected.
  useEffect(() => {
    if (selected == null) return
    const c = chunks[selected]
    if (!c) return
    const el = lineEls.current[lineOf(c.start)]
    const container = scrollRef.current
    if (el && container) {
      const top = el.offsetTop - container.clientHeight / 2 + 40
      container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    }
  }, [selected, resp]) // eslint-disable-line react-hooks/exhaustive-deps

  // Build colored segments for one line (runs of the same chunk index). Each
  // segment also carries `cs` — its absolute char start — so a text selection can
  // be mapped back to file offsets (see segOffset).
  function segmentsFor(k) {
    const ls = lineStart[k]
    const line = lines[k]
    if (line.length === 0) {
      const ci = chunkAt(ls)
      return [{ text: ' ', ci, cs: ls }]
    }
    const segs = []
    let start = 0
    let cur = chunkAt(ls)
    for (let p = 1; p < line.length; p++) {
      const ci = chunkAt(ls + p)
      if (ci !== cur) { segs.push({ text: line.slice(start, p), ci: cur, cs: ls + start }); start = p; cur = ci }
    }
    segs.push({ text: line.slice(start), ci: cur, cs: ls + start })
    return segs
  }

  // A text selection in the code → "chunk around this range". Resolve both
  // selection endpoints to file char offsets; fall back to whichever resolves.
  const onCodeMouseUp = () => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const r = sel.getRangeAt(0)
    if (sel.isCollapsed) {
      // A plain click (no drag). In the clean view, clicking outside the current
      // highlight clears it — back to nothing highlighted (whole file).
      if (!showChunks && pendingRange) {
        const pos = segOffset(r.startContainer, r.startOffset)
        if (pos == null || pos < pendingRange.start || pos >= pendingRange.end) {
          setPendingRange(null); setManualMode(false); setSelected(null)
        }
      }
      return
    }
    const a = segOffset(r.startContainer, r.startOffset)
    const b = segOffset(r.endContainer, r.endOffset)
    if (a == null && b == null) return // selection outside the code
    let start = a == null ? b : a
    let end = b == null ? a : b
    if (end < start) { const tmp = start; start = end; end = tmp }
    sel.removeAllRanges() // drop the native blue selection; the chunk band replaces it
    resetSub()
    setManualMode(false)
    setPendingRange({ start, end })
  }

  return (
    <div className={`viewer${locked ? ' locked' : ''}${controlsReady ? '' : ' controls-hidden'}`}>
      <div className="viewer-toolbar">
        <div className={`toolbar-top${bottomOpen ? ' open' : ''}`}>
          <div className="vt-file-row">
            <span className="vt-path">{file.relPath}</span>
          </div>
          <div className="gran-row">
            <span className="chunk-count"><b>{chunks.length}</b> chunks</span>
            <span className="gran-divider" aria-hidden="true" />
            <span className="gran-hint">
              {pendingRange
                ? 'Chunked around your highlight'
                : (manualMode ? 'Manual chunking (Advanced)' : 'Highlight code to chunk around it')}
            </span>
          </div>
          <button
            type="button"
            className="bottom-toggle"
            onClick={() => setBottomOpen((o) => !o)}
            title={bottomOpen ? 'Hide controls' : 'Show controls'}
            aria-label={bottomOpen ? 'Hide controls' : 'Show controls'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2.5"
                 strokeLinecap="round" strokeLinejoin="round">
              <polyline points={bottomOpen ? '6 15 12 9 18 15' : '6 9 12 15 18 9'} />
            </svg>
          </button>
        </div>
        <div className={`toolbar-bottom-wrap${bottomOpen ? ' open' : ''}`}>
        <div className="toolbar-bottom">
          <button
            className={`chunk-toggle${showChunks ? ' active' : ''}`}
            onClick={() => setShowChunks((s) => !s)}
            title={showChunks ? 'Hide chunk highlights' : 'Show chunk highlights'}
            aria-label={showChunks ? 'Hide chunk highlights' : 'Show chunk highlights'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="1.3"
                 strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="6" rx="1.5" />
              <rect x="3" y="14" width="18" height="6" rx="1.5" />
              {!showChunks && <line x1="3" y1="21" x2="21" y2="3" />}
            </svg>
          </button>
          <div className="slider-stack">
            {/* Manual granularity (Advanced fallback to highlighting). */}
            <label className="slider-wrap gran">
              <span className="slider-label">Granularity</span>
              <input
                type="range"
                min="1"
                max={sliderMax}
                step="1"
                value={shownSize}
                style={{ '--pct': `${((shownSize - 1) / Math.max(1, sliderMax - 1)) * 100}%` }}
                onChange={(e) => {
                  enterManual()
                  onChunkSize(Number(e.target.value))
                  setShowChunks(true)
                  resetSub()
                  setSelected(null)
                }}
              />
              <span className="slider-val" aria-hidden="true" />
            </label>
            {isStructural && (
              <label className="slider-wrap">
                <button
                  type="button"
                  role="switch"
                  aria-checked={shownDepth > 0}
                  className={`switch${shownDepth > 0 ? ' on' : ''}`}
                  onClick={() => { enterManual(); setDepthSpread((d) => (d > 0 ? 0 : 1)); setSelected(null) }}
                  title={shownDepth > 0 ? 'Disable depth spread' : 'Enable depth spread'}
                >
                  <span className="switch-knob" />
                </button>
                <span className="slider-label">Depth spread</span>
                <span className="range-ticks-wrap">
                  <input
                    type="range"
                    min="0"
                    max="6"
                    step="1"
                    className={shownDepth === 0 ? 'off' : ''}
                    value={shownDepth}
                    style={{ '--pct': `${(shownDepth / 6) * 100}%` }}
                    onChange={(e) => { enterManual(); setDepthSpread(Number(e.target.value)); setSelected(null) }}
                  />
                  <span className="range-ticks">
                    <svg width="200" height="6" shapeRendering="crispEdges">
                      {[1, 2, 3, 4, 5].filter((v) => v !== shownDepth).map((v) => (
                        <rect key={v} x={7 + (v / 6) * 186 - 1} y="0" width="2" height="6" fill="#ffffff" />
                      ))}
                    </svg>
                  </span>
                </span>
                <span className="slider-val">{shownDepth >= 6 ? '∞' : shownDepth}</span>
              </label>
            )}
            <label className="slider-wrap sub">
              <button
                type="button"
                role="switch"
                aria-checked={subOn}
                className={`switch${subOn ? ' on' : ''}`}
                onClick={() => {
                  enterManual()
                  if (subOn) { setSubOn(false); setSubWords(500) } // park at the off position
                  else setSubOn(true)
                  setSelected(null)
                }}
                title={subOn ? 'Disable word sub-splitting' : 'Enable word sub-splitting'}
              >
                <span className="switch-knob" />
              </button>
              <span className="slider-label">Sub-split</span>
              <input
                type="range"
                min="1"
                max="500"
                step="1"
                /* Inverted: left = 500 words, right = 1. The DOM value is the
                   mirror (501 - subWords); we map back on change. */
                value={501 - subWords}
                className={!subOn ? 'off' : ''}
                style={{ '--pct': `${((500 - subWords) / 499) * 100}%` }}
                onChange={(e) => {
                  enterManual()
                  setSubWords(501 - Number(e.target.value))
                  if (!subOn) setSubOn(true) // sliding turns it on (500 stays on)
                  setSelected(null)
                }}
              />
              <span className="slider-val sub-val">{subOn ? `${subWords} w` : 'off'}</span>
            </label>
          </div>
        </div>
        </div>
      </div>

      <div className={`viewer-body${drawerOpen ? ' drawer-open' : ''}${locked ? ' locked' : ''}`}>
        <div className={`code-scroll${scrolling ? ' scrolling' : ''}`} ref={scrollRef} onScroll={onScroll} onMouseUp={onCodeMouseUp}>
          <div className={`code${showChunks ? ' bands' : ''}`}>
            {lines.map((line, k) => {
              if (k < firstLine || k > lastLine) return null
              // Segments always carry data-cs (so drag-to-highlight maps to char
              // offsets), but a band is painted only when chunk highlights are on
              // OR the segment is the selected chunk — so the default view is clean
              // while your highlighted target still shows.
              return (
                <div key={k} className="code-line" data-ln={k} ref={(el) => { if (el) lineEls.current[k] = el }}>
                  {annotatedLines.has(k) && <span className="ln-dot" title="Has edits" />}
                  <span className="ln">{k + 1}</span>
                  <span className="lc">
                    {(pendingRange
                      ? segmentsFor(k).flatMap((s) => splitSegByHighlight(s, pendingRange.start, pendingRange.end))
                      : segmentsFor(k)
                    ).map((s, j) => {
                      const isSel = showChunks && s.ci === selected
                      // The user's highlight wins the background; else a chunk band
                      // (only while bands are shown).
                      const bg = s.hl ? USER_HL : (showChunks && s.ci !== -1 ? (isSel ? bandSelectedFor(s.ci) : bandFor(s.ci)) : undefined)
                      return (
                        <span
                          key={j}
                          className={`seg${s.ci === -1 ? ' plain-seg' : ''}${isSel ? ' sel' : ''}${s.hl ? ' user-hl' : ''}`}
                          data-cs={s.cs}
                          style={bg ? { background: bg } : undefined}
                          onClick={(s.ci === -1 || !showChunks) ? undefined : () => setSelected(s.ci)}
                        >
                          {s.text}
                        </span>
                      )
                    })}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        <button
          className="drawer-handle"
          style={{ right: drawerOpen ? '50%' : 0 }}
          onClick={() => { if (!locked) setDrawerOpen((o) => !o) }}
          disabled={locked}
          title={locked ? 'Close the welcome panel first' : (drawerOpen ? 'Hide chunk list' : 'Show chunk list')}
          aria-label={drawerOpen ? 'Hide chunk list' : 'Show chunk list'}
        >
          <span className="dh-icon">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2.5"
                 strokeLinecap="round" strokeLinejoin="round">
              <polyline points={drawerOpen ? '9 6 15 12 9 18' : '15 6 9 12 15 18'} />
            </svg>
          </span>
        </button>

        <aside className={`chunk-list${drawerOpen ? '' : ' closed'}`}>
          {/* Top half: an editable copy of the selected chunk's code (starts as the
              original). Added chars are highlighted; a red gutter dot marks lines
              where something was removed. Edits never touch the file. */}
          <div className="cl-pane">
            <div className="cl-pane-head cl-edit-head">
              <span>Edits{editNode ? <span className="cl-pane-for"> · {editNode.label}</span> : ''}</span>
              <button
                className="cl-reset"
                onClick={() => editKey && setEdits((m) => { const c = { ...m }; delete c[editKey]; return c })}
                disabled={!isEdited}
                title="Reset to the original code"
              >reset</button>
            </div>
            <div className="cl-edit-wrap">
              <div className="cl-edit-back" ref={editBackRef} aria-hidden="true">
                {editLines.map((ln, k) => (
                  <div key={k} className="cl-edit-line">
                    {ln.dot && <span className="cl-edit-dot" />}
                    {ln.segments.length === 0
                      ? '​'
                      : ln.segments.map((sg, si) => (
                        sg.added
                          ? <span key={si} className="cl-edit-add">{sg.text}</span>
                          : <span key={si}>{sg.text}</span>
                      ))}
                  </div>
                ))}
              </div>
              <textarea
                className="cl-edit-ta"
                spellCheck={false}
                value={editBuf}
                onChange={(e) => editKey && setEdits((m) => {
                  const c = { ...m }
                  if (e.target.value === selCode) delete c[editKey]
                  else c[editKey] = {
                    text: e.target.value,
                    around: pendingRange, gran: chunkSize, depthSpread, subOn, subWords,
                    fileId: file.id, relPath: file.relPath, nodeId: editNode.nodeId, label: editNode.label,
                    ts: Date.now(),
                  }
                  return c
                })}
                onScroll={(e) => { if (editBackRef.current) editBackRef.current.scrollTop = e.target.scrollTop }}
                disabled={!editKey}
              />
            </div>
          </div>
          {/* Bottom half: edit-history carousel — scroll through every saved edit;
              jumping restores that edit's file + slider config and selects the chunk. */}
          <div className="cl-pane cl-history">
            <div className="cl-pane-head cl-edit-head">
              <span>Edit history{editHistory.length ? ` · ${histIdx + 1}/${editHistory.length}` : ''}</span>
              <span className="cl-hist-nav">
                <button
                  className="cl-hist-arrow"
                  onClick={() => setHistoryIdx((i) => Math.max(0, (editHistory.length ? Math.min(i, editHistory.length - 1) : 0) - 1))}
                  disabled={editHistory.length < 2 || histIdx === 0}
                  aria-label="Previous edit"
                >‹</button>
                <button
                  className="cl-hist-arrow"
                  onClick={() => setHistoryIdx((i) => Math.min(editHistory.length - 1, (editHistory.length ? Math.min(i, editHistory.length - 1) : 0) + 1))}
                  disabled={editHistory.length < 2 || histIdx >= editHistory.length - 1}
                  aria-label="Next edit"
                >›</button>
              </span>
            </div>
            {histEntry ? (
              <button
                className="cl-hist-card"
                onClick={() => onJumpToEdit?.(histEntry)}
                title="Jump to this chunk with its original slider settings"
              >
                <div className="cl-hist-loc">
                  {histEntry.relPath || file.relPath}
                  {histEntry.label ? <span className="cl-hist-chunk"> › {histEntry.label}</span> : ''}
                </div>
                <pre className="cl-hist-preview">{(editTextOf(histEntry) || '').slice(0, 400)}</pre>
              </button>
            ) : (
              <div className="cl-pane-empty">No edits yet.</div>
            )}
          </div>
        </aside>

        {/* RAG Q&A: floating chat over the file view (clears the drawer when open). */}
        {(chatOpen || chatClosing) && (
          <div
            ref={chatPanelRef}
            className={`chat-panel${chatClosing ? ' closing' : ''}`}
            role="dialog"
            aria-label="Ask about this file"
            onAnimationEnd={() => { if (chatClosing) setChatClosing(false) }}
          >
            <div className="chat-head">
              <span className="chat-title">Ask about this file</span>
              <button className="chat-close" onClick={closeChat} aria-label="Close chat">×</button>
            </div>
            {targetNodeId && (
              <div className="chat-context">
                <span className="chat-ctx-info">
                  {selected != null && chunks[selected] ? (
                    <>
                      <span className="chat-ctx-chunk">chunk #{selected + 1} · {chunks[selected].label}</span>
                      {nodePath(chunks[selected].nodeId).length > 0 && (
                        <span className="chat-ctx-path">
                          {nodePath(chunks[selected].nodeId).map((n, i, a) => (
                            <span key={n.id} className="chat-ctx-crumb">
                              {n.label}
                              {i < a.length - 1 && <span className="chat-ctx-sep"> › </span>}
                            </span>
                          ))}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="chat-ctx-chunk">Whole file</span>
                  )}
                </span>
                {editKey && (
                  <button
                    type="button"
                    className={`chat-suggest sm${editMode ? ' active' : ''}`}
                    onClick={toggleEditMode}
                    aria-pressed={editMode}
                    title={editMode
                      ? 'Turn off edit mode — back to Q&A'
                      : (selChunk ? 'Edit this chunk by chatting' : 'Edit the whole file by chatting')}
                  >
                    ✎ Suggest edits · {editMode ? 'on' : 'off'}
                  </button>
                )}
              </div>
            )}
            <div className="chat-body" ref={chatScrollRef}>
              {chatLog.map((m, i) => (
                <div key={i} className={`chat-msg ${m.role}${m.deepen ? ' deepen' : ''}${m.edit ? ' edit' : ''}${m.edits ? ' edits' : ''}`}>
                  {m.role === 'assistant' && m.path?.length > 0 && (
                    <div className="chat-msg-path">{m.path.join(' › ')}</div>
                  )}
                  <div className="chat-bubble">{renderRich(m.text)}</div>
                  {m.role === 'assistant' && m.depth > 0 && (
                    <div className="chat-msg-depth">detail level {m.depth}{m.atBottom ? ' · deepest' : ''}</div>
                  )}
                </div>
              ))}
              {(chatBusy || suggestBusy) && (
                <div className="chat-msg assistant">
                  <div className="chat-bubble thinking">{suggestBusy ? 'Editing…' : 'Thinking…'}</div>
                </div>
              )}
              {chatError && <div className="chat-msg-error">{chatError}</div>}
              {/* "More detail" drills the current line one level deeper. */}
              {!chatBusy && !suggestBusy && chatLog.length > 0
                && chatLog[chatLog.length - 1].role === 'assistant'
                && !chatLog[chatLog.length - 1].atBottom
                && targetNodeId && targetNodeId === chatNodeId && (
                <div className="chat-actions">
                  <button type="button" className="chat-deepen" onClick={deepen}>↡ More detail</button>
                </div>
              )}
            </div>
            <form
              className={`chat-input-row${editMode ? ' editing' : ''}`}
              onSubmit={(e) => { e.preventDefault(); submitChat() }}
            >
              {/* Attach another project file as context — Q&A only (edit mode has
                  its own target). The current file is already in context, so omit it. */}
              {!editMode && (
                <ContextAttach
                  files={files.filter((f) => f.id !== file.id)}
                  value={ctxFileId}
                  onChange={setCtxFileId}
                  disabled={chatBusy || suggestBusy}
                />
              )}
              <textarea
                ref={chatInputRef}
                className="chat-input"
                rows={1}
                placeholder={editMode
                  ? (selChunk ? 'Describe a change to this chunk…' : 'Describe a change to the file…')
                  : (selected != null ? 'Ask about this chunk…' : 'Ask about the whole file…')}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter inserts a newline.
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitChat() }
                }}
                disabled={!targetNodeId || chatBusy || suggestBusy}
              />
              <button
                className="chat-send"
                type="submit"
                disabled={!targetNodeId || chatBusy || suggestBusy || !chatInput.trim()}
                aria-label={editMode ? 'Apply edit' : 'Send'}
              >↑</button>
            </form>
          </div>
        )}
        <button
          ref={chatFabRef}
          className={`chat-fab${chatOpen ? ' open' : ''}`}
          onClick={() => (chatOpen ? closeChat() : openChat())}
          title={chatOpen ? 'Close chat' : 'Ask about this file'}
          aria-label={chatOpen ? 'Close chat' : 'Ask about this file'}
        >
          {chatOpen ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          ) : (
            // chat bubble with a file (document) glyph inside
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 4.5h16a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-9.5l-3.5 3v-3h-3a1.5 1.5 0 0 1-1.5-1.5V6a1.5 1.5 0 0 1 1.5-1.5z" />
              <path d="M9.8 7.2h2.9l1.4 1.4V12.8h-4.3z" />
              <path d="M12.7 7.2v1.4h1.4" />
            </svg>
          )}
        </button>
      </div>

      {loading && <div className="viewer-loading">chunking…</div>}
    </div>
  )
}
