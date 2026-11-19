import { useEffect, useRef, useState } from 'preact/hooks'
import { Alert, Check, Key, Phone, Plug, Spinner } from '../icons'
import { Qr } from './Qr'
import type { AppState } from '../protocol/state'
import { client, run, useLayout } from '../ui'

export function Splash() {
  return (
    <div class="splash" aria-label="Starting">
      <div class="ring" />
    </div>
  )
}

function useSubmit() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const go = async (op: string, fields: Record<string, unknown>) => {
    setBusy(true)
    setError('')
    try {
      await client().request(op, fields, 60_000)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, go, clear: () => setError('') }
}

/** Setting the desk up from a phone: a QR code and a short code for the desk's one-time page. */
function PhonePanel({ s, onBack }: { s: AppState; onBack: () => void }) {
  const p = s.pairing
  const [left, setLeft] = useState(0)
  useEffect(() => {
    if (!p || (p.state !== 'waiting' && p.state !== 'working')) void run('pair.start')
  }, [])
  useEffect(() => {
    if (!p) return
    const end = Date.now() + p.expires_in * 1000
    const tick = () => setLeft(Math.max(0, Math.round((end - Date.now()) / 1000)))
    tick()
    const t = window.setInterval(tick, 1000)
    return () => window.clearInterval(t)
  }, [p?.code, p?.expires_in])
  const typed = (p?.addresses[0] || '').replace(/^https?:\/\//, '')
  const status =
    !p ? { tone: 'busy', text: 'Opening the setup page' }
    : p.state === 'working' ? { tone: 'busy', text: 'Got your details. Signing in' }
    : p.state === 'failed' ? { tone: 'error', text: p.error || 'That did not work.' }
    : p.error ? { tone: 'error', text: p.error }
    : { tone: '', text: `The code works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} more.` }
  return (
    <div class="phone">
      {p && p.state !== 'failed' ? (
        <div class="phone-qr">
          <Qr text={p.url} />
        </div>
      ) : null}
      <div class="phone-text">
        <h2>Use your phone</h2>
        <p>Scan the code with your phone's camera, then enter your Hermes address and sign-in there.</p>
        {p && p.state !== 'failed' ? (
          <p class="phone-or">
            Or open <b>{typed}</b> and type <span class="phone-code">{p.code}</span>
          </p>
        ) : null}
        <div class={`addr-status ${status.tone}`} role="status" aria-live="polite">
          {status.tone === 'busy' ? <Spinner size={16} /> : status.tone === 'error' ? <Alert size={16} /> : null}
          <span>{status.text}</span>
        </div>
        <div class="row">
          {p?.state === 'failed' ? (
            <button class="btn primary inline" onClick={() => void run('pair.start')}>
              Try again
            </button>
          ) : null}
          <button class="btn quiet inline" onClick={onBack}>
            Type it here instead
          </button>
        </div>
      </div>
    </div>
  )
}

function PhoneButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" class="btn quiet phone-btn" onClick={onClick}>
      <Phone size={18} /> Use your phone instead
    </button>
  )
}

interface Check {
  url: string | null
  version: string
  tried: string[]
  insecure: boolean
}

/** Checks what is typed as the user types, so the form can say what it found before Connect. */
function useAddressCheck(text: string) {
  const [state, setState] = useState<{ for: string; busy: boolean; check: Check | null; error: string }>({ for: '', busy: false, check: null, error: '' })
  const latest = useRef('')
  useEffect(() => {
    const typed = text.trim()
    latest.current = typed
    if (typed.length < 3) {
      setState({ for: typed, busy: false, check: null, error: '' })
      return
    }
    setState((s) => ({ ...s, for: typed, busy: true }))
    const t = window.setTimeout(async () => {
      try {
        const r = (await client().request('setup.check', { url: typed }, 20_000)) as unknown as Check
        if (latest.current === typed) setState({ for: typed, busy: false, check: r, error: '' })
      } catch (e) {
        if (latest.current === typed) setState({ for: typed, busy: false, check: null, error: (e as Error).message })
      }
    }, 550)
    return () => window.clearTimeout(t)
  }, [text])
  return state
}

function hasScheme(text: string): boolean {
  return /^\s*[a-z]{3,6}\s*:?\/\//i.test(text) || /^\s*https?:/i.test(text)
}

