import { useEffect, useState } from 'preact/hooks'
import { speech } from './audio/speech'
import { ChatView, chatHandle } from './components/ChatView'
import { Composer, composerHandle } from './components/Composer'
import { SetupScreen, SigninScreen, Splash } from './components/Gate'
import { ImageViewer } from './components/ImageViewer'
import { PromptCard } from './components/PromptCard'
import { MenuSheet, ProfilesSheet, QrSheet, SettingsSheet } from './components/Sheets'
import { StatusLine } from './components/StatusLine'
import { Toasts } from './components/Toasts'
import { TopBar } from './components/TopBar'
import { Presence } from './components/Presence'
import type { AppState } from './protocol/state'
import type { Settings } from './protocol/types'
import { client, overlays, run, useApp, useLayout, useOverlays, type Overlay } from './ui'

/** Light by day (07:00 to 19:00) when the theme follows the time of day. */
export function effectiveTheme(theme: Settings['theme'], now = new Date()): 'dark' | 'light' {
  if (theme !== 'auto') return theme
  const h = now.getHours()
  return h >= 7 && h < 19 ? 'light' : 'dark'
}

function useLook(s: AppState) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (s.settings.theme !== 'auto') return
    const t = window.setInterval(() => setTick((n) => n + 1), 60_000)
    return () => window.clearInterval(t)
  }, [s.settings.theme])
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = effectiveTheme(s.settings.theme)
    root.dataset.textSize = s.settings.text_size
  }, [s.settings.theme, s.settings.text_size, tick])
  useEffect(() => speech.setVolume(s.settings.speech_volume), [s.settings.speech_volume])
}

function isTyping(el: Element | null): boolean {
  return !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'checkbox'))
}

function useKeys(s: AppState) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const top = overlays.top
      const mod = e.ctrlKey || e.metaKey
      if (e.key === 'Escape') {
        if (top) overlays.close()
        else if (s.turn) client().fire('stop')
        e.preventDefault()
        return
      }
      // Chromium keeps Ctrl+N for itself in some modes, so Alt+N does the same.
      if ((mod || e.altKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        overlays.closeAll()
        if (s.link === 'ready') void run('chat.new', {})
        return
      }
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        overlays.open({ kind: 'profiles' })
        return
      }
      if (mod && e.key === ',') {
        e.preventDefault()
        overlays.open({ kind: 'settings' })
        return
      }
      if (top) return
      if (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        chatHandle.current?.jump(e.key === 'ArrowUp' ? -1 : 1)
        return
      }
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault()
        chatHandle.current?.page(e.key === 'PageUp' ? -1 : 1)
        return
      }
      if (mod && e.key === 'End') {
        chatHandle.current?.toEnd()
        return
      }
      // Typing anywhere goes into the message box, keystroke included.
      const box = composerHandle.current
      if (box && !mod && !e.altKey && e.key.length === 1 && !isTyping(document.activeElement)) {
        e.preventDefault()
        box.focus()
        box.setRangeText(e.key, box.selectionStart, box.selectionEnd, 'end')
        box.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s.turn, s.link])
}

function OverlayView({ o, s }: { o: Overlay; s: AppState }) {
  switch (o.kind) {
    case 'profiles':
      return <ProfilesSheet s={s} initial={o.profile} />
    case 'menu':
      return <MenuSheet s={s} />
    case 'settings':
      return <SettingsSheet s={s} />
    case 'qr':
      return <QrSheet url={o.url} title={o.title} hint={o.hint} />
    case 'image':
      return <ImageViewer src={o.src} alt={o.alt} />
  }
}

export function App() {
  const s = useApp()
  const stack = useOverlays()
  const [changingAddress, setChangingAddress] = useState(false)
  const layout = useLayout()
  const side = layout === 'landscape'
  useLook(s)
  useEffect(() => {
    const root = document.documentElement
    root.dataset.layout = layout
  }, [layout])
  useKeys(s)
  useEffect(() => {
    if (s.link !== 'signin') setChangingAddress(false)
  }, [s.link])

  if (!s.hello) return <Splash />

  if (s.link === 'setup' || (s.link === 'signin' && changingAddress)) {
    return (
      <>
        <SetupScreen s={s} onCancel={changingAddress ? () => setChangingAddress(false) : undefined} />
        <Toasts notices={s.notices} />
      </>
    )
  }
  if (s.link === 'signin') {
    return (
      <>
        <SigninScreen s={s} onChangeAddress={() => setChangingAddress(true)} />
        <Toasts notices={s.notices} />
      </>
    )
  }

  return (
    <div class="app">
      {side ? <Presence s={s} /> : <TopBar s={s} />}
      <div class="main">
        {side ? null : <StatusLine s={s} />}
        <ChatView s={s} />
        <div class={s.prompt ? 'dock has-prompt' : 'dock'}>
          {s.prompt ? <PromptCard key={s.prompt.id} prompt={s.prompt} /> : null}
          <Composer s={s} />
        </div>
      </div>
      {stack.map((o, i) => (
        <OverlayView key={`${o.kind}-${i}`} o={o} s={s} />
      ))}
      <Toasts notices={s.notices} />
    </div>
  )
}
