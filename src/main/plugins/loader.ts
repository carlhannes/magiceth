// Finds plugins, and runs at most one of them.
//
// Listing reads nothing but package.json files, every time it is asked, so a folder dropped into
// Documents shows up without a restart and no plugin code runs until someone picks it. Activation
// is a require() in this process; deactivation drops the plugin's modules from the require cache
// so the next pick starts from the file on disk — which is also what lets a user edit their
// plugin and try again without restarting the app.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { documentsDir } from '../util/app-paths'
import type {
  KeyPress,
  PluginActivation,
  PluginInstance,
  PluginManifest,
  PluginModule,
  PluginScreen
} from '../../shared/plugin'
import { createHost } from './host'
import type { HostHandle } from './host'
import { parseManifest } from './manifest'

const req = createRequire(__filename)

/** Built-in plugins are bundled next to the main entry; a packaged app reads them out of the asar. */
export function builtInPluginsDir(): string {
  return join(__dirname, 'plugins')
}

export function userPluginsDir(): string {
  return join(documentsDir(), 'plugins')
}

function scan(root: string, origin: PluginManifest['origin']): PluginManifest[] {
  let names: string[]
  try {
    names = readdirSync(root).sort()
  } catch {
    return []
  }
  const found: PluginManifest[] = []
  for (const name of names) {
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const file = join(dir, 'package.json')
    if (!existsSync(file)) continue
    let json: string
    try {
      json = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const manifest = parseManifest(json, dir, origin)
    if (manifest) found.push(manifest)
  }
  return found
}

/** Every plugin folder with a manifest, built-in first. Reads manifests only. */
export function listPlugins(): PluginManifest[] {
  const builtIn = scan(builtInPluginsDir(), 'built-in')
  const taken = new Set(builtIn.map((m) => m.id))
  const user = scan(userPluginsDir(), 'user').map((m) =>
    taken.has(m.id) && !m.problem
      ? { ...m, problem: `The name "${m.id}" belongs to a built-in plugin.` }
      : m
  )
  return [...builtIn, ...user]
}

interface Active {
  manifest: PluginManifest
  device: string
  instance: PluginInstance
  host: HostHandle
}

let active: Active | null = null
let pushScreen: (screen: PluginScreen) => void = () => {}

/** Where re-renders go. Set once by index.ts. */
export function onPluginScreen(cb: (screen: PluginScreen) => void): void {
  pushScreen = cb
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function screenOf(a: Active): PluginScreen {
  let view
  try {
    view = a.instance.render()
  } catch (err) {
    view = {
      blocks: [
        {
          kind: 'text' as const,
          text: `The plugin failed to render: ${describe(err)}`,
          tone: 'warn' as const
        }
      ],
      keys: []
    }
  }
  return {
    pluginId: a.manifest.id,
    title: a.manifest.title,
    device: a.device,
    running: Boolean(view.running) || a.host.running(),
    view
  }
}

function refresh(a: Active): void {
  if (active !== a) return
  pushScreen(screenOf(a))
}

/** Forget every module loaded from the plugin's folder, so the next activation reads the files again. */
function purge(dir: string): void {
  const prefix = dir + sep
  for (const key of Object.keys(req.cache)) {
    if (key.startsWith(prefix)) delete req.cache[key]
  }
}

/**
 * Sockets only: they are what a plugin can forget, and the only kind that stays still between two
 * readings — the hotplug poll spawns commands and timers continuously, so counting those would
 * report a leak on every deactivation.
 */
const SOCKET_KINDS = new Set(['UDPWrap', 'TCPServerWrap', 'TCPWrap', 'TCPSocketWrap'])

function resourceCounts(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const kind of process.getActiveResourcesInfo()) {
    if (SOCKET_KINDS.has(kind)) counts[kind] = (counts[kind] ?? 0) + 1
  }
  return counts
}

export async function activatePlugin(id: string, device: string): Promise<PluginActivation> {
  await deactivatePlugin()
  const manifest = listPlugins().find((m) => m.id === id)
  if (!manifest) return { ok: false, message: `There is no plugin called "${id}".` }
  if (manifest.problem) return { ok: false, message: manifest.problem }

  const before = resourceCounts()
  let mod: PluginModule
  try {
    mod = req(manifest.entry) as PluginModule
  } catch (err) {
    purge(manifest.dir)
    return { ok: false, message: `${manifest.title} could not be loaded: ${describe(err)}` }
  }
  if (typeof mod?.activate !== 'function') {
    purge(manifest.dir)
    return { ok: false, message: `${manifest.title} exports no activate() function.` }
  }

  // The host's update callback must reach the Active record, which does not exist until activate()
  // has returned — hence the indirection through `current`.
  let current: Active | null = null
  const host = createHost(manifest, device, () => {
    if (current) refresh(current)
  })
  try {
    const instance = await mod.activate(host.host)
    current = { manifest, device, instance, host }
    active = current
    activationBaseline = before
    return { ok: true, screen: screenOf(current) }
  } catch (err) {
    host.dispose()
    purge(manifest.dir)
    return { ok: false, message: `${manifest.title} failed to start: ${describe(err)}` }
  }
}

let activationBaseline: Record<string, number> = {}

/**
 * Stop the active plugin, if any. The host's own resources go synchronously — the stop file is
 * written and the DHCP socket closed before the first await — so calling this from before-quit
 * without awaiting still leaves nothing behind that matters.
 */
export async function deactivatePlugin(): Promise<void> {
  const a = active
  if (!a) return
  active = null
  a.host.dispose()
  try {
    await a.instance.deactivate()
  } catch (err) {
    console.error(`${a.manifest.id}: deactivate() failed:`, err)
  }
  purge(a.manifest.dir)
  // A hint, not a guarantee: a socket or timer the plugin forgot shows up as a count that did not
  // come back down. Logged for whoever is writing the plugin.
  const after = resourceCounts()
  const leaked = Object.entries(after)
    .filter(([kind, n]) => n > (activationBaseline[kind] ?? 0))
    .map(([kind, n]) => `${kind} ${activationBaseline[kind] ?? 0}→${n}`)
  if (leaked.length > 0)
    console.warn(`${a.manifest.id}: still open after deactivate: ${leaked.join(', ')}`)
}

export async function pluginKey(key: KeyPress): Promise<void> {
  const a = active
  if (!a) return
  try {
    await a.instance.onKey(key)
  } catch (err) {
    a.host.host.log(`Error: ${describe(err)}`)
  }
  refresh(a)
}

export async function pluginSubmit(formId: string, values: Record<string, string>): Promise<void> {
  const a = active
  if (!a) return
  try {
    await a.instance.onSubmit?.(formId, values)
  } catch (err) {
    a.host.host.log(`Error: ${describe(err)}`)
  }
  refresh(a)
}
