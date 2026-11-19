import { useState } from 'preact/hooks'
import { Key, Plug } from '../icons'
import type { AppState } from '../protocol/state'
import { client, useLayout } from '../ui'

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
  return { busy, error, go }
}

export function SetupScreen({ s, onCancel }: { s: AppState; onCancel?: () => void }) {
  const [url, setUrl] = useState(onCancel && s.server ? s.server.url : '')
  const { busy, error, go } = useSubmit()
  return (
    <main class="gate">
      <div class="gate-intro">
        <div class="gate-mark">
          <Plug size={30} />
        </div>
        <h1>Connect to your Hermes</h1>
        <p>Type the address you use for your Hermes dashboard. This device reaches it over Tailscale.</p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (url.trim()) void go('setup', { url: url.trim() })
        }}
      >
        <label>
          Address
          <input class="field" value={url} autoFocus autoCapitalize="off" spellcheck={false} placeholder="hermes.your-tailnet.ts.net" onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
        </label>
        <div class="form-error" role="alert">{error || (onCancel ? '' : s.error)}</div>
        <button class="btn primary" disabled={busy || !url.trim()}>
          {busy ? 'Looking for Hermes' : 'Connect'}
        </button>
        {onCancel ? (
          <button type="button" class="btn quiet" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </form>
    </main>
  )
}

export function SigninScreen({ s, onChangeAddress }: { s: AppState; onChangeAddress: () => void }) {
  const [username, setUsername] = useState(s.account?.username || '')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const { busy, error, go } = useSubmit()
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
      </div>
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
      </form>
    </main>
  )
}
