import { useEffect, useRef, useState } from 'preact/hooks'
import { ago, domain, sourceLabel } from '../format'
import { Back, ChevronRight, Chats, Close, Compact, Compose, Search, Settings as SettingsIcon } from '../icons'
import type { AppState } from '../protocol/state'
import type { Profile, Session, Settings } from '../protocol/types'
import { client, overlays, run } from '../ui'
import { Avatar } from './Avatar'
import { Qr } from './Qr'
import { Sheet } from './Sheet'

function Head({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <div class="sheet-head">
      {onBack ? (
        <button class="icon-btn" onClick={onBack} aria-label="Back">
          <Back />
        </button>
      ) : null}
      <h2>{title}</h2>
      <button class="icon-btn" onClick={() => overlays.close()} aria-label="Close">
        <Close />
      </button>
    </div>
  )
}

async function open(fields: Record<string, unknown>) {
  overlays.closeAll()
  await run('chat.open', fields)
}

export function ProfilesSheet({ s, initial }: { s: AppState; initial?: string }) {
  const [browsing, setBrowsing] = useState<string | null>(initial || null)
  const profile = s.profiles.find((p) => p.name === browsing)
  return (
    <Sheet tall label="Profiles and conversations">
      {profile ? (
        <SessionsView s={s} profile={profile} onBack={() => setBrowsing(null)} />
      ) : (
        <>
          <Head title="Profiles" />
          <div class="sheet-body">
            <div class="list">
              {s.profiles.map((p) => (
                <ProfileRow key={p.name} p={p} current={s.view?.profile === p.name} onBrowse={() => setBrowsing(p.name)} />
              ))}
            </div>
            {!s.profiles.length ? <div class="empty">No profiles yet.</div> : null}
          </div>
        </>
      )}
    </Sheet>
  )
}

function ProfileRow({ p, current, onBrowse }: { p: Profile; current: boolean; onBrowse: () => void }) {
  return (
    <div>
      <button class="list-item" onClick={() => void open({ profile: p.name })}>
        <Avatar profile={p} size={44} />
        <span class="list-text">
          <span class="list-title">
            <span>{p.display_name || p.name}</span>
            {current ? <span class="badge accent">Open</span> : null}
          </span>
          <span class="list-sub">{p.main?.preview || 'Start the main chat'}</span>
        </span>
        <span class="list-side">{p.main ? ago(p.main.last_active) : ''}</span>
      </button>
      <button class="subrow" onClick={onBrowse}>
        <span>Conversations</span>
        <ChevronRight size={18} />
      </button>
    </div>
  )
}

function SessionsView({ s, profile, onBack }: { s: AppState; profile: Profile; onBack: () => void }) {
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<Session[] | null>(null)
  const timer = useRef(0)

  useEffect(() => {
    window.clearTimeout(timer.current)
    let live = true
    timer.current = window.setTimeout(async () => {
      try {
        const r = await client().request<{ sessions: Session[] }>('sessions.list', { profile: profile.name, query: query || undefined, limit: 50 })
        if (live) setRows(r.sessions)
      } catch {
        if (live) setRows([])
      }
    }, query ? 250 : 0)
    return () => {
      live = false
    }
  }, [profile.name, query])

  return (
    <>
      <Head title={profile.display_name || profile.name} onBack={onBack} />
      <div class="sheet-body">
        <div class="search">
          <Search size={18} />
          <input class="field" type="search" placeholder="Search conversations" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} aria-label="Search conversations" />
        </div>
        <button
          class="menu-item"
          onClick={async () => {
            overlays.closeAll()
            await run('chat.new', { profile: profile.name })
          }}
        >
          <Compose /> New chat
        </button>
        <div class="list">
          {(rows || []).map((r) => (
            <button key={r.id} class="list-item" onClick={() => void open({ profile: profile.name, session_id: r.is_main ? undefined : r.id })}>
              <span class="list-text">
                <span class="list-title">
                  <span>{r.is_main ? 'Main chat' : r.title || 'Untitled'}</span>
                  {s.view?.session_id === r.id ? <span class="badge accent">Open</span> : null}
                </span>
                <span class="list-sub">{r.preview}</span>
              </span>
              <span class="list-side">
                <span>{ago(r.last_active)}</span>
                {r.source && !r.is_main ? <span class="badge">{sourceLabel(r.source)}</span> : null}
              </span>
            </button>
          ))}
        </div>
        {rows && !rows.length ? <div class="empty">{query ? 'Nothing matches that.' : 'No conversations yet.'}</div> : null}
        {!rows ? <div class="empty">Loading</div> : null}
      </div>
    </>
  )
}

