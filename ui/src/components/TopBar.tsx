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
  return (
    <header class="topbar">
      <button class="who" onClick={() => overlays.open({ kind: 'profiles' })} aria-label={`${name}, ${title}. Switch profile or conversation`}>
        {profile ? <Avatar profile={profile} size={38} /> : null}
        <span class="who-text">
          <span class="who-name">
            <span>{name}</span>
            <Chevron size={16} />
          </span>
          {title ? <span class="who-title">{title}</span> : null}
        </span>
      </button>
      <button class="icon-btn" disabled={!ready} onClick={() => void run('chat.new', {})} aria-label="New chat">
        <span class="disc">
          <Compose size={20} />
        </span>
      </button>
      <button class="icon-btn" onClick={() => overlays.open({ kind: 'menu' })} aria-label="More">
        <span class="disc">
          <More size={20} />
        </span>
      </button>
    </header>
  )
}
