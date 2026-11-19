// Writes a streamed reply out at a reading pace: 40 to 80 characters a second, catching up
// quickly when the model is far ahead, so it reads like typing without lagging behind.

export const MIN_RATE = 40
export const MAX_RATE = 80
/** Beyond this many characters behind, speed up so the gap closes in about half a second. */
export const FAR_BEHIND = 120

export function rateFor(backlog: number): number {
  if (backlog <= 0) return 0
  if (backlog > FAR_BEHIND) return Math.max(MAX_RATE, backlog * 4)
  return MIN_RATE + (MAX_RATE - MIN_RATE) * Math.min(1, backlog / FAR_BEHIND)
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

export class Pacer {
  private target = ''
  private shown = 0

  constructor(start = '', shownChars = 0) {
    this.target = start
    this.shown = Math.min(shownChars, start.length)
  }

  /** The text the model has produced so far (cumulative). */
  setTarget(text: string): void {
    if (!text.startsWith(this.target.slice(0, Math.floor(this.shown)))) {
      // The reply was rewritten (say, a MEDIA tag was taken out): keep what still matches.
      this.shown = Math.min(this.shown, commonPrefix(this.target, text))
    }
    this.target = text
  }

  /** Advance by `dt` seconds. Returns whether the visible text changed. */
  step(dt: number): boolean {
    const before = Math.floor(this.shown)
    const backlog = this.target.length - this.shown
    if (backlog <= 0) {
      this.shown = this.target.length
      return before !== this.shown
    }
    this.shown = Math.min(this.target.length, this.shown + rateFor(backlog) * Math.min(dt, 0.25))
    return Math.floor(this.shown) !== before
  }

  get done(): boolean {
    return Math.floor(this.shown) >= this.target.length
  }

  get count(): number {
    return Math.floor(this.shown)
  }

  /** The visible text, never splitting a surrogate pair. */
  get text(): string {
    let end = Math.floor(this.shown)
    const code = this.target.charCodeAt(end - 1)
    if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1
    return this.target.slice(0, end)
  }

  finish(): void {
    this.shown = this.target.length
  }
}
