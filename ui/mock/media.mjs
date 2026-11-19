// Sample media made on the fly: pictures (PNG), a short audio clip (WAV) and a CSV file.
// Nothing here is copied from anywhere.
import { deflateSync } from 'node:zlib'

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** A PNG from a function (x, y) => [r, g, b, a]. */
export function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = pixel(x, y)
      raw.set([r, g, b, a], row + 1 + x * 4)
    }
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(w, 0)
  head.writeUInt32BE(h, 4)
  head[8] = 8
  head[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const mixc = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))

/** A calm abstract landscape: a dusk gradient, a low sun and layered hills. */
export function landscape(w = 960, h = 600) {
  const top = [24, 30, 92]
  const low = [236, 146, 120]
  return png(w, h, (x, y) => {
    const t = y / h
    let c = mixc(top, low, Math.min(1, t * 1.4))
    const sx = w * 0.68, sy = h * 0.52, r = h * 0.11
    const d = Math.hypot(x - sx, y - sy)
    if (d < r) c = mixc(c, [255, 222, 170], 0.9)
    else if (d < r * 2.4) c = mixc(c, [255, 200, 150], 0.25 * (1 - (d - r) / (r * 1.4)))
    const hill1 = h * 0.62 + Math.sin(x / 90) * 22 + Math.sin(x / 31) * 6
    const hill2 = h * 0.74 + Math.sin(x / 140 + 1.3) * 30
    const hill3 = h * 0.86 + Math.sin(x / 70 + 2.1) * 14
    if (y > hill1) c = [58, 52, 112]
    if (y > hill2) c = [36, 34, 84]
    if (y > hill3) c = [18, 18, 52]
    return c
  })
}

/** A small rounded tile with a mark, used for favicons. */
export function tile(size, rgb, mark = [255, 255, 255]) {
  return png(size, size, (x, y) => {
    const r = size * 0.22
    const cx = Math.min(Math.max(x, r), size - 1 - r)
    const cy = Math.min(Math.max(y, r), size - 1 - r)
    if (Math.hypot(x - cx, y - cy) > r) return [0, 0, 0, 0]
    const d = Math.hypot(x - size / 2, y - size / 2)
    return d < size * 0.2 ? mark : rgb
  })
}

/** A wide card picture for link previews. */
export function banner(w = 600, h = 315, a = [40, 60, 160], b = [120, 70, 190]) {
  return png(w, h, (x, y) => {
    const c = mixc(a, b, (x / w + y / h) / 2)
    const ring = Math.abs(Math.hypot(x - w * 0.75, y - h * 0.4) - h * 0.28) < 3
    return ring ? [255, 255, 255] : c
  })
}

/** A round avatar: soft gradient sphere. */
export function avatar(size = 128) {
  return png(size, size, (x, y) => {
    const d = Math.hypot(x - size / 2, y - size / 2)
    if (d > size / 2) return [0, 0, 0, 0]
    const lx = Math.hypot(x - size * 0.35, y - size * 0.3) / size
    return mixc([255, 196, 180], [110, 40, 70], Math.min(1, lx * 1.4))
  })
}

/** Signed 16-bit mono PCM: a few soft syllables, to stand in for speech. */
export function speechPcm(rate = 24000, seconds = 2.6) {
  const n = Math.floor(rate * seconds)
  const out = new Int16Array(n)
  const notes = [196, 220, 247, 220, 196, 175, 196, 233]
  const syl = n / notes.length
  for (let i = 0; i < n; i++) {
    const k = Math.floor(i / syl)
    const p = (i % syl) / syl
    const env = Math.sin(Math.PI * Math.min(1, p * 1.25)) ** 2 * (p < 0.8 ? 1 : 0)
    const f = notes[k % notes.length]
    const t = i / rate
    const v = Math.sin(2 * Math.PI * f * t) * 0.6 + Math.sin(2 * Math.PI * f * 2 * t) * 0.25 + Math.sin(2 * Math.PI * f * 3 * t) * 0.1
    out[i] = Math.round(v * env * 9000)
  }
  return out
}

/** A WAV file: a short two-note chime phrase. */
export function chimeWav(rate = 22050, seconds = 4) {
  const n = Math.floor(rate * seconds)
  const data = Buffer.alloc(n * 2)
  const notes = [523.25, 659.25, 783.99, 659.25]
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const k = Math.floor(t)
    const local = t - k
    const f = notes[k % notes.length]
    const v = Math.sin(2 * Math.PI * f * t) * Math.exp(-local * 3) * 0.5
    data.writeInt16LE(Math.round(v * 32767 * 0.6), i * 2)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

export function budgetCsv() {
  return Buffer.from(
    'Category,Planned,Spent\nGroceries,320,287.40\nTransport,90,64.10\nUtilities,140,151.25\nEating out,80,46.00\nSubscriptions,35,35.00\n',
  )
}
