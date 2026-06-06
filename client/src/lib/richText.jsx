// Claude structures its output with a bit of Markdown that's meaningful and
// shouldn't leak through as literal characters:
//   ```fenced```        → <pre><code> block (multi-line code)
//   **bold**            → <strong>
//   `code`              → <code> (inline code: identifiers, filenames, literals)
//   ## heading (line)   → a styled heading line (1-6 leading #'s, H1..H6)
// We render those and leave everything else (including newlines, via the
// bubble's white-space: pre-wrap) intact. Unmatched **/` are left as-is.

// Inline pass: turn **…** and `…` spans within a single line into <strong>/<code>.
// A single split with an alternation keeps them mutually exclusive — a `…` span
// is taken whole, so ** inside it isn't re-parsed (and vice versa).
function inlineFmt(text, keyPrefix) {
  return String(text)
    .split(/(\*\*[\s\S]+?\*\*|`[^`]+?`)/g)
    .map((part, i) => {
      if (/^\*\*[\s\S]+\*\*$/.test(part)) {
        // Recurse so a `code` span nested inside the bold (e.g. **`foo`**) is
        // itself parsed into <code> rather than leaking its backticks. Inline
        // code is taken whole below, so its contents are never re-parsed.
        return <strong key={`${keyPrefix}b${i}`}>{inlineFmt(part.slice(2, -2), `${keyPrefix}b${i}`)}</strong>
      }
      if (/^`[^`]+`$/.test(part)) {
        return <code key={`${keyPrefix}c${i}`}>{part.slice(1, -1)}</code>
      }
      return part
    })
}

// Prose pass: a line that starts with 1-6 #'s + a space is a heading; the rest
// get the inline treatment. Lines are rejoined with explicit "\n" so pre-wrap
// preserves the original line breaks. Edge newlines are trimmed so prose sitting
// next to a code block doesn't leave a blank gap.
function renderProse(segment, keyPrefix) {
  const cleaned = segment.replace(/^\n+/, '').replace(/\n+$/, '')
  if (!cleaned) return []
  const lines = cleaned.split('\n')
  const out = []
  lines.forEach((line, i) => {
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      out.push(
        <span key={`${keyPrefix}h${i}`} className="chat-h" data-level={h[1].length}>
          {inlineFmt(h[2], `${keyPrefix}h${i}`)}
        </span>,
      )
    } else {
      out.push(<span key={`${keyPrefix}l${i}`}>{inlineFmt(line, `${keyPrefix}l${i}`)}</span>)
    }
    if (i < lines.length - 1) out.push('\n')
  })
  return out
}

// Top pass: peel off ```fenced``` code blocks (rendered verbatim in a <pre>), and
// hand the prose between them to renderProse.
export function renderRich(text) {
  const src = String(text)
  const fenceRe = /```[ \t]*(\w*)\n?([\s\S]*?)```/g
  const out = []
  let lastIndex = 0
  let key = 0
  let m
  while ((m = fenceRe.exec(src)) !== null) {
    if (m.index > lastIndex) out.push(...renderProse(src.slice(lastIndex, m.index), `p${key}`))
    const code = m[2].replace(/\n$/, '')
    out.push(
      <pre key={`code${key}`} className="chat-code">
        <code>{code}</code>
      </pre>,
    )
    lastIndex = fenceRe.lastIndex
    key += 1
  }
  if (lastIndex < src.length) out.push(...renderProse(src.slice(lastIndex), `p${key}`))
  return out
}
