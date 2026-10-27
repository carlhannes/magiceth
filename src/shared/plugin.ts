// The plugin contract: what a Configure-mode plugin is given, and what it must provide.
//
// Types only, plus the API version number. A plugin runs in the main process as plain Node —
// sockets, commands and files all live there — and never in the renderer, which only ever draws
// the view a plugin describes. That is what keeps the CSP and context isolation exactly as they
// are, and what keeps every screen in the one shell with the one key legend. Lives in shared/ so a
// plugin author writing TypeScript can import the types, and so the renderer can type the view
// without reaching into main/.
//
// This is plugin API version 1, and it is locked: it changes by addition only — a new optional
// member, a new optional field — so a plugin written against it keeps working. docs/PLUGINS.md
// embeds this file verbatim and explains it in prose; a test keeps the two identical.

import type { NetInfo } from './types'

/**
 * The version a manifest's `magiceth.api` must equal exactly. Grows by optional additions only,
 * which a plugin feature-detects (`typeof host.something === 'function'`); a bump is the last
 * resort for a change that cannot be made additive, and then plugins written for the old version
 * are listed greyed with the reason rather than loaded.
 */
export const PLUGIN_API = 1

/**
 * What the app reads from a plugin folder's package.json — the only thing it reads until the
 * plugin is picked. A folder without a `name` or a `magiceth` key is not a plugin and is skipped;
 * one that is a plugin but cannot run gets `problem` and is listed greyed with the reason, so a
 * mistake in a manifest is visible rather than silent.
 */
export interface PluginManifest {
  /**
   * package.json `name`, trimmed. Must match `^[a-z0-9][a-z0-9._-]{0,63}$` — it doubles as the
   * storage file's name. The ids of the plugins shipped with the app are reserved.
   */
  id: string
  /** `magiceth.title`, or the id when there is none. */
  title: string
  /** package.json `description`, or empty. */
  description: string
  /** package.json `author`: a string, or the `name` of an object. Shown on the chooser row. */
  author?: string
  /** package.json `version`, or `0.0.0`. */
  version: string
  /** Absolute path of the folder. */
  dir: string
  /** Absolute path of the entry script — package.json `main`, default `index.js` — always inside `dir`. */
  entry: string
  /** Shipped with the app, or found in the user's plugin folder. A label on the row, not a rank. */
  origin: 'built-in' | 'user'
  /** `magiceth.api` as written; must equal PLUGIN_API. */
  api: number
  /** Why the plugin cannot be opened: a bad id, the wrong api, an entry outside the folder, or an id a built-in owns. */
  problem?: string
}

/**
 * A key pressed while the plugin's screen is up. `key` is the DOM `KeyboardEvent.key`: `'a'`,
 * `'N'`, `'Enter'`, `'ArrowDown'`, `'Escape'`, … Esc and Tab belong to the shell and never arrive,
 * with one exception: while a form is open, Esc and the Cancel button arrive as `'Escape'`, and the
 * plugin closes the form by leaving it out of its next view.
 */
export interface KeyPress {
  key: string
  shift: boolean
  alt: boolean
  ctrl: boolean
  meta: boolean
}

/** One text field of a form block. */
export interface FormField {
  /** The property the typed value comes back under in `onSubmit`. */
  key: string
  label: string
  /** What the field starts out containing. */
  value?: string
  /** Placeholder, shown while the field is empty. */
  hint?: string
}

/**
 * The vocabulary a plugin draws with. Each kind has exactly one renderer, so every plugin looks
 * like the rest of the app; a kind this app does not know draws nothing.
 *
 * - `text`: a paragraph; `muted` for a note, `warn` for a problem.
 * - `table`: label/value rows under an optional title.
 * - `list`: numbered rows, one highlighted when `selected` is set. Moving the selection is the
 *   plugin's job — the arrow keys reach it like any other key. `empty` shows when there are no rows.
 * - `log`: lines in a monospace box, oldest first; `host.lines()` is the usual source.
 * - `form`: takes over the screen with text fields, Save and Cancel. Only the first form block of
 *   a view is used, and it hides every other block. Enter in a field or Save calls
 *   `onSubmit(id, values)`; Esc or Cancel sends the plugin `'Escape'`. The form is drawn when it
 *   appears and redrawn only when `id` or `error` changes — anything else would wipe what is being
 *   typed — and it closes when the next view carries no form block.
 * - `html`: the escape hatch, inserted as is. The page's CSP is `default-src 'self'; script-src
 *   'self'; style-src 'self' 'unsafe-inline'`: inline styles work; scripts, event handlers and
 *   remote or `data:` images do not. The app's own CSS classes are not part of this API.
 */
