/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import type { Plugin } from 'vite'

// The service (or the mock with MOCK=1) owns /ws, /media, /proxy and /avatar.
const target = process.env.MOCK ? 'http://127.0.0.1:8766' : 'http://127.0.0.1:8765'

// The built page may only talk to the service that served it. (Not in development: Vite's own
// client needs more.)
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const csp = (): Plugin => ({
  name: 'csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
})

export default defineConfig({
  plugins: [preact(), csp()],
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 600 },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/ws': { target, ws: true },
      '/media': target,
      '/proxy': target,
      '/avatar': target,
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
})
