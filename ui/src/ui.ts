// Screen-only state (which sheet is open, the picture being viewed), kept apart from the service's model.
import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { Client } from './protocol/client'
import type { AppState } from './protocol/state'

export type Overlay =
  | { kind: 'profiles'; profile?: string }
  | { kind: 'menu' }
  | { kind: 'settings' }
  | { kind: 'qr'; url: string; title?: string; hint?: string }
  | { kind: 'image'; src: string; alt?: string }

type Listener = () => void

class OverlayStore {
  stack: Overlay[] = []
  private listeners = new Set<Listener>()
  open(o: Overlay) {
    // A sheet replaces another sheet; the picture viewer and the QR sheet stack on top.
    const keep = o.kind === 'image' || o.kind === 'qr' ? this.stack : []
    this.stack = [...keep.filter((x) => x.kind !== o.kind), o]
    this.emit()
  }
  close() {
    this.stack = this.stack.slice(0, -1)
    this.emit()
  }
  closeAll() {
    if (!this.stack.length) return
    this.stack = []
    this.emit()
  }
  get top(): Overlay | undefined {
    return this.stack[this.stack.length - 1]
  }
  subscribe(fn: Listener) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private emit() {
    for (const fn of this.listeners) fn()
  }
}

export const overlays = new OverlayStore()

let theClient: Client | null = null

export function setClient(c: Client): void {
  theClient = c
}

export function client(): Client {
  if (!theClient) throw new Error('no client')
  return theClient
}

/**
 * The service's model, re-rendering on every change. Subscribes in a layout effect and checks
 * once more straight after, so an event that lands between render and subscription is not lost.
 */
export function useApp(): AppState {
  const c = client()
  const [, force] = useState(0)
  const seen = useRef(c.store.state)
  seen.current = c.store.state
  useLayoutEffect(() => {
    const off = c.store.subscribe(() => force((n) => n + 1))
    if (c.store.state !== seen.current) force((n) => n + 1)
    return off
  }, [c])
  return c.store.state
}

export function useOverlays(): Overlay[] {
  const [, force] = useState(0)
  const seen = useRef(overlays.stack)
  seen.current = overlays.stack
  useLayoutEffect(() => {
    const off = overlays.subscribe(() => force((n) => n + 1))
    if (overlays.stack !== seen.current) force((n) => n + 1)
    return off
  }, [])
  return overlays.stack
}

/** Show a sentence for a while, as the service's notices are shown. */
export function toast(text: string, level: 'info' | 'warning' | 'error' = 'error'): void {
  client().handle({ type: 'notice', text, level, ttl_s: 6 })
}

export async function run(op: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
  try {
    return await client().request(op, fields)
  } catch (e) {
    toast((e as Error).message)
    return null
  }
}

/** Which way round the screen is. The desk is normally landscape (1280x720 at scale 2). */
export type Layout = 'portrait' | 'landscape'

const landscapeQuery = typeof window !== 'undefined' ? window.matchMedia('(orientation: landscape)') : null

export function currentLayout(): Layout {
  return landscapeQuery?.matches ? 'landscape' : 'portrait'
}

export function useLayout(): Layout {
  const [layout, setLayout] = useState<Layout>(currentLayout)
  useLayoutEffect(() => {
    if (!landscapeQuery) return
    const on = () => setLayout(currentLayout())
    landscapeQuery.addEventListener('change', on)
    on()
    return () => landscapeQuery.removeEventListener('change', on)
  }, [])
  return layout
}

