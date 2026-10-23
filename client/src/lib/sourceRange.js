const lineAtOffset = (text, offset) => {
  const bounded = Math.max(0, Math.min(text.length, Number(offset) || 0))
  return (text.slice(0, bounded).match(/\n/g)?.length || 0) + 1
}

// Source ranges are half-open [start, end), matching the server's box spans.
// Use the final included character for the ending line so a range that stops at
// the start of the next line does not claim that untouched line.
export function sourceRangeLabel(text, range) {
  if (!text || !range) return 'Selection'
  const start = Math.max(0, Math.min(text.length, Number(range.start) || 0))
  const end = Math.max(start, Math.min(text.length, Number(range.end) || start))
  const firstLine = lineAtOffset(text, start)
  const lastLine = lineAtOffset(text, Math.max(start, end - 1))
  return firstLine === lastLine ? `Line ${firstLine}` : `Lines ${firstLine}–${lastLine}`
}
