// Times, dates and sizes in British English.

const pad = (n: number) => String(n).padStart(2, '0')

export function clock(ts: number): string {
  const d = new Date(ts * 1000)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function dayKey(ts: number): number {
  return dayStart(new Date(ts * 1000))
}

export function dayLabel(ts: number, now = Date.now()): string {
  const diff = Math.round((dayStart(new Date(now)) - dayKey(ts)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  const d = new Date(ts * 1000)
  const opts: Intl.DateTimeFormatOptions = diff < 7
    ? { weekday: 'long' }
    : { weekday: 'short', day: 'numeric', month: 'long', ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) }
  return d.toLocaleDateString('en-GB', opts)
}

/** "now", "5m", "2h", "3d", "2w", then a date. */
export function ago(ts: number, now = Date.now()): string {
  if (!ts) return ''
  const s = Math.max(0, now / 1000 - ts)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`
  if (s < 30 * 86_400) return `${Math.floor(s / (7 * 86_400))}w`
  return new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function duration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00'
  const s = Math.floor(seconds)
  return `${Math.floor(s / 60)}:${pad(s % 60)}`
}

export function bytes(n?: number): string {
  if (n == null) return ''
  if (n < 1024) return `${n} bytes`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

const SOURCES: Record<string, string> = {
  lantern: 'Desk', discord: 'Discord', telegram: 'Telegram', cli: 'Terminal', tui: 'Terminal', desktop: 'Desktop',
  gui: 'Desktop', webapp: 'Web', web: 'Web', slack: 'Slack', whatsapp: 'WhatsApp', signal: 'Signal', api_server: 'API',
  local: 'Local', email: 'Email', sms: 'SMS', matrix: 'Matrix',
}

export function sourceLabel(source: string): string {
  return SOURCES[source] || (source ? source[0].toUpperCase() + source.slice(1) : '')
}

export function fileKind(mime: string, name: string): string {
  const ext = (name.split('.').pop() || '').toUpperCase()
  if (mime === 'application/pdf') return 'PDF'
  if (mime.startsWith('text/')) return ext || 'Text'
  return ext || mime.split('/').pop()?.toUpperCase() || 'File'
}
