import { useEffect, useRef, useState } from 'preact/hooks'
import { bytes, duration, fileKind } from '../format'
import { File as FileIcon, Pause, Play, QrIcon } from '../icons'
import type { Media } from '../protocol/types'
import { overlays } from '../ui'

export function MediaList({ media }: { media: Media[] }) {
  if (!media.length) return null
  return (
    <div class="media-list">
      {media.map((m) =>
        m.kind === 'image' ? <ImageMedia key={m.id} media={m} /> : m.kind === 'audio' ? <AudioCard key={m.id} media={m} /> : <FileCard key={m.id} media={m} />,
      )}
    </div>
  )
}

function ImageMedia({ media }: { media: Media }) {
  return (
    <img
      class="media-img"
      src={media.url}
      alt={media.name}
      loading="lazy"
      decoding="async"
      onClick={() => overlays.open({ kind: 'image', src: media.url, alt: media.name })}
    />
  )
}

export function AudioCard({ media }: { media: Media }) {
  const ref = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [length, setLength] = useState(0)
  const [rate, setRate] = useState(1)

  useEffect(() => {
    const a = ref.current
    if (!a) return
    const sync = () => {
      setTime(a.currentTime)
      setLength(isFinite(a.duration) ? a.duration : 0)
      setPlaying(!a.paused && !a.ended)
    }
    const events = ['timeupdate', 'durationchange', 'loadedmetadata', 'play', 'pause', 'ended']
    for (const ev of events) a.addEventListener(ev, sync)
    return () => {
      for (const ev of events) a.removeEventListener(ev, sync)
    }
  }, [])

  const toggle = () => {
    const a = ref.current
    if (!a) return
    if (a.paused) {
      // Only one thing plays at a time.
      document.querySelectorAll('audio').forEach((other) => other !== a && other.pause())
      void a.play().catch(() => undefined)
    } else a.pause()
  }
  const fill = length ? `${(time / length) * 100}%` : '0%'

  return (
    <div class="card audio">
      <audio ref={ref} src={media.url} preload="metadata" />
      <div class="audio-row">
        <button class="play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={20} /> : <Play size={20} />}
        </button>
        <div class="audio-main">
          <div class="audio-name">{media.name}</div>
          <input
            class="scrub"
            type="range"
            min={0}
            max={length || 0}
            step={0.1}
            value={time}
            style={{ '--fill': fill }}
            aria-label="Position"
            onInput={(e) => {
              const a = ref.current
              if (a) a.currentTime = Number((e.target as HTMLInputElement).value)
            }}
          />
        </div>
      </div>
      <div class="audio-foot">
        <span>
          {duration(time)} / {duration(length)}
        </span>
        <button
          class="speed"
          aria-label="Playback speed"
          onClick={() => {
            const next = rate === 1 ? 1.5 : 1
            setRate(next)
            if (ref.current) ref.current.playbackRate = next
          }}
        >
          {rate === 1 ? '1x' : '1.5x'}
        </button>
      </div>
    </div>
  )
}

export function FileCard({ media }: { media: Media }) {
  // A phone can only open an address it can reach; this device's own /media paths are not one.
  const share = media.link && /^https?:\/\//i.test(media.link) ? media.link : /^https?:\/\//i.test(media.url) ? media.url : ''
  const shareable = Boolean(share)
  const sub = [fileKind(media.mime, media.name), bytes(media.size)].filter(Boolean).join(' · ')
  const body = (
    <>
      <span class="card-icon">
        <FileIcon />
      </span>
      <span class="card-text">
        <span class="card-title">{media.name}</span>
        <span class="card-sub">{sub}</span>
      </span>
      {shareable ? (
        <span class="card-trail">
          <QrIcon />
        </span>
      ) : null}
    </>
  )
  return shareable ? (
    <button class="card" onClick={() => overlays.open({ kind: 'qr', url: share, title: media.name, hint: 'Scan to download it on your phone. Your phone needs to be signed in to your Hermes dashboard.' })}>
      {body}
    </button>
  ) : (
    <div class="card">{body}</div>
  )
}
