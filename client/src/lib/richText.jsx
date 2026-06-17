// Claude structures its output with a bit of Markdown that's meaningful and
// shouldn't leak through as literal characters:
//   ```fenced```        → <pre><code> block (multi-line code)
//   **bold**            → <strong>
//   `code`              → <code> (inline code: identifiers, filenames, literals)
//   ## heading (line)   → a styled heading line (1-6 leading #'s, H1..H6)
// We render those and leave everything else (including newlines, via the
// bubble's white-space: pre-wrap) intact. Unmatched **/` are left as-is.
//
// `mentions` (optional) is [{ name, onClick }]: any whole-word occurrence of a
// known file/folder name — in prose OR inline code — becomes a clickable ref, so
// the names referenced in an answer are clickable right where they appear.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Split plain text on known mention names (whole-word, case-insensitive) and wrap
// each match in a clickable button. Returns an array of strings + elements.
function linkifyMentions(text, keyPrefix, mentions) {
  if (!mentions || !mentions.length || !text) return [text]
  // Longest names first so e.g. "app.test.js" wins over "app.js" in the alternation.
  const names = [...new Set(mentions.map((m) => m.name))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
  // The optional trailing "/" lets a folder mention ("ingest/") render as one
  // clickable ref; for a path ("ingest/code.js") it backtracks so each part links.
  const re = new RegExp(`(?<![\\w-])(${names.join('|')})(\\/?)(?![\\w-])`, 'gi')
  const out = []
  let last = 0
  let i = 0
  let mm
  while ((mm = re.exec(text)) !== null) {
    if (mm.index > last) out.push(text.slice(last, mm.index))
    const mention = mentions.find((x) => x.name.toLowerCase() === mm[1].toLowerCase())
    out.push(
      <button key={`${keyPrefix}m${i}`} type="button" className="chat-inline-ref" onClick={mention.onClick}>
        {mm[1] + (mm[2] || '')}
      </button>,
    )
    last = re.lastIndex
    i += 1
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// Inline pass: turn **…** and `…` spans within a single line into <strong>/<code>;
// link any mention names in the plain text (folder chat). A `code` span becomes a
// clickable ref if it's a known mention OR `linkCode(content)` returns a handler
// (file chat: jump to that symbol in the open file). A single split with an
// alternation keeps **/` mutually exclusive.
function inlineFmt(text, keyPrefix, mentions, linkCode) {
  return String(text)
    .split(/(\*\*[\s\S]+?\*\*|`[^`]+?`)/g)
    .flatMap((part, i) => {
      if (/^\*\*[\s\S]+\*\*$/.test(part)) {
        return [<strong key={`${keyPrefix}b${i}`}>{inlineFmt(part.slice(2, -2), `${keyPrefix}b${i}`, mentions, linkCode)}</strong>]
      }
      if (/^`[^`]+`$/.test(part)) {
        const content = part.slice(1, -1)
        // A folder is often written `like/` — strip a trailing slash so it matches
        // the mention name (which is the bare basename).
        const lookup = content.replace(/\/+$/, '')
        const onClick = mentions?.find((x) => x.name.toLowerCase() === lookup.toLowerCase())?.onClick || linkCode?.(content)
        if (onClick) {
          return [
            <button key={`${keyPrefix}c${i}`} type="button" className="chat-inline-ref code" onClick={onClick}>
              {content}
            </button>,
          ]
        }
        return [<code key={`${keyPrefix}c${i}`}>{content}</code>]
      }
      return linkifyMentions(part, `${keyPrefix}p${i}`, mentions)
    })
}

// Prose pass: a line that starts with 1-6 #'s + a space is a heading; the rest
// get the inline treatment. Lines are rejoined with explicit "\n" so pre-wrap
// preserves the original line breaks. Edge newlines are trimmed so prose sitting
// next to a code block doesn't leave a blank gap.
function renderProse(segment, keyPrefix, mentions, linkCode) {
  const cleaned = segment.replace(/^\n+/, '').replace(/\n+$/, '')
  if (!cleaned) return []
  const lines = cleaned.split('\n')
  const out = []
  lines.forEach((line, i) => {
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      out.push(
        <span key={`${keyPrefix}h${i}`} className="chat-h" data-level={h[1].length}>
          {inlineFmt(h[2], `${keyPrefix}h${i}`, mentions, linkCode)}
        </span>,
      )
    } else {
      out.push(<span key={`${keyPrefix}l${i}`}>{inlineFmt(line, `${keyPrefix}l${i}`, mentions, linkCode)}</span>)
    }
    if (i < lines.length - 1) out.push('\n')
  })
  return out
}

// Top pass: peel off ```fenced``` code blocks (rendered verbatim in a <pre>), and
// hand the prose between them to renderProse.
export function renderRich(text, mentions, linkCode) {
  const src = String(text)
  const fenceRe = /```[ \t]*(\w*)\n?([\s\S]*?)```/g
  const out = []
  let lastIndex = 0
  let key = 0
  let m
  while ((m = fenceRe.exec(src)) !== null) {
    if (m.index > lastIndex) out.push(...renderProse(src.slice(lastIndex, m.index), `p${key}`, mentions, linkCode))
    const code = m[2].replace(/\n$/, '')
    out.push(
      <pre key={`code${key}`} className="chat-code">
        <code>{code}</code>
      </pre>,
    )
    lastIndex = fenceRe.lastIndex
    key += 1
  }
  if (lastIndex < src.length) out.push(...renderProse(src.slice(lastIndex), `p${key}`, mentions, linkCode))
  return out
}
