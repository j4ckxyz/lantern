// A stand-in for `lantern run --dev`: the local API (docs/local-api.md) with scripted replies,
// so every screen can be shown and tested with no Hermes.
//
//   node mock/server.mjs                 serves dist/ and the API on 127.0.0.1:8766 (PORT to change)
//   open http://127.0.0.1:8766/?t=dev
//
// Start states, from the page address: ?mock=setup | signin | offline | connecting | empty
// Theme and text size: &theme=light&size=large
// Trigger words in a message: slow, media, links, approve, ask, error, long, wait (holds until
// stopped). Anything else gets a short echo.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { avatar, banner, budgetCsv, chimeWav, landscape, speechPcm, tile } from './media.mjs'

const PORT = Number(process.env.PORT || 8766)
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))

// 2026-11-19 09:00 UTC. Conversation times are fixed so screenshots do not change from day to day.
const BASE = Date.UTC(2026, 10, 19, 9, 0) / 1000
const NOW = BASE + 5400 // 10:30

const MEDIA = {
  'img-1': { body: landscape(), type: 'image/png' },
  'voice-1': { body: chimeWav(), type: 'audio/wav' },
  'file-1': { body: budgetCsv(), type: 'text/csv' },
}
const AVATAR = avatar(128)
const FAVICONS = { 'raspberrypi.com': tile(64, [197, 26, 74]), default: tile(64, [60, 90, 200]) }
const BANNER = banner()

// -- a fixed world ------------------------------------------------------------------------------

const msg = (id, role, text, ts, extra = {}) => ({ id, role, text, ts, media: [], ...extra })

function mainHistory() {
  return [
    msg('h1', 'user', 'Can you remind me to check the bike tyres at 6pm?', BASE - 15 * 3600),
    msg('h2', 'assistant', 'Done. I have set a reminder for **18:00** today: "Check the bike tyres".', BASE - 15 * 3600 + 6),
    msg('h3', 'user', "What's on today?", BASE + 3500),
    msg(
      'h4',
      'assistant',
      'You have three things today:\n\n- **10:00** Call with Sam about the website\n- **13:30** Collect the parcel from the depot\n- **16:00** Driving lesson\n\nIt is 11°C in Manchester and dry until mid-afternoon, so the lesson should be fine.',
      BASE + 3506,
    ),
  ]
}

function olderPage(page) {
  const start = BASE - (page + 2) * 86400
  const out = []
  for (let i = 0; i < 3; i++) {
    const t = start + i * 600
    out.push(msg(`old-${page}-${i}u`, 'user', `Earlier question ${page * 3 + i + 1}: what was the plan for the garden?`, t))
    out.push(msg(`old-${page}-${i}a`, 'assistant', `We said the raised beds go along the south fence, with herbs nearest the door. (Earlier answer ${page * 3 + i + 1}.)`, t + 8))
  }
  return out
}

const PROFILES = () => [
  {
    name: 'default',
    display_name: 'Hermes',
    is_default: true,
    avatar: '/avatar/default',
    main: { id: 'main-default', preview: 'You have three things today: 10:00 Call with Sam about the website', last_active: BASE + 3506, message_count: 22 },
  },
  {
    name: 'sidequest-content',
    display_name: 'Sidequest',
    is_default: false,
    avatar: '/avatar/sidequest-content',
    main: null,
  },
]

const SESSIONS = {
  default: [
    { id: 'main-default', title: 'Main chat', preview: 'You have three things today', source: 'gui', last_active: BASE + 3506, message_count: 22, is_main: true },
    { id: 's-hike', title: 'Weekend walking route', preview: 'The north coast path from Grève de Lecq is about 9 km', source: 'discord', last_active: BASE - 3 * 3600, message_count: 8, is_main: false },
    { id: 's-garage', title: 'Garage door sensor', preview: 'The reed switch reads open when the gap is over 15 mm', source: 'lantern', last_active: BASE - 26 * 3600, message_count: 14, is_main: false },
    { id: 's-letter', title: 'Reply to the letting agent', preview: 'Here is a polite draft that asks for the deposit timeline', source: 'desktop', last_active: BASE - 3 * 86400, message_count: 6, is_main: false },
    { id: 's-eink', title: 'Compare e-ink displays', preview: 'For a 7.5 inch panel the refresh time is the main trade-off', source: 'cli', last_active: BASE - 9 * 86400, message_count: 11, is_main: false },
  ],
  'sidequest-content': [
    { id: 's-sq1', title: 'Video script outline', preview: 'Three acts: the problem, the build, the reveal', source: 'discord', last_active: BASE - 2 * 86400, message_count: 9, is_main: false },
  ],
}

