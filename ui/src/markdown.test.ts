import { describe, expect, it } from 'vitest'
import { extractLinks, plainText, renderMarkdown, safeHref } from './markdown'

const dom = (html: string) => {
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}

describe('renderMarkdown', () => {
  it('renders headings, lists, tables and code', () => {
    const html = renderMarkdown('## Plan\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```python\nprint("hi")\n```')
    const d = dom(html)
    expect(d.querySelector('h2')?.textContent).toBe('Plan')
    expect(d.querySelectorAll('li')).toHaveLength(2)
    expect(d.querySelector('.table-wrap table')).not.toBeNull()
    expect(d.querySelector('.code .code-head')?.textContent).toBe('Python')
    expect(d.querySelector('.code code span')).not.toBeNull() // highlighted
  })

  it('never renders raw HTML', () => {
    const d = dom(renderMarkdown('<script>alert(1)</script><b>bold</b>'))
    expect(d.querySelector('script')).toBeNull()
    expect(d.querySelector('b')).toBeNull()
    expect(d.textContent).toContain('<script>')
  })

  it('turns links into data-href with no navigation', () => {
    const d = dom(renderMarkdown('[Pi](https://www.raspberrypi.com/) and https://example.org'))
    const links = d.querySelectorAll('a')
    expect(links).toHaveLength(2)
    for (const a of links) {
      expect(a.getAttribute('href')).toBeNull()
      expect(a.getAttribute('data-href')).toMatch(/^https:/)
    }
  })

  it('drops javascript: and data: links', () => {
    for (const bad of ['[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](data:text/html,hi)', '[x](vbscript:msgbox)']) {
      const d = dom(renderMarkdown(bad))
      expect(d.querySelector('a')).toBeNull()
      expect(d.innerHTML).not.toMatch(/javascript|vbscript|data:/i)
    }
  })

  it('loads pictures only through the proxy', () => {
    const d = dom(renderMarkdown('![cat](https://example.org/cat.png) ![local](/etc/passwd) ![d](data:image/png;base64,AAAA)'))
    const imgs = d.querySelectorAll('img')
    expect(imgs).toHaveLength(1)
    expect(imgs[0].getAttribute('src')).toBe('/proxy/image?url=' + encodeURIComponent('https://example.org/cat.png'))
  })

  it('strips event handlers and SVG even if they got through', () => {
    const payloads = [
      '<img src=x onerror=alert(1)>',
      '<svg onload=alert(1)><circle/></svg>',
      '![x](https://e.org/a.png" onerror="alert(1))',
      '<a href="javascript:alert(1)">x</a>',
      '<iframe src="https://evil.example"></iframe>',
    ]
    for (const p of payloads) {
      const d = dom(renderMarkdown(p))
      expect(d.querySelector('svg, iframe, script, [href]')).toBeNull()
      for (const el of d.querySelectorAll('*')) {
        for (const attr of el.getAttributeNames()) expect(attr.startsWith('on')).toBe(false)
      }
    }
  })

  it('marks an unclosed fence as provisional while streaming, and does not highlight it', () => {
    const d = dom(renderMarkdown('Here:\n\n```python\nfor i in range(3):', true))
    const code = d.querySelector('.code')
    expect(code?.classList.contains('provisional')).toBe(true)
    expect(code?.querySelector('code span')).toBeNull()
    const closed = dom(renderMarkdown('```python\nx = 1\n```', true))
    expect(closed.querySelector('.code')?.classList.contains('provisional')).toBe(false)
  })
})

describe('links', () => {
  it('extracts web links in order, without duplicates or pictures', () => {
    const text = 'See [a](https://a.example/x) and https://b.example and [a again](https://a.example/x) ![p](https://img.example/p.png) [mail](mailto:x@y.z)'
    expect(extractLinks(text)).toEqual(['https://a.example/x', 'https://b.example'])
  })
  it('caps the count', () => {
    expect(extractLinks('https://1.example https://2.example https://3.example https://4.example')).toHaveLength(3)
  })
  it('ignores links inside code', () => {
    expect(extractLinks('`https://code.example` and\n\n```\nhttps://fence.example\n```')).toEqual([])
  })
  it('only offers safe hrefs', () => {
    expect(safeHref('https://x.example')).toBe('https://x.example')
    expect(safeHref(' javascript:alert(1)')).toBeNull()
    expect(safeHref('/relative')).toBeNull()
  })
  it('makes plain text for previews', () => {
    expect(plainText('## Hi **there** [link](https://x.example)\n```\ncode\n```')).toBe('Hi there link')
  })
})
