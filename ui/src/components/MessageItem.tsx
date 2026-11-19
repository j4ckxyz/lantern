import { useState } from 'preact/hooks'
import { clock } from '../format'
import { Speaker, Stop } from '../icons'
import { extractLinks } from '../markdown'
import type { Message } from '../protocol/types'
import { client, run } from '../ui'
import { speech } from '../audio/speech'
import { LinkCard } from './LinkCard'
import { Markdown } from './Markdown'
import { MediaList } from './Media'
import { adoptPacer, PacedText } from './Live'

export function UserMessage({ m }: { m: Message }) {
  return (
    <div class="msg-user" data-msg={m.id}>
      <div class="bubble">
        {m.text}
        <MediaList media={m.media} />
      </div>
    </div>
  )
}

function CommandResult({ m }: { m: Message }) {
  return (
    <article class="msg-command" data-msg={m.id}>
      <div class="cmd-head">
        <span class="cmd-name">{m.command}</span>
        <time>{clock(m.ts)}</time>
      </div>
      <pre class="cmd-out">{m.text}</pre>
    </article>
  )
}

export function AgentMessage({ m, pacing, speaking }: { m: Message; pacing: boolean; speaking: boolean }) {
  if (m.command) return <CommandResult m={m} />
  return <AgentReply m={m} pacing={pacing} speaking={speaking} />
}

function AgentReply({ m, pacing, speaking }: { m: Message; pacing: boolean; speaking: boolean }) {
  const [pacer] = useState(() => (pacing ? adoptPacer() : null))
  const [typing, setTyping] = useState(pacing)
  const links = !m.interim && !typing ? extractLinks(m.text) : []

  const speak = () => {
    if (speaking) {
      client().fire('speak.stop')
      speech.stop()
    } else {
      speech.prime()
      void run('speak', { message_id: m.id })
    }
  }

  return (
    <article class={`msg-agent${m.interim ? ' interim' : ''}`} data-msg={m.id}>
      {m.voice ? (
        <div class="voice-tag">
          <Speaker size={16} /> Voice reply
        </div>
      ) : null}
      {typing && pacer ? <PacedText text={m.text} pacer={pacer} onDone={() => setTyping(false)} /> : m.text ? <Markdown text={m.text} class={m.interim ? 'interim' : ''} /> : null}
      {m.error ? (
        <div class="failure">
          <strong>Something went wrong</strong>
          {m.error}
        </div>
      ) : null}
      {!typing ? <MediaList media={m.media} /> : null}
      {links.length ? (
        <div class="links">
          {links.map((u) => (
            <LinkCard key={u} url={u} />
          ))}
        </div>
      ) : null}
      {!m.interim && !typing ? (
        <div class="msg-meta">
          <button class={`icon-btn${speaking ? ' on' : ''}`} onClick={speak} aria-label={speaking ? 'Stop reading aloud' : 'Read aloud'}>
            {speaking ? <Stop size={18} /> : <Speaker size={19} />}
          </button>
          <time>{clock(m.ts)}</time>
        </div>
      ) : null}
    </article>
  )
}
