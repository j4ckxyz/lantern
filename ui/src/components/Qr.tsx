import qrcode from 'qrcode-generator'
import { useMemo } from 'preact/hooks'

/** A QR code as one SVG path: crisp at any scale, dark modules on a light square. */
export function Qr({ text }: { text: string }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text, 'Byte')
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`
    }
    return { n, d }
  }, [text])
  return (
    <div class="qr-code" role="img" aria-label="QR code">
      <svg viewBox={`0 0 ${n} ${n}`} shape-rendering="crispEdges">
        <path d={d} fill="var(--qr-dark)" />
      </svg>
    </div>
  )
}
