# The desk's screen

The web page Chromium shows full screen on the desk: a chat with your Hermes. It is built with
Preact, TypeScript and Vite, and talks only to the service on the same machine
(`ws://127.0.0.1:8765/ws`, see [docs/local-api.md](../docs/local-api.md)). It never loads anything
from elsewhere: remote pictures come through the service's `/proxy/image`.

## Run it

```sh
npm install
npm run mock          # a stand-in for the service on 127.0.0.1:8766 (serves dist/ once built)
MOCK=1 npm run dev    # the UI with live reload, talking to the mock
npm run dev           # the UI, talking to a real `lantern run --dev` on 8765
```

Open the address Vite prints with `?t=dev` added. To see it as the desk does, use Chrome's device
toolbar at 640x360 (landscape, the desk's normal way round) with a device pixel ratio of 2, or:

```sh
chromium --app='http://127.0.0.1:5173/?t=dev' --window-size=640,360 --force-device-scale-factor=2
```

`npm run build` writes `dist/`, which the service serves. The JavaScript and CSS come to about
115 KB gzipped; the fonts (Inter and JetBrains Mono, self-hosted) are extra.

## The mock

`mock/server.mjs` speaks the whole local API with scripted replies and sample media it draws
itself (`mock/media.mjs`). Add these to the page address:

| Query | Starts in |
|---|---|
| `mock=setup` | The address form |
| `mock=signin` | The sign-in form |
| `mock=offline` | Offline, counting down to a retry |
| `mock=connecting` | Connecting |
| `mock=empty` | An empty main chat |
| `theme=light`, `size=large` | Those settings |

Words in a message choose the reply:

| Word | Reply |
|---|---|
| `slow` | Status updates and two tools over a few seconds |
| `wait` | Starts working and holds until you press Stop |
| `media` | A picture, an audio clip and a file |
| `links` | Two links: one with a preview, one whose preview fails |
| `approve` | An approval card (only Allow once and Deny are offered) |
| `ask` | A question with choices and free text |
| `error` | A turn that fails |
| `long` | Headings, code blocks in several languages, a table and a quote |

Anything else is echoed. Wrong address: type one containing `bad`. Wrong password: `wrong`.

## Tests

```sh
npm test       # Vitest: Markdown and sanitising, the typing pace, links, the event model, copy rules
npm run e2e    # builds, then Playwright against the mock: landscape 640x360 and portrait 360x640, scale 2
```

The Playwright suite has two parts:

- `tests/e2e/flows.spec.ts` drives the screen: sending, Stop and Esc, approvals, questions, the QR
  sheet, profiles, past conversations, new chat, compacting, older history, reading aloud, media,
  setup and sign-in errors, offline and Retry, settings, no navigation or outside requests, no em
  dashes, and WCAG AA contrast for the text colours in both themes.
- `tests/e2e/screens.spec.ts` compares every screen and state, dark and light (plus compact and
  large text), with the approved pictures in `tests/e2e/screens.spec.ts-snapshots/`. After a
  deliberate change to the design, run `npx playwright test --update-snapshots=all` and look at
  every new picture before keeping it.

The tests move the page's clock to 19 November 2026, 10:30 (London), so dates and times in the
pictures do not depend on when they run.

## Where things are

| Path | What |
|---|---|
| `src/protocol/` | The event types, the WebSocket client and the reducer that is the screen's model |
| `src/markdown.ts` | Markdown to safe HTML: no raw HTML, links become QR sheets, pictures go through the proxy |
| `src/pacer.ts` | Writes replies out at 40 to 80 characters a second, catching up when far behind |
| `src/components/` | The screens |
| `src/audio/` | Speech from the service, played through an AudioWorklet |
| `src/styles/tokens.css` | Every colour and size, for both themes and all three text sizes |

House style: British English, no em dashes, and no colour outside `tokens.css`.