export type Block =
  | { kind: 'text'; text: string; tone?: 'muted' | 'warn' }
  | { kind: 'table'; title?: string; rows: [string, string][] }
  | { kind: 'list'; title?: string; rows: string[]; selected?: number; empty?: string }
  | { kind: 'log'; title?: string; lines: string[] }
  | { kind: 'form'; id: string; title: string; fields: FormField[]; error?: string }
  | { kind: 'html'; html: string }

/** One entry of the key legend at the bottom of the screen. */
export interface KeyHint {
  key: string
  label: string
}

/** What `render()` returns: the whole screen below the topbar. */
export interface PluginView {
  /** One line pinned under the topbar, after the plugin's title and the port. */
  status?: string
  /** Spinner in the topbar. */
  busy?: boolean
  /** Something is running that leaving would stop; the shell asks for a second press of Esc or Tab first. */
  running?: boolean
  /** Drawn in order, top to bottom. */
  blocks: Block[]
  /** The key legend at the bottom. Esc is added by the shell. */
  keys: KeyHint[]
}

// --- Shell side: what the main process pushes to the renderer. A plugin never sees these. ------

/** The screen the main process pushes to the renderer whenever the active plugin re-renders. */
export interface PluginScreen {
  pluginId: string
  title: string
  device: string
  /** `view.running`, or a DHCP session the host runs for the plugin. */
  running: boolean
  view: PluginView
}

/** What opening a plugin gives the renderer: its first screen, or why it could not start. */
export type PluginActivation = { ok: true; screen: PluginScreen } | { ok: false; message: string }

// --- What the host hands a plugin -----------------------------------------------------------

/** The outcome of `host.run()`. */
export interface HostRunResult {
  /** The exit status; `1` when the command could not start or timed out. */
  code: number
  stdout: string
  stderr: string
}

/** The link the DHCP server serves: the address the host put on the port, and its network. */
export interface DhcpLink {
  /** The host's own address on the port, e.g. `10.254.254.1` — also the server id and the router it hands out. */
  serverIp: string
  /** Prefix length of the link; the pool is a /24. */
  cidr: number
  /** The subnet-directed broadcast, which is where every DHCP reply goes. */
  broadcast: string
}

/**
 * What the DHCP server reports, in the order things happen:
 * - `address`: the address is on the port and port 67 is bound — the server is listening.
 * - `discover`: a client the spec allows asked; `vendorClass` and `hostname` as it sent them.
 * - `offer`: the address it was offered.
 * - `ack`: a lease was granted, or renewed.
 * - `release`: the client gave its address back.
 * - `ignored`: a packet that got silence, and why — another vendor class, a relayed packet, a
 *   declined address.
 * - `error`: a problem that did not end the session, such as a full pool, or why it could not start.
 * - `stopped`: the session is over — `stop()`, the plugin closed, the cap, or a start that failed —
 *   and the address is being removed.
 */
export type DhcpEvent =
  | {
      kind: 'address'
      serverIp: string
      cidr: number
      /** With `shareInternet`: the interface the link's traffic leaves through, and the DNS servers handed out. */
      upstream?: { device: string; dnsServers: string[] }
    }
  | { kind: 'discover'; mac: string; vendorClass?: string; hostname?: string }
  | { kind: 'offer'; mac: string; ip: string }
  | { kind: 'ack'; mac: string; ip: string }
  | { kind: 'release'; mac: string; ip: string }
  | { kind: 'ignored'; mac: string; reason: string }
  | { kind: 'error'; message: string }
  | { kind: 'stopped'; reason: string }

