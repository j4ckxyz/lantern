// The desk's normal way round: 1280x720 at scale 2 (640x360 CSS pixels). Pictures of every state,
// compared with approved images like screens.spec.ts (which covers portrait).
import { expect, test } from '@playwright/test'
import { openApp, openChat, say, settle } from './helpers'

test.use({ viewport: { width: 640, height: 360 } })

for (const theme of ['dark', 'light'] as const) {
  test.describe(`landscape ${theme}`, () => {
    test('chat, with the clock in the panel', async ({ page }) => {
      await openChat(page, { theme })
      await expect(page.locator('.p-time')).toHaveText('10:30')
      await settle(page)
      await expect(page).toHaveScreenshot(`l-chat-${theme}.png`)
    })

    test('working: the panel says what Hermes is doing', async ({ page }) => {
      await openChat(page, { theme })
      await page.locator('textarea').fill('wait for it')
      await page.keyboard.press('Enter')
      await expect(page.locator('.p-tools')).toContainText('Reading notes/garden.md')
      await expect(page.getByText('Let me check the forecast and your garden notes first.')).toBeVisible()
      // The tools are listed once, in the panel, not again in the reply.
      await expect(page.locator('.msg-agent.live .tools')).toBeHidden()
      await settle(page)
      await expect(page).toHaveScreenshot(`l-working-${theme}.png`)
    })

    test('approval: the card replaces the message box, Stop moves to the panel', async ({ page }) => {
      await openChat(page, { theme })
      await page.locator('textarea').fill('approve this')
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible()
      await expect(page.locator('.composer')).toBeHidden()
      await expect(page.locator('.p-chip.stop')).toBeVisible()
      await settle(page)
      await expect(page).toHaveScreenshot(`l-approval-${theme}.png`)
    })

    test('question', async ({ page }) => {
      await openChat(page, { theme })
      await page.locator('textarea').fill('ask me')
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Family' })).toBeVisible()
      await settle(page)
      await expect(page).toHaveScreenshot(`l-question-${theme}.png`)
    })

    test('media reply', async ({ page }) => {
      await openChat(page, { theme })
      await say(page, 'show me media')
      await settle(page)
      await expect(page).toHaveScreenshot(`l-media-${theme}.png`)
    })

    test('long reply', async ({ page }) => {
      await openChat(page, { theme })
      await say(page, 'something long')
      await page.locator('.md table').scrollIntoViewIfNeeded()
      await settle(page)
      await expect(page).toHaveScreenshot(`l-long-${theme}.png`)
    })

    test('profiles drawer', async ({ page }) => {
      await openChat(page, { theme, conversations: true })
      await page.locator('.p-who').click()
      await expect(page.getByRole('dialog', { name: 'Profiles and conversations' })).toBeVisible()
      await page.waitForTimeout(400)
      await expect(page).toHaveScreenshot(`l-profiles-${theme}.png`)
    })

    test('settings drawer', async ({ page }) => {
      await openChat(page, { theme })
      await page.keyboard.press('Control+,')
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
      await page.waitForTimeout(400)
      await expect(page).toHaveScreenshot(`l-settings-${theme}.png`)
    })

    test('QR dialog', async ({ page }) => {
      await openChat(page, { theme })
      await say(page, 'links please')
      await page.locator('.link-card').first().click()
      await expect(page.getByRole('dialog', { name: 'Open on your phone' })).toBeVisible()
      await page.waitForTimeout(400)
      await expect(page).toHaveScreenshot(`l-qr-${theme}.png`)
    })

    test('sign in fits without scrolling', async ({ page }) => {
      await openApp(page, { mock: 'signin', theme })
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeInViewport()
      await expect(page.getByRole('button', { name: 'Use a different address' })).toBeInViewport()
      await expect(page).toHaveScreenshot(`l-signin-${theme}.png`)
    })

    test('setup', async ({ page }) => {
      await openApp(page, { mock: 'setup', theme })
      await expect(page.getByRole('heading', { name: 'Connect to your Hermes' })).toBeVisible()
      await expect(page).toHaveScreenshot(`l-setup-${theme}.png`)
    })

    test('setting up from a phone', async ({ page }) => {
      await openApp(page, { mock: 'signin', theme })
      await page.getByRole('button', { name: 'Use your phone instead' }).click()
      await expect(page.locator('.phone-code')).toHaveText('K7Q-4MP')
      await expect(page).toHaveScreenshot(`l-phone-${theme}.png`)
    })

    test('slash command palette', async ({ page }) => {
      await openChat(page, { theme })
      await page.locator('textarea').fill('/')
      await expect(page.getByRole('option', { name: /\/usage/ })).toBeVisible()
      await page.waitForTimeout(300)
      await expect(page).toHaveScreenshot(`l-palette-${theme}.png`)
    })

    test('thinking', async ({ page }) => {
      await openChat(page, { theme })
      await page.locator('textarea').fill('slow one')
      await page.keyboard.press('Enter')
      await expect(page.locator('.p-status .thinking')).toBeVisible()
      await expect(page).toHaveScreenshot(`l-thinking-${theme}.png`)
    })

    test('offline', async ({ page }) => {
      await openApp(page, { mock: 'offline', theme })
      await expect(page.getByText('Hermes is not answering')).toBeVisible()
      await settle(page)
      await expect(page).toHaveScreenshot(`l-offline-${theme}.png`, { mask: [page.locator('.p-line span').first()] })
    })
  })
}

test('landscape, large text', async ({ page }) => {
  await openChat(page, { size: 'large' })
  await settle(page)
  await expect(page).toHaveScreenshot('l-chat-large.png')
})

test('the panel follows a turn: thinking, then the clock again', async ({ page }) => {
  await openChat(page)
  await say(page, 'slow one')
  await expect(page.locator('.p-time')).toBeVisible()
  await expect(page.locator('.p-work')).toHaveCount(0)
})

test('turning the screen swaps the panel for the top bar', async ({ page }) => {
  await openChat(page)
  await expect(page.locator('.presence')).toBeVisible()
  await expect(page.locator('.topbar')).toHaveCount(0)
  await page.setViewportSize({ width: 360, height: 640 })
  await expect(page.locator('.topbar')).toBeVisible()
  await expect(page.locator('.presence')).toHaveCount(0)
})
