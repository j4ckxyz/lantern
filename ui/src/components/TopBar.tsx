import { Chevron, Compose, More } from '../icons'
import type { AppState } from '../protocol/state'
import { overlays, run } from '../ui'
import { Avatar } from './Avatar'

export function TopBar({ s }: { s: AppState }) {
  const view = s.view
  const profile = s.profiles.find((p) => p.name === view?.profile) || s.profiles.find((p) => p.is_default)
  const name = profile?.display_name || profile?.name || 'Hermes'
  const title = view ? (view.kind === 'main' ? 'Main chat' : view.title || 'New chat') : ''
  const ready = s.link === 'ready'
  const full = s.settings.conversations
  const who = (
    <>
      {profile ? <Avatar profile={profile} size={38} /> : null}
      <span class="who-text">
        <span class="who-name">
          <span>{name}</span>
          {full ? <Chevron size={16} /> : null}
        </span>
        {title && full ? <span class="who-title">{title}</span> : null}
      </span>
    </>
  )
  return (
    <header class="topbar">
      {full ? (
        <button class="who" onClick={() => overlays.open({ kind: 'profiles' })} aria-label={`${name}, ${title}. Switch profile or conversation`} title="Profiles and conversations">
          {who}
        </button>
      ) : (
        <div class="who">{who}</div>
      )}
      {full ? (
        <button class="icon-btn" disabled={!ready} onClick={() => void run('chat.new', {})} aria-label="New chat" title="New chat (Ctrl+N)">
          <span class="disc">
            <Compose size={20} />
          </span>
        </button>
      ) : null}
      <button class="icon-btn" onClick={() => overlays.open({ kind: 'menu' })} aria-label="More" title="More">
        <span class="disc">
          <More size={20} />
        </span>
      </button>
    </header>
  )
}
