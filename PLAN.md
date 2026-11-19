# Plan: Lantern as a desk appliance

Status: **approved** (19 November 2026); milestones 0 and 1 in progress. What has actually been run is in
`docs/tested.md`.

Lantern becomes a dedicated, appliance-like desk device for chatting with your own Hermes
Agent: a Raspberry Pi 4 (2 GB) on the back of a Raspberry Pi Touch Display 2 (5", 720x1280,
turned to landscape: 1280x720), typed into with a Keychron K8 Pro over Bluetooth or the touchscreen. It boots
straight into a full-screen chat with no visible operating system.

This plan comes from reading the whole repository, the Hermes docs, the Hermes source (`main`
at `ae2a81ccc0`, 16 November 2026) and the protocol notes from Hermes Desktop. The important
claims were checked against a live Hermes on a VPS (Hermes 0.22.5, release 2026.9.24).
What was checked live is marked **(live)**.

## Changes after approval

Asked for on 19 November 2026, after the first build:

- **Simple by default.** The desk is one conversation with your agent, the default profile's main
  chat, like talking to an assistant. Profiles, side chats, New chat and compaction appear only
  when **Profiles and side chats** is turned on in Settings (`conversations`, default off).
- **Hermes's slash commands.** `/` in the message box lists what Hermes offers this profile
  (`commands.catalog`), leaving out what Hermes's own apps keep out of their menus. Commands run
  with `slash.exec`, falling back to `command.dispatch` as the apps do; output appears as a card
  in the conversation, and a command that expands into a prompt is sent as a turn.
- **Thinking.** Reasoning is never shown; a soft three-light wave animates in the reply's place
  and in the panel until the first words arrive.
- **Keyboard and mouse.** Type anywhere, `?` for the shortcuts, `↑` to bring back your last
  message, Tab through every control with focus kept inside sheets, hover states only for a
  mouse, and a pointer that hides itself when resting or when the screen is touched. An approval
  takes keyboard focus on Deny, so a stray Enter is the safe answer.
- **Addresses.** Whatever is typed is repaired (`https//`, a missing scheme, a pasted dashboard
  route, a port) and every likely URL is tried at once; the form says what it found before you
  press Connect, and warns when plain http would cross the internet.
- **Set up from a phone.** Hermes has no device sign-in, so the desk opens a one-time page on
  the local network (`pairing.py`): a QR code and a short code on screen, the details typed on
  the phone. It closes after one use, ten minutes or five wrong codes.
- **Without Tailscale.** Home-network and reverse-proxy Hermes setups are supported
  (`install.sh --no-tailscale`, and `prompts/setup-hermes.md` covers all three); Tailscale stays
  the recommended way.
- **Endpoint audit** against Hermes v0.22.5's source. Fixes for session-authority sockets:
  deleting through `DELETE /api/sessions/{id}`, approvals quoting the generation they came with,
  `source: gui`, and closing a card answered on another device (`approval.settled`). Also speech
  falling back to a whole clip when a voice cannot stream.

## 1. Decisions

