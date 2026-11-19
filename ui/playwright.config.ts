import { defineConfig } from '@playwright/test'

const PORT = 8767

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  workers: 4,
  reporter: [['list']],
  expect: {
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002, threshold: 0.05 },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 2,
    timezoneId: 'Europe/London',
    locale: 'en-GB',
    hasTouch: true,
  },
  webServer: {
    command: 'node mock/server.mjs',
    env: { PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/?t=dev`,
    reuseExistingServer: false,
  },
})