export function MenuSheet({ s }: { s: AppState }) {
  const ready = s.link === 'ready'
  return (
    <Sheet label="Menu">
      <div class="sheet-body">
        <button class="menu-item" disabled={!ready} onClick={async () => {
          overlays.closeAll()
          await run('chat.new', {})
        }}>
          <Compose /> New chat
        </button>
        <button class="menu-item" disabled={!ready || !s.view?.messages.length} onClick={async () => {
          overlays.closeAll()
          await run('chat.compact')
        }}>
          <Compact />
          <span>
            Compact this chat
            <small>Summarise older messages so Hermes starts fresh, keeping the gist.</small>
          </span>
        </button>
        <button class="menu-item" onClick={() => overlays.open({ kind: 'profiles', profile: s.view?.profile })}>
          <Chats /> Conversations
        </button>
        <button class="menu-item" onClick={() => overlays.open({ kind: 'settings' })}>
          <SettingsIcon /> Settings
        </button>
      </div>
    </Sheet>
  )
}

function Segmented<K extends string>({ value, options, onPick }: { value: K; options: [K, string][]; onPick: (k: K) => void }) {
  return (
    <div class="segmented" role="group">
      {options.map(([k, label]) => (
        <button key={k} aria-pressed={value === k} onClick={() => onPick(k)}>
          {label}
        </button>
      ))}
    </div>
  )
}

export function SettingsSheet({ s }: { s: AppState }) {
  const set = (changes: Partial<Settings>) => void run('settings.set', { changes })
  return (
    <Sheet tall label="Settings">
      <Head title="Settings" />
      <div class="sheet-body">
        <div class="group">
          <h3>Text size</h3>
          <Segmented value={s.settings.text_size} options={[['compact', 'Compact'], ['comfortable', 'Comfortable'], ['large', 'Large']]} onPick={(text_size) => set({ text_size })} />
        </div>
        <div class="group">
          <h3>Theme</h3>
          <Segmented value={s.settings.theme} options={[['dark', 'Dark'], ['light', 'Light'], ['auto', 'Auto']]} onPick={(theme) => set({ theme })} />
          <p class="note">Auto is light from 07:00 to 19:00 and dark the rest of the time.</p>
        </div>
        <div class="group">
          <h3>Hermes</h3>
          <div class="panel">
            <div class="kv">
              <span>Address</span>
              <span>{s.server ? domain(s.server.url) : 'Not set'}</span>
            </div>
            <div class="kv">
              <span>Signed in as</span>
              <span>{s.account?.username || 'Nobody'}</span>
            </div>
            <div class="kv">
              <span>Hermes version</span>
              <span>{s.server?.version || 'Unknown'}</span>
            </div>
          </div>
          {s.account ? (
            <div class="row" style={{ marginTop: '10px' }}>
              <button
                class="btn danger"
                onClick={async () => {
                  if (!window.confirm('Sign out of Hermes on this device? The saved password is erased too.')) return
                  overlays.closeAll()
                  await run('signout')
                }}
              >
                Sign out
              </button>
            </div>
          ) : null}
        </div>
        <div class="group">
          <h3>About</h3>
          <div class="panel">
            <div class="kv">
              <span>Device</span>
              <span>{s.device?.name || 'This device'}</span>
            </div>
            <div class="kv">
              <span>Software</span>
              <span>Lantern</span>
            </div>
          </div>
          <p class="note">Sound, screen sleep, Wi-Fi and Bluetooth settings arrive in a later update.</p>
        </div>
      </div>
    </Sheet>
  )
}

export function QrSheet({ url, title, hint }: { url: string; title?: string; hint?: string }) {
  return (
    <Sheet center label="Open on your phone">
      <Head title="Open on your phone" />
      <div class="sheet-body">
        <div class="qr">
          <Qr text={url} />
          <div class="qr-text">
            {title ? <div class="qr-title">{title}</div> : null}
            <div class="qr-url">{url}</div>
            <div class="qr-hint">{hint || 'Point your phone’s camera at the code to open the link.'}</div>
          </div>
        </div>
      </div>
    </Sheet>
  )
}
