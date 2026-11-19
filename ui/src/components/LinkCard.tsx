import { useEffect, useState } from 'preact/hooks'
import { domain } from '../format'
import { Globe, QrIcon } from '../icons'
import type { LinkPreview } from '../protocol/types'
import { client, overlays } from '../ui'

const previews = new Map<string, Promise<LinkPreview | null>>()

function preview(url: string): Promise<LinkPreview | null> {
  let p = previews.get(url)
  if (!p) {
    p = client()
      .request<{ preview: LinkPreview }>('link.preview', { url }, 15_000)
      .then((r) => r.preview)
      .catch(() => null)
    previews.set(url, p)
  }
  return p
}

export function LinkCard({ url }: { url: string }) {
  const [data, setData] = useState<LinkPreview | null | undefined>(undefined)
  const [iconBroken, setIconBroken] = useState(false)
  const [thumbBroken, setThumbBroken] = useState(false)
  useEffect(() => {
    let live = true
    void preview(url).then((p) => live && setData(p))
    return () => {
      live = false
    }
  }, [url])

  const site = data ? data.site || domain(url) : url.replace(/^https?:\/\/(www\.)?/i, '')
  const title = data?.title || domain(url)
  return (
    <button class="card link-card" onClick={() => overlays.open({ kind: 'qr', url, title: data?.title || undefined })}>
      <span class="card-icon">{data?.favicon && !iconBroken ? <img src={data.favicon} alt="" onError={() => setIconBroken(true)} /> : <Globe size={20} />}</span>
      <span class="card-text">
        {data === undefined ? (
          <>
            <span class="skeleton" />
            <span class="card-sub">{domain(url)}</span>
          </>
        ) : (
          <>
            <span class="card-title">{title}</span>
            <span class="card-sub">{site}</span>
          </>
        )}
      </span>
      {data?.image && !thumbBroken ? (
        <img class="card-thumb" src={data.image} alt="" onError={() => setThumbBroken(true)} />
      ) : (
        <span class="card-trail">
          <QrIcon size={20} />
        </span>
      )}
    </button>
  )
}
