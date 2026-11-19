// Pictures of every state and screen, compared with approved images (tests/e2e/screens.spec.ts-snapshots).
// After a deliberate design change: npx playwright test --update-snapshots, then look at the new pictures.
import { expect, test } from '@playwright/test'
import { openApp, openChat, say, settle } from './helpers'

for (const theme of ['dark', 'light'] as const) {
  test.describe(theme, () => {
    test('chat', async ({ page }) => {
      await openChat(page, { theme })
      await settle(page)
      await expect(page).toHaveScreenshot(`chat-${theme}.png`)
    })

    test('setup', async ({ page }) => {
      await openApp(page, { mock: 'setup', theme })
      await expect(page.getByRole('heading', { name: 'Connect to your Hermes' })).toBeVisible()
      await expect(page).toHaveScreenshot(`setup-${theme}.png`)
    })

    test('sign in', async ({ page }) => {
      await openApp(page, { mock: 'signin', theme })
      await expect(page.getByRole('heading', { name: 'Sign in to Hermes' })).toBeVisible()
      await expect(page).toHaveScreenshot(`signin-${theme}.png`)
    })

    test('offline', async ({ page }) => {
      await openApp(page, { mock: 'offline', theme })
      await expect(page.getByText('Hermes is not answering')).toBeVisible()
      await settle(page)
      await expect(page).toHaveScreenshot(`offline-${theme}.png`, { mask: [page.locator('.statusline .msg')] })
    })

    test('connecting', async ({ page }) => {
      await openApp(page, { mock: 'connecting', theme })
      await expect(page.getByText('Connecting to Hermes')).toBeVisible()
      await settle(page)
      await expect(page).toHaveScreenshot(`connecting-${theme}.png`)
    })

    test('working', async ({ page }) => {
      await openChat(page, { theme })
      await page.locator('textarea').fill('wait for it')
      await page.keyboard.press('Enter')
      await expect(page.getByText('Reading notes/garden.md')).toBeVisible()
      await expect(page.getByText('Let me check the forecast and your garden notes first.')).toBeVisible()
      await settle(page)
      await expect(page).toHaveScreenshot(`working-${theme}.png`)
    })

    test('media reply', async ({ page }) => {
      await openChat(page, { theme })
      await say(page, 'show me media')
      await settle(page)
      await expect(page).toHaveScreenshot(`media-${theme}.png`)
    })

    test('link cards', async ({ page }) => {
      await openChat(page, { theme })
      await say(page, 'links please')
      await expect(page.getByText('Raspberry Pi Touch Display 2')).toBeVisible()
      await settle(page)
      await expect(page).toHaveScreenshot(`links-${theme}.png`)
    })

    test('long reply with code and a table', async ({ page }) => {
      await openChat(page, { theme })
      await say(page, 'something long')
      await page.locator('.md table').scrollIntoViewIfNeeded()
      await settle(page)
      await expect(page).toHaveScreenshot(`long-${theme}.png`)
    })

    test('approval', async ({ page }) => {
      await openChat(page, { theme })
      await page.locator('textarea').fill('approve this')
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible()
      await settle(page)
      await expect(page).toHaveScreenshot(`approval-${theme}.png`)
    })

    test('question', async ({ page }) => {
      await openChat(page, { theme })
      await page.locator('textarea').fill('ask me')
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Family' })).toBeVisible()
      await settle(page)
      await expect(page).toHaveScreenshot(`question-${theme}.png`)
    })

    test('failed turn', async ({ page }) => {
      await openChat(page, { theme })
      await page.locator('textarea').fill('error please')
      await page.keyboard.press('Enter')
      await expect(page.getByText('That reply did not finish')).toBeVisible()
      await settle(page)
      await expect(page).toHaveScreenshot(`failure-${theme}.png`)
    })

    test('profiles sheet', async ({ page }) => {
      await openChat(page, { theme })
      await page.locator('.who').click()
      await expect(page.getByRole('dialog', { name: 'Profiles and conversations' })).toBeVisible()
      await page.waitForTimeout(400)
      await expect(page).toHaveScreenshot(`profiles-${theme}.png`)
    })

    test('conversations', async ({ page }) => {
      await openChat(page, { theme })
      await page.locator('.who').click()
      await page.getByRole('button', { name: 'Conversations' }).first().click()
      await expect(page.getByText('Weekend walking route')).toBeVisible()
      await page.waitForTimeout(400)
      await expect(page).toHaveScreenshot(`conversations-${theme}.png`)
    })

    test('menu', async ({ page }) => {
      await openChat(page, { theme })
      await page.getByRole('button', { name: 'More' }).click()
      await expect(page.getByText('Compact this chat')).toBeVisible()
      await page.waitForTimeout(400)
      await expect(page).toHaveScreenshot(`menu-${theme}.png`)
    })

    test('settings', async ({ page }) => {
      await openChat(page, { theme })
      await page.keyboard.press('Control+,')
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
      await page.waitForTimeout(400)
      await expect(page).toHaveScreenshot(`settings-${theme}.png`)
    })

    test('QR sheet', async ({ page }) => {
      await openChat(page, { theme })
      await say(page, 'links please')
      await page.locator('.link-card').first().click()
      await expect(page.getByRole('dialog', { name: 'Open on your phone' })).toBeVisible()
      await page.waitForTimeout(400)
      await expect(page).toHaveScreenshot(`qr-${theme}.png`)
    })

    test('picture viewer', async ({ page }) => {
      await openChat(page, { theme })
      await say(page, 'show me media')
      await page.locator('.media-img').click()
      await expect(page.locator('.viewer img')).toBeVisible()
      await page.waitForTimeout(300)
      await expect(page).toHaveScreenshot(`viewer-${theme}.png`)
    })

    test('new chat', async ({ page }) => {
      await openChat(page, { theme })
      await page.getByRole('button', { name: 'New chat' }).click()
      await expect(page.getByText('New chat about the desk')).toBeVisible()
      await expect(page).toHaveScreenshot(`new-chat-${theme}.png`)
    })
  })
}

for (const size of ['compact', 'large'] as const) {
  test(`chat, ${size} text`, async ({ page }) => {
    await openChat(page, { size })
    await settle(page)
    await expect(page).toHaveScreenshot(`chat-${size}.png`)
  })

  test(`long reply, ${size} text`, async ({ page }) => {
    await openChat(page, { size })
    await say(page, 'something long')
    await page.locator('.md .code').first().scrollIntoViewIfNeeded()
    await settle(page)
    await expect(page).toHaveScreenshot(`long-${size}.png`)
  })
}
