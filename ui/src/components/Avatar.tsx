import { useState } from 'preact/hooks'
import type { Profile } from '../protocol/types'

const HUES = [228, 250, 265, 205, 190, 280, 215, 240]

function hue(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return HUES[h % HUES.length]
}

export function initials(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase()
}

export function Avatar({ profile, size = 36 }: { profile: Pick<Profile, 'name' | 'display_name' | 'avatar'>; size?: number }) {
  const [broken, setBroken] = useState(false)
  const label = profile.display_name || profile.name
  const h = hue(profile.name)
  const style = {
    width: `${size}px`,
    height: `${size}px`,
    fontSize: `${Math.round(size * 0.38)}px`,
    background: `linear-gradient(145deg, hsl(${h} 62% 58%), hsl(${h + 25} 55% 36%))`,
  }
  return (
    <span class="avatar" style={style} aria-hidden="true">
      {profile.avatar && !broken ? <img src={profile.avatar} alt="" onError={() => setBroken(true)} /> : initials(label)}
    </span>
  )
}
