import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_API } from '../src/shared/plugin'

// docs/PLUGINS.md is the plugin API's reference and embeds src/shared/plugin.ts verbatim. The two
// are kept identical here, so the page cannot drift from the contract it documents, and the api
// number in its manifest example is the one the app checks for.

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const doc = readFileSync(join(root, 'docs/PLUGINS.md'), 'utf8')
const source = readFileSync(join(root, 'src/shared/plugin.ts'), 'utf8')

function embedded(): string {
  const start = doc.indexOf('<!-- plugin.ts -->')
  const end = doc.indexOf('<!-- /plugin.ts -->')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const lines = doc.slice(start, end).split('\n')
  const open = lines.findIndex((l) => l.startsWith('```'))
  const close = lines.length - 1 - [...lines].reverse().findIndex((l) => l.startsWith('```'))
  return lines.slice(open + 1, close).join('\n')
}

describe('docs/PLUGINS.md', () => {
  it('embeds src/shared/plugin.ts verbatim', () => {
    expect(embedded().trim()).toBe(source.trim())
  })

  it('shows the api number the app checks for', () => {
    expect(doc).toContain(`"api": ${PLUGIN_API}`)
    expect(doc).toContain(`# Plugin API ${PLUGIN_API}`)
  })
})
