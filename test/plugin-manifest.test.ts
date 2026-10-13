import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { parseManifest } from '../src/main/plugins/manifest'

const DIR = join('/tmp', 'plugins', 'unifi-adopt')

const VALID = JSON.stringify({
  name: 'unifi-adopt',
  version: '1.0.0',
  description: 'Adopt a UniFi device.',
  author: { name: 'magiceth' },
  main: 'index.js',
  magiceth: { api: 1, title: 'UniFi adoption' }
})

describe('parseManifest', () => {
  it('reads a complete manifest', () => {
    const m = parseManifest(VALID, DIR, 'built-in')
    expect(m).toBeDefined()
    expect(m?.id).toBe('unifi-adopt')
    expect(m?.title).toBe('UniFi adoption')
    expect(m?.description).toBe('Adopt a UniFi device.')
    expect(m?.author).toBe('magiceth')
    expect(m?.version).toBe('1.0.0')
    expect(m?.entry).toBe(join(DIR, 'index.js'))
    expect(m?.origin).toBe('built-in')
    expect(m?.problem).toBeUndefined()
  })

  it('defaults the title to the name and the entry to index.js', () => {
    const m = parseManifest(JSON.stringify({ name: 'mine', magiceth: { api: 1 } }), DIR, 'user')
    expect(m?.title).toBe('mine')
    expect(m?.entry).toBe(join(DIR, 'index.js'))
    expect(m?.version).toBe('0.0.0')
    expect(m?.problem).toBeUndefined()
  })

  // A stray npm package in the folder is not a plugin; it is skipped, not reported.
  it('is undefined for a package.json without a magiceth key', () => {
    expect(
      parseManifest(JSON.stringify({ name: 'lodash', version: '4' }), DIR, 'user')
    ).toBeUndefined()
    expect(parseManifest('not json', DIR, 'user')).toBeUndefined()
    expect(parseManifest('[]', DIR, 'user')).toBeUndefined()
    expect(parseManifest(JSON.stringify({ magiceth: { api: 1 } }), DIR, 'user')).toBeUndefined()
  })

  // A real plugin with a mistake is listed with the reason, so the mistake can be seen.
  it('reports a wrong or missing api version', () => {
    expect(
      parseManifest(JSON.stringify({ name: 'x', magiceth: { api: 2 } }), DIR, 'user')?.problem
    ).toMatch(/api 2.*provides 1/)
    expect(
      parseManifest(JSON.stringify({ name: 'x', magiceth: {} }), DIR, 'user')?.problem
    ).toMatch(/missing/)
  })

  // The id becomes a filename in userData, so it must never be a path or a scope.
  it('rejects names that could not be a filename', () => {
    for (const name of ['@scope/pkg', 'Has Caps', '../x', '']) {
      const m = parseManifest(JSON.stringify({ name, magiceth: { api: 1 } }), DIR, 'user')
      expect(m?.problem, name).toMatch(/must be lowercase/)
    }
  })

  it('keeps the entry inside the plugin folder', () => {
    const up = parseManifest(
      JSON.stringify({ name: 'x', main: '../evil.js', magiceth: { api: 1 } }),
      DIR,
      'user'
    )
    expect(up?.problem).toMatch(/inside the plugin folder/)
    const abs = parseManifest(
      JSON.stringify({ name: 'x', main: '/etc/passwd', magiceth: { api: 1 } }),
      DIR,
      'user'
    )
    expect(abs?.problem).toMatch(/inside the plugin folder/)
    const sub = parseManifest(
      JSON.stringify({ name: 'x', main: 'dist/main.js', magiceth: { api: 1 } }),
      DIR,
      'user'
    )
    expect(sub?.problem).toBeUndefined()
    expect(sub?.entry).toBe(join(DIR, 'dist', 'main.js'))
  })
})
