// Markdown for replies: markdown-it with raw HTML off, then DOMPurify. Links never navigate (they
// carry data-href and open the QR sheet), and pictures only ever load through the service's proxy.
import MarkdownIt from 'markdown-it'

type MD = InstanceType<typeof MarkdownIt>
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const LANGS: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash, c, cpp, css, diff, go, ini, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml,
}
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang)
const ALIASES: Record<string, string> = {
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', js: 'javascript', jsx: 'javascript', ts: 'typescript',
  tsx: 'typescript', py: 'python', rs: 'rust', html: 'xml', svg: 'xml', yml: 'yaml', toml: 'ini', md: 'markdown',
  'c++': 'cpp', h: 'c', golang: 'go',
}

const LABELS: Record<string, string> = {
  bash: 'Shell', c: 'C', cpp: 'C++', css: 'CSS', diff: 'Diff', go: 'Go', ini: 'Config', java: 'Java',
  javascript: 'JavaScript', json: 'JSON', markdown: 'Markdown', python: 'Python', rust: 'Rust', sql: 'SQL',
  typescript: 'TypeScript', xml: 'HTML', yaml: 'YAML',
}

export function languageOf(info: string): string | null {
  const word = (info || '').trim().split(/\s+/)[0].toLowerCase()
  if (!word) return null
  const name = ALIASES[word] || word
  return hljs.getLanguage(name) ? name : null
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Only http(s) and mailto links are ever offered (on the QR sheet). */
export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null
  const trimmed = href.trim()
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null
}

export function proxied(src: string): string | null {
  return /^https?:\/\//i.test(src.trim()) ? `/proxy/image?url=${encodeURIComponent(src.trim())}` : null
}

function makeRenderer(highlight: boolean): MD {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false })
  md.validateLink = () => true // judged below, when the link becomes a data-href

  md.renderer.rules.fence = (tokens, idx, _opts, env) => {
    const token = tokens[idx]
    const lang = languageOf(token.info)
    const isOpen = (env as { provisional?: number } | undefined)?.provisional === idx
    const body =
      highlight && lang && !isOpen ? hljs.highlight(token.content, { language: lang, ignoreIllegals: true }).value : escapeHtml(token.content)
    const label = lang ? LABELS[lang] : (token.info || '').trim().split(/\s+/)[0]
    const head = label ? `<div class="code-head">${escapeHtml(label)}</div>` : ''
    return `<div class="code${isOpen ? ' provisional' : ''}">${head}<pre><code class="hljs">${body}</code></pre></div>`
  }
  md.renderer.rules.code_block = (tokens, idx) =>
    `<div class="code"><pre><code class="hljs">${escapeHtml(tokens[idx].content)}</code></pre></div>`

  md.renderer.rules.link_open = (tokens, idx) => {
    const href = safeHref(String(tokens[idx].attrGet('href') ?? ''))
    return href ? `<a class="link" data-href="${escapeHtml(href)}" role="button" tabindex="0">` : '<span class="link-dead">'
  }
  md.renderer.rules.link_close = (tokens, idx) => {
    // Find the matching opener to know which tag to close.
    let depth = 0
    for (let i = idx - 1; i >= 0; i--) {
      if (tokens[i].type === 'link_close') depth++
      if (tokens[i].type === 'link_open') {
        if (depth === 0) return safeHref(String(tokens[i].attrGet('href') ?? '')) ? '</a>' : '</span>'
        depth--
      }
    }
    return '</a>'
  }

  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx]
    const alt = escapeHtml(token.content || '')
    const src = proxied(String(token.attrGet('src') ?? ''))
    if (!src) return alt ? `<span class="img-missing">${alt}</span>` : ''
    return `<img class="md-img" src="${escapeHtml(src)}" alt="${alt}" loading="lazy" decoding="async">`
  }

  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>'
  md.renderer.rules.table_close = () => '</table></div>'
  return md
}

const full = makeRenderer(true)

let purifier: ReturnType<typeof DOMPurify> | null = null
function purify(): ReturnType<typeof DOMPurify> {
  if (purifier) return purifier
  purifier = DOMPurify(window)
  purifier.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element
    if (el.tagName === 'A') {
      el.removeAttribute('href')
      el.removeAttribute('target')
      const href = safeHref(el.getAttribute('data-href'))
      if (href) el.setAttribute('data-href', href)
      else el.removeAttribute('data-href')
    }
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') || ''
      if (!src.startsWith('/proxy/image?url=')) el.remove()
    }
  })
  return purifier
}

const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'strong', 'em', 's', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'a', 'span', 'div', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub',
]
const ALLOWED_ATTR = ['class', 'data-href', 'role', 'tabindex', 'src', 'alt', 'loading', 'decoding', 'start', 'align']

/** Whether the text ends inside a fenced code block that has not closed yet. */
export function openFenceIndex(md: MD, text: string): number | null {
  const fences = text.match(/^ {0,3}(`{3,}|~{3,})/gm)
  if (!fences || fences.length % 2 === 0) return null
  const tokens = md.parse(text, {})
  for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i].type === 'fence') return i
  return null
}

/**
 * Markdown to safe HTML. `streaming` marks a reply still being written: an unclosed code fence
 * is drawn as provisional and left unhighlighted until it closes.
 */
export function renderMarkdown(text: string, streaming = false): string {
  const env: { provisional?: number } = {}
  if (streaming) {
    const open = openFenceIndex(full, text)
    if (open !== null) env.provisional = open
  }
  const html = full.render(text, env)
  return purify().sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    // Not URLs, so not URI-checked; data-href is checked by the hook above, img src likewise.
    ADD_URI_SAFE_ATTR: ['data-href', 'tabindex', 'loading', 'decoding', 'start', 'align'],
  }) as string
}

/** The web links in a reply, in order, without duplicates or pictures. At most `limit`. */
export function extractLinks(text: string, limit = 3): string[] {
  const out: string[] = []
  const walk = (tokens: ReturnType<MD['parse']>) => {
    for (const t of tokens) {
      if (t.type === 'link_open') {
        const href = String(t.attrGet('href') ?? '')
        if (/^https?:\/\//i.test(href) && !out.includes(href)) out.push(href)
      }
      if (t.children) walk(t.children)
    }
  }
  walk(full.parse(text || '', {}))
  return out.slice(0, limit)
}

/** Plain text for previews and speech: no Markdown syntax. */
export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
