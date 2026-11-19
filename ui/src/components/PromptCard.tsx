import { useState } from 'preact/hooks'
import { Question, Shield } from '../icons'
import type { Prompt } from '../protocol/types'
import { run } from '../ui'

export function PromptCard({ prompt }: { prompt: Prompt }) {
  const [text, setText] = useState('')
  const [sent, setSent] = useState(false)
  const answer = async (fields: Record<string, unknown>) => {
    setSent(true)
    const ok = await run('answer', { id: prompt.id, ...fields })
    if (!ok) setSent(false)
  }

  if (prompt.kind === 'approval') {
    // Only "once" and "deny" are offered here; standing permission belongs on the phone or computer.
    return (
      <section class="prompt" role="alertdialog" aria-label={prompt.title}>
        <div class="prompt-title">
          <Shield size={20} />
          {prompt.title || 'Allow this command?'}
        </div>
        {prompt.text ? <div class="prompt-text">{prompt.text}</div> : null}
        {prompt.command ? <pre class="prompt-command">{prompt.command}</pre> : null}
        <div class="row">
          <button class="btn" disabled={sent} onClick={() => void answer({ choice: 'deny' })}>
            Deny
          </button>
          <button class="btn primary" disabled={sent} onClick={() => void answer({ choice: 'once' })}>
            Allow once
          </button>
        </div>
      </section>
    )
  }

  return (
    <section class="prompt" role="alertdialog" aria-label={prompt.title}>
      <div class="prompt-title">
        <Question size={20} />
        {prompt.title || 'Hermes asks'}
      </div>
      {prompt.text ? <div class="prompt-text">{prompt.text}</div> : null}
      {prompt.choices.length ? (
        <div class="row wrap">
          {prompt.choices.map((c) => (
            <button key={c.id} class="btn" disabled={sent} onClick={() => void answer({ choice: c.id })}>
              {c.label}
            </button>
          ))}
        </div>
      ) : null}
      {prompt.free_text ? (
        <form
          class="prompt-free"
          onSubmit={(e) => {
            e.preventDefault()
            if (text.trim()) void answer({ text: text.trim() })
          }}
        >
          <input class="field" value={text} placeholder="Type an answer" onInput={(e) => setText((e.target as HTMLInputElement).value)} />
          <button class="btn primary inline" disabled={sent || !text.trim()}>
            Send
          </button>
        </form>
      ) : null}
    </section>
  )
}
