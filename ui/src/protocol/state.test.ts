import { describe, expect, it } from 'vitest'
import { initialState, prependMessages, reduce } from './state'
import type { Message, ServerEvent, View } from './types'

const msg = (id: string, role: Message['role'], text: string, extra: Partial<Message> = {}): Message => ({
  id, role, text, ts: 1, media: [], ...extra,
})
const view: View = { profile: 'default', session_id: 's1', kind: 'main', title: 'Main chat', messages: [msg('m1', 'user', 'hi')], has_more: true }

const run = (events: ServerEvent[]) => events.reduce((s, e) => reduce(s, e, 1000), initialState)

describe('reduce', () => {
  it('replaces cumulative deltas instead of appending', () => {
    const s = run([
      { type: 'view', view },
      { type: 'turn.start', turn: { id: 't1', started: 1, text: '', status: '', tools: [] } },
      { type: 'turn.delta', text: 'Hel' },
      { type: 'turn.delta', text: 'Hello' },
    ])
    expect(s.turn?.text).toBe('Hello')
  })

  it('replaces a message with the same id', () => {
    const s = run([
      { type: 'view', view },
      { type: 'message', message: msg('m2', 'assistant', 'draft') },
      { type: 'message', message: msg('m2', 'assistant', 'final') },
    ])
    expect(s.view?.messages.map((m) => m.text)).toEqual(['hi', 'final'])
  })

  it('hands the finished reply to the pacer and ends the turn', () => {
    let s = run([
      { type: 'view', view },
      { type: 'turn.start', turn: { id: 't1', started: 1, text: '', status: '', tools: [] } },
      { type: 'turn.delta', text: 'Hello' },
      { type: 'message', message: msg('m3', 'assistant', 'Hello there') },
    ])
    expect(s.pacingId).toBe('m3')
    s = reduce(s, { type: 'turn.end', outcome: 'success' })
    expect(s.turn).toBeNull()
    expect(s.failure).toBeNull()
  })

  it('does not pace interim commentary', () => {
    const s = run([
      { type: 'view', view },
      { type: 'turn.start', turn: { id: 't1', started: 1, text: '', status: '', tools: [] } },
      { type: 'message', message: msg('i1', 'assistant', 'Let me check.', { interim: true }) },
    ])
    expect(s.pacingId).toBeNull()
    expect(s.turn).not.toBeNull()
  })

  it('records a failed turn', () => {
    const s = run([
      { type: 'view', view },
      { type: 'turn.start', turn: { id: 't1', started: 1, text: '', status: '', tools: [] } },
      { type: 'turn.end', outcome: 'failure', error: 'Rate limited.' },
    ])
    expect(s.failure?.error).toBe('Rate limited.')
  })

  it('drops the turn when the link goes down and keeps the retry time', () => {
    const s = run([
      { type: 'view', view },
      { type: 'turn.start', turn: { id: 't1', started: 1, text: '', status: '', tools: [] } },
      { type: 'link', state: 'offline', error: 'No Wi-Fi', retry_in: 8 },
    ])
    expect(s.turn).toBeNull()
    expect(s.retryAt).toBe(9000)
  })

  it('renames the open chat without touching its messages', () => {
    let s = run([{ type: 'view', view }, { type: 'title', session_id: 'other', title: 'Nope' }])
    expect(s.view?.title).toBe('Main chat')
    s = reduce(s, { type: 'title', session_id: 's1', title: 'Weekend plans' })
    expect(s.view?.title).toBe('Weekend plans')
    expect(s.view?.messages).toHaveLength(1)
  })

  it('shows a message that arrived in another main chat', () => {
    const profiles = [{ name: 'sq', display_name: 'Sidequest', is_default: false, avatar: null, main: null }]
    const s = run([{ type: 'profiles', profiles }, { type: 'attention', profile: 'sq', session_id: 'm', preview: 'Your script is ready' }])
    expect(s.notices.map((n) => n.text)).toEqual(['Sidequest: Your script is ready'])
  })

  it('closes only the matching prompt', () => {
    const prompt = { id: 'p1', kind: 'approval' as const, title: 'Allow?', text: '', choices: [], free_text: false }
    let s = run([{ type: 'prompt', prompt }])
    s = reduce(s, { type: 'prompt.close', id: 'other' })
    expect(s.prompt).not.toBeNull()
    s = reduce(s, { type: 'prompt.close', id: 'p1' })
    expect(s.prompt).toBeNull()
  })

  it('drops older history that arrives after a different chat was opened', () => {
    const other: View = { ...view, session_id: 's2', messages: [] }
    const s = prependMessages(run([{ type: 'view', view: other }]), [msg('m0', 'assistant', 'old')], true, 's1')
    expect(s.view?.messages).toEqual([])
  })

  it('prepends older history without duplicates', () => {
    const s = prependMessages(run([{ type: 'view', view }]), [msg('m0', 'assistant', 'old'), msg('m1', 'user', 'hi')], false)
    expect(s.view?.messages.map((m) => m.id)).toEqual(['m0', 'm1'])
    expect(s.view?.has_more).toBe(false)
  })
})
