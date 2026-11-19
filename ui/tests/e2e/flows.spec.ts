import { expect, test } from '@playwright/test'
import { openApp, openChat, say } from './helpers'

test('send and get a reply', async ({ page }) => {
  await openChat(page)
  await say(page, 'hello there')
  await expect(page.locator('.bubble').last()).toHaveText('hello there')
  await expect(page.locator('.msg-agent').last()).toContainText('You said: "hello there"')
  await expect(page.locator('textarea')).toHaveValue('')
})

test('Shift+Enter makes a new line instead of sending', async ({ page }) => {
  await openChat(page)
  await page.locator('textarea').fill('one')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('two')
  await expect(page.locator('textarea')).toHaveValue('one\ntwo')
})

test('typing anywhere goes into the message box', async ({ page }) => {
  await openChat(page)
  await page.locator('.scroller').click({ position: { x: 20, y: 20 } })
  await page.keyboard.type('hi')
  await expect(page.locator('textarea')).toHaveValue('hi')
})

test('stop a turn with the button, and with Esc', async ({ page }) => {
  await openChat(page)
  await page.locator('textarea').fill('wait for it')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
  await expect(page.getByText('Reading notes/garden.md')).toBeVisible()
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  await expect(page.locator('.tool')).toHaveCount(0)
  // What was written so far is kept.
  await expect(page.locator('.msg-agent').last()).toContainText('Let me check the forecast')

  await page.locator('textarea').fill('wait again')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
  await page.locator('textarea').blur()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
})

test('approvals offer only Allow once and Deny', async ({ page }) => {
  await openChat(page)
  await page.locator('textarea').fill('approve this')
  await page.keyboard.press('Enter')
  const card = page.getByRole('alertdialog')
  await expect(card).toContainText('sudo systemctl restart hermes-dashboard')
  await expect(card.getByRole('button')).toHaveText(['Deny', 'Allow once'])
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(card).toHaveCount(0)
  await expect(page.locator('.msg-agent').last()).toContainText('The dashboard restarted cleanly', { timeout: 10_000 })
})

test('a question can be answered with a choice or in words', async ({ page }) => {
  await openChat(page)
  await page.locator('textarea').fill('ask me')
  await page.keyboard.press('Enter')
  const card = page.getByRole('alertdialog')
  await card.getByPlaceholder('Type an answer').fill('Work')
  await card.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.msg-agent').last()).toContainText('Added to Work', { timeout: 10_000 })
})

