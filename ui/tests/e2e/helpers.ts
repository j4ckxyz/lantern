import { expect, type Page } from '@playwright/test'

/**
 * Moves the page's clock to 2026-11-19 10:30:30 (UTC, so London time) while letting it run, so
 * "Today", "Yesterday" and times do not depend on when the tests are run. Playwright's own fake
 * clock freezes animation timing, which the typing pace relies on, so it is not used.
 */
export async function pinDate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Real = Date
    const offset = Real.UTC(2026, 10, 19, 10, 30, 30) - Real.now()
    class Shifted extends Real {
      constructor(...args: unknown[]) {
        if (args.length) super(...(args as [number]))
        else super(Real.now() + offset)
      }
      static now() {
        return Real.now() + offset
      }
    }
    ;(globalThis as { Date: DateConstructor }).Date = Shifted as unknown as DateConstructor
  })
}

export interface OpenOptions {
  mock?: 'setup' | 'signin' | 'offline' | 'connecting' | 'empty'
  theme?: 'dark' | 'light'
  size?: 'compact' | 'comfortable' | 'large'
  /** Profiles, side chats and New chat on screen (the desk's simple mode hides them). */
  conversations?: boolean
}

export async function openApp(page: Page, opts: OpenOptions = {}): Promise<void> {
  await pinDate(page)
  const q = new URLSearchParams({ t: 'dev' })
  if (opts.mock) q.set('mock', opts.mock)
  if (opts.theme) q.set('theme', opts.theme)
  if (opts.size) q.set('size', opts.size)
  if (opts.conversations) q.set('conversations', '1')
  await page.goto(`/?${q}`)
  await page.evaluate(() => document.fonts.ready)
}

export async function openChat(page: Page, opts: OpenOptions = {}): Promise<void> {
  await openApp(page, opts)
  await expect(page.locator('textarea')).toBeVisible()
  await expect(page.getByText('You have three things today')).toBeVisible()
}

/** Send a message and wait until the turn is over and the reply has finished typing. */
export async function say(page: Page, text: string): Promise<void> {
  await page.locator('textarea').fill(text)
  await page.keyboard.press('Enter')
  const mine = page.locator('.msg-user').filter({ hasText: text }).last()
  await expect(mine).toBeVisible()
  // The reply right after it shows its time and speaker button only once it has typed itself out.
  const reply = mine.locator('xpath=following-sibling::article[contains(@class, "msg-agent")][1]')
  await expect(reply.locator('.msg-meta')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.send.stop')).toHaveCount(0, { timeout: 20_000 })
}

/** Wait for the chat to stop moving: pictures and audio headers loaded, then no scrolling for a while. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle')
  await page.evaluate(() =>
    Promise.all([
      ...[...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => i.addEventListener('load', r, { once: true }) || i.addEventListener('error', r, { once: true }))),
      ...[...document.querySelectorAll('audio')].filter((a) => a.readyState < 1).map((a) => new Promise((r) => a.addEventListener('loadedmetadata', r, { once: true }))),
    ]),
  )
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const el = document.querySelector('.scroller')
        let last = -1
        let stable = 0
        const check = () => {
          const now = el ? el.scrollHeight * 10000 + el.scrollTop : 0
          stable = now === last ? stable + 1 : 0
          last = now
          if (stable >= 8) resolve()
          else requestAnimationFrame(() => setTimeout(check, 40))
        }
        check()
      }),
  )
}
