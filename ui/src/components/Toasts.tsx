import { useEffect } from 'preact/hooks'
import { Alert, Info } from '../icons'
import { dropNotice, type Notice } from '../protocol/state'
import { client } from '../ui'

export function Toasts({ notices }: { notices: Notice[] }) {
  useEffect(() => {
    if (!notices.length) return
    const next = Math.min(...notices.map((n) => n.until))
    const t = window.setTimeout(() => {
      const now = Date.now()
      client().store.update((s) => s.notices.filter((n) => n.until <= now).reduce((acc, n) => dropNotice(acc, n.key), s))
    }, Math.max(0, next - Date.now()) + 20)
    return () => window.clearTimeout(t)
  }, [notices])
  if (!notices.length) return null
  return (
    <div class="toasts" role="status" aria-live="polite">
      {notices.map((n) => (
        <div key={n.key} class={`toast ${n.level}`} onClick={() => client().store.update((s) => dropNotice(s, n.key))}>
          {n.level === 'info' ? <Info size={18} /> : <Alert size={18} />}
          <span>{n.text}</span>
        </div>
      ))}
    </div>
  )
}
