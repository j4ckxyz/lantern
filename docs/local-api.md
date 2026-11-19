# The local API

`lantern run` holds the one connection to Hermes. The desk's screen (a web page in Chromium)
and the `lantern` command talk to it through this API. It is the same protocol over two
transports:

| Transport | Where | Who |
|---|---|---|
| WebSocket | `ws://127.0.0.1:8765/ws` | The UI. Gated by a per-boot token (below) |
| Unix socket | `$LANTERN_HOME/lantern.sock`, mode 0600, one JSON object per line | `lantern status`, `send`, `chat` and scripts |

Nothing here carries a password or a Hermes token. The service never listens on a network
interface.

## HTTP on 127.0.0.1:8765

| Path | What |
|---|---|
| `GET /?t=<token>` | The UI. A valid token sets the `lantern_ui` cookie (HttpOnly, SameSite=Strict) that the rest of these paths require |
| `GET /assets/...` | The built UI's scripts, styles and fonts. No token needed |
| `GET /ws` | The WebSocket |
| `GET /media/<id>` | A picture, audio or file the agent sent, fetched from Hermes. Audio honours `Range` |
| `GET /proxy/image?url=<https url>` | A remote image (a Markdown image, a link card's picture or favicon). Only `http` and `https`; private, loopback, link-local and tailnet addresses are refused; 10 MB and 10 s at most; image types only |
| `GET /avatar/<profile>` | The profile's avatar, or 404 when it has none |

The token is made fresh at every start and handed to Chromium in its start URL by the kiosk
unit. `lantern run --dev` uses the fixed token `dev` and also accepts `?t=dev` on every path, so
a Vite dev server can proxy to it.

## Messages

Every message is a JSON object. The service sends events (`type`); the client sends operations
(`op`). Add `"req": "<anything>"` to an operation to get exactly one answer:

```json
{"type": "result", "req": "r7", "ok": true, ...}
{"type": "result", "req": "r7", "ok": false, "error": "A sentence a person can read."}
```

Without `req`, a success is silent and a failure still comes back as a `result` with `req: null`.

### Shapes

```text
Profile  {name, display_name, is_default, avatar: "/avatar/<name>" | null,
          main: {id, preview, last_active, message_count} | null}
View     {profile, session_id, kind: "main" | "session", title, messages: [Message], has_more}
Message  {id, role: "user" | "assistant", text, ts, media: [Media],
          interim?: true, voice?: true, error?: "...", command?: "/usage"}
Media    {id, kind: "image" | "audio" | "file", name, mime, size?, url: "/media/<id>",
          link?: "<the Hermes dashboard download address, for a phone>"}
Turn     {id, started, text, status, tools: [Tool]}
Tool     {id, name, label, state: "running" | "done" | "failed", progress?: 0..1, duration_s?}
Prompt   {id, kind: "approval" | "clarify", title, text, command?,
          choices: [{id, label}], free_text}
Session  {id, title, preview, source, last_active, message_count, is_main}
```

`text` is Markdown with `MEDIA:` tags already taken out; what they pointed at is in `media`.
`ts`, `started` and `last_active` are Unix seconds. A `Message` id is stable, so an event with
an id the client already shows replaces it.

### The first message: `hello`

Sent on connecting, and again whenever everything changed (a new Hermes address, signing in or
out):

```json
{"type": "hello", "version": 2,
 "state": "ready", "error": "", "detail": "",
 "server": {"url": "https://hermes.example.ts.net", "version": "0.22.5"},
 "device": {"name": "Desk"},
 "account": {"username": "ada", "remembered": true},
 "profiles": [Profile],
 "view": View,
 "turn": Turn | null,
 "prompt": Prompt | null,
 "settings": {...},
 "dev": false}
```

`state` is one of:

| State | Meaning | What the screen offers |
|---|---|---|
| `setup` | No Hermes address yet | The address form (`setup`) |
| `signin` | Hermes wants a username and password | The sign-in form (`signin`) |
| `connecting` | Reaching Hermes | The last chat, read-only, with a progress line |
| `offline` | Cannot reach Hermes; retrying. `error` says why in a sentence, `detail` is technical | The last chat, read-only, with the reason and Retry |
| `ready` | Connected | Everything |

### Events

| Event | Fields | Meaning |
|---|---|---|
| `link` | `state`, `error`, `detail`, `retry_in?` | The connection state changed. `retry_in` is seconds until the next attempt |
| `profiles` | `profiles` | The profile list or a main chat's preview changed |
| `title` | `session_id`, `title` | Hermes named the open side chat. Update the header; the messages are unchanged |
| `view` | `view` | A different chat is open, or the open one was reloaded (new, compacted, changed elsewhere) |
| `message` | `message` | Add this message, or replace the one with the same id |
| `turn.start` | `turn` | Hermes began working in the open chat |
| `turn.delta` | `text` | The reply so far. **Cumulative**: replace, never append |
| `turn.activity` | `status`, `tools` | What Hermes is doing. `status` is a short phrase or empty |
| `turn.end` | `outcome` (`success`, `failure`, `cancelled`), `error?` | The turn is over. The finished reply has already arrived as a `message` |
| `prompt` | `prompt` | Hermes needs an answer (an approval or a question) |
| `prompt.close` | `id` | That prompt was answered or withdrawn |
| `attention` | `profile`, `session_id`, `preview` | A new message arrived in a main chat the screen is not showing (a routine, your phone). Wakes the screen outside quiet hours |
| `notice` | `text`, `level` (`info`, `warning`, `error`), `ttl_s` | A short message to show for a while |
| `settings` | `settings` | Settings changed |
| `speech.start` | `id`, `message_id`, `sample_rate` | Spoken audio follows as binary frames: signed 16-bit little-endian mono PCM |
| `speech.end` | `id`, `reason` (`done`, `stopped`, `error`), `error?` | No more audio for that `id` |
| `speech.clip` | `id`, `message_id`, `url` | The whole reply as one clip (`/media/<id>`), for a Hermes voice that cannot stream; play it instead of PCM frames. `speech.end` follows straight away |

A turn reads `turn.start` → (`turn.delta` | `turn.activity` | `prompt`)* → `message` → `turn.end`.
Commentary before the answer arrives as a `message` with `interim: true`.

### Operations

| Op | Fields | Result | Does |
|---|---|---|---|
| `send` | `text` | `id` | Send a message in the open chat |
| `stop` | | | Stop the turn in progress |
| `chat.open` | `profile`, `session_id?` | `view` | Open a chat; without `session_id`, that profile's main chat (created if it has none) |
| `chat.new` | `profile?` | `view` | Start a new side chat on the profile (default: the open one) |
| `chat.compact` | | | Ask Hermes to compact the open chat; a `view` follows |
| `history.more` | | `messages`, `has_more` | Older messages of the open chat, oldest first, to put above the current ones |
| `sessions.list` | `profile`, `query?`, `limit?`, `offset?` | `sessions` | Conversations on a profile, most recent first. Automation (cron and the like) is left out |
| `answer` | `id`, `choice?` or `text?` | | Answer a prompt. Approvals accept only `once` and `deny` |
| `commands.list` | | `commands` | Hermes's slash commands for the open chat's profile, as `{name, description, args, options?}` (`args`: null, `text`, `options` or `mixed`). Commands Hermes's own apps keep out of their menus (terminal-only, settings, hidden) are left out. The desk's own `/stop` comes first, and `/new` when conversations are on |
| `command` | `text` (`/name arg`) | `output?`, `prefill?`, `notice?`, `sent?`, `view?` | Run a command. Output also arrives as a `message` with `command` set. A command that expands into a prompt is sent as a turn (the screen shows the command, Hermes gets the expansion) and answers `sent`. `prefill` is text for the message box |
| `link.preview` | `url` | `preview` | `{url, title, description, site, favicon, image}`; the pictures are `/proxy/image` paths or null |
| `speak` | `message_id` | `id` | Read a message aloud; `speech.*` events follow |
| `speak.stop` | | | Stop speaking |
| `settings.set` | `changes` | `settings` | Change settings (keys below) |
| `setup.check` | `url` | `url`, `version`, `tried`, `insecure` | Check what was typed before saving it. The service repairs typos (`https//`, a missing scheme, a pasted dashboard route), tries every likely address at once, and answers with the likeliest one that a Hermes dashboard answers on (`url` is null when none does). `insecure` is true for plain `http` outside this network or tailnet |
| `setup` | `url` | | Set the Hermes address, after the same checks as `setup.check`. When nothing answers yet, the likeliest address is kept and tried again |
| `signin` | `username`, `password`, `remember` | | Sign in. With `remember`, the password is kept to sign in again by itself |
| `signout` | | | Forget the session and any saved password |
| `retry` | | | Try to connect now instead of waiting |
| `status` | | `status` | The `hello` snapshot again |
| `alive` | | | The UI is responsive. The kiosk watchdog restarts Chromium after 30 s without one |

### Settings

Kept by the service in `$LANTERN_HOME/settings.json`, so they survive restarts and updates.

| Key | Values | Default |
|---|---|---|
| `text_size` | `compact`, `comfortable`, `large` | `comfortable` |
| `theme` | `dark`, `light`, `auto` | `dark` |
| `sounds` | bool: thinking sounds | `false` |
| `sound_volume`, `speech_volume` | 0 to 1 | `0.4`, `0.8` |
| `read_aloud` | bool: speak each reply as it finishes | `false` |
| `brightness` | 0.05 to 1 | `0.8` |
| `dim_after_s`, `off_after_s` | seconds; 0 never | `120`, `600` |
| `quiet_start`, `quiet_end` | `"HH:MM"` | `"23:00"`, `"07:00"` |
| `touch_keyboard` | `auto`, `always` | `auto` |
| `default_profile` | a profile name | `default` |
| `conversations` | bool: show profiles, side chats, New chat and compaction. Off, the desk is one conversation (the default profile's main chat), and turning it off returns there | `false` |
