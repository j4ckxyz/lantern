# AGENTS.md

How to work on Lantern. `README.md` is the overview for people; `PLAN.md` is the plan and its
milestones; `docs/local-api.md` is the contract between the screen and the service.

## What this is

Lantern is a desk device for your own Hermes Agent: a Raspberry Pi 4 behind a 5-inch touchscreen,
turned landscape, that boots straight into a chat with Hermes. Three parts:

```
Chromium (kiosk, cage)  ──ws://127.0.0.1:8765──►  lantern run (Python)  ──Tailscale──►  Hermes
ui/: Preact, TypeScript          bridge.py           the only holder of the sign-in       /api/ws, REST
```

- **`ui/`**: the screen. A web app, built with Vite, shown full-screen by Chromium under cage. It
  talks only to the service, never to Hermes or the internet.
- **`src/lantern/`**: the service. It holds the connection to Hermes and the credentials, and serves
  the protocol in `docs/local-api.md` to the screen (WebSocket) and to the `lantern` command
  (Unix socket).
- **`device/`**: what turns Raspberry Pi OS Lite into the appliance. It covers the installer, the
  systemd units, the kiosk launcher, the boot splash, the SD-card hardening and the bundle build.

## Layout

| Path | What it is |
|---|---|
| `src/lantern/dashboard.py` | **The only file that speaks Hermes's dashboard API**. It covers the WebSocket (mode detection, refused-key retry, heartbeat), the per-mode request shapes, history, speech |
| `src/lantern/auth.py` | Native sign-in (PKCE, bearer tokens), refresh, the saved password, a tiny HTTP client |
| `src/lantern/conversation.py` | Profiles, main chats, the open chat, turn assembly from Hermes's events, prompts |
| `src/lantern/media.py` | `MEDIA:` tags (Hermes's own rules), media ids, fetching and caching the bytes |
| `src/lantern/links.py` | Link previews and remote pictures, fetched with strict limits |
| `src/lantern/bridge.py` | HTTP and WebSocket on 127.0.0.1 for the screen, token-gated |
| `src/lantern/service.py` | `lantern run`: the connection loop, clients, operations, settings, reading aloud |
| `src/lantern/fakehermes.py` | A stand-in Hermes for tests and development (needs `aiohttp`, in the dev extra) |
| `src/lantern/net.py` | Finds a Tailscale name when the machine does not use Tailscale's DNS |
| `ui/` | The screen; `ui/README.md` says how to run it, its mock, and its screenshot tests. Landscape puts a panel (`Presence.tsx`) beside the chat; portrait has a top bar. The dark theme is true black so it meets the display's black glass; `styles/aura.css` is the state light behind the panel |
| `device/` | `install.sh`, `build-bundle.sh`, `kiosk.sh`, `systemd/`, `plymouth/`, `system/` |
| `tests/` | The Python suite, against the fake Hermes and a pretend screen on the bridge |

## Running it

```sh
make setup                   # .venv with the dev extra, and the UI's packages
make fake &                  # a stand-in Hermes on 127.0.0.1:9119 (user ada, password pw)
LANTERN_HOME=/tmp/lantern-dev .venv/bin/lantern setup http://127.0.0.1:9119 --username ada
make dev &                   # the service, token "dev"
cd ui && npm run dev         # open the Vite address at 640x360, device scale factor 2
```

`ui/` also has its own mock of the service (`npm run mock`), for UI work without Python.

## Tests

```sh
make test                    # pyflakes, the em dash check, pytest (about 25 s), Vitest
cd ui && npm run e2e         # Playwright screenshots and flows: landscape 640x360 and portrait 360x640, scale 2
```

Unix socket paths are limited to about 100 characters, so tests that start the service use the
`short_tmp` fixture, not `tmp_path`. A test that hangs is usually an event that never arrived; run
it with `-o faulthandler_timeout=20`.

## Rules

1. **Only `dashboard.py` speaks Hermes's protocol.** Read the method's contract in the Hermes source
   (`tui_gateway/contracts/`) before using one, send only declared keys, and keep `fakehermes.py`
   in the same shape. Plain and session-authority sockets take different shapes; see the module
   docstring.
2. **The screen never holds a credential** and never reaches the network except through the
   service. Every remote fetch goes through `links.py`, which refuses private and tailnet
   addresses.
3. **Agent output is untrusted.** The UI renders Markdown with raw HTML off and sanitises the
   result; nothing navigates away from the page.
4. **Approvals from the desk are "once" or "deny"**, enforced in the service, not only the UI.
5. **The protocol is a contract.** Change `docs/local-api.md` first, then the service and the UI
   (and the UI's mock) together.
6. **Never post to someone's real main chat in a test.** Live tests use a throwaway side chat and
   delete it with `session.delete`.
7. **British English, and no em dashes**, in UI copy, docs and messages a person reads
   (`make copy-check`).
8. **Keep it light.** The device has 2 GB. A new dependency on the device needs a reason in
   `PLAN.md`. Python 3.11 is the floor.

## Before you hand back work

1. `make test` passes, and `cd ui && npm run build && npm run e2e` pass.
2. If you touched the UI, look at the screenshots in both themes and at comfortable and large text,
   in landscape (the desk's normal way round) and portrait.
3. If you touched `device/`, ShellCheck is clean, and you said plainly what has not been run on a
   Pi.
4. `docs/tested.md` says what is true now. Do not mark something as working that you did not run.
