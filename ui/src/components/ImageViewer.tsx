import { useRef, useState } from 'preact/hooks'
import { Close } from '../icons'
import { overlays } from '../ui'

/** Full screen, with pinch to zoom, drag to pan and double tap to zoom in or out. */
export function ImageViewer({ src, alt }: { src: string; alt?: string }) {
  const [t, setT] = useState({ scale: 1, x: 0, y: 0 })
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const start = useRef<{ dist: number; scale: number; x: number; y: number; px: number; py: number } | null>(null)
  const lastTap = useRef(0)

  const snapshot = () => {
    const pts = [...pointers.current.values()]
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length
    start.current = { dist, scale: t.scale, x: t.x, y: t.y, px: cx, py: cy }
  }

  return (
    <div
      class="viewer"
      role="dialog"
      aria-label={alt || 'Picture'}
      onPointerDown={(e) => {
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        snapshot()
        const now = Date.now()
        if (pointers.current.size === 1 && now - lastTap.current < 300) {
          setT((c) => (c.scale > 1 ? { scale: 1, x: 0, y: 0 } : { scale: 2.5, x: 0, y: 0 }))
        }
        lastTap.current = now
      }}
      onPointerMove={(e) => {
        if (!pointers.current.has(e.pointerId) || !start.current) return
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
        const pts = [...pointers.current.values()]
        const s0 = start.current
        const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length
        const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length
        let scale = s0.scale
        if (pts.length > 1 && s0.dist) {
          const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
          scale = Math.min(6, Math.max(1, (s0.scale * dist) / s0.dist))
        }
        if (scale === 1 && pts.length === 1) return setT({ scale: 1, x: 0, y: 0 })
        setT({ scale, x: s0.x + (cx - s0.px), y: s0.y + (cy - s0.py) })
      }}
      onPointerUp={(e) => {
        pointers.current.delete(e.pointerId)
        if (pointers.current.size) snapshot()
        else start.current = null
      }}
      onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
    >
      <img src={src} alt={alt || ''} draggable={false} style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})` }} />
      <button class="icon-btn close" onClick={() => overlays.close()} onPointerDown={(e) => e.stopPropagation()} aria-label="Close">
        <span class="disc">
          <Close />
        </span>
      </button>
      {alt ? <div class="caption">{alt}</div> : null}
    </div>
  )
}
