import { useEffect, useState } from 'preact/hooks'
import type { AppState } from '../protocol/state'
import { client } from '../ui'

export function StatusLine({ s }: { s: AppState }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!s.retryAt) return
    const t = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(t)
  }, [s.retryAt])

  if (s.socket !== 'open') {
    return (
      <div class="statusline" role="status">
        <span class="msg">
          <strong>Starting up</strong>
          Waiting for this device's service.
        </span>
        <span class="progress" />
      </div>
    )
  }
  if (s.link === 'connecting') {
    return (
      <div class="statusline" role="status">
        <span class="msg">Connecting to Hermes</span>
        <span class="progress" />
      </div>
    )
  }
  if (s.link === 'offline') {
    const secs = s.retryAt ? Math.max(0, Math.ceil((s.retryAt - now) / 1000)) : null
    return (
      <div class="statusline offline" role="status">
        <span class="msg">
          <strong>{s.error || 'Hermes is not answering'}</strong>
          {secs ? `Trying again in ${secs} s` : secs === 0 ? 'Trying again now' : 'Showing the last conversation'}
        </span>
        <button class="pill-btn" onClick={() => client().fire('retry')}>
          Retry
        </button>
      </div>
    )
  }
  return null
}
