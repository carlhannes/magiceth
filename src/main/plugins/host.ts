// What a plugin is handed on activation. Thin on purpose: the heavy pieces — the DHCP session,
// the storage file, command running — live in their own modules and are only wired up here, so
// a plugin author reads one interface and the app keeps one place that decides what plugins may do.

import { getPlatform } from '../platform'
import { run } from '../util/run-command'
import type { DhcpSession, DhcpSpec, PluginHost, PluginManifest } from '../../shared/plugin'
import { dhcpSessionRunning, startDhcpSession, stopDhcpSession } from './dhcp/session'
import { pluginStorage } from './storage'

/** Enough for a whole session at a glance; older lines scroll off the top. */
const MAX_LINES = 300

export interface HostHandle {
  host: PluginHost
  /** True while a DHCP session the host started for this plugin is alive. */
  running(): boolean
  /** Stop anything the host started on the plugin's behalf. Synchronous. */
  dispose(): void
}

function stamp(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function createHost(
  manifest: PluginManifest,
  device: string,
  onUpdate: () => void
): HostHandle {
  let startedAt = Date.now()
  const lines: string[] = []
  let session: DhcpSession | null = null

  const host: PluginHost = {
    device,
    readNetInfo: () => getPlatform().readNetInfo(device),
    log(text) {
      lines.push(`${stamp(Math.round((Date.now() - startedAt) / 1000))} ${text}`)
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
      onUpdate()
    },
    lines: () => [...lines],
    clearLog() {
      lines.length = 0
      startedAt = Date.now()
    },
    update: onUpdate,
    storage: pluginStorage(manifest.id),
    run: (file, args, opts) => run(file, args, opts),
    dhcp: {
      async start(spec: DhcpSpec): Promise<DhcpSession> {
        const wrapped: DhcpSpec = {
          ...spec,
          onEvent: (event) => {
            if (event.kind === 'stopped') session = null
            spec.onEvent(event)
          }
        }
        session = await startDhcpSession(device, wrapped)
        return session
      }
    }
  }

  return {
    host,
    running: () => session !== null && dhcpSessionRunning(),
    dispose() {
      if (session) {
        session = null
        stopDhcpSession('the plugin was closed')
      }
    }
  }
}
