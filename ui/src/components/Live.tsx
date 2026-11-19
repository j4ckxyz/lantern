// The reply being written. One pacer per turn, handed on to the finished message so the
// typing never jumps when the final text arrives.
import { useEffect, useRef, useState } from 'preact/hooks'
import { Pacer } from '../pacer'
import type { Tool, Turn } from '../protocol/types'
import { Check, Cross, Spinner } from '../icons'
import { Markdown } from './Markdown'

const live: { turnId: string; pacer: Pacer | null } = { turnId: '', pacer: null }

function pacerFor(turnId: string): Pacer {
  if (live.turnId !== turnId || !live.pacer) {
    live.turnId = turnId
    live.pacer = new Pacer()
  }
  return live.pacer
}

/** Takes over the live pacer (or starts one) for a finished message. */
export function adoptPacer(): Pacer {
  const p = live.pacer || new Pacer()
  live.pacer = null
  live.turnId = ''
  return p
}

function usePaced(pacer: Pacer, target: string, onDone?: () => void): string {
  pacer.setTarget(target)
  const [text, setText] = useState(pacer.text)
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      if (pacer.step(dt)) setText(pacer.text)
      if (pacer.done) {
        setText(pacer.text)
        done.current?.()
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [pacer, target])
  return text
}

export function LiveReply({ turn, waiting = false }: { turn: Turn; waiting?: boolean }) {
  const pacer = pacerFor(turn.id)
  const text = usePaced(pacer, turn.text)
  return (
    <div class="msg-agent live" aria-live="polite">
      {text ? <Markdown text={text} streaming /> : null}
      <Activity turn={turn} waiting={waiting} />
    </div>
  )
}

/** A finished reply that keeps writing itself out, then renders normally. */
export function PacedText({ text, pacer, onDone }: { text: string; pacer: Pacer; onDone: () => void }) {
  const shown = usePaced(pacer, text, onDone)
  return <Markdown text={shown} streaming={shown.length < text.length} />
}

export function Thinking() {
  return (
    <span class="thinking" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  )
}

function toolLabel(t: Tool): string {
  return t.label || t.name.replace(/[_.]/g, ' ')
}

export function Activity({ turn, waiting = false }: { turn: Turn; waiting?: boolean }) {
  const running = turn.tools.filter((t) => t.state === 'running')
  const status = waiting
    ? 'Waiting for your answer'
    : // The chips name each tool; the line says what is happening overall, never the same words twice.
      turn.status || (running.length ? 'Working' : turn.text ? '' : 'Thinking')
  const tools = turn.tools.slice(-4)
  // Before the first words and between tools, a soft wave says Hermes is thinking. Its reasoning
  // itself is never shown.
  const thinking = !waiting && !running.length && !turn.text
  return (
    <div class="activity">
      {status ? (
        <div class="activity-status">
          {thinking ? <Thinking /> : <span class={waiting ? 'pulse held' : 'pulse'} />}
          <span>{status}</span>
        </div>
      ) : null}
      {tools.length ? (
        <div class="tools">
          {tools.map((t) => (
            <span key={t.id} class={`tool ${t.state}`}>
              {t.state === 'running' ? <Spinner size={15} /> : t.state === 'done' ? <Check size={15} /> : <Cross size={15} />}
              <span>{toolLabel(t)}</span>
              {t.state === 'running' && t.progress != null ? <i class="bar" style={{ width: `${Math.round(t.progress * 100)}%` }} /> : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
