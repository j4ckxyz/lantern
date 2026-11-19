import { useMemo } from 'preact/hooks'
import { renderMarkdown } from '../markdown'
import { overlays } from '../ui'

const cache = new Map<string, string>()

function cached(text: string): string {
  let html = cache.get(text)
  if (html === undefined) {
    html = renderMarkdown(text)
    cache.set(text, html)
    if (cache.size > 400) cache.delete(cache.keys().next().value as string)
  }
  return html
}

function activate(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  const link = el?.closest?.('a.link') as HTMLElement | null
  if (link) {
    const url = link.getAttribute('data-href')
    if (url) overlays.open({ kind: 'qr', url, title: link.textContent?.trim() || undefined })
    return true
  }
  const img = el?.closest?.('img.md-img') as HTMLImageElement | null
  if (img) {
    overlays.open({ kind: 'image', src: img.getAttribute('src') || '', alt: img.alt })
    return true
  }
  return false
}

/** Rendered Markdown. Links open the QR sheet and pictures open the viewer; nothing navigates. */
export function Markdown({ text, streaming = false, class: cls = '' }: { text: string; streaming?: boolean; class?: string }) {
  const html = useMemo(() => (streaming ? renderMarkdown(text, true) : cached(text)), [text, streaming])
  return (
    <div
      class={`md ${cls}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        if (activate(e.target)) e.preventDefault()
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && activate(e.target)) e.preventDefault()
      }}
    />
  )
}