| Area | Decision | Why |
|---|---|---|
| UI stack | Chromium in kiosk mode under `cage` (a Wayland kiosk compositor), with GPU acceleration | Markdown, code highlighting, images, emoji, font shaping, Web Audio and touch scrolling come for free, and the whole UI can be developed in a browser on a Mac. It costs an estimated 300 to 450 MB of RAM and a few seconds of boot, which 2 GB affords (section 4.6) |
| Existing code | Keep the Python service and its Hermes connection, and rebuild the UI as a local web app. Remove the critter, the shared look, every write the device makes into Hermes, the LVGL app, the plugin route and the third-party app SDK | The service already works against your Hermes **(live)**; the rest does not fit a professional single-purpose device |
| Conversations | Follow Hermes's official clients (Bot Mode): each profile has one **main chat**, its canonical "Bot Chat", shared with your phone and Mac. **New chat** opens an ordinary side session. **Compact** keeps the main chat going with fresh context | The same model as the Hermes apps you showed, so the desk, phone and Mac agree |
| Profiles | All profiles, opening on Hermes's main chat; a sheet lists each profile with its main chat and its other sessions | Matches the app you showed; `profiles.list` returns each profile and its main chat **(live)** |
| Text size | "Comfortable": about 3.2 mm body text, about 34 characters a line; Compact and Large in Settings | Readable from 60 to 70 cm without making replies tiresome to scroll |
| OS and boot | Raspberry Pi OS Lite 64-bit (Trixie), cage and Chromium as a systemd unit on tty1, a quiet kernel and a Plymouth splash | No desktop session, about 300 MB lighter than the desktop image, fully under our control |
| SD card | Hardened writable root: logs and temporary files in RAM, no swap file on the card (zram instead), atomic writes, fsck on boot. A read-only overlay is a later option | Most of the robustness for little cost, and updates stay simple |
| Updates | Bundles built by GitHub Actions and signed with minisign. The device verifies a bundle, installs it beside the current version, switches a symlink and rolls back by itself if the new version fails a health check | Nothing compiles on the Pi; installs are atomic and reversible |
| Sleep | Dim after 2 minutes and switch off after 10. Wake on a key, a touch (the waking touch is swallowed) or a new message in a main chat. Quiet hours 23:00 to 07:00. All adjustable | Saves the backlight and the panel, with no surprise taps |
| Thinking sounds | An ambient pad while Hermes works, a completion chime and a low error tone, all synthesised with Web Audio. Off by default | No audio files; lives in the same audio graph as speech, so it can duck under it |
| Speaker | Not decided: the device plays through PipeWire and works with whatever is plugged in (3.5 mm, USB or Bluetooth) | Defers a purchase; section 4.8 lists what each choice means |
| Settings | Everything on screen, including Wi-Fi, Bluetooth pairing, the Hermes address and Tailscale sign-in (the login link is shown as a QR code). The UI reaches the system only through a small root helper | No SSH needed in daily life; the UI and the service never run as root |
| Links | Cards with title and favicon, fetched by the device itself (no third-party preview service). Tapping a card opens a large QR code sheet; nothing navigates away | There is no browser to open them in, and your phone is in your pocket |
| Keyboard | Automatic: no on-screen keyboard while the Keychron is connected; a built-in touch keyboard otherwise | You can switch the K8 Pro's slot to your Mac and still use the desk |
| Look | The visual language of the official Hermes app: deep navy, soft round icon buttons, the profile's avatar in the header. Its artwork and logos are not used | Feels part of the family without imitating it |
| Name | Agent first: the splash and header show the profile's avatar and name. "Lantern" appears only in Settings, About and the docs | Professional, and does not pose as a Nous Research product |
| Sign-in | Hermes's native-app flow (PKCE, bearer tokens) **(live)**, plus a saved password so the desk can sign in again by itself | Your choice for convenience; the risk is spelled out in section 7 |
| Formatting | A `platform_hints.lantern` entry in your Hermes `config.yaml`, applied once. The device never writes to your Hermes | Hermes has no hint for a desk device and a client cannot declare its screen, so this is the supported way |
| Spoken replies | A speaker button on every reply, and a "Read replies aloud" setting (off by default) that uses Hermes's streaming text-to-speech. Audio the agent sends always gets a player | Speech starts as soon as Hermes has the first sentence: 2.5 to 2.7 s with your OpenAI voice **(live)** |
| Approvals | "Allow once" and "Deny" only. Anything broader stays on your phone or Mac | A desk anyone can walk up to should not grant standing permission |
| Card setup | Now: stock Pi OS Lite flashed with Raspberry Pi Imager, then one install script. Later: a CI-built image with an on-screen first-run wizard | Fast iteration first, flash-and-go once things settle |
| Remote access | Tailscale SSH only. OpenSSH is off and there is no console login on the screen. Nothing listens on the network | The smallest attack surface that still allows maintenance |
| Lock | A PIN on Settings only. Chat stays open | Your choice: the desk is at home, but account and network changes need the PIN |
| Hardware testing | Mac only for now; deploy to the Pi together later | Your choice. Milestone 0's hardware measurements wait for that |

## 2. What changes in this repository

**Keep and update**

- `src/lantern/dashboard.py`, `base.py`, `service.py`: the connection, reconnection and local
  socket. Changes are in section 4.2.
- `src/lantern/config.py` and `net.py` (finding Tailscale names without MagicDNS). `audio.py` went:
  all sound plays in the browser, and the service relays streamed speech to it.
- `tests/`: `tests/fakes/dashboard.py` grows to match the current Hermes contracts and becomes a
  development server (`lantern fakehermes`).
- `src/lantern/cli.py`: `setup`, `run`, `status`, `doctor`, `send` and `chat` stay. `critter`,
  `look` and `devserver` go. `update` is added.

**Remove**

- The critter and the shared look: `src/lantern/persona.py`, `look.py`, both `plugin/` copies,
  `app/src/critter.c`, `docs/images/critters.png`, and the `persona.*` and `look.*` ops and
  events.
- Everything the device wrote into Hermes: the `lantern` skill, `plugin-data/lantern/*.json` and
  the line in `MEMORY.md`. The hidden opening note stays only if the platform hint proves not
  to reach the main chat (milestone 0).
- `app/` (the LVGL C app), `plugin/`, `src/lantern/device.py`, `identity.py`, `protocol.py`,
  `devserver.py`, `builtin.py`, `examples/`, `docs/protocol.md`, `docs/two-ways.md` and
  `prompts/setup-plugin.md`. They stay in git history. The local socket stays as an internal
  interface, so a third-party SDK could come back later without redesign.
- `docs/images/` and `docs/pi5/`, replaced by new screenshots.

**Add**

