import { describe, expect, it } from 'vitest'
import { FAR_BEHIND, MAX_RATE, MIN_RATE, Pacer, rateFor } from './pacer'

describe('rateFor', () => {
  it('stays between 40 and 80 characters a second when close behind', () => {
    expect(rateFor(1)).toBeGreaterThanOrEqual(MIN_RATE)
    expect(rateFor(FAR_BEHIND)).toBeLessThanOrEqual(MAX_RATE)
  })
  it('catches up quickly when far behind', () => {
    expect(rateFor(2000)).toBeGreaterThan(1000)
  })
})

describe('Pacer', () => {
  it('reveals text gradually', () => {
    const p = new Pacer()
    p.setTarget('Hello there, this is a reply.')
    p.step(0.1)
    expect(p.text.length).toBeGreaterThan(0)
    expect(p.text.length).toBeLessThan(10)
    for (let i = 0; i < 100; i++) p.step(0.05)
    expect(p.text).toBe('Hello there, this is a reply.')
    expect(p.done).toBe(true)
  })
  it('closes a big gap in under a second, then types the rest', () => {
    const p = new Pacer()
    p.setTarget('x'.repeat(5000))
    let t = 0
    while (5000 - p.count > FAR_BEHIND && t < 5) {
      p.step(1 / 60)
      t += 1 / 60
    }
    expect(t).toBeLessThan(1)
    while (!p.done && t < 10) {
      p.step(1 / 60)
      t += 1 / 60
    }
    expect(t).toBeLessThan(3.5)
  })
  it('keeps the matching part when the text is rewritten', () => {
    const p = new Pacer('Look at MEDIA:/tmp/a.png and more', 20)
    p.setTarget('Look at and more')
    expect(p.text).toBe('Look at ')
  })
  it('continues from where it was', () => {
    const p = new Pacer('abcdefghij', 4)
    expect(p.text).toBe('abcd')
  })
  it('never splits an emoji', () => {
    const p = new Pacer('a\u{1F600}b', 2)
    expect(p.text).toBe('a')
  })
})
