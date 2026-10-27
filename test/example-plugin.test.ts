import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseManifest } from '../src/main/plugins/manifest'
import { renderBlocks } from '../src/renderer/src/plugin-view'
import type { PluginHost, PluginInstance, PluginModule, PluginView } from '../src/shared/plugin'

// The example plugin is what the docs tell people to copy, so it is held to the contract here the
// same way the loader holds a user plugin: loaded with require(), handed a host, driven by keys.
// Every view it produces is also pushed through the renderer, so a block it emits that the app
// could not draw would fail here rather than on someone's screen.

const dir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'examples', 'plugins', 'hello')
const load = createRequire(import.meta.url)

function fakeHost(): { host: PluginHost; lines: string[]; stored: () => unknown } {
  const lines: string[] = []
  let stored: unknown
  const host: PluginHost = {
    device: 'en9',
    readNetInfo: () => Promise.reject(new Error('not in tests')),
    log: (text) => {
      lines.push(text)
    },
    lines: () => [...lines],
    clearLog: () => {
      lines.length = 0
    },
    update: () => undefined,
    storage: {
      load: <T>(fallback: T): T => (stored === undefined ? fallback : (stored as T)),
      save: (value) => {
        stored = JSON.parse(JSON.stringify(value))
      }
    },
    run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'not in tests' }),
    dhcp: { start: () => Promise.reject(new Error('not in tests')) }
  }
  return { host, lines, stored: () => stored }
}

const key = (k: string) => ({ key: k, shift: false, alt: false, ctrl: false, meta: false })

async function start(host: PluginHost): Promise<PluginInstance> {
  const mod = load(join(dir, 'index.js')) as PluginModule
  return mod.activate(host)
}

/** Render, and prove the renderer can draw every block of it. */
function view(instance: PluginInstance): PluginView & { html: string } {
  const v = instance.render()
  return { ...v, html: renderBlocks(v.blocks) }
}

describe('examples/plugins/hello', () => {
  it('has a manifest the app accepts, with an author to show', () => {
    const m = parseManifest(readFileSync(join(dir, 'package.json'), 'utf8'), dir, 'user')
    expect(m?.problem).toBeUndefined()
    expect(m?.id).toBe('hello')
    expect(m?.title).toBe('Hello plugin')
    expect(m?.author).toBe('magiceth')
    expect(m?.entry).toBe(join(dir, 'index.js'))
  })

  it('renders a status, the four block kinds, and a key legend', async () => {
    const { host, lines } = fakeHost()
    const v = view(await start(host))
    expect(v.status).toBe('saying hello')
    expect(v.blocks.map((b) => b.kind)).toEqual(['text', 'table', 'list', 'log'])
    expect(v.html).toContain('Hello from a user plugin.')
    expect(v.html).toContain('Presses')
    expect(v.html).toContain(
      '<li class="profile sel"><span class="pi">1</span><span class="pn">apple'
    )
    expect(v.html).toContain('hello activated on en9')
    expect(v.keys.length).toBeGreaterThan(0)
    expect(lines[0]).toBe('hello activated on en9')
  })

  it('moves its own list selection and counts other keys', async () => {
    const { host, lines } = fakeHost()
    const instance = await start(host)
    await instance.onKey(key('ArrowDown'))
    expect(view(instance).html).toContain(
      '<li class="profile sel"><span class="pi">2</span><span class="pn">banana'
    )
    await instance.onKey(key('x'))
    await instance.onKey(key('y'))
    expect(view(instance).html).toContain('<span class="val">2</span>')
    expect(lines).toContain('key x')
    expect(lines).toContain('key y')
  })

  it('opens a form on N, refuses an empty name, saves a real one, and drops the form on Escape', async () => {
    const { host, lines, stored } = fakeHost()
    const instance = await start(host)
    await instance.onKey(key('n'))
    let form = view(instance).blocks.find((b) => b.kind === 'form')
    expect(form).toMatchObject({ id: 'name', title: 'Your name' })

    await instance.onSubmit?.('name', { name: '  ' })
    form = view(instance).blocks.find((b) => b.kind === 'form')
    expect(form).toMatchObject({ id: 'name', error: 'A name, please.' })

    await instance.onSubmit?.('name', { name: 'Ada' })
    expect(view(instance).blocks.some((b) => b.kind === 'form')).toBe(false)
    expect(stored()).toMatchObject({ name: 'Ada' })
    expect(lines).toContain('named Ada')
    expect(view(instance).html).toContain('<span class="val">Ada</span>')

    await instance.onKey(key('n'))
    expect(view(instance).blocks.some((b) => b.kind === 'form')).toBe(true)
    await instance.onKey(key('Escape'))
    expect(view(instance).blocks.some((b) => b.kind === 'form')).toBe(false)
  })

  it('remembers how often it was opened through storage, and says goodbye', async () => {
    const { host, lines } = fakeHost()
    const first = await start(host)
    expect(view(first).html).toContain('<span class="val">1 time</span>')
    await first.deactivate()
    expect(lines).toContain('bye')
    const second = await start(host)
    expect(view(second).html).toContain('<span class="val">2 times</span>')
  })
})
