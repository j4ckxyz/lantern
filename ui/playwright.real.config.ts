import { defineConfig } from '@playwright/test'

/**
 * The built UI against the real Python service and the fake Hermes (src/lantern/fakehermes.py),
 * rather than the UI's own mock: proves both sides read docs/local-api.md the same way.
 * Run `npm run build` first; needs the repository's .venv (make setup).
 */
const PORT = 8768
const FAKE = 9461

export default defineConfig({
  testDir: 'tests/real',
  timeout: 45_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 640, height: 360 },
    deviceScaleFactor: 2,
    timezoneId: 'Europe/London',
    locale: 'en-GB',
    hasTouch: true,
  },
  webServer: [
    {
      command: `../.venv/bin/lantern fakehermes --port ${FAKE}`,
      url: `http://127.0.0.1:${FAKE}/api/status`,
      reuseExistingServer: false,
    },
    {
      command: 'bash tests/real/start-service.sh',
      env: { PORT: String(PORT), FAKE_PORT: String(FAKE) },
      url: `http://127.0.0.1:${PORT}/?t=dev`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
