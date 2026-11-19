import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { Send, Stop } from '../icons'
import type { AppState } from '../protocol/state'
import type { Command } from '../protocol/types'
import { client, toast } from '../ui'
import { loadCommands, Palette, suggest, type Suggestion } from './Palette'

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

  // "/" starts a Hermes command: the palette offers them, Enter runs one. "//" sends a plain "/".
  const [commands, setCommands] = useState<Command[]>([])
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const isCommand = text.startsWith('/') && !text.startsWith('//')
  useEffect(() => {
    if (isCommand && ready && s.view) loadCommands(s.view.profile).then(setCommands).catch(() => undefined)
  }, [isCommand, ready, s.view?.profile])
  useEffect(() => {
    setActive(0)
    if (!isCommand) setDismissed(false)
  }, [text])
  const items: Suggestion[] = isCommand && !dismissed ? suggest(text, commands) || [] : []

  const runCommand = async (body: string) => {
    setText('')
    try {
      const r = (await client().request('command', { text: body }, 130_000)) as { prefill?: string; notice?: string }
      if (r.prefill) setText(r.prefill)
      if (r.notice) toast(r.notice, 'info')
    } catch (e) {
      setText(body)
      toast((e as Error).message)
    }
  }

  const pick = (item: Suggestion) => {
    if (item.runs) void runCommand(item.fill)
    else {
      setText(item.fill)
      ref.current?.focus()
    }
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  const send = async () => {
    let body = text.trim()
    if (!body || !ready) return
    if (body.startsWith('/') && !body.startsWith('//')) return runCommand(body)
    if (body.startsWith('//')) body = body.slice(1)
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
    <>
    <Palette items={items} active={active} onPick={pick} />
    <div class="composer">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={ready ? `Message ${name}` : 'Waiting for Hermes'}
        aria-label={`Message ${name}`}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (items.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
            return
          }
          if (items.length && e.key === 'Tab') {
            e.preventDefault()
            setText(items[active].fill)
            return
          }
          if (items.length && e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            setDismissed(true)
            return
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault()
            const item = items[active]
            if (item && text.trim() !== item.fill.trim()) pick(item)
            else if (!busy || isCommand) void send()
          } else if (e.key === 'ArrowUp' && !text) {
            // Bring back the last thing you sent, to fix or resend it.
            const last = [...(s.view?.messages || [])].reverse().find((m) => m.role === 'user')
            if (last) {
              e.preventDefault()
              setText(last.text)
            }
          }
        }}
      />
      {busy && !text.trim() ? (
        <button class="send stop" onClick={stop} aria-label="Stop">
          <Stop size={20} />
        </button>
      ) : (
        <button class="send" disabled={!ready || !text.trim() || (busy && !isCommand)} onClick={() => void send()} aria-label={isCommand ? 'Run command' : 'Send'}>
          <Send size={22} />
        </button>
      )}
    </div>
    </>
  )
}
