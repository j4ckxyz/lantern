// House style: no em dashes anywhere in the UI, its copy, its tests or its docs.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const EM_DASH = String.fromCharCode(0x2014)
const SKIP = new Set(['node_modules', 'dist', 'test-results', 'playwright-report'])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name) || name.endsWith('-snapshots')) return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.(tsx?|mjs|js|css|html|md|json)$/.test(name) && name !== 'package-lock.json' ? [path] : []
  })
}

describe('copy', () => {
  it('has no em dashes', () => {
    const offenders = files(ROOT).filter((f) => readFileSync(f, 'utf8').includes(EM_DASH))
    expect(offenders).toEqual([])
  })
})