export function SetupScreen({ s, onCancel }: { s: AppState; onCancel?: () => void }) {
  const [phone, setPhone] = useState(!!s.pairing)
  const [url, setUrl] = useState(onCancel && s.server ? s.server.url : '')
  const { busy, error, go, clear } = useSubmit()
  const found = useAddressCheck(url)
  const guess = found.check?.url || found.check?.tried[0] || ''
  const prefix = hasScheme(url) ? '' : guess.startsWith('http://') ? 'http://' : 'https://'
  const status = (() => {
    if (error || (!onCancel && s.error && !found.check)) return { tone: 'error', text: error || s.error || '' }
    if (found.error) return { tone: 'error', text: found.error }
    if (found.busy) return { tone: 'busy', text: 'Looking for Hermes' }
    if (found.check?.url && found.check.insecure)
      return { tone: 'warn', text: `Found Hermes at ${found.check.url}, but the connection is not encrypted, so your password would cross the internet unprotected. Use https or Tailscale if you can.` }
    if (found.check?.url) return { tone: 'ok', text: `Found Hermes${found.check.version ? ' ' + found.check.version : ''} at ${found.check.url}` }
    if (found.check) return { tone: 'none', text: 'Nothing answers there yet. Check the address, and that this desk is on the same network or tailnet as Hermes.' }
    return null
  })()
  return (
    <main class="gate">
      <div class="gate-intro">
        <div class="gate-mark">
          <Plug size={30} />
        </div>
        <h1>Connect to your Hermes</h1>
        <p>Type the address of your Hermes dashboard. A Tailscale name works best; an address on your home network or the internet works too.</p>
      </div>
      {phone ? (
        <PhonePanel s={s} onBack={() => { client().fire('pair.stop'); setPhone(false) }} />
      ) : (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (url.trim()) void go('setup', { url: found.check?.url && found.for === url.trim() ? found.check.url : url.trim() })
        }}
      >
        <label>
          Address
          <span class="field addr">
            {prefix ? <span class="addr-scheme" aria-hidden="true">{prefix}</span> : null}
            <input
              value={url}
              autoFocus
              autoCapitalize="off"
              autoComplete="url"
              inputMode="url"
              spellcheck={false}
              placeholder="hermes.your-tailnet.ts.net"
              onInput={(e) => {
                clear()
                setUrl((e.target as HTMLInputElement).value)
              }}
            />
          </span>
        </label>
        <div class={`addr-status ${status?.tone || ''}`} role="status" aria-live="polite">
          {status?.tone === 'ok' ? <Check size={16} /> : status?.tone === 'warn' || status?.tone === 'error' ? <Alert size={16} /> : status?.tone === 'busy' ? <Spinner size={16} /> : null}
          <span>{status?.text || ''}</span>
        </div>
        <button class="btn primary" disabled={busy || !url.trim()}>
          {busy ? 'Connecting' : 'Connect'}
        </button>
        {onCancel ? (
          <button type="button" class="btn quiet" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <PhoneButton onClick={() => setPhone(true)} />
        )}
      </form>
      )}
    </main>
  )
}

export function SigninScreen({ s, onChangeAddress }: { s: AppState; onChangeAddress: () => void }) {
  const [username, setUsername] = useState(s.account?.username || '')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const { busy, error, go } = useSubmit()
  const [phone, setPhone] = useState(!!s.pairing)
  // In landscape the form has the height to itself, so changing the address sits with the address.
  const wide = useLayout() === 'landscape'
  const change = (
    <button type="button" class={wide ? 'gate-change' : 'btn quiet'} onClick={onChangeAddress}>
      Use a different address
    </button>
  )
  return (
    <main class="gate">
      <div class="gate-intro">
        <div class="gate-mark">
          <Key size={30} />
        </div>
        <h1>Sign in to Hermes</h1>
        <p>Use the username and password of your Hermes dashboard.</p>
        {s.server ? <div class="server-chip">{s.server.url}</div> : null}
        {wide ? change : null}
        {wide && !phone ? (
          <button type="button" class="gate-change" onClick={() => setPhone(true)}>
            Use your phone instead
          </button>
        ) : null}
      </div>
      {phone ? (
        <PhonePanel s={s} onBack={() => { client().fire('pair.stop'); setPhone(false) }} />
      ) : (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (username && password) void go('signin', { username, password, remember })
        }}
      >
        <label>
          Username
          <input class="field" value={username} autoCapitalize="off" autoComplete="username" spellcheck={false} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          Password
          <input class="field" type="password" value={password} autoComplete="current-password" onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
        </label>
        <label class="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember((e.target as HTMLInputElement).checked)} />
          <span>
            <b>Stay signed in</b>
            Keeps the password on this device so it can sign in again by itself. Anyone with its memory card could read it.
          </span>
        </label>
        <div class="form-error" role="alert">{error || (s.error && !password ? s.error : '')}</div>
        <button class="btn primary" disabled={busy || !username || !password}>
          {busy ? 'Signing in' : 'Sign in'}
        </button>
        {wide ? null : change}
        {wide ? null : <PhoneButton onClick={() => setPhone(true)} />}
      </form>
      )}
    </main>
  )
}
