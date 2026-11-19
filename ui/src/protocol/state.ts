// The screen's model: a pure reducer over the service's events, so it can be tested without a DOM.
import {
  DEFAULT_SETTINGS,
  type LinkState,
  type Message,
  type Pairing,
  type Profile,
  type Prompt,
  type ServerEvent,
  type Settings,
  type Turn,
  type View,
} from './types'

export interface Notice {
  key: number
  text: string
  level: 'info' | 'warning' | 'error'
  until: number
}

export interface Failure {
  error: string
}

export interface AppState {
  /** The local socket to the service, not the link to Hermes. */
  socket: 'opening' | 'open' | 'closed'
  hello: boolean
  link: LinkState
  error: string
  detail: string
  /** When the service will next try to reach Hermes (ms since epoch), or null. */
  retryAt: number | null
  server: { url: string; version: string } | null
  device: { name: string } | null
  account: { username: string; remembered: boolean } | null
  profiles: Profile[]
  view: View | null
  turn: Turn | null
  /** The finished reply that should keep writing itself out at a typing pace. */
  pacingId: string | null
  failure: Failure | null
  prompt: Prompt | null
  settings: Settings
  dev: boolean
  notices: Notice[]
  speech: { id: string; messageId: string } | null
  pairing: Pairing | null
}

export const initialState: AppState = {
  socket: 'opening',
  hello: false,
  link: 'connecting',
  error: '',
  detail: '',
  retryAt: null,
  server: null,
  device: null,
  account: null,
  profiles: [],
  view: null,
  turn: null,
  pacingId: null,
  failure: null,
  prompt: null,
  settings: DEFAULT_SETTINGS,
  dev: false,
  notices: [],
  speech: null,
  pairing: null,
}

let noticeKey = 0

export function upsert(messages: Message[], message: Message): Message[] {
  const at = messages.findIndex((m) => m.id === message.id)
  if (at === -1) return [...messages, message]
  const copy = messages.slice()
  copy[at] = message
  return copy
}

export function reduce(state: AppState, event: ServerEvent, now = Date.now()): AppState {
  switch (event.type) {
    case 'hello':
      return {
        ...state,
        hello: true,
        link: event.state,
        error: event.error || '',
        detail: event.detail || '',
        retryAt: null,
        server: event.server,
        device: event.device,
        account: event.account,
        profiles: event.profiles || [],
        view: event.view,
        turn: event.turn,
        pacingId: null,
        failure: null,
        prompt: event.prompt,
        settings: { ...DEFAULT_SETTINGS, ...(event.settings || {}) },
        dev: !!event.dev,
        pairing: event.pairing || null,
      }
    case 'pair':
      return { ...state, pairing: event.pairing }
    case 'link':
      return {
        ...state,
        link: event.state,
        error: event.error || '',
        detail: event.detail || '',
        retryAt: event.retry_in != null ? now + event.retry_in * 1000 : null,
        // A turn cannot outlive the connection it ran on.
        turn: event.state === 'ready' ? state.turn : null,
      }
    case 'profiles':
      return { ...state, profiles: event.profiles }
    case 'view':
      // The same chat reloaded (compacted, changed elsewhere) keeps a turn that is still running.
      if (state.view && state.view.session_id === event.view.session_id) return { ...state, view: event.view }
      return { ...state, view: event.view, turn: null, pacingId: null, failure: null }
    case 'title':
      return state.view && state.view.session_id === event.session_id
        ? { ...state, view: { ...state.view, title: event.title } }
        : state
    case 'message': {
      if (!state.view) return state
      const m = event.message
      const finished = m.role === 'assistant' && !m.interim && state.turn !== null
      return {
        ...state,
        view: { ...state.view, messages: upsert(state.view.messages, m) },
        pacingId: finished ? m.id : state.pacingId,
        turn: finished && state.turn ? { ...state.turn, text: '' } : state.turn,
      }
    }
    case 'turn.start':
      return { ...state, turn: event.turn, failure: null, pacingId: null }
    case 'turn.delta':
      return state.turn ? { ...state, turn: { ...state.turn, text: event.text } } : state
    case 'turn.activity':
      return state.turn ? { ...state, turn: { ...state.turn, status: event.status, tools: event.tools } } : state
    case 'turn.end':
      return {
        ...state,
        turn: null,
        failure: event.outcome === 'failure' ? { error: event.error || 'Hermes could not finish that reply.' } : null,
      }
    case 'prompt':
      return { ...state, prompt: event.prompt }
    case 'prompt.close':
      return state.prompt && state.prompt.id === event.id ? { ...state, prompt: null } : state
    case 'attention': {
      // A main chat that is not on screen got a message (a routine, another device). Waking the
      // screen is the device's job; here it is shown for a while.
      const p = state.profiles.find((x) => x.name === event.profile)
      const who = p?.display_name || event.profile
      return reduce(state, { type: 'notice', text: `${who}: ${event.preview}`, level: 'info', ttl_s: 10 }, now)
    }
    case 'notice':
      return {
        ...state,
        notices: [
          ...state.notices.slice(-2),
          { key: ++noticeKey, text: event.text, level: event.level || 'info', until: now + (event.ttl_s || 6) * 1000 },
        ],
      }
    case 'settings':
      return { ...state, settings: { ...state.settings, ...event.settings } }
    case 'speech.start':
    case 'speech.clip':
      return { ...state, speech: { id: event.id, messageId: event.message_id } }
    case 'speech.end':
      return state.speech && state.speech.id === event.id ? { ...state, speech: null } : state
    default:
      return state
  }
}

export function dropNotice(state: AppState, key: number): AppState {
  return { ...state, notices: state.notices.filter((n) => n.key !== key) }
}

/** Older history for the chat `sessionId`. Dropped if a different chat has been opened since it was asked for. */
export function prependMessages(state: AppState, older: Message[], hasMore: boolean, sessionId?: string): AppState {
  if (!state.view || (sessionId !== undefined && state.view.session_id !== sessionId)) return state
  const seen = new Set(state.view.messages.map((m) => m.id))
  const fresh = older.filter((m) => !seen.has(m.id))
  return { ...state, view: { ...state.view, messages: [...fresh, ...state.view.messages], has_more: hasMore } }
}
