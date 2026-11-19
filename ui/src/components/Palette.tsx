// Hermes's slash commands, offered as you type "/" in the message box: arrows or Tab to pick,
// Enter to run, or a tap. The list comes from the service (`commands.list`) and is kept per profile.
import type { Command } from '../protocol/types'
import { client } from '../ui'

const cache = new Map<string, Promise<Command[]>>()

export function loadCommands(profile: string): Promise<Command[]> {
  let p = cache.get(profile)
  if (!p) {
    p = client()
      .request('commands.list', {})
      .then((r) => ((r as { commands?: Command[] }).commands || []) as Command[])
    p.catch(() => cache.delete(profile))
    cache.set(profile, p)
  }
  return p
}

export function forgetCommands(): void {
  cache.clear()
}

export interface Suggestion {
  /** What the box holds after picking it. */
  fill: string
  label: string
  detail: string
  /** Picking it runs the command straight away (nothing more to type). */
  runs: boolean
}

/** What to offer for the text in the box, or null when it is not a command being typed. */
export function suggest(text: string, commands: Command[]): Suggestion[] | null {
  const m = text.match(/^\/(\S*)(\s(.*))?$/s)
  if (!m || text.startsWith('//')) return null
  const word = m[1].toLowerCase()
  if (m[2] === undefined) {
    const starts = commands.filter((c) => c.name.slice(1).toLowerCase().startsWith(word))
    const contains = commands.filter((c) => !starts.includes(c) && word && (c.name.toLowerCase().includes(word) || c.description.toLowerCase().includes(word)))
    return [...starts, ...contains].slice(0, 30).map((c) => ({
      fill: c.args ? `${c.name} ` : c.name,
      label: c.name,
      detail: c.description,
      runs: !c.args,
    }))
  }
  const cmd = commands.find((c) => c.name.toLowerCase() === `/${word}`)
  if (!cmd?.options?.length) return []
  const arg = (m[3] || '').toLowerCase()
  return cmd.options
    .filter((o) => o.toLowerCase().startsWith(arg))
    .map((o) => ({ fill: `${cmd.name} ${o}`, label: o, detail: cmd.description, runs: true }))
}

export function Palette({ items, active, onPick }: { items: Suggestion[]; active: number; onPick: (s: Suggestion) => void }) {
  if (!items.length) return null
  return (
    <div class="palette" role="listbox" aria-label="Hermes commands">
      {items.map((s, i) => (
        <button
          key={s.fill}
          type="button"
          role="option"
          aria-selected={i === active}
          class={i === active ? 'pal-item on' : 'pal-item'}
          ref={(el) => {
            if (el && i === active) el.scrollIntoView({ block: 'nearest' })
          }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(s)}
        >
          <span class="pal-name">{s.label}</span>
          <span class="pal-detail">{s.detail}</span>
        </button>
      ))}
    </div>
  )
}
