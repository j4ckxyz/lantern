import { expect, test, type Page } from '@playwright/test'

const shots = 'test-results/real'

async function open(page: Page) {
  await page.goto('/?t=dev')
  await expect(page.locator('textarea')).toBeVisible()
  // The simple desk is always the default profile's main chat.
  await expect(page.getByText("parents' evening")).toBeVisible()
}

/** Profiles and side chats on or off, through Settings, as a person would. */
async function conversations(page: Page, on: boolean) {
  await page.keyboard.press('Control+,')
  const toggle = page.getByRole('switch', { name: /Profiles and side chats/ })
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(on))
  await page.keyboard.press('Escape')
}

async function say(page: Page, text: string) {
  await page.locator('textarea').fill(text)
  await page.keyboard.press('Enter')
  const mine = page.locator('.msg-user').filter({ hasText: text }).last()
  await expect(mine).toBeVisible()
  await expect(page.locator('.send.stop')).toHaveCount(0, { timeout: 30_000 })
  const reply = mine.locator('xpath=following-sibling::article[contains(@class, "msg-agent")][last()]')
  await expect(reply.locator('.msg-meta')).toBeVisible({ timeout: 20_000 })
}

test.describe.configure({ mode: 'serial' })

test('opens on the main chat from the real service, with the avatar', async ({ page }) => {
  await open(page)
  await expect(page.locator('.presence, .topbar')).toContainText('Hermes')
  const avatar = page.locator('.presence, .topbar').locator('img').first()
  await expect(avatar).toBeVisible()
  expect(await avatar.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  await page.screenshot({ path: `${shots}/open.png` })
})

test('a streamed reply, tools while it works, and Markdown', async ({ page }) => {
  await open(page)
  await page.locator('textarea').fill('slow one please')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Web search: weather in Manchester').first()).toBeVisible({ timeout: 10_000 })
  await page.screenshot({ path: `${shots}/working.png` })
  await expect(page.locator('.send.stop')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('.msg-agent').last()).toContainText('fake Hermes')
  await expect(page.locator('.msg-agent').last().locator('strong')).toHaveText('fake Hermes')
})

test('pictures, audio and files from MEDIA tags', async ({ page }) => {
  await open(page)
  await say(page, 'media please')
  const reply = page.locator('.msg-agent').last()
  const img = reply.locator('img').first()
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0)
  await expect(reply.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await expect(reply.getByText('report.pdf')).toBeVisible()
  await expect(reply).toContainText('MEDIA:/not/a/delivery.png')
  await expect(reply).not.toContainText('MEDIA:/home')
  await page.screenshot({ path: `${shots}/media.png` })
  await reply.getByText('report.pdf').click()
  await expect(page.getByRole('dialog', { name: 'Open on your phone' })).toBeVisible()
  await page.screenshot({ path: `${shots}/file-qr.png` })
})

test('approvals: only Allow once or Deny', async ({ page }) => {
  await open(page)
  await page.locator('textarea').fill('approve this')
  await page.keyboard.press('Enter')
  const card = page.getByRole('alertdialog')
  await expect(card).toContainText('rm -rf ~/build/cache')
  await expect(card.getByRole('button')).toHaveText(['Deny', 'Allow once'])
  await page.screenshot({ path: `${shots}/approval.png` })
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(page.locator('.msg-agent').last()).toContainText('You chose once', { timeout: 15_000 })
})

test('a new chat gets its title from Hermes', async ({ page }) => {
  await open(page)
  await conversations(page, true)
  await page.getByRole('button', { name: 'New chat' }).click()
  await expect(page.getByText("parents' evening")).toHaveCount(0)
  await say(page, 'plan a quiet weekend')
  await expect(page.locator('.presence, .topbar')).toContainText('plan a quiet weekend')
  // Back to the simple desk: it returns to the main chat by itself.
  await conversations(page, false)
  await expect(page.getByText("parents' evening")).toBeVisible()
})

test('slash commands come from Hermes and run there', async ({ page }) => {
  await open(page)
  await page.locator('textarea').fill('/')
  await expect(page.getByRole('option', { name: /\/usage/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /\/model/ })).toHaveCount(0)
  await page.locator('textarea').fill('/usage')
  await page.keyboard.press('Enter')
  await expect(page.locator('.msg-command').last()).toContainText('1,234 tokens in')
})

test('reading a reply aloud plays streamed speech', async ({ page }) => {
  await open(page)
  const speak = page.locator('.msg-agent').last().getByRole('button', { name: 'Read aloud' })
  await speak.click()
  await expect(page.locator('.msg-agent').last().getByRole('button', { name: 'Read aloud' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('status').filter({ hasText: /could not|went wrong/i })).toHaveCount(0)
})
