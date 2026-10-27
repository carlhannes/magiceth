// Pure: a plugin folder's package.json → PluginManifest. Tested in test/plugin-manifest.test.ts.
//
// This is everything the app knows about a plugin until it is picked, so it is deliberately
// strict about the two things that matter for safety — the id becomes a filename, the entry
// becomes a require() — and lenient about everything else.

import { isAbsolute, join, normalize, sep } from 'node:path'
import { PLUGIN_API } from '../../shared/plugin'
import type { PluginManifest } from '../../shared/plugin'

/** The id doubles as the storage filename and must never be a path. */
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

function authorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'object' && value !== null) {
    const name = (value as { name?: unknown }).name
    if (typeof name === 'string') return name.trim() || undefined
  }
  return undefined
}

/**
 * Returns undefined for a folder that is not a magiceth plugin at all (no `magiceth` key, no
 * name), and a manifest with `problem` set for one that is but cannot be activated. The
 * distinction matters in the chooser: a stray npm package in the folder is skipped, a plugin with
 * a wrong api version is shown with the reason.
 */
export function parseManifest(
  json: string,
  dir: string,
  origin: PluginManifest['origin']
): PluginManifest | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const pkg = parsed as Record<string, unknown>
  if (typeof pkg.name !== 'string') return undefined
  const meta = pkg.magiceth
  if (typeof meta !== 'object' || meta === null) return undefined
  const m = meta as Record<string, unknown>

  const id = pkg.name.trim()
  const title = typeof m.title === 'string' && m.title.trim() ? m.title.trim() : id
  const main = typeof pkg.main === 'string' && pkg.main.trim() ? pkg.main.trim() : 'index.js'
  const entry = isAbsolute(main) ? main : normalize(join(dir, main))
  const api = typeof m.api === 'number' ? m.api : NaN

  const manifest: PluginManifest = {
    id,
    title,
    description: typeof pkg.description === 'string' ? pkg.description.trim() : '',
    author: authorText(pkg.author),
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    dir,
    entry,
    origin,
    api
  }

  if (!ID.test(id)) {
    manifest.problem = `The name "${id}" must be lowercase letters, digits, dots, dashes or underscores.`
  } else if (api !== PLUGIN_API) {
    manifest.problem = `Needs plugin api ${Number.isNaN(api) ? '(missing)' : api}; this app provides ${PLUGIN_API}.`
  } else if (!entry.startsWith(dir + sep)) {
    manifest.problem = `The entry "${main}" must be inside the plugin folder.`
  }
  return manifest
}