const SETTINGS = {
  text_size: 'comfortable', theme: 'dark', sounds: false, sound_volume: 0.4, speech_volume: 0.8, read_aloud: false,
  brightness: 0.8, dim_after_s: 120, off_after_s: 600, quiet_start: '23:00', quiet_end: '07:00', touch_keyboard: 'auto',
  default_profile: 'default',
}

const LONG = `## Setting up the desk display

The Touch Display 2 needs one line in \`config.txt\` on a Pi 4, then a reboot.

### 1. Enable the panel

\`\`\`ini
dtoverlay=vc4-kms-v3d
dtoverlay=vc4-kms-dsi-ili9881-5inch
\`\`\`

### 2. Check that it was found

\`\`\`bash
wlr-randr
journalctl -b | grep -i dsi
\`\`\`

### 3. Measure the backlight range

\`\`\`python
from pathlib import Path

base = next(Path("/sys/class/backlight").iterdir())
print(base.name, (base / "max_brightness").read_text().strip())
\`\`\`

| Setting | Value | Why |
|---|---|---|
| Resolution | 720 x 1280 | Native portrait |
| Scale | 2 | 360 x 640 layout |
| Refresh | 60 Hz | Smooth scrolling |

> If the screen stays black, reseat the ribbon cable with the contacts facing the board.

That is all it needs. The kiosk starts on the next boot.`

// -- the HTTP side -------------------------------------------------------------------------------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml' }

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra })
  res.end(body)
}

