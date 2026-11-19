import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { Send, Stop } from '../icons'
import type { AppState } from '../protocol/state'
import { client, toast } from '../ui'

export const composerHandle: { current: HTMLTextAreaElement | null } = { current: null }

export function Composer({ s }: { s: AppState }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    composerHandle.current = ref.current
    return () => {
      composerHandle.current = null
    }
  }, [])
  const ready = s.link === 'ready' && s.socket === 'open'
  const busy = s.turn !== null
  const profile = s.profiles.find((p) => p.name === s.view?.profile)
  const name = profile?.display_name || 'Hermes'

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  const send = async () => {
    const body = text.trim()
    if (!body || !ready) return
    setText('')
    try {
      await client().request('send', { text: body })
    } catch (e) {
      setText(body)
      toast((e as Error).message)
    }
  }

  const stop = () => client().fire('stop')

  return (
    <div class="composer">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={ready ? `Message ${name}` : 'Waiting for Hermes'}
        aria-label={`Message ${name}`}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault()
            if (!busy) void send()
          }
        }}
      />
      {busy && !text.trim() ? (
        <button class="send stop" onClick={stop} aria-label="Stop">
          <Stop size={20} />
        </button>
      ) : (
        <button class="send" disabled={!ready || !text.trim() || busy} onClick={() => void send()} aria-label="Send">
          <Send size={22} />
        </button>
      )}
    </div>
  )
}