```
ui/                 the web UI (Preact, TypeScript, Vite)
  src/              screens, Markdown and MEDIA parsing, sanitising, audio, keyboard, QR
  tests/            Vitest unit tests and Playwright screenshot and flow tests
src/lantern/
  bridge.py         serves the built UI and a WebSocket for it on 127.0.0.1
  auth.py           native PKCE sign-in, token refresh, saved password
  conversation.py   profiles, main chats, the open chat, turns, prompts, compaction
  media.py          MEDIA: tags, fetching through Hermes, image and audio proxying
  links.py          link previews (title, favicon) with strict fetch limits
  errors.py         the two errors the service speaks in
  fakehermes.py     the fake dashboard, promoted from tests for development
helper/             lantern-helper: a small root service for Wi-Fi, Bluetooth, backlight,
                    Tailscale, volume, reboot and updates, with a fixed list of operations
device/             install.sh, systemd units, the Plymouth theme, config.txt and cmdline
                    fragments, the Chromium flags, tmpfs and journald drop-ins
.github/workflows/  tests, bundle builds and (later) the image build
```

Python's minimum version rises from 3.9 to 3.11. The device runs Trixie (3.13), and Bullseye
support only existed for older Pis.

## 3. Hermes-side setup (one time, done by you)

1. **The platform hint.** Add this to Hermes's `config.yaml`, or ask Hermes to add it. The
   exact key shape is confirmed in milestone 0:

   ```yaml
   platform_hints:
     lantern: >-
       You are being read on the owner's desk device: a 5-inch landscape touchscreen read from
       about 60 cm. Prefer short, direct answers. Markdown, code blocks, tables, images and
       links all render; links appear as cards with a QR code. Keep code lines under 60
       characters where you can. To send a file, image or audio, use a MEDIA: tag.
   ```

2. **Remove what the old Lantern left behind**, if anything (checked with you first):
   `plugin-data/lantern/`, `skills/lantern/`, and any `Lantern:` entry in `memories/MEMORY.md`.

3. Nothing else: no plugin, no new port, no restart.

## 4. Architecture

```
 Raspberry Pi 4                                                      your Hermes
┌─────────────────────────────────────────────────────────┐        ┌───────────────────────┐
│ cage ─ Chromium (kiosk user)                            │        │ hermes dashboard      │
│   UI: Preact app, Web Audio, on-screen keyboard         │        │  /api/ws   JSON-RPC   │
│        │ ws://127.0.0.1:8765 (UI bridge, token-gated)   │Tailscale│  /api/sessions, media│
│ lantern run (lantern user)                              │◄──────►│  /api/audio/*         │
│   Hermes connection, roster, media, links, speech       │ HTTPS  │  /auth/native/*       │
│        │ Unix socket (fixed operations)                 │  WSS   └───────────────────────┘
│ lantern-helper (root): Wi-Fi, Bluetooth, backlight,     │
│   Tailscale, volume, updates                            │
└─────────────────────────────────────────────────────────┘
```

Three processes, three accounts:

- **Chromium runs as `kiosk`.** It can reach only `127.0.0.1:8765` and has no credentials.
- **The service runs as `lantern`.** It owns the connection to Hermes and the credentials, and
  `kiosk` cannot read them.
- **The helper runs as root.** It does a fixed list of operations, checks every argument and
  never uses a shell.

### 4.1 Talking to Hermes

The service uses the dashboard's `/api/ws` JSON-RPC, as Hermes's own Desktop and mobile apps
do, plus a little REST. The API server (`/v1`) was considered and rejected. Its key is no
narrower than a dashboard sign-in, and it cannot upload files, fetch audio, transcribe or speak,
or continue other surfaces' conversations.

| Need | How |
|---|---|
| Sign in | `GET /auth/native/authorize` (PKCE S256), `POST /auth/password-login`, `POST /auth/native/token`, then `Authorization: Bearer` everywhere. Refreshed through `POST /auth/native/refresh` two minutes before expiry **(live)** |
| WebSocket | A fresh `POST /api/auth/ws-ticket` per connection; `?ticket=` **(live)** |
| Liveness | `gateway.ping` every 15 s when `gateway.ready` says `heartbeat: true` (yours does **(live)**); reconnect after 45 s of silence |
| Socket mode | Read `gateway.ready.session_authority`. Plain mode (yours **(live)**) and authority mode each get their own request shapes, as in Hermes Desktop's `wire.rs`. A refused optional key is dropped and retried; a refused required key is reported as a Lantern bug |
| Profiles and main chats | `profiles.list` gives `canonical_session.resolved_id` **(live)**. A profile with no main chat gets one through `session.create {title: "Bot Chat", hidden: true, ...}` when you first open it |
| Open a chat | `session.resume {session_id, omit_messages: true}`, then `GET /api/sessions/{id}/messages?order=latest&limit=60`, showing `display_content` where present |
| Send | `prompt.submit` (adds `submission_id` and `attachments` in authority mode) |
| Stop | `session.interrupt` (adds `execution_generation` in authority mode) |
| New chat | `session.create` on the current profile, as a normal (not hidden) session |
| Compact | `session.compress`, falling back to `session.mutate {operation: "compress"}` |
| History and search | `GET /api/sessions` and `/api/sessions/search`, leaving out cron, kanban, tool and oneshot sessions |
| Approvals, questions | Server requests `approval` and `clarify` (plain mode), or the `approval.request` and `clarify.request` events (authority mode). Only `once` and `deny` are ever sent |
| Changes elsewhere | `change_events` (`sessions.changed`) **(live)**: re-read the open chat when a routine or another device adds to it |
| Speech | `WS /api/audio/speak-stream` (sentence-by-sentence PCM) for reading aloud; `POST /api/audio/speak` as the fallback **(live)** |
| Never used | `GET /api/audio/voice-config` (it hands out provider API keys) and any `/api/fs` write |

