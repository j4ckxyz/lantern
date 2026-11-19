import type { ComponentChildren } from 'preact'
import { useRef } from 'preact/hooks'
import { overlays } from '../ui'

/**
 * A bottom sheet in portrait; in landscape a drawer from the side panel (or, with `center`, a
 * dialog in the middle). Closes on the scrim, Esc (handled by the app) or a swipe down on its top.
 */
export function Sheet({ children, tall = false, center = false, label }: { children: ComponentChildren; tall?: boolean; center?: boolean; label: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; dy: number } | null>(null)

  const down = (e: PointerEvent) => {
    drag.current = { y: e.clientY, dy: 0 }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent) => {
    if (!drag.current || !ref.current) return
    drag.current.dy = Math.max(0, e.clientY - drag.current.y)
    ref.current.style.transform = `translateY(${drag.current.dy}px)`
  }
  const up = () => {
    const d = drag.current
    drag.current = null
    if (!ref.current || !d) return
    if (d.dy > 90) overlays.close()
    else {
      ref.current.style.transition = 'transform 180ms'
      ref.current.style.transform = ''
      window.setTimeout(() => ref.current && (ref.current.style.transition = ''), 200)
    }
  }

  return (
    <>
      <div class="scrim" onClick={() => overlays.close()} />
      <div class={`sheet${tall ? ' tall' : ''}${center ? ' center' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-label={label}>
        <div class="sheet-grip" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
        {children}
      </div>
    </>
  )
}