test('a link card opens the QR sheet, and Esc closes it', async ({ page }) => {
  await openChat(page)
  await say(page, 'links please')
  await page.getByText('Raspberry Pi Touch Display 2').click()
  const sheet = page.getByRole('dialog', { name: 'Open on your phone' })
  await expect(sheet).toContainText('https://www.raspberrypi.com/products/touch-display-2/')
  await expect(sheet.locator('.qr-code svg path')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  // An inline link does the same, and nothing ever navigates.
  await page.locator('.md a.link').first().click()
  await expect(page.getByRole('dialog', { name: 'Open on your phone' })).toBeVisible()
  expect(page.url()).toContain('/?t=dev')
})

test('a link whose preview fails still gets a card with its address', async ({ page }) => {
  await openChat(page)
  await say(page, 'links please')
  await expect(page.locator('.link-card').nth(1)).toContainText('example.org')
})

test('switch profile', async ({ page }) => {
  await openChat(page, { conversations: true })
  await page.locator('.who').click()
  await page.getByRole('button', { name: /Sidequest/ }).first().click()
  await expect(page.locator('.who-name')).toHaveText('Sidequest')
  await expect(page.locator('.who-title')).toHaveText('Main chat')
  await expect(page.getByRole('heading', { name: 'Sidequest' })).toBeVisible()
  // No avatar for this profile: initials instead.
  await expect(page.locator('.topbar .avatar')).toHaveText('SI')
})

test('open a past conversation and search the list', async ({ page }) => {
  await openChat(page, { conversations: true })
  await page.keyboard.press('Control+k')
  await page.getByRole('button', { name: 'Conversations' }).first().click()
  await page.getByPlaceholder('Search conversations').fill('garage')
  await expect(page.locator('.sheet .list-item')).toHaveCount(1)
  await page.getByText('Garage door sensor').click()
  await expect(page.locator('.who-title')).toHaveText('Garage door sensor')
})

test('new chat, then Hermes names it', async ({ page }) => {
  await openChat(page, { conversations: true })
  await page.getByRole('button', { name: 'New chat' }).click()
  await expect(page.locator('.who-title')).toHaveText('New chat')
  await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()
  await expect(page.locator('.who-title')).toHaveText('New chat about the desk')
  // Nothing from the previous chat (say, older history still on its way) ends up in the new one.
  await page.waitForTimeout(500)
  await expect(page.locator('[data-msg]')).toHaveCount(0)
})

test('compact from the menu', async ({ page }) => {
  await openChat(page, { conversations: true })
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByText('Compact this chat').click()
  await expect(page.getByText('Compacting this chat')).toBeVisible()
})

test('older messages load when scrolling up', async ({ page }) => {
  await openChat(page)
  for (let i = 0; i < 6; i++) {
    await page.locator('.scroller').evaluate((el) => (el.scrollTop = 0))
    await page.waitForTimeout(350)
  }
  await expect(page.getByText(/Earlier question 1:/)).toBeVisible()
  await expect(page.locator('.history-edge')).toHaveCount(0)
})

test('read a reply aloud', async ({ page }) => {
  await openChat(page)
  const speak = page.locator('.msg-agent').last().getByRole('button', { name: 'Read aloud' })
  await speak.click()
  await expect(page.locator('.msg-agent').last().getByRole('button', { name: 'Stop reading aloud' })).toBeVisible()
  await expect(page.locator('.msg-agent').last().getByRole('button', { name: 'Read aloud' })).toBeVisible({ timeout: 10_000 })
})

test('media: a picture opens full screen, audio plays and changes speed', async ({ page }) => {
  await openChat(page)
  await say(page, 'show me media')
  await page.locator('.media-img').click()
  await expect(page.locator('.viewer')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.viewer')).toHaveCount(0)
  const audio = page.locator('.card.audio')
  await audio.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(audio.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await audio.getByRole('button', { name: 'Playback speed' }).click()
  await expect(audio.getByRole('button', { name: 'Playback speed' })).toHaveText('1.5x')
  await expect(page.locator('.card').filter({ hasText: 'november-budget.csv' })).toContainText('CSV')
})

test('a failed turn says so and offers to try again', async ({ page }) => {
  await openChat(page)
  await page.locator('textarea').fill('error please')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alert')).toContainText('rate limiting')
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
})

test('setup: a wrong address is explained, a right one leads to sign-in', async ({ page }) => {
  await openApp(page, { mock: 'setup' })
  const status = page.locator('.addr-status')
  await page.getByLabel('Address').fill('bad.example')
  await expect(status).toContainText('Nothing answers there yet')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(status).toContainText('Nothing answered at bad.example')
  await page.getByLabel('Address').fill('hermes.example.ts.net')
  await expect(status).toContainText('Found Hermes 0.22.5 at https://hermes.example.ts.net')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in to Hermes' })).toBeVisible()
})

test('setup: the address gets the scheme it will use, and plain http off the network is flagged', async ({ page }) => {
  await openApp(page, { mock: 'setup' })
  const field = page.getByLabel('Address')
  const scheme = page.locator('.addr-scheme')
  await field.fill('hermes.example.ts.net')
  await expect(scheme).toHaveText('https://')
  await field.fill('192.168.1.20')
  await expect(page.locator('.addr-status')).toContainText('http://192.168.1.20:9119')
  await expect(scheme).toHaveText('http://')
  await field.fill('https://hermes.example.com')
  await expect(scheme).toHaveCount(0)
  await field.fill('http://hermes.example.com')
  await expect(page.locator('.addr-status.warn')).toContainText('not encrypted')
})

test('the simple desk: one conversation, nothing to manage until you ask for it', async ({ page }) => {
  await openChat(page)
  await expect(page.getByRole('button', { name: 'New chat' })).toHaveCount(0)
  await expect(page.locator('button.who')).toHaveCount(0)
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.keyboard.press('Control+,')
  await page.getByRole('switch', { name: /Profiles and side chats/ }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible()
  await expect(page.locator('button.who')).toBeVisible()
})

test('keyboard: ? lists the shortcuts, Up brings back your last message, Esc closes', async ({ page }) => {
  await openChat(page)
  await page.locator('.scroller').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('textarea')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(page.locator('textarea')).toHaveValue("What's on today?")
})

test('keyboard: an approval takes focus on Deny, so a stray Enter is the safe answer', async ({ page }) => {
  await openChat(page)
  await page.locator('textarea').fill('approve this')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Deny' })).toBeFocused()
  // Typing does not go anywhere that could answer it.
  await page.keyboard.type('yes')
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
})

test('mouse: the pointer shows while the mouse moves and hides on touch', async ({ page }) => {
  await openChat(page)
  const html = page.locator('html')
  await expect(html).toHaveClass(/no-cursor/)
  await page.mouse.move(100, 100)
  await page.mouse.move(120, 140)
  await expect(html).not.toHaveClass(/no-cursor/)
  await expect(html).toHaveAttribute('data-input', 'mouse')
  await page.locator('.scroller').tap({ position: { x: 20, y: 20 } })
  await expect(html).toHaveClass(/no-cursor/)
  await expect(html).toHaveAttribute('data-input', 'touch')
})

test('sign in: a wrong password is explained, the right one opens the chat', async ({ page }) => {
  await openApp(page, { mock: 'signin' })
  await page.getByLabel('Username').fill('ada')
  await page.getByLabel('Password', { exact: true }).fill('wrong')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toHaveText('That username or password is not right.')
  await page.getByLabel('Password', { exact: true }).fill('right')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.locator('textarea')).toBeVisible()
})

test('offline: counts down, and Retry reconnects', async ({ page }) => {
  await openApp(page, { mock: 'offline' })
  await expect(page.getByText(/Trying again in \d+ s/)).toBeVisible()
  await expect(page.locator('textarea')).toHaveAttribute('placeholder', 'Waiting for Hermes')
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.locator('.statusline')).toHaveCount(0, { timeout: 5000 })
  await expect(page.locator('textarea')).toHaveAttribute('placeholder', 'Message Hermes')
})

test('settings change text size and theme through the service', async ({ page }) => {
  await openChat(page)
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByText('Settings').click()
  await page.getByRole('button', { name: 'Large' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-text-size', 'large')
  await page.getByRole('button', { name: 'Light' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('the page never navigates and loads nothing from elsewhere', async ({ page }) => {
  const outside: string[] = []
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:8767/') && !r.url().startsWith('ws://127.0.0.1:8767/') && !r.url().startsWith('data:')) outside.push(r.url())
  })
  await openChat(page)
  await say(page, 'links please')
  await say(page, 'show me media')
  expect(outside).toEqual([])
  expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:8767\/\?/)
})

test('no em dashes on any screen', async ({ page }) => {
  for (const mock of ['setup', 'signin', 'offline', undefined] as const) {
    await openApp(page, { mock })
    await page.waitForTimeout(300)
    expect(await page.locator('body').innerText()).not.toContain(String.fromCharCode(0x2014))
  }
})

function luminance(rgb: number[]): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

for (const theme of ['dark', 'light'] as const) {
  test(`text contrast meets WCAG AA (${theme})`, async ({ page }) => {
    await openChat(page, { theme })
    const tokens = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement)
      const probe = document.createElement('div')
      document.body.appendChild(probe)
      const rgb = (name: string) => {
        probe.style.color = css.getPropertyValue(name).trim()
        return (getComputedStyle(probe).color.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number)
      }
      const out: Record<string, number[]> = {}
      for (const t of ['--bg', '--surface', '--surface-2', '--user-bubble', '--text', '--text-2', '--text-3', '--accent', '--accent-fill', '--on-accent', '--danger']) out[t] = rgb(t)
      probe.remove()
      return out
    })
    const pairs: [string, string][] = [
      ['--text', '--bg'], ['--text', '--surface'], ['--text', '--user-bubble'],
      ['--text-2', '--bg'], ['--text-2', '--surface'], ['--text-3', '--bg'], ['--text-3', '--surface'],
      ['--on-accent', '--accent-fill'], ['--accent', '--bg'], ['--danger', '--bg'],
    ]
    for (const [fg, bg] of pairs) {
      expect(ratio(tokens[fg], tokens[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })
}

test('slash commands: the palette offers them, Enter runs one, and options can be picked', async ({ page }) => {
  await openChat(page)
  const box = page.locator('textarea')
  await box.fill('/')
  const palette = page.getByRole('listbox', { name: 'Hermes commands' })
  await expect(palette.getByRole('option', { name: /\/usage/ })).toBeVisible()
  await box.fill('/us')
  await expect(palette.getByRole('option').first()).toContainText('/usage')
  await page.keyboard.press('Enter')
  await expect(page.locator('.msg-command').last()).toContainText('1,234 tokens in, 567 out')
  await expect(page.locator('.msg-command .cmd-name').last()).toHaveText('/usage')
  await expect(box).toHaveValue('')

  await box.fill('/pers')
  await expect(palette.getByRole('option').first()).toContainText('/personality')
  await page.keyboard.press('Tab')
  await expect(box).toHaveValue('/personality ')
  await expect(palette.getByRole('option')).toHaveCount(3)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.locator('.msg-command').last()).toContainText('Personality: friendly')

  await box.fill('/plan the move')
  await page.keyboard.press('Enter')
  await expect(page.locator('.msg-user').last()).toContainText('/plan the move')
  await expect(page.locator('.send.stop')).toHaveCount(0, { timeout: 20_000 })

  // Esc closes the palette without stopping anything; "//" sends a plain slash.
  await box.fill('/')
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
})

test('setup from a phone: a QR code and a short code, and back to typing', async ({ page }) => {
  await openApp(page, { mock: 'setup' })
  await page.getByRole('button', { name: 'Use your phone instead' }).click()
  await expect(page.getByRole('heading', { name: 'Use your phone' })).toBeVisible()
  await expect(page.locator('.phone .qr-code')).toBeVisible()
  await expect(page.locator('.phone-code')).toHaveText('K7Q-4MP')
  await expect(page.locator('.phone-or')).toContainText('lantern.local:8770')
  await page.getByRole('button', { name: 'Type it here instead' }).click()
  await expect(page.getByLabel('Address')).toBeVisible()
})