Fixes to the existing client come in the same work:

- **Oldest-first history.** History asks for `order=latest`; without it Hermes returns the
  oldest rows first.
- **Duplicated text.** `message.delta` chunks are de-duplicated by `offset`, so a re-sent chunk
  no longer appears twice.
- **Reclaimed sessions.** `session.reclaimed` (an idle live session that Hermes reaped) is
  handled by resuming again.
- **Missed events.** `approval.cancelled`, `notification.clear`, `tool.progress` and
  `error_surface` are handled.

### 4.2 Media from the agent

Hermes does not pull media out of replies for dashboard clients. `MEDIA:/path` tags arrive in
the reply text itself, and `[[audio_as_voice]]` marks a spoken reply. The service parses them
with the same rules as Hermes's messaging adapters, so tags inside code are left alone. It
strips the tags from the text and attaches media items to the message.

| Kind | Fetched with | Shown as |
|---|---|---|
| Image (`MEDIA:` under Hermes's images, screenshots or cache folders) | `GET /api/media?path=` (images only, 25 MB) | Inline at the full width of the message; tap for a full-screen viewer with pinch zoom |
| Remote image (`![alt](https://...)`) | Fetched by the service: http and https only, 10 MB cap, image types only, private and tailnet addresses refused | Same as above |
| Audio (`MEDIA:...mp3/ogg/wav`, or `[[audio_as_voice]]`) | `GET /api/files/download` with the service's own sign-in (tickets are for browsers); the bridge serves it with Range | A player card: play or pause, a scrubber, elapsed and total time, 1x and 1.5x. A voice reply auto-plays when "Read replies aloud" is on |
| Other files | `GET /api/files/download` (100 MB) | A file card with the name, size and type. A QR code links to the same file on your Hermes dashboard, which your phone opens if it is signed in |
| Images from tools (`tool.complete.image_path`) | `/api/media` | Inline under the tool chip |

The UI never talks to Hermes or the internet. Everything goes through `127.0.0.1:8765`, under a
strict Content Security Policy.

### 4.3 Links

The UI takes the links out of a finished reply. The service then fetches a preview of each
one:
- **What it reads:** the title, description, `og:image` and favicon. No cookies are sent.
- **Limits:** a 5 s timeout, the first 512 KB of HTML, and at most three redirects, each one
  re-checked against the blocked addresses.
- **Blocked addresses:** private, link-local, loopback and tailnet addresses, except your
  Hermes host. This stops a reply from making the device probe your network.

Previews are cached in RAM for 24 hours. A card shows the favicon, title and domain. Tapping it
opens a sheet with a QR code about 60% of the screen wide, the full address and the title; it
closes on swipe down, a tap outside it or Esc. Markdown links in running text are tinted, and a
tap opens the same sheet.

### 4.4 The UI

**Stack**
- **Framework:** Preact and TypeScript, built with Vite.
- **Markdown:** `markdown-it`, with raw HTML switched off and every result passed through
  `DOMPurify`.
- **Code and QR:** `highlight.js` core with a curated set of about 15 languages, and
  `qrcode-generator`.
- **Fonts:** Inter and JetBrains Mono, self-hosted as subset woff2.
- **Budget:** under 250 KB of gzipped JavaScript and CSS, fonts aside.

**Geometry**
- **Viewport:** Chromium runs at `--force-device-scale-factor=2`, and every CSS pixel is two panel
  pixels. The panel is natively portrait, but the desk stands **landscape** (changed after
  approval, 19 November 2026): the kiosk turns the output inside cage with `wlr-randr`, and a udev
  rule turns touch to match (`install.sh --rotate 90|270|0`). The UI lays out at 640x360 CSS pixels.
- **Landscape layout:** a 208 px panel on the left takes the place of the top bar, the status line
  and the tool chips, so the conversation gets the full 360 px of height. The panel shows the
  avatar, name and chat title (tap for profiles), then by state: the time and date when idle;
  the status and each tool while Hermes works (with a turning ring on the avatar); what failed
  and Retry when offline. New chat and the menu sit at its foot. Sheets become a drawer from the
  panel's side, the QR sheet a dialog with the code beside its text, and setup and sign-in put
  the explanation beside the form. An approval or a question takes the message box's place, and
  Stop moves to the panel. Tried and dropped: a 72 px icon rail (lost the chat's title and the
  activity) and a single column with a slimmer top bar (a third less room for the chat).
- **Black glass, flush edges** (19 November 2026): the panel sits behind about 15 mm of black
  glass, so the dark theme is true black and its edges vanish into the glass. Colour lives in a
  soft light behind the panel that follows Hermes's state: dim navy at rest, a slow blue
  breathing while it works, amber when it needs you, grey when it is away (`ui/src/styles/aura.css`).
  The light fades out at least 14 px inside every screen edge. Three directions were tried, each
  checked inside a to-scale picture of the glass: a glow behind the conversation ("halo"), this
  state light ("aura"), and pure black with type only ("ink"). Aura was chosen because the state
  reads from across the desk.
- **Portrait** (`--rotate 0`) keeps the layout below.
- **Comfortable text:** body 18/27 px, code 14 px, meta 13 px. Compact is 16 px and Large 21 px.
- **Chrome:** touch targets at least 48 px (about 8 mm), a 56 px top bar, a composer that grows
  from 56 px to 5 lines, and 16 px gutters.

**Chat screen** (top to bottom)
- **Top bar:** the profile avatar and name with a chevron (opens the profile and session
  sheet), the chat's title (Main chat or the session title), and a menu (New chat, Compact,
  History, Settings).
