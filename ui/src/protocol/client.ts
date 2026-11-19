// The WebSocket to the service: one connection, operations with answers, and a store the screen reads.
import { initialState, reduce, type AppState } from './state'
import type { ServerEvent } from './types'

type Listener = () => void
type Answer = { ok: boolean; error?: string; [key: string]: unknown }

export class OpError extends Error {}

export class Store {
  state: AppState = initialState
  private listeners = new Set<Listener>()

  set(next: AppState): void {
    if (next === this.state) return
    this.state = next
    for (const fn of this.listeners) fn()
  }

  update(fn: (s: AppState) => AppState): void {
    this.set(fn(this.state))
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

export interface ClientOptions {
  url: string
  onAudio?: (pcm: ArrayBuffer) => void
  onEvent?: (event: ServerEvent) => void
}

export class Client {
  readonly store = new Store()
  private ws: WebSocket | null = null
  private pending = new Map<string, { resolve: (a: Answer) => void; reject: (e: Error) => void }>()
  private n = 0
  private retry = 0
  private aliveTimer = 0
  private closed = false

  constructor(private opts: ClientOptions) {}

  connect(): void {
    this.closed = false
    const ws = new WebSocket(this.opts.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.store.update((s) => ({ ...s, socket: 'opening' }))
    ws.onopen = () => {
      this.retry = 0
      this.store.update((s) => ({ ...s, socket: 'open' }))
      window.clearInterval(this.aliveTimer)
      this.aliveTimer = window.setInterval(() => this.fire('alive'), 10_000)
      this.fire('alive')
    }
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        this.opts.onAudio?.(e.data as ArrayBuffer)
        return
      }
      let event: ServerEvent
      try {
        event = JSON.parse(e.data)
      } catch {
        return
      }
      this.handle(event)
    }
    ws.onclose = () => {
      window.clearInterval(this.aliveTimer)
      for (const p of this.pending.values()) p.reject(new OpError('The connection to this device’s service dropped.'))
      this.pending.clear()
      this.store.update((s) => ({ ...s, socket: 'closed' }))
      if (this.closed) return
      // The service is on this machine: come back quickly, then settle at 3 s.
      const delay = Math.min(3000, 300 * 2 ** this.retry++)
      window.setTimeout(() => this.connect(), delay)
    }
  }

  close(): void {
    this.closed = true
    this.ws?.close()
  }

  /** Apply one event to the store; also used by tests. */
  handle(event: ServerEvent): void {
    if (event.type === 'result') {
      const req = event.req
      if (req && this.pending.has(req)) {
        const p = this.pending.get(req)!
        this.pending.delete(req)
        p.resolve(event as Answer)
      } else if (!event.ok && event.error) {
        this.store.update((s) => reduce(s, { type: 'notice', text: event.error!, level: 'error', ttl_s: 8 }))
      }
      return
    }
    this.store.update((s) => reduce(s, event))
    this.opts.onEvent?.(event)
  }

  /** Send an operation and wait for its answer. Rejects with a readable sentence on failure. */
  request<T = Answer>(op: string, fields: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new OpError('Not connected to this device’s service yet.'))
    }
    const req = `r${++this.n}`
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(req)
        reject(new OpError('That took too long. Try again.'))
      }, timeoutMs)
      this.pending.set(req, {
        resolve: (a) => {
          window.clearTimeout(timer)
          if (a.ok) resolve(a as T)
          else reject(new OpError(a.error || 'That did not work.'))
        },
        reject: (e) => {
          window.clearTimeout(timer)
          reject(e)
        },
      })
      ws.send(JSON.stringify({ op, req, ...fields }))
    })
  }

  /** Send an operation without waiting; a failure still arrives as a notice. */
  fire(op: string, fields: Record<string, unknown> = {}): void {
    const ws = this.ws
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, ...fields }))
  }
}

/** `/ws` on this origin, carrying the page's own query (the token, and in development the mock's options). */
export function socketUrl(loc: Location = window.location): string {
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${loc.host}/ws${loc.search}`
}
