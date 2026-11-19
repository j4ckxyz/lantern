// How the desk is being used right now: touch, a mouse or a keyboard. Sets data-input on <html>,
// so styles can show hover states only for a mouse, and hides the pointer when it is not in use
// (a kiosk has no other way to put the cursor away).
type Mode = 'touch' | 'mouse' | 'keyboard'

const HIDE_AFTER_MS = 2500

export function trackInput(root: HTMLElement = document.documentElement): void {
  let timer = 0
  const set = (mode: Mode) => {
    if (root.dataset.input !== mode) root.dataset.input = mode
  }
  const showCursor = () => {
    root.classList.remove('no-cursor')
    window.clearTimeout(timer)
    timer = window.setTimeout(() => root.classList.add('no-cursor'), HIDE_AFTER_MS)
  }
  root.dataset.input = 'touch'
  root.classList.add('no-cursor')
  window.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType !== 'mouse') return
      set('mouse')
      showCursor()
    },
    { passive: true },
  )
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse') {
        set('mouse')
        showCursor()
      } else {
        set('touch')
        window.clearTimeout(timer)
        root.classList.add('no-cursor')
      }
    },
    { passive: true },
  )
  window.addEventListener('wheel', () => showCursor(), { passive: true })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' || e.key.startsWith('Arrow') || e.key === 'Enter' || e.key === 'Escape') set('keyboard')
  })
}