- **Messages:**
  - Your messages sit in a filled, right-aligned bubble.
  - Hermes's replies are full-width text with no bubble, so code and tables get the width.
  - Date dividers come from timestamps.
  - A "Jump to latest" pill appears when you have scrolled up.
- **Activity line** under the reply being written: a soft pulse and "Thinking", then a chip for
  each tool ("Searching the web: weather in Manchester"), with progress where Hermes gives it.
  Reasoning text is not shown.
- **Composer:** the message box, then a send button that becomes a stop button while Hermes
  works. Enter sends, Shift+Enter adds a new line.

**Streaming.**
- Text deltas are buffered and released at a steady 40 to 80 characters a second, catching up
  quickly when far behind, so output reads like typing without lagging the model.
- Only the message being written is re-rendered, at most once per animation frame. A Markdown
  block that is still open (an unclosed code fence) is drawn as provisional and settles when it
  closes.

**States.** Each one has a distinct, plain-English presentation:

| State | Shown as |
|---|---|
| Starting | The splash with the cached avatar, until the first `ready` |
| Connecting / reconnecting | A thin bar under the top bar: "Connecting to Hermes" or "Reconnecting in 8 s", with a Retry button. The chat stays readable and the composer keeps your draft |
| Offline | The bar names the layer that failed, because the helper reports Wi-Fi and Tailscale state: "No Wi-Fi", "Tailscale is signed out" or "Hermes is not answering" |
| Signed out | A full-screen sign-in (it happens by itself first when a password is saved) |
| Thinking / tools | The activity line, plus the ambient sound if it is on |
| Error in a turn | An inline card in the conversation with Hermes's message and Retry |
| Approval / question | A card pinned above the composer: the exact command, then Allow once or Deny; or the question with its choices or a text box |

**Other screens.**
- **Profile and session sheet:** profiles with main chat previews and "N more sessions", then
  that profile's sessions with search.
- **Settings:** see 4.9.
- **Media viewer, QR sheet, and a PIN pad for Settings.**
- **Setup:** Wi-Fi, then Tailscale (QR of the login link), then the Hermes address, then
  sign-in.

**Keyboard.** The Keychron works everywhere:
- **Sending and stopping:** Enter sends, Esc stops a turn or closes a sheet.
- **Chats and screens:** Ctrl+N starts a new chat; Ctrl+K opens the profile and session sheet;
  Ctrl+, opens Settings.
- **Scrolling:** Page Up and Page Down scroll the chat; Ctrl+Up and Ctrl+Down jump between
  messages.

The touch keyboard is a British QWERTY layout with £ and a symbols layer, takes the lower 40% of
the screen, and keeps the line being typed visible. The helper reports whether a Bluetooth
keyboard is connected, so the UI knows when to offer it.

**Copy.** All interface text is British English and never uses an em dash. A CI check rejects
U+2014 in `ui/` and `docs/`.

### 4.5 Look

- **Palette:** deep navy background (`#05051f`-ish), raised navy surfaces, white primary text,
  blue-grey secondary text, and a blue accent as in the app's unread dots.
- **Shapes:** round 48 px icon buttons and generous radii.
- **Avatar:** the profile's own avatar, from `profiles.get_asset` (initials on a colour when
  there is none).
- **Themes:** dark by default, with a light theme and "follow the time of day" in Settings.
- **Colour tokens:** defined once and checked for WCAG AA contrast in the Playwright tests.

### 4.6 Memory budget (estimates, to be measured in milestone 0)

| | MB |
|---|---|
| Kernel, systemd, NetworkManager, BlueZ, Tailscale, PipeWire | about 220 |
| cage | about 20 |
| Chromium (browser, GPU and one renderer process) | 300 to 450 |
| The service (Python, measured at 37 to 41 on a Pi 5) | about 45 |
| The helper | about 15 |
| **Total** | **about 600 to 750 of 1,900 usable** |

zram swap (512 MB, compressed) covers spikes such as a large image. A watchdog restarts the
kiosk if Chromium passes 900 MB.

### 4.7 Screen sleep

The UI sees every touch and key, so it keeps the idle timer and asks the helper to set the
backlight (`/sys/class/backlight/*`). Brightness is set to a level or switched off with
`bl_power`.
- **Waking by touch:** the first touch only wakes the screen.
- **Waking by key:** the key wakes the screen and is also typed.
- **Waking by message:** a new message in any profile's main chat wakes the screen to a dimmed
  level, outside quiet hours.