function serveMedia(req, res, item) {
  const total = item.body.length
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '')
  if (range) {
    const start = range[1] ? Number(range[1]) : 0
    const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1
    return send(res, 206, item.body.subarray(start, end + 1), item.type, {
      'Content-Range': `bytes ${start}-${end}/${total}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
    })
  }
  send(res, 200, item.body, item.type, { 'Accept-Ranges': 'bytes', 'Content-Length': total })
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname
  if (path.startsWith('/media/')) {
    const item = MEDIA[path.slice(7)]
    return item ? serveMedia(req, res, item) : send(res, 404, 'not found')
  }
  if (path.startsWith('/avatar/')) {
    return path === '/avatar/default' ? send(res, 200, AVATAR, 'image/png') : send(res, 404, 'no avatar')
  }
  if (path === '/proxy/image') {
    const target = url.searchParams.get('url') || ''
    if (!/^https?:\/\//.test(target) || target.includes('missing')) return send(res, 404, 'refused')
    if (target.includes('favicon')) return send(res, 200, target.includes('raspberrypi') ? FAVICONS['raspberrypi.com'] : FAVICONS.default, 'image/png')
    if (target.endsWith('.png') && target.includes('photo')) return send(res, 200, MEDIA['img-1'].body, 'image/png')
    return send(res, 200, BANNER, 'image/png')
  }
  // The built UI, when there is one.
  const file = path === '/' ? 'index.html' : normalize(path).replace(/^[/\\]+/, '')
  const full = join(DIST, file)
  if (!full.startsWith(DIST) || !existsSync(full) || !statSync(full).isFile()) {
    return send(res, 404, existsSync(DIST) ? 'not found' : 'Run "npm run build" first, or use "npm run dev" with MOCK=1.')
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(full)] || 'application/octet-stream' })
  createReadStream(full).pipe(res)
})

// -- the WebSocket side ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams
  const start = Date.now()
  const now = () => NOW + Math.floor((Date.now() - start) / 1000)
  let n = 0
  const nextId = (p) => `${p}${++n}`
  const out = (event) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(event))
  const reply = (m, fields = {}, ok = true, error) => m.req != null && out({ type: 'result', req: m.req, op: m.op, ok, ...(ok ? fields : { error }) })

  const world = {
    state: q.get('mock') === 'setup' ? 'setup' : q.get('mock') === 'signin' ? 'signin' : q.get('mock') === 'offline' ? 'offline' : q.get('mock') === 'connecting' ? 'connecting' : 'ready',
    settings: { ...SETTINGS, ...(q.get('theme') ? { theme: q.get('theme') } : {}), ...(q.get('size') ? { text_size: q.get('size') } : {}) },
    profiles: PROFILES(),
    view: { profile: 'default', session_id: 'main-default', kind: 'main', title: 'Main chat', messages: q.get('mock') === 'empty' ? [] : mainHistory(), has_more: q.get('mock') !== 'empty' },
    page: 0,
    turn: null,
    prompt: null,
    speaking: null,
  }

  const hello = () =>
    out({
      type: 'hello', version: 2, state: world.state,
      error: world.state === 'offline' ? 'Hermes is not answering' : '',
      detail: world.state === 'offline' ? 'connect timed out after 15 s' : '',
      server: world.state === 'setup' ? null : { url: 'https://hermes.example.ts.net', version: '0.22.5' },
      device: { name: 'Desk' },
      account: world.state === 'ready' ? { username: 'ada', remembered: true } : null,
      profiles: world.state === 'setup' ? [] : world.profiles,
      view: world.state === 'setup' ? null : world.view,
      turn: null, prompt: null, settings: world.settings, dev: true,
    })

  hello()
  if (world.state === 'offline') out({ type: 'link', state: 'offline', error: 'Hermes is not answering', detail: 'connect timed out after 15 s', retry_in: 8 })

  // -- turns --

  const add = (m) => {
    world.view.messages.push(m)
    out({ type: 'message', message: m })
  }

  async function stream(turn, text, { chunk = 6, every = 45 } = {}) {
    let i = 0
    while (i < text.length) {
      if (turn.stopped) return false
      i = Math.min(text.length, i + chunk)
      turn.text = text.slice(0, i)
      out({ type: 'turn.delta', text: turn.text })
      await sleep(every)
    }
    return true
  }

  function activity(turn, status, tools = turn.tools) {
    turn.status = status
    turn.tools = tools
    out({ type: 'turn.activity', status, tools })
  }

  async function finish(turn, text, extra = {}) {
    if (turn.stopped) return
    add(msg(nextId('a'), 'assistant', text, now(), extra))
    world.turn = null
    out({ type: 'turn.end', outcome: 'success' })
  }

  const waitAnswer = (turn) => new Promise((resolve) => (turn.answer = resolve))

  async function runTurn(text) {
    const turn = { id: nextId('t'), started: now(), text: '', status: '', tools: [], stopped: false, answer: null }
    world.turn = turn
    out({ type: 'turn.start', turn: { id: turn.id, started: turn.started, text: '', status: '', tools: [] } })
    const t = text.toLowerCase()
    await sleep(350)
    if (t.includes('approve')) {
      activity(turn, 'Thinking')
      await sleep(400)
      world.prompt = {
        id: 'p1', kind: 'approval', title: 'Allow this command?', text: 'Hermes wants to run a command on homelab.',
        command: 'sudo systemctl restart hermes-dashboard',
        choices: [{ id: 'once', label: 'Allow once' }, { id: 'session', label: 'Allow for this session' }, { id: 'always', label: 'Always allow' }, { id: 'deny', label: 'Deny' }],
        free_text: false,
      }
      out({ type: 'prompt', prompt: world.prompt })
      const answer = await waitAnswer(turn)
      if (turn.stopped) return
      activity(turn, answer === 'once' ? 'Restarting the dashboard' : '', [])
      await sleep(500)
      const said = answer === 'once' ? 'Done. The dashboard restarted cleanly and is answering again.' : 'All right, I have left it running as it is.'
      await stream(turn, said)
      return finish(turn, said)
    }
    if (t.includes('ask')) {
      world.prompt = {
        id: 'q1', kind: 'clarify', title: 'Hermes asks', text: 'Which calendar should I add the dentist appointment to?',
        choices: [{ id: 'personal', label: 'Personal' }, { id: 'family', label: 'Family' }], free_text: true,
      }
      out({ type: 'prompt', prompt: world.prompt })
      const answer = await waitAnswer(turn)
      if (turn.stopped) return
      const said = `Added to **${answer}**: dentist on Tuesday 25 November at 09:40.`
      await stream(turn, said)
      return finish(turn, said)
    }
    if (t.includes('error')) {
      activity(turn, 'Thinking')
      await stream(turn, 'Let me look that up')
      await sleep(400)
      world.turn = null
      return out({ type: 'turn.end', outcome: 'failure', error: 'The model provider is rate limiting requests. Try again in a minute.' })
    }
    if (t.includes('wait')) {
      // Holds in the middle of a turn until stopped: for pictures of the working state, and Stop.
      activity(turn, 'Thinking')
      await sleep(300)
      activity(turn, 'Checking your notes', [
        { id: 'w1', name: 'web_search', label: 'Searching the web: Manchester weather', state: 'done', duration_s: 1.1 },
        { id: 'w2', name: 'read_file', label: 'Reading notes/garden.md', state: 'running', progress: 0.6 },
      ])
      await stream(turn, 'Let me check the forecast and your garden notes first.')
      return
    }
    if (t.includes('slow')) {
      activity(turn, 'Thinking')
      await sleep(900)
      const tools = [{ id: 'x1', name: 'web_search', label: 'Searching the web: Manchester weather', state: 'running' }]
      activity(turn, '', tools)
      await sleep(1200)
      tools[0] = { ...tools[0], state: 'done', duration_s: 1.2 }
      tools.push({ id: 'x2', name: 'read_file', label: 'Reading notes/garden.md', state: 'running', progress: 0.3 })
      activity(turn, '', [...tools])
      await sleep(900)
      tools[1] = { ...tools[1], progress: 0.8 }
      activity(turn, '', [...tools])
      await sleep(700)
      tools[1] = { ...tools[1], state: 'done', duration_s: 1.6 }
      activity(turn, '', [...tools])
      const said = 'Tomorrow looks dry until about 15:00, so the morning is best for planting. Your garden notes say the herbs go nearest the back door.'
      await stream(turn, said)
      return finish(turn, said)
    }
    if (t.includes('media')) {
      activity(turn, 'Making the picture')
      await sleep(700)
      const said = 'Here is the render of the desk at dusk, a short audio summary, and the budget as a spreadsheet.'
      await stream(turn, said)
      return finish(turn, said, {
        media: [
          { id: 'img-1', kind: 'image', name: 'desk-at-dusk.png', mime: 'image/png', size: MEDIA['img-1'].body.length, url: '/media/img-1' },
          { id: 'voice-1', kind: 'audio', name: 'summary.wav', mime: 'audio/wav', size: MEDIA['voice-1'].body.length, url: '/media/voice-1' },
          { id: 'file-1', kind: 'file', name: 'november-budget.csv', mime: 'text/csv', size: MEDIA['file-1'].body.length, url: '/media/file-1', link: 'https://hermes.example.ts.net/api/files/download?path=%2Fhome%2Fhermes%2F.hermes%2Fcache%2Fdocuments%2Fnovember-budget.csv' },
        ],
      })
    }
    if (t.includes('links')) {
      const said = 'The official page has the dimensions and the cable options: [Touch Display 2](https://www.raspberrypi.com/products/touch-display-2/). There is also a mounting guide at https://example.org/missing-page if you want a stand.'
      await stream(turn, said)
      return finish(turn, said)
    }
    if (t.includes('long')) {
      activity(turn, 'Thinking')
      await sleep(400)
      await stream(turn, LONG, { chunk: 14, every: 30 })
      return finish(turn, LONG)
    }
    const said = `You said: "${text.trim()}". Try **slow**, **media**, **links**, **approve**, **ask**, **error** or **long** to see the other replies.`
    await stream(turn, said)
    return finish(turn, said)
  }

  // -- speech --

  function speak(messageId) {
    stopSpeaking('stopped')
    const id = nextId('sp')
    const pcm = speechPcm(24000)
    const step = 2400 // 100 ms
    let at = 0
    out({ type: 'speech.start', id, message_id: messageId, sample_rate: 24000 })
    const timer = setInterval(() => {
      if (at >= pcm.length) return stopSpeaking('done')
      const part = pcm.slice(at, at + step)
      at += step
      if (ws.readyState === ws.OPEN) ws.send(Buffer.from(part.buffer))
    }, 90)
    world.speaking = { id, timer }
    return id
  }

  function stopSpeaking(reason) {
    if (!world.speaking) return
    clearInterval(world.speaking.timer)
    out({ type: 'speech.end', id: world.speaking.id, reason })
    world.speaking = null
  }

  // -- operations --

  ws.on('message', async (raw, isBinary) => {
    if (isBinary) return
    let m
    try {
      m = JSON.parse(raw.toString())
    } catch {
      return
    }
    const ready = world.state === 'ready'
    switch (m.op) {
      case 'alive':
        return
      case 'status':
        return reply(m, { status: {} })
      case 'send': {
        if (!ready) return reply(m, {}, false, 'Not connected to Hermes yet.')
        if (world.turn) return reply(m, {}, false, 'Hermes is still answering. Stop it first, or wait.')
        const u = msg(nextId('u'), 'user', String(m.text || ''), now())
        add(u)
        reply(m, { id: u.id })
        return runTurn(u.text)
      }
      case 'stop': {
        const turn = world.turn
        if (!turn) return reply(m)
        turn.stopped = true
        world.turn = null
        if (world.prompt) {
          out({ type: 'prompt.close', id: world.prompt.id })
          world.prompt = null
        }
        if (turn.text) add(msg(nextId('a'), 'assistant', turn.text, now()))
        out({ type: 'turn.end', outcome: 'cancelled' })
        return reply(m)
      }
      case 'answer': {
        if (!world.prompt || world.prompt.id !== m.id) return reply(m, {}, false, 'That question has already been answered.')
        if (world.prompt.kind === 'approval' && !['once', 'deny'].includes(m.choice)) return reply(m, {}, false, 'Only "Allow once" or "Deny" can be chosen here.')
        const kind = world.prompt.kind
        const answer = m.choice ? (world.prompt.choices.find((c) => c.id === m.choice)?.label || m.choice) : m.text
        out({ type: 'prompt.close', id: world.prompt.id })
        world.prompt = null
        reply(m)
        world.turn?.answer?.(kind === 'approval' ? m.choice : answer)
        return
      }
      case 'chat.open': {
        const profile = m.profile || 'default'
        if (!m.session_id && profile === 'default') {
          world.view = { profile, session_id: 'main-default', kind: 'main', title: 'Main chat', messages: mainHistory(), has_more: true }
        } else if (!m.session_id) {
          world.view = { profile, session_id: `main-${profile}`, kind: 'main', title: 'Main chat', messages: [], has_more: false }
          world.profiles = world.profiles.map((p) => (p.name === profile ? { ...p, main: { id: `main-${profile}`, preview: '', last_active: now(), message_count: 0 } } : p))
          out({ type: 'profiles', profiles: world.profiles })
        } else {
          const row = (SESSIONS[profile] || []).find((s) => s.id === m.session_id)
          world.view = {
            profile, session_id: m.session_id, kind: 'session', title: row?.title || 'Conversation',
            messages: [msg(`${m.session_id}-1`, 'user', 'Picking this up again.', BASE - 7200), msg(`${m.session_id}-2`, 'assistant', row?.preview ? `${row.preview}.` : 'Here is where we were.', BASE - 7190)],
            has_more: false,
          }
        }
        world.page = 0
        out({ type: 'view', view: world.view })
        return reply(m, { view: world.view })
      }
      case 'chat.new': {
        const profile = m.profile || world.view.profile
        world.view = { profile, session_id: nextId('new-'), kind: 'session', title: '', messages: [], has_more: false }
        out({ type: 'view', view: world.view })
        reply(m, { view: world.view })
        // Hermes names a side chat after its first exchange; here, a moment after it opens.
        const sid = world.view.session_id
        await sleep(1500)
        if (world.view.session_id === sid) {
          world.view.title = 'New chat about the desk'
          out({ type: 'title', session_id: sid, title: world.view.title })
        }
        return
      }
      case 'chat.compact':
        out({ type: 'notice', text: 'Compacting this chat. Hermes keeps a summary of what came before.', level: 'info', ttl_s: 5 })
        await sleep(900)
        world.view = { ...world.view, messages: world.view.messages.slice(-2), has_more: true }
        out({ type: 'view', view: world.view })
        return reply(m)
      case 'history.more': {
        if (!world.view.has_more) return reply(m, { messages: [], has_more: false })
        await sleep(250)
        const page = olderPage(world.page++)
        world.view.messages = [...page, ...world.view.messages]
        world.view.has_more = world.page < 2
        return reply(m, { messages: page, has_more: world.view.has_more })
      }
      case 'sessions.list': {
        const rows = (SESSIONS[m.profile] || []).filter((s) => !m.query || `${s.title} ${s.preview}`.toLowerCase().includes(String(m.query).toLowerCase()))
        await sleep(120)
        return reply(m, { sessions: rows })
      }
      case 'link.preview': {
        await sleep(200)
        const url = String(m.url || '')
        if (url.includes('missing')) return reply(m, {}, false, 'Could not load a preview for that page.')
        if (url.includes('raspberrypi.com')) {
          return reply(m, {
            preview: {
              url, title: 'Raspberry Pi Touch Display 2', description: 'A 5-inch or 7-inch touchscreen for Raspberry Pi.', site: 'Raspberry Pi',
              favicon: `/proxy/image?url=${encodeURIComponent('https://www.raspberrypi.com/favicon.ico')}`,
              image: `/proxy/image?url=${encodeURIComponent('https://www.raspberrypi.com/app/uploads/display.png')}`,
            },
          })
        }
        const host = new URL(url).hostname
        return reply(m, { preview: { url, title: host, description: null, site: host, favicon: `/proxy/image?url=${encodeURIComponent(`https://${host}/favicon.ico`)}`, image: null } })
      }
      case 'speak': {
        const id = speak(m.message_id)
        return reply(m, { id })
      }
      case 'speak.stop':
        stopSpeaking('stopped')
        return reply(m)
      case 'settings.set':
        world.settings = { ...world.settings, ...(m.changes || {}) }
        out({ type: 'settings', settings: world.settings })
        return reply(m, { settings: world.settings })
      case 'setup': {
        await sleep(500)
        if (/bad|nothing/.test(String(m.url))) return reply(m, {}, false, `Nothing answered at ${m.url}. Check the address, and that Tailscale is connected.`)
        world.state = 'signin'
        reply(m)
        return hello()
      }
      case 'signin':
        await sleep(500)
        if (m.password === 'wrong') return reply(m, {}, false, 'That username or password is not right.')
        world.state = 'ready'
        reply(m)
        return hello()
      case 'signout':
        world.state = 'signin'
        reply(m)
        return hello()
      case 'retry':
        world.state = 'connecting'
        out({ type: 'link', state: 'connecting' })
        reply(m)
        await sleep(900)
        world.state = 'ready'
        return out({ type: 'link', state: 'ready' })
      default:
        return reply(m, {}, false, `Unknown operation: ${m.op}`)
    }
  })

  ws.on('close', () => stopSpeaking('stopped'))
})

server.listen(PORT, '127.0.0.1', () => console.log(`mock service on http://127.0.0.1:${PORT}/?t=dev`))
