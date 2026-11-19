// The side panel in landscape: who you are talking to, what they are doing, and the two actions.
// It takes the place of the top bar, the status line and the tool chips of the portrait layout, so
// the conversation gets the whole height of the screen.
import { useEffect, useState } from 'preact/hooks'
import { Check, Chevron, Compose, Cross, More, Spinner, Stop } from '../icons'
import type { AppState } from '../protocol/state'
import type { Tool } from '../protocol/types'
import { client, overlays, run } from '../ui'
import { Avatar } from './Avatar'
import { Thinking } from './Live'

function useNow(every: number, on = true): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => setNow(Date.now()), every)
    return () => window.clearInterval(t)
  }, [every, on])
  return now
}

function toolLabel(t: Tool): string {
  return t.label || t.name.replace(/[_.]/g, ' ')
}

type Mood = 'idle' | 'working' | 'waiting' | 'away'

function mood(s: AppState): Mood {
  if (s.socket !== 'open' || s.link !== 'ready') return 'away'
  if (s.prompt) return 'waiting'
  if (s.turn) return 'working'
  return 'idle'
}

export function Presence({ s }: { s: AppState }) {
  const view = s.view
  const profile = s.profiles.find((p) => p.name === view?.profile) || s.profiles.find((p) => p.is_default)
  const name = profile?.display_name || profile?.name || 'Hermes'
  const title = view ? (view.kind === 'main' ? 'Main chat' : view.title || 'New chat') : ''
  const m = mood(s)
  const ready = s.link === 'ready'
  const full = s.settings.conversations
  const who = (
    <>
      <span class="p-avatar">{profile ? <Avatar profile={profile} size={48} /> : null}</span>
      <span class="p-names">
        <span class="p-name">
          <span>{name}</span>
          {full ? <Chevron size={15} /> : null}
        </span>
        {title && full ? <span class="p-title">{title}</span> : null}
      </span>
    </>
  )
  return (
    <aside class={`presence ${m}`}>
      {full ? (
        <button class="p-who" onClick={() => overlays.open({ kind: 'profiles' })} aria-label={`${name}, ${title}. Switch profile or conversation`} title="Profiles and conversations">
          {who}
        </button>
      ) : (
        <div class="p-who">{who}</div>
      )}
      <div class="p-state">
        <State s={s} m={m} />
      </div>
      <div class="p-actions">
        {full ? (
          <button class="p-act" disabled={!ready} onClick={() => void run('chat.new', {})} title="New chat (Ctrl+N)">
            <Compose size={18} />
            <span>New chat</span>
          </button>
        ) : null}
        {full ? (
          <button class="p-act" onClick={() => overlays.open({ kind: 'menu' })} aria-label="More" title="More">
            <More size={18} />
          </button>
        ) : (
          <button class="p-act" onClick={() => overlays.open({ kind: 'menu' })} aria-label="More">
            <More size={18} />
            <span>Menu</span>
          </button>
        )}
      </div>
    </aside>
  )
}

function State({ s, m }: { s: AppState; m: Mood }) {
  const now = useNow(m === 'away' && s.retryAt ? 500 : 15_000)
  if (s.socket !== 'open') {
    return <Line title="Starting up" sub="Waiting for this device's service." busy />
  }
  if (s.link === 'connecting') {
    return <Line title="Connecting" sub="Reaching your Hermes." busy />
  }
  if (s.link === 'offline') {
    const secs = s.retryAt ? Math.max(0, Math.ceil((s.retryAt - now) / 1000)) : null
    return (
      <div class="p-line warn" role="status">
        <strong>{s.error || 'Hermes is not answering'}</strong>
        <span>{secs ? `Trying again in ${secs} s` : secs === 0 ? 'Trying again now' : 'Showing the last conversation'}</span>
        <button class="p-chip" onClick={() => client().fire('retry')}>
          Retry now
        </button>
      </div>
    )
  }
  if (s.turn) {
    const running = s.turn.tools.filter((t) => t.state === 'running')
    const status = s.prompt ? 'Waiting for you' : s.turn.status || (running.length ? 'Working' : s.turn.text ? 'Writing' : 'Thinking')
    const tools = s.turn.tools.slice(-3)
    return (
      <div class="p-work" role="status" aria-live="polite">
        <div class="p-status">
          {!s.prompt && !running.length && !s.turn.text ? <Thinking /> : <span class={s.prompt ? 'pulse held' : 'pulse'} />}
          <span>{status}</span>
        </div>
        {tools.length ? (
          <ul class="p-tools">
            {tools.map((t) => (
              <li key={t.id} class={t.state}>
                {t.state === 'running' ? <Spinner size={14} /> : t.state === 'done' ? <Check size={14} /> : <Cross size={14} />}
                <span>{toolLabel(t)}</span>
                {t.state === 'running' && t.progress != null ? <i class="bar" style={{ width: `${Math.round(t.progress * 100)}%` }} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {s.prompt ? (
          // The message box (and its Stop) gives way to the question, so Stop moves here.
          <button class="p-chip stop" onClick={() => client().fire('stop')}>
            <Stop size={14} /> Stop
          </button>
        ) : null}
      </div>
    )
  }
  return <Clock now={now} />
}

function Line({ title, sub, busy }: { title: string; sub: string; busy?: boolean }) {
  return (
    <div class="p-line" role="status">
      <strong>{title}</strong>
      <span>{sub}</span>
      {busy ? <span class="p-progress" /> : null}
    </div>
  )
}

const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long' })
const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' })

function Clock({ now }: { now: number }) {
  const d = new Date(now)
  return (
    <div class="p-clock" aria-hidden="true">
      <span class="p-time">{timeFmt.format(d)}</span>
      <span class="p-date">
        {dayFmt.format(d)}
        <br />
        {dateFmt.format(d)}
      </span>
    </div>
  )
}
