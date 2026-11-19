# What has been run, and on what

Written down so you know what you are standing on. Anything not listed here has not been run.

## Against a live Hermes (19 November 2026)

Hermes Agent 0.22.5 (release 2026.9.24) on a VPS, reached over Tailscale through `hermes dashboard`
with a username and password. Run from a Linux laptop with the service's own code. Every test
turn happened in a throwaway side chat that was deleted afterwards with `session.delete`; the
main chat was only read.

| Check | Result |
|---|---|
| Native sign-in (PKCE: authorize, password-login, token) | Works; tokens last 12 hours |
| WebSocket ticket with a bearer token | Works |
| Socket mode | Plain gateway (no session authority), `heartbeat: true`, `change_events: true` |
| `gateway.ping` | Answered |
| `profiles.list` | Both profiles; the default one has its main chat ("Bot Chat"), the other has none yet |
| `profiles.get_asset` (avatar) | The default profile's avatar, a 93 KB PNG |
| History (`/api/sessions/{id}/messages?order=latest`) | Works. The newest rows of a busy main chat are mostly tool calls, hence pages of 120 rows |
| A side chat (`session.create`, source `lantern`) | Created; `idempotency_key` was accepted |
| A streamed turn | `turn.delta` is cumulative and its last value equals the finished reply exactly |
| Streaming speech (`/api/audio/speak-stream`) | Works: 24 kHz PCM. **First audio after 2.5 to 2.7 s** (OpenAI voice, one sentence at a time) |
| One-shot speech (`/api/audio/speak`) | Works: MP3, 24 kHz, about 2.4 s for a short line |
| Compaction (`session.compress`) | Works on a side chat |
| Deleting a session | `session.delete` over the WebSocket works; `DELETE /api/sessions/{id}` answers 409 `client_upgrade_required` |

Not yet run live:
- Approvals and questions from the agent.
- Media the agent sends (`MEDIA:` tags) and link previews of real pages.
- Opening the main chat from the desk.
- Whether a `platform_hints.lantern` entry shapes replies there (milestone 0, needs the hint added to
  your `config.yaml` first).

## On a development machine

Linux (x86_64), Python 3.12, Node 22, against `lantern fakehermes`:

- The Python suite: 45 tests, about 20 s. It covers:
  - sign-in, refresh and the saved password;
  - every operation in `docs/local-api.md`;
  - re-sent chunks dropped, media served with Range, approvals limited to "once" and "deny";
  - questions, activity from another device, paging, compaction, streaming speech;
  - reconnecting after a drop, and the bridge's token;
  - a message sent while a chat is being switched lands in the new chat.
- The screen, at scale 2 in Playwright's Chromium, in landscape (640x360 CSS pixels, the panel's
  1280x720 turned, as the desk stands) and portrait (360x640):
  - 31 unit tests: Markdown and sanitising, including XSS payloads; the typing pace; protocol state;
  - 66 portrait screenshot and flow tests against the UI's own mock, in both themes and three text
    sizes;
  - 27 landscape tests: every main screen in both themes and large text, plus checks that the
    panel lists the tools once, that an approval replaces the message box and moves Stop to the
    panel, that sign-in fits without scrolling, and that turning the screen swaps the panel for
    the top bar;
  - screenshots compare colours tightly (`threshold: 0.05`), so a change between navy and true
    black is caught;
  - 6 tests of the built UI against the real service and the stand-in Hermes. They cover the main
    chat with its avatar, streaming with tool chips, pictures, audio and files from `MEDIA:` tags,
    an approval, a new chat getting its title, and reading aloud.
- A release bundle built with `device/build-bundle.sh` (580 KB). Its checksums verify, and the wheel
  installs into a clean virtualenv. The UI packaged inside it is served with the token check.
- `device/install.sh`'s edits to `config.txt` and `cmdline.txt`, run twice on copies of Raspberry Pi
  OS's files: one marked block, nothing doubled.
- ShellCheck on every script: clean.
- Turning the screen: the kiosk's in-cage step against a stand-in `wlr-randr` (it turns the first
  output, or leaves it for portrait, then starts the browser), and the installer's display step
  run into a scratch directory for 90 and 270 degrees.

## Not run yet

- **Anything on the Raspberry Pi 4 or the Touch Display 2.** The installer, the units, the splash,
  cage and Chromium, memory, boot time, touch and the speaker have all been written but not run
  on the device.
- **Turning the panel to landscape on the device.** Not run: whether cage accepts `wlr-randr`'s
  transform, which of 90 and 270 is right way up for your stand, whether touch lands in the right
  place with the udev calibration matrix, and how the boot splash looks turned (it is a centred
  dot, so it should not matter).
- A built release bundle installed from scratch.
