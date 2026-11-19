// The shapes in docs/local-api.md, one to one.

export type LinkState = 'setup' | 'signin' | 'connecting' | 'offline' | 'ready'

export interface MainChat {
  id: string
  preview: string
  last_active: number
  message_count: number
}

export interface Profile {
  name: string
  display_name: string
  is_default: boolean
  avatar: string | null
  main: MainChat | null
}

export interface Media {
  id: string
  kind: 'image' | 'audio' | 'file'
  name: string
  mime: string
  size?: number
  url: string
  /** A phone-reachable address for the same file (the Hermes dashboard's download link), for the QR code. */
  link?: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  ts: number
  media: Media[]
  interim?: boolean
  voice?: boolean
  error?: string
}

export interface View {
  profile: string
  session_id: string
  kind: 'main' | 'session'
  title: string
  messages: Message[]
  has_more: boolean
}

export interface Tool {
  id: string
  name: string
  label: string
  state: 'running' | 'done' | 'failed'
  progress?: number
  duration_s?: number
}

export interface Turn {
  id: string
  started: number
  text: string
  status: string
  tools: Tool[]
}

export interface Choice {
  id: string
  label: string
}

export interface Prompt {
  id: string
  kind: 'approval' | 'clarify'
  title: string
  text: string
  command?: string
  choices: Choice[]
  free_text: boolean
}

export interface Session {
  id: string
  title: string
  preview: string
  source: string
  last_active: number
  message_count: number
  is_main: boolean
}

export interface LinkPreview {
  url: string
  title: string | null
  description: string | null
  site: string | null
  favicon: string | null
  image: string | null
}

export interface Settings {
  text_size: 'compact' | 'comfortable' | 'large'
  theme: 'dark' | 'light' | 'auto'
  sounds: boolean
  sound_volume: number
  speech_volume: number
  read_aloud: boolean
  brightness: number
  dim_after_s: number
  off_after_s: number
  quiet_start: string
  quiet_end: string
  touch_keyboard: 'auto' | 'always'
  default_profile: string
}

export const DEFAULT_SETTINGS: Settings = {
  text_size: 'comfortable',
  theme: 'dark',
  sounds: false,
  sound_volume: 0.4,
  speech_volume: 0.8,
  read_aloud: false,
  brightness: 0.8,
  dim_after_s: 120,
  off_after_s: 600,
  quiet_start: '23:00',
  quiet_end: '07:00',
  touch_keyboard: 'auto',
  default_profile: 'default',
}

export interface Hello {
  type: 'hello'
  version: number
  state: LinkState
  error: string
  detail: string
  server: { url: string; version: string } | null
  device: { name: string } | null
  account: { username: string; remembered: boolean } | null
  profiles: Profile[]
  view: View | null
  turn: Turn | null
  prompt: Prompt | null
  settings: Partial<Settings>
  dev: boolean
}

export type ServerEvent =
  | Hello
  | { type: 'link'; state: LinkState; error?: string; detail?: string; retry_in?: number }
  | { type: 'profiles'; profiles: Profile[] }
  | { type: 'view'; view: View }
  | { type: 'title'; session_id: string; title: string }
  | { type: 'message'; message: Message }
  | { type: 'turn.start'; turn: Turn }
  | { type: 'turn.delta'; text: string }
  | { type: 'turn.activity'; status: string; tools: Tool[] }
  | { type: 'turn.end'; outcome: 'success' | 'failure' | 'cancelled'; error?: string }
  | { type: 'prompt'; prompt: Prompt }
  | { type: 'prompt.close'; id: string }
  | { type: 'attention'; profile: string; session_id: string; preview: string }
  | { type: 'notice'; text: string; level: 'info' | 'warning' | 'error'; ttl_s: number }
  | { type: 'settings'; settings: Partial<Settings> }
  | { type: 'speech.start'; id: string; message_id: string; sample_rate: number }
  | { type: 'speech.end'; id: string; reason: 'done' | 'stopped' | 'error'; error?: string }
  | { type: 'result'; req: string | null; ok: boolean; error?: string; [key: string]: unknown }
