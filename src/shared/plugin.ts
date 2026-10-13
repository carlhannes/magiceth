// The plugin contract: what a Configure-mode plugin is given, and what it must provide.
//
// Types only. A plugin runs in the main process as plain Node — sockets, commands and files all
// live there — and never in the renderer, which only ever draws the view a plugin describes. That
// is what keeps the CSP and context isolation exactly as they are, and what keeps every screen in
// the one shell with the one key legend. Lives in shared/ so a plugin author writing TypeScript
// can import the types, and so the renderer can type the view without reaching into main/.

import type { NetInfo } from './types'

/** Bump when PluginHost, PluginInstance or the view blocks change shape incompatibly. */
export const PLUGIN_API = 1

/**
 * What the app reads from a plugin folder's package.json — the only thing it reads until the
 * plugin is picked. `problem` is set when the folder cannot be activated (wrong api, bad entry);
 * it is listed greyed rather than hidden, so a mistake in a manifest is visible.
 */
export interface PluginManifest {
  id: string
  title: string
  description: string
  author?: string
  version: string
  /** Absolute path of the folder. */
  dir: string
  /** Absolute path of the entry script, always inside `dir`. */
  entry: string
  origin: 'built-in' | 'user'
  api: number
  problem?: string
}

export interface KeyPress {
  key: string
  shift: boolean
  alt: boolean
  ctrl: boolean
  meta: boolean
}

export interface FormField {
  key: string
  label: string
  value?: string
  hint?: string
}

/**
 * The vocabulary a plugin draws with. Each kind has exactly one renderer, so every plugin looks
 * like the rest of the app. `html` is the escape hatch for a plugin that needs more: the CSP is
 * `script-src 'self'`, so it can style but never run anything.
 */
export type Block =
  | { kind: 'text'; text: string; tone?: 'muted' | 'warn' }
  | { kind: 'table'; title?: string; rows: [string, string][] }
  | { kind: 'list'; title?: string; rows: string[]; selected?: number; empty?: string }
  | { kind: 'log'; title?: string; lines: string[] }
  | { kind: 'form'; id: string; title: string; fields: FormField[]; error?: string }
  | { kind: 'html'; html: string }

export interface KeyHint {
  key: string
  label: string
}

export interface PluginView {
  /** One line pinned under the topbar, next to the port. */
  status?: string
  /** Spinner in the topbar. */
  busy?: boolean
  /** Something is running that leaving would stop; the shell asks for a second press first. */
  running?: boolean
  blocks: Block[]
  /** The key legend at the bottom. Esc is added by the shell. */
  keys: KeyHint[]
}

/** The screen the main process pushes to the renderer whenever the active plugin re-renders. */
export interface PluginScreen {
  pluginId: string
  title: string
  device: string
  running: boolean
  view: PluginView
}

export type PluginActivation = { ok: true; screen: PluginScreen } | { ok: false; message: string }

// --- What the host hands a plugin -----------------------------------------------------------

export interface HostRunResult {
  code: number
  stdout: string
  stderr: string
}

export interface DhcpLink {
  serverIp: string
  cidr: number
  /** The subnet-directed broadcast, which is where every DHCP reply goes. */
  broadcast: string
}

export type DhcpEvent =
  | { kind: 'address'; serverIp: string; cidr: number }
  | { kind: 'discover'; mac: string; vendorClass?: string; hostname?: string }
  | { kind: 'offer'; mac: string; ip: string }
  | { kind: 'ack'; mac: string; ip: string }
  | { kind: 'release'; mac: string; ip: string }
  | { kind: 'ignored'; mac: string; reason: string }
  | { kind: 'error'; message: string }
  | { kind: 'stopped'; reason: string }

export interface DhcpSpec {
  /** The options every lease carries, beyond the standard ones; built once the link is known. */
  options(link: DhcpLink): { code: number; hex: string }[]
  /** Only clients whose vendor class (option 60) starts with this are answered. */
  vendorClassPrefix?: string
  /** Default 120 s — short, so a device forgets this link quickly once it is moved. */
  leaseSeconds?: number
  onEvent(event: DhcpEvent): void
}

export interface DhcpSession extends DhcpLink {
  stop(): void
}

export interface PluginHost {
  /** The port the plugin was activated on. Fixed for the session. */
  device: string
  readNetInfo(): Promise<NetInfo>
  /** Append a timestamped line to the plugin's log and re-render. */
  log(text: string): void
  /** The log so far, oldest first, for a log block. */
  lines(): string[]
  /** Re-render: call after any state change the screen should show. */
  update(): void
  /** One JSON file per plugin, in the app's data folder. */
  storage: {
    load<T>(fallback: T): T
    save(value: unknown): void
  }
  /** Run a command without a shell: a file and an argument array, never a command line. */
  run(file: string, args: string[], opts?: { timeoutMs?: number }): Promise<HostRunResult>
  /**
   * A DHCP server on the port, answering only what the spec allows. The host puts an address on
   * the port (one admin prompt), binds port 67 and takes both away again when stopped. Rejects
   * with a human-readable message when it cannot start; events follow through the spec.
   */
  dhcp: {
    start(spec: DhcpSpec): Promise<DhcpSession>
  }
}

export interface PluginInstance {
  render(): PluginView
  onKey(key: KeyPress): void | Promise<void>
  /** A form block was submitted. Validate, then either re-render with `error` or move on. */
  onSubmit?(formId: string, values: Record<string, string>): void | Promise<void>
  /** Close every socket and timer. The host stops any DHCP session it started for the plugin. */
  deactivate(): void | Promise<void>
}

export interface PluginModule {
  activate(host: PluginHost): PluginInstance | Promise<PluginInstance>
}
