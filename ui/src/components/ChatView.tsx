import { Fragment } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { dayKey, dayLabel } from '../format'
import { Down } from '../icons'
import { prependMessages, type AppState } from '../protocol/state'
import type { Message } from '../protocol/types'
import { client, run } from '../ui'
import { Avatar } from './Avatar'
import { LiveReply } from './Live'
import { AgentMessage, UserMessage } from './MessageItem'

const NEAR_BOTTOM = 80

export interface ChatHandle {
  page(dir: 1 | -1): void
  jump(dir: 1 | -1): void
  toEnd(): void
}

export const chatHandle: { current: ChatHandle | null } = { current: null }

export function ChatView({ s }: { s: AppState }) {
  const view = s.view
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const lastTop = useRef(0)
  const [showJump, setShowJump] = useState(false)
  const loading = useRef(false)
  const anchor = useRef<{ height: number; top: number } | null>(null)
  const [edge, setEdge] = useState<'idle' | 'loading'>('idle')

  const toEnd = (smooth = false) => {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    pinned.current = true
    setShowJump(false)
  }

  // A different chat: start at the bottom.
  useLayoutEffect(() => {
    pinned.current = true
    toEnd()
  }, [view?.session_id])

  // New content: follow it when the reader is at the bottom; keep the place after older history arrives.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (anchor.current) {
      el.scrollTop = el.scrollHeight - anchor.current.height + anchor.current.top
      anchor.current = null
      return
    }
    if (pinned.current) el.scrollTop = el.scrollHeight
    else setShowJump(true)
  })

  // Keep following while a reply is typed out (it grows between renders of this component).
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight
    })
    const inner = el.firstElementChild
    if (inner) obs.observe(inner)
    return () => obs.disconnect()
  }, [view?.session_id])

  const more = async () => {
    const el = ref.current
    if (!el || loading.current || !view?.has_more) return
    loading.current = true
    setEdge('loading')
    const sid = view.session_id
    const r = await run('history.more')
    if (r && client().store.state.view?.session_id === sid) {
      anchor.current = { height: el.scrollHeight, top: el.scrollTop }
      client().store.update((st) => prependMessages(st, (r.messages as Message[]) || [], !!r.has_more, sid))
    }
    loading.current = false
    setEdge('idle')
  }

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    // Only the reader scrolling up lets go of the bottom. Content growing (a picture loading, a
    // reply typing) can make the gap look large for a frame before the chat catches up, and must not.
    const movedUp = el.scrollTop < lastTop.current - 2
    lastTop.current = el.scrollTop
    if (distance < NEAR_BOTTOM) pinned.current = true
    else if (movedUp) pinned.current = false
    if (pinned.current) setShowJump(false)
    else if (distance > el.clientHeight) setShowJump(true)
    if (el.scrollTop < 400) void more()
  }

  chatHandle.current = {
    page(dir) {
      const el = ref.current
      if (el) el.scrollBy({ top: dir * el.clientHeight * 0.85, behavior: 'smooth' })
    },
    jump(dir) {
      const el = ref.current
      if (!el) return
      const items = Array.from(el.querySelectorAll<HTMLElement>('[data-msg]'))
      const top = el.scrollTop + 8
      const target = dir < 0 ? items.reverse().find((i) => i.offsetTop < top - 4) : items.find((i) => i.offsetTop > top + 4)
      if (target) el.scrollTo({ top: target.offsetTop - 8, behavior: 'smooth' })
      else if (dir > 0) toEnd(true)
    },
    toEnd: () => toEnd(true),
  }

  const messages = view?.messages || []
  const profile = s.profiles.find((p) => p.name === view?.profile)
  let lastDay = 0

  return (
    <div class="chat">
      <div class="scroller" ref={ref} onScroll={onScroll}>
        <div class="chat-inner">
          {view?.has_more ? <div class="history-edge">{edge === 'loading' ? 'Loading earlier messages' : ' '}</div> : null}
          {!messages.length && !s.turn ? (
            <div class="welcome">
              {profile ? <Avatar profile={profile} size={72} /> : null}
              <h2>{view?.kind === 'session' ? 'New chat' : profile?.display_name || 'Hermes'}</h2>
              <p>
                {view?.kind === 'session'
                  ? 'A fresh conversation. Your main chat is still there in Conversations.'
                  : 'Ask anything. This chat is the same one you see on your phone and computer.'}
              </p>
            </div>
          ) : null}
          {messages.map((m) => {
            const day = dayKey(m.ts)
            const divider = day !== lastDay
            lastDay = day
            return (
              <Fragment key={m.id}>
                {divider ? (
                  <div class="day">
                    <span>{dayLabel(m.ts)}</span>
                  </div>
                ) : null}
                {m.role === 'user' ? (
                  <UserMessage m={m} />
                ) : (
                  <AgentMessage m={m} pacing={m.id === s.pacingId} speaking={s.speech?.messageId === m.id} />
                )}
              </Fragment>
            )
          })}
          {s.turn && !s.pacingId ? <LiveReply turn={s.turn} waiting={!!s.prompt} /> : null}
          {s.failure ? <FailureCard error={s.failure.error} messages={messages} /> : null}
        </div>
      </div>
      {showJump ? (
        <button class="jump" onClick={() => toEnd(true)}>
          <Down size={16} /> Latest
        </button>
      ) : null}
    </div>
  )
}

function FailureCard({ error, messages }: { error: string; messages: Message[] }) {
  const last = [...messages].reverse().find((m) => m.role === 'user')
  return (
    <div class="failure" role="alert">
      <strong>That reply did not finish</strong>
      {error}
      {last ? (
        <div class="row">
          <button class="btn inline" onClick={() => void run('send', { text: last.text })}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  )
}