- **Chromium:** its own screen-saver behaviour is switched off.

### 4.8 Audio

All sound comes from the browser, through one Web Audio graph, to PipeWire:
- **Sources:** speech, audio players, the ambient pad and the cues.
- **Ducking:** speech and players duck the pad.
- **Volumes:** sound effects and speech each have their own volume.
- **Quiet hours:** they mute effects.

**Streamed speech.** The service relays `speak-stream` PCM to the browser as binary WebSocket
frames, and an AudioWorklet plays them gaplessly. Playback can be stopped at once.

**Sound design** (synthesised, no files):
- **Ambient pad:** two detuned triangle oscillators and a sine sub-octave through a slowly
  moving low-pass filter. It fades in over 1.5 s once a turn has run longer than 1.2 s, so quick
  replies stay silent, and fades out over 0.8 s.
- **Cues:** a quiet filtered tick when a tool starts, a two-note rising chime when a reply
  completes, and a soft falling tone on error.

**Output choices.** PipeWire picks the device. Settings lists the outputs PipeWire sees and
remembers the choice.
- **3.5 mm:** works, with some hiss.
- **USB:** cleanest.
- **Bluetooth:** works, but shares the Pi 4's single radio with Wi-Fi and your keyboard, so
  expect the odd stutter.

### 4.9 Settings (all on screen)

| Section | Settings |
|---|---|
| Display | Brightness, dim after, off after, quiet hours, theme, text size |
| Sound | Thinking sounds on or off, effects volume, speech volume, "Read replies aloud", output device |
| Keyboard | Bluetooth devices: pair (the device becomes discoverable for 2 minutes and shows the passkey), connect, forget; touch keyboard: automatic or always available |
| Network | Wi-Fi networks (scan, join, forget, through NetworkManager); Tailscale status, sign-in by QR and sign-out |
| Hermes | Address, the signed-in account, sign out (also erases the saved password), the default profile |
| Security | Settings PIN: set, change or remove |
| System | Version, check for updates, install, roll back, restart the app, reboot, power off, and a support bundle (redacted logs, saved where Tailscale SSH can collect them) |

Changes take effect at once and are saved in `/var/lib/lantern/settings.json`. The PIN is
stored as a scrypt hash.

## 5. The device image and boot

**Base image.** Raspberry Pi OS Lite 64-bit (Trixie), flashed with Raspberry Pi Imager. Imager
sets your Wi-Fi, a user and your SSH public key. `device/install.sh` then does the rest:

1. **Packages:** `cage`, `chromium`, `plymouth`, `pipewire`, `wireplumber`, `tailscale`,
   `python3-venv`, `fonts-noto-color-emoji` and `zram-tools`.
2. **Accounts:** the `kiosk` and `lantern` users and the release layout (section 6).
3. **`config.txt`:**
   - `dtoverlay=vc4-kms-v3d` and `dtoverlay=vc4-kms-dsi-ili9881-5inch` (the Touch Display 2 5"
     on a Pi 4; confirmed in milestone 0);
   - `disable_splash=1`;
   - `gpu_mem` left at the KMS default.
4. **`cmdline.txt`:**
   - `quiet splash loglevel=3 logo.nologo vt.global_cursor_default=0 consoleblank=0`;
   - `plymouth.ignore-serial-consoles` and `fsck.repair=yes`.
5. **Plymouth:** the `lantern` theme, a navy screen with a soft progress pulse. It has no
   product logo; the avatar appears with the first UI frame.
6. **systemd units:**
   - `lantern-helper.service`;
   - `lantern.service` (with `WatchdogSec`);
   - `lantern-kiosk.service`, which runs `cage -- chromium ...` as `kiosk` on tty1 (`TTYPath`,
     `PAMName=login`), `After=lantern.service`, with `Restart=always`;
   - `getty@tty1` masked, and no other consoles. The hardware watchdog is on
     (`RuntimeWatchdogSec=15`).
7. **Chromium flags:**
   - Mode and scale: `--kiosk --app=http://127.0.0.1:8765/ --ozone-platform=wayland
     --force-device-scale-factor=2`.
   - Quiet startup: `--noerrdialogs --disable-session-crashed-bubble --no-first-run`.
   - Behaviour: `--overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required
     --disable-features=Translate,MediaRouter`.
   - Profile and cache: a profile in RAM (`/run/kiosk`), so the browser writes nothing to the
     card.
8. **Hardening:**
   - **RAM instead of card:** journald `Storage=volatile` with a 32 MB cap; `/tmp` and
     `/var/tmp` on tmpfs; `dphys-swapfile` removed, with zram in its place.
   - **Fewer writes:** `noatime` on root; `apt-daily` timers off (updates are ours).
9. **Tailscale and SSH:** `tailscale up --ssh` (you approve it once), OpenSSH disabled, and
   password logins off everywhere.

**Boot target:** under 20 s from power to a usable chat. Measured with `systemd-analyze` and a
UI mark the service logs.

