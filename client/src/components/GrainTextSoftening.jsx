import { useEffect, useRef } from 'react'

// Follow rendered text rather than assuming fixed text positions.
export default function GrainTextSoftening() {
  const layer = useRef(null)
  useEffect(() => {
    let timer
    let disposed = false
    const update = () => {
      if (disposed || !layer.current) return
      const width = window.innerWidth
      const height = window.innerHeight
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const root = layer.current.parentElement
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      let node
      ctx.fillStyle = 'white'
      while ((node = walker.nextNode())) {
        if (!node.textContent.trim()) continue
        const parent = node.parentElement
        if (!parent || parent.closest('script, style, [aria-hidden="true"]')) continue
        const bounds = parent.getBoundingClientRect()
        if (bounds.bottom < 0 || bounds.top > height || bounds.right < 0 || bounds.left > width) continue
        const style = getComputedStyle(parent)
        if (style.visibility === 'hidden' || style.display === 'none') continue
        range.selectNodeContents(node)
        for (const rect of range.getClientRects()) {
          if (rect.bottom >= 0 && rect.top <= height) {
            ctx.fillRect(rect.x - 2, rect.y - 1, rect.width + 4, rect.height + 2)
          }
        }
      }
      layer.current.style.maskImage = `url(${canvas.toDataURL()})`
      // The original crisp grain remains everywhere except under the text.
      ctx.globalCompositeOperation = 'source-out'
      ctx.fillRect(0, 0, width, height)
      root.style.setProperty('--grain-clear-text-mask', `url(${canvas.toDataURL()})`)
    }
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(update, 60)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(layer.current.parentElement, { childList: true, subtree: true, characterData: true })
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    document.fonts.ready.then(schedule)
    schedule()
    return () => {
      disposed = true
      clearTimeout(timer)
      observer.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [])
  return <div ref={layer} className="grain-text-softening" aria-hidden="true" />
}