/** What the plugin asks the DHCP server to do. */
export interface DhcpSpec {
  /**
   * The options every OFFER and ACK carries beyond the standard ones (53, 54, 51, 1, 3, 28, and
   * 6 with `shareInternet`). Called once, when the link is known and before the admin prompt.
   * `code` is 1–254; `hex` is the raw value as hex digits, separators such as `:` allowed. A bad
   * code or an odd number of digits rejects `start()` before anything is prompted for.
   */
  options(link: DhcpLink): { code: number; hex: string }[]
  /** Only clients whose vendor class (option 60) starts with this are answered; everything else gets silence. */
  vendorClassPrefix?: string
  /**
   * Also give the link this computer's internet for the session: the host forwards and NATs the
   * link's network out through its default-route interface and hands that interface's DNS
   * servers out as option 6, so a device on the port can reach anything this computer can.
   * `start()` rejects before any prompt when there is no default route, when the port is that
   * interface, when it has no DNS servers, or on an OS where this is not done yet (Linux,
   * Windows). Forwarding and NAT are machine-wide while the session runs; the same elevated
   * script that added the address takes them away again. The `address` event says which
   * interface and servers were used.
   */
  shareInternet?: boolean
  /** Default 120 s — short, so a device forgets this link quickly once it is moved. */
  leaseSeconds?: number
  /** Where the events go. */
  onEvent(event: DhcpEvent): void
}

/** A running DHCP session. `stop()` ends it and removes the address; stopping twice is harmless. */
export interface DhcpSession extends DhcpLink {
  stop(): void
}

/**
 * Everything a plugin may use, handed to `activate()`. The same object for a plugin shipped with
 * the app and one in the user's folder.
 */
export interface PluginHost {
  /** The port the plugin was activated on. Fixed for the session; if it disappears, the plugin is closed. */
  device: string
  /** The port's current addressing — IPv4, DHCP or static, gateway, DNS — as the Ethernet dashboard reads it. */
  readNetInfo(): Promise<NetInfo>
  /**
   * Append a line stamped `m:ss` since activation (or the last `clearLog()`) and re-render. The
   * last 300 lines are kept. Ignored while `render()` is running.
   */
  log(text: string): void
  /** The log so far, oldest first, for a log block. */
  lines(): string[]
  /** Forget the log and restart its clock — for a plugin whose work comes in separate runs. Does not re-render. */
  clearLog(): void
  /** Re-render: call after any state change the screen should show. Ignored while `render()` is running. */
  update(): void
  /** One JSON file per plugin, in the app's data folder (not in Documents). Synchronous; the file is the truth. */
  storage: {
    /** The file's contents, or `fallback` when it is missing or not valid JSON. Nothing is validated. */
    load<T>(fallback: T): T
    /** Replace the file with `value` as pretty-printed JSON. */
    save(value: unknown): void
  }
  /**
   * Run a command without a shell: a file and an argument array, never a command line. Never
   * rejects — a command that could not start or timed out resolves with `code` 1. 8 s timeout by
   * default, 8 MB of output at most, never elevated.
   */
  run(file: string, args: string[], opts?: { timeoutMs?: number }): Promise<HostRunResult>
  /**
   * A DHCP server on the port, answering only what the spec allows: its vendor class, from its own
   * pool (`.10`–`.49` of a free private /24), to the port's broadcast, never a NAK. The host puts an
   * address on the port — one admin prompt, up to three minutes to answer it — binds port 67, and
   * takes both away again on `stop()`, when the plugin is closed, or after fifteen minutes.
   * Resolves as soon as the address has been asked for; the `address` event says when the server
   * listens, and a refused prompt arrives as `error` then `stopped`. Rejects with a message for the
   * screen when it cannot start at all: the port already holds a DHCP lease, no private /24 is
   * free, or an option is malformed. One session per app; a new start replaces the old.
   */
  dhcp: {
    start(spec: DhcpSpec): Promise<DhcpSession>
  }
}

/** What `activate()` returns: the plugin's behaviour for as long as its screen is up. */
export interface PluginInstance {
  /**
   * The whole screen. Called after activation, after every key and submit, and on every `log()` or
   * `update()`. A throw is shown as a warning text block.
   */
  render(): PluginView
  /** A key the user pressed — see KeyPress for which ones arrive. The screen re-renders afterwards; a throw becomes a log line. */
  onKey(key: KeyPress): void | Promise<void>
  /**
   * A form block was submitted. Validate, then either re-render with `error` or move on. Without
   * it, Save does nothing. A throw becomes a log line.
   */
  onSubmit?(formId: string, values: Record<string, string>): void | Promise<void>
  /**
   * Close every socket and timer. The host has already stopped any DHCP session it started for
   * the plugin. Afterwards the plugin's modules are dropped from the require cache, so the next
   * open reads the files on disk again.
   */
  deactivate(): void | Promise<void>
}

/**
 * What the entry script exports: `module.exports = { activate }`. A throw, or a missing export, is
 * shown as a notice in the chooser.
 */
export interface PluginModule {
  activate(host: PluginHost): PluginInstance | Promise<PluginInstance>
}