**Recovery.**
- **Crashes:** each unit restarts itself.
- **Crash loops:** a service that fails five times in two minutes makes the kiosk show a plain
  "Something went wrong" screen, offering Restart, Roll back to the previous version and
  Reboot.
- **Hung renderer:** if the UI stops answering the service's heartbeat for 30 s, the helper
  restarts the kiosk.

## 6. Updates

**What CI builds.** A release tag builds `lantern-<version>-arm64.tar.zst` in GitHub Actions. It
contains:
- the built UI;
- a wheel of the service and its pure-Python dependencies;
- the helper;
- the device files;
- `SHA256SUMS`, signed with minisign (the public key ships on the device).

**Install layout.** Each version goes to `/opt/lantern/releases/<version>/` with its own venv;
`/opt/lantern/current` is a symlink.

**Updating** (the helper does this):
1. Download the bundle and check the signature and checksums.
2. Unpack it beside the running version.
3. Swap the symlink atomically and restart the units.
4. If the new version is not `ready` (or at least showing the UI) within 90 s, swap back and
   say so.

The last two versions are kept. The device checks for updates daily and **never installs
without you**; Settings shows "Version 0.3.1 is available".

## 7. Security and privacy

- **Credentials** are in `/var/lib/lantern/credentials.json`: mode 0600, owned by `lantern`,
  written atomically. The file holds the access and refresh tokens and, by your choice, the
  password.
  - **The password** is used only to sign in again when the refresh token is refused. It is
    deleted if Hermes rejects it, and Sign out erases the whole file.
  - **Plainly:** a Pi 4 has no secure element. Anyone with the SD card has your Hermes
    dashboard password, and the dashboard has full control of Hermes. If the card is lost,
    change the dashboard password, which also signs every device out.
- **The browser** never sees credentials.
  - **Bridge token:** the UI bridge listens only on `127.0.0.1` and requires a per-boot token
    that the kiosk unit passes to Chromium in the start URL.
  - **Sanitising:** agent output is sanitised (no raw HTML or scripts), and the Content
    Security Policy allows only `self`.
  - **No navigation:** link clicks never navigate.
- **No listening ports** besides Tailscale's own. CI checks with `ss -ltnu` in the image tests.
- **Outbound fetches** for link previews and remote images refuse private, loopback,
  link-local and tailnet addresses (except your Hermes host), cap size and time, and send no
  cookies. Only the linked site sees the request; no third party is involved.
- **Approvals** from the desk are Allow once or Deny only.
- **The helper** accepts a fixed set of operations over a root-owned socket that only `lantern`
  can open, checks every argument and never runs a shell.
- **The Settings PIN** guards Settings and account, network and update actions. Chat stays open.
- **Remote access** is Tailscale SSH only, governed by your tailnet ACLs.

## 8. Milestones

Each milestone ends with its tests passing and a short demo.

### M0: Prove the risky parts (1 to 2 days, Mac and VPS; the hardware items wait for the Pi)

- **Platform hint:** confirm `platform_hints.lantern` shapes replies in the main chat when the
  desk sends to it, given that the main chat may be bound to the source of the client that
  created it. If it does not, keep a short hidden opening note in new chats and decide
  together what to do for the main chat.
- **Activity from elsewhere:** confirm what the desk receives when your phone, or a routine,
  adds to a main chat the desk has open (live events or only `sessions.changed`).
- **Hermes calls:** ~~check that `session.compress` and `speak-stream` behave as the source says on
  0.22.5~~ Done: both work (`docs/tested.md`).
- **On the Pi (later):** the Touch Display 2 overlay, cage and Chromium RAM, scrolling
  smoothness, and boot time.

### M1: Boot to chat with streamed text (MVP)

- **Service:**
  - native sign-in with refresh and the saved password; heartbeat; mode detection;
  - the fixes in 4.1;
  - profiles and main chats, and New chat;
  - the UI bridge;
  - critter, look and plugin code removed.
- **UI:**
  - the chat screen with Markdown and code;
  - streaming at a typing pace, Stop, the activity line and tool chips;
  - every connection state;
  - the physical keyboard.
- **Device:**
  - `install.sh`, the units, Chromium flags, the Plymouth splash and hardening;
  - Tailscale SSH.
- **Exit:**
  - on a Mac, the full flow against the fake Hermes and against a live Hermes;
  - on the Pi, power-on to a streamed answer in under 20 s, with idle RAM under 800 MB.

### M2: Every kind of media

- MEDIA tags and Markdown images; the image viewer.
- Audio players; file cards.
- Link cards with favicons and the QR sheet.
- Read aloud: the button, the setting and streamed playback.
- Approval and question cards.
- **Exit:** a scripted reply from the fake containing every kind of media renders correctly,
  and the same set is checked once against a live Hermes.

### M3: The appliance

- The profile and session sheet with search; Compact.
- All of Settings, with the helper (Wi-Fi, Bluetooth, Tailscale, backlight, volume).
- The touch keyboard; sleep, dim, wake and quiet hours.
- The thinking sounds.
- The Settings PIN.
- Signed updates and rollback; crash-loop recovery.
- **Exit:**
  - a 72-hour soak with network chaos (section 9) and no memory growth beyond 5%;
  - 20 random power cuts, every one booting cleanly;
  - an update and a rollback, both done from the screen.

### M4: Polish

- A CI-built image (pi-gen) with an on-screen first-run wizard (Wi-Fi, Tailscale QR, Hermes
  address, sign-in).
- An optional read-only overlay root with a data partition.
- Performance work.
- Accessibility pass.
- New README, AGENTS.md, `docs/local-api.md` and screenshots taken on the Pi.

## 9. Test plan

**Python** (`pytest`, under 30 s, no network beyond 127.0.0.1)

- **The fake Hermes:** `tests/fakes/dashboard.py` is brought up to the current contracts. It
  covers:
  - native PKCE and refresh;
  - `profiles.list`, plain and authority modes, and the heartbeat;
  - `session.reclaimed` and `compress`;
  - media, files and stream tickets;
  - `speak-stream`, approvals and clarify.

  Like Hermes, it rejects any undeclared parameter key.
- **Contract test:** every request the service builds is checked against Hermes's published
  contract (`gateway-contract.openrpc.json`) for 0.22.5 and for current main, so drift shows
  up as a failing test, not a broken desk.
- **Unit tests:**
  - MEDIA tag parsing (the cases from Hermes's own parser, including tags inside code);
  - link-preview limits and private-address blocking;
  - credential handling (a refused password is deleted, Sign out erases everything);
  - update verification (a bad signature or checksum is refused, and rollback works);
  - the helper's argument checks.
- **Live test (opt-in, `LANTERN_LIVE=1`):** against a live Hermes. It signs in, lists profiles,
  runs one turn in a throwaway session and deletes that session with `session.delete`, as was
  done while writing this plan.

**UI**

- **Vitest:**
  - Markdown rendering;
  - the sanitiser, against a set of XSS payloads;
  - streaming pacing;
  - link extraction;
  - keyboard shortcuts.
- **Playwright** at 640x360 (landscape) and 360x640 (portrait) CSS pixels, scale 2, against the fake:
  - screenshots of every screen and state, dark and light, at all three text sizes, compared
    with approved images;
  - flows: send, stop, approve, new chat, compact, switch profile, QR sheet and settings;
  - a contrast check of the colour tokens.

**On the Pi**

- **Measured budgets:**
  - boot to a usable chat under 20 s;
  - idle RAM under 800 MB;
  - no main-thread task over 50 ms while streaming (Chromium tracing);
  - smooth scrolling through a 200-message chat.
- **Soak:** 72 hours with Wi-Fi switched off and on, the Hermes dashboard restarted, the service
  killed and Tailscale bounced.
- **Power cuts:** 20 random pulls during idle, streaming and updates.
- **Manual checklist (you):**
  - touch accuracy and scrolling;
  - switching the K8 Pro between Mac and desk;
  - sleep and wake;
  - speaker quality;
  - readability at your normal distance.

**CI** runs pytest, pyflakes, Vitest, Playwright, the em dash check and the bundle build on
every push. A tag publishes the signed bundle.

## 10. Developing on a Mac

```sh
uv venv .venv && uv pip install --python .venv/bin/python -e ".[dev]"
.venv/bin/lantern fakehermes --port 9119 &                      # or a live Hermes
LANTERN_HOME=/tmp/dev .venv/bin/lantern setup http://127.0.0.1:9119 --no-service
LANTERN_HOME=/tmp/dev .venv/bin/lantern run --dev &             # bridge on 127.0.0.1:8765, fake helper
cd ui && npm install && npm run dev                              # Vite, proxied to the bridge
```

- **The browser:** open the Vite address in Chrome with the device toolbar set to 640x360 at
  DPR 2, or start Chrome with `--app=... --window-size=640,360 --force-device-scale-factor=2`
  to mimic the kiosk.
- **Hardware stand-ins:** `--dev` swaps the root helper for a fake one with simulated Wi-Fi,
  Bluetooth, backlight and updates, so every Settings screen works on the Mac.
- **Sound:** plays through the Mac's speakers.
- **Fake Hermes:** sends scripted replies (slow, tools, every kind of media, an approval, an
  error, a disconnect) on trigger words, so each state can be shown on demand.
- **On real hardware later:** `make deploy PI=<tailnet name>` copies a development bundle over
  Tailscale SSH and restarts the units, with no reflash.

## 11. Risks and open questions

- **Hermes's internal API moves.** `/api/ws` is what Hermes's own apps use, not a frozen public
  API. Mitigations:
  - one module speaks it;
  - mode detection and the drop-and-retry of optional keys;
  - the contract test against two Hermes versions.
- **Formatting in the main chat** depends on M0's finding about the platform hint.
- **The Touch Display 2 on a Pi 4** needs the right overlay and a 15-pin cable (both in the
  box). Touch through Wayland under cage is expected to work but has not been run yet.
- **Bluetooth** carries the keyboard and possibly a speaker, alongside Wi-Fi, on one radio.
- **Chromium memory** on 2 GB is estimated, not yet measured; it is the first thing M0 checks
  on the Pi.
- **The saved password** is a deliberate trade of security for convenience (section 7).
