# Plugin API 1

How to write a plugin for magiceth's Configure mode. This page is the reference for **plugin API
version 1**, and unlike the rest of the documentation it is deliberately exact: field names,
formats and behaviours are stated as they are, because plugins written against them must keep
working. The API is locked — see [Stability](#stability) — and any change to it is an API change
that goes through this page and the list at the end.

The normative contract is `src/shared/plugin.ts`, embedded verbatim [below](#the-contract); a
test keeps that copy identical to the source. `examples/plugins/hello` is a complete plugin to copy.

## What a plugin is

A folder with a `package.json` and a JavaScript entry file. The app reads the `package.json` to list
the plugin; nothing else in the folder is touched until you open it. Opening it `require()`s the
entry in the app's **main process** — plain Node, no DOM, no window — and calls its `activate(host)`.
From then on the plugin describes its screen as a list of **blocks**; the app draws them, sends every
key to the plugin, and adds `Esc` to leave. Leaving calls `deactivate()` and forgets the plugin's
modules, so editing a plugin on disk takes effect the next time it is opened. No restart, ever.

A plugin runs with the app's own privileges. See [Trust](#trust).

## Where plugins live

- **Yours:** `Documents/magiceth/plugins/<folder>/` — the operating system's Documents folder
  (`~/Documents/magiceth/plugins` on macOS and Linux, `%USERPROFILE%\Documents\magiceth\plugins` on
  Windows). The folder name is free; the id comes from the manifest.
- **Shipped with the app:** inside the app, with exactly the same shape. The chooser marks them
  `built in`; otherwise they are listed, loaded and run like yours. Their ids are reserved.

The chooser is one list sorted by title. Entering Configure mode, and leaving a plugin, re-reads both
folders, so a plugin dropped in appears without a restart. Type to search the list, `Backspace` to
widen it, `Esc` to clear it.

## The manifest

`package.json`, with the `magiceth` key that marks the folder as a plugin:

```json
{
  "name": "hello",
  "version": "0.1.0",
  "description": "A user plugin that says hello.",
  "author": "Your Name",
  "main": "index.js",
  "magiceth": { "api": 1, "title": "Hello plugin" }
}
```

| Field            | Rule                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`           | The plugin's id. Required. Must match `^[a-z0-9][a-z0-9._-]{0,63}$`: lowercase letters, digits, dots, dashes, underscores — it doubles as the storage file's name. |
| `magiceth`       | Required; without it the folder is not a plugin and is skipped silently (an npm package in the folder is not an error).                                            |
| `magiceth.api`   | Must equal `1`. Any other value lists the plugin greyed with the reason.                                                                                           |
| `magiceth.title` | What the chooser shows. Defaults to the id.                                                                                                                        |
| `main`           | The entry script, relative to the folder. Defaults to `index.js`. Must resolve inside the folder.                                                                  |
| `description`    | Shown under the title. Defaults to empty.                                                                                                                          |
| `author`         | A string, or an object with a `name`. Shown on the row (`by …`). Optional.                                                                                         |
| `version`        | Shown at the end of the row. Defaults to `0.0.0`.                                                                                                                  |

A manifest that is a plugin but cannot run — bad id, wrong `api`, entry outside the folder, or an
id a built-in plugin owns — is listed greyed with the problem as its description, so the mistake is
visible. Pressing `Enter` on it shows the problem in the notice bar.

## The module

The entry is loaded with Node's `require()`, so it is a **CommonJS** module:

```js
module.exports = {
  activate(host) {
    return {
      render: () => ({ blocks: [{ kind: 'text', text: 'hi' }], keys: [] }),
      onKey() {},
      deactivate() {}
    }
  }
}
```

- It runs on the Node bundled with the app's Electron. Node built-ins are available
  (`require('node:dgram')`, …).
- A plugin may ship its own `node_modules`; they resolve from the plugin's folder and are forgotten
  with the rest of it on leave.
- `require('electron')` works, because the module runs in the main process — but it is **not part of
  this API**, the stability promise does not cover it, and the plugins shipped with the app are not
  allowed to use it. If a plugin needs something from the app, the right fix is a new optional
  member on `PluginHost`.
- Writing TypeScript: compile to CommonJS and `import type` from `src/shared/plugin.ts` (in a
  checkout of this repo). The built-in plugin is written that way and bundled to exactly the shape
  above; a bundled built-in that required anything outside its own folder would fail the build.

## Lifecycle

1. **Open.** The app `require()`s the entry and calls `activate(host)`. It may return the instance
   or a Promise of it. While it runs, no keys are forwarded.
2. **Render.** `render()` is called for the first screen, after every `onKey` and `onSubmit`, and on
   every `host.log()` and `host.update()`.
3. **Keys.** Every key the shell does not own goes to `onKey`. A submitted form goes to `onSubmit`.
4. **Leave.** `Esc` (or `Tab`, or the port disappearing, or the app quitting) ends the plugin: the
   host stops any DHCP session it runs for it, awaits `deactivate()`, and drops every module under
   the plugin's folder from the require cache.

What a failure does:

| Where                                 | Effect                                                        |
| ------------------------------------- | ------------------------------------------------------------- |
| `activate` throws, or no `activate`   | A notice in the chooser; the plugin is not open.              |
| `render` throws                       | The screen shows a warning text block with the message.       |
| `onKey` / `onSubmit` throws           | A line `Error: …` in the plugin's log; the screen re-renders. |
| `deactivate` throws                   | Logged to the app's console; the plugin is still closed.      |
| A socket left open after `deactivate` | A hint in the app's console naming the kind of handle.        |

## The screen

`render()` returns a `PluginView`:

- `status` — one line pinned under the topbar, shown as `<title> · <port> · <status>`.
- `busy` — a spinner in the topbar.
- `running` — something is going on that leaving would stop. The shell then asks for a second press
  of `Esc` or `Tab` before leaving.
- `blocks` — drawn in order, top to bottom. The area scrolls.
- `keys` — the legend at the bottom: `{ key, label }` pairs. `Esc leave` is appended by the shell.

### Blocks

**`text`** — a paragraph. `tone: 'muted'` for a note, `'warn'` for a problem.

```json
{ "kind": "text", "text": "Connect the device to this port and nothing else.", "tone": "muted" }
```

**`table`** — label/value rows under an optional title.

```json
{
  "kind": "table",
  "title": "This laptop",
  "rows": [
    ["Port", "en9"],
    ["Address", "10.254.254.1/24"]
  ]
}
```

**`list`** — numbered rows, one highlighted when `selected` is set. Moving the selection is the
plugin's job: the arrow keys arrive in `onKey` like any other key, and the plugin re-renders with a
new `selected`. `empty` is shown instead of the rows when there are none.

```json
{
  "kind": "list",
  "title": "Controllers",
  "rows": ["Office", "Home"],
  "selected": 0,
  "empty": "None saved yet."
}
```

**`log`** — lines in a monospace box, oldest first. `host.lines()` is the usual source.

```json
{ "kind": "log", "title": "Activity", "lines": ["0:00 started", "0:04 lease 10.254.254.10"] }
```

**`form`** — see [Forms](#forms).

**`html`** — the escape hatch: inserted as is, no sanitising. The page's Content Security Policy is
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`, so inline `style`
attributes work and scripts, `on*` handlers, and remote or `data:` images do not. It is for layout
the typed blocks cannot do; the app's own CSS classes are not part of this API and may change.

A block kind this app does not know draws nothing, which is what lets a plugin written for a newer
app degrade rather than break.

### Forms

A `form` block takes over the screen: its fields, a **Save** and a **Cancel** button, the first
field focused.

```json
{
  "kind": "form",
  "id": "controller",
  "title": "New controller",
  "fields": [
    { "key": "name", "label": "Name", "value": "", "hint": "Office" },
    { "key": "url", "label": "Inform URL", "hint": "unifi.example.com" }
  ],
  "error": "That is not a URL."
}
```

- Only the **first** form block of a view is used, and it hides every other block.
- All fields are single-line text. `value` prefills, `hint` is the placeholder.
- `Enter` in any field, or Save, calls `onSubmit(id, values)` with every field's text keyed by
  `key`. Validate there: re-render with `error` set to show it, or without the form to close it.
- `Esc`, or Cancel, sends the plugin `onKey({ key: 'Escape', … })`. The plugin closes the form by
  leaving it out of its next view. A plugin that keeps the form after `Escape` leaves the user no
  way out, so handle it.
- The form is drawn when it appears and **redrawn only when `id` or `error` changes**. Nothing
  else repaints it, because a repaint would wipe what is being typed. To force a redraw, change
  `id`.
- While a form is open, the fields own the keyboard: no key but `Esc` reaches the plugin.

### Keys

`onKey` receives `{ key, shift, alt, ctrl, meta }`, where `key` is the DOM `KeyboardEvent.key`:
`'a'`, `'N'` (with Shift), `'1'`, `'Enter'`, `'ArrowDown'`, `'Backspace'`, …

The shell owns `Esc` and `Tab`; they never reach the plugin, except that `Esc` inside an open form
arrives as `'Escape'` (above). Everything else does, digits and letters included. There is no
host-side selection or confirmation: a list's selection, a "press again to confirm" step, and a
screen's modes are all the plugin's own state, re-rendered on every key.

## The host

The `PluginHost` handed to `activate()`. The same object for a built-in and a user plugin.

- **`device`** — the port the plugin was opened on, e.g. `en9`. Fixed for the session. If the port
  disappears, the plugin is closed with a notice.
- **`readNetInfo()`** — the port's current addressing as the Ethernet dashboard reads it: IPv4,
  prefix, DHCP or static and the server, gateway, DNS. Resolves to a `NetInfo`
  (`src/shared/types.ts`), which is part of this API through this method and changes additively
  only.
- **`log(text)`** — appends a line stamped `m:ss` (minutes and seconds since activation, or since
  the last `clearLog()`) and re-renders. The last 300 lines are kept. Ignored while `render()` is
  running — log before or after, not during.
- **`lines()`** — the log so far, oldest first, ready for a `log` block.
- **`clearLog()`** — forgets the log and restarts its clock. Does not re-render. For a plugin whose
  work comes in separate runs.
- **`update()`** — re-render now. Call it after a state change that did not come from a key, such
  as a socket event. Ignored while `render()` is running.
- **`storage.load(fallback)`** / **`storage.save(value)`** — one JSON file per plugin in the app's
  data folder (not in Documents), named after the id. `load` returns the parsed file, or `fallback`
  when the file is missing or not valid JSON; nothing is validated, so check what you get. `save`
  replaces the file with the value as pretty-printed JSON. Both are synchronous.
- **`run(file, args, { timeoutMs })`** — runs a command without a shell: a file and an argument
  array, never a command line. Resolves to `{ code, stdout, stderr }` and never rejects: a command
  that could not start or hit the timeout resolves with `code` 1. The default timeout is 8 s,
  output is capped at 8 MB, and nothing is ever elevated.
- **`dhcp.start(spec)`** — see next.

### The DHCP service

`host.dhcp.start(spec)` turns the port into a small DHCP server for devices connected to it and
nothing else. What it does, and will not do:

- Puts an address on the port — `10.254.254.1/24` or the first free of a few private /24s — through
  **one admin prompt**. The user has up to three minutes to answer it.
- Answers only clients whose vendor class (DHCP option 60) starts with `spec.vendorClassPrefix`,
  only from its own pool (`.10`–`.49`), only to the port's broadcast address, and **never** with a
  NAK. Anything else on the wire gets silence — the socket hears every interface, and a device on
  the user's LAN must never be answered.
- Every OFFER and ACK carries the standard options (53, 54, 51, 1, 3, 28) and then what
  `spec.options(link)` returns: `{ code, hex }` pairs, `code` 1–254, `hex` the raw value as hex
  digits (separators such as `:` allowed). `options` is called once, when the link is known and
  before the prompt; a bad option rejects the start before anything is prompted for.
- Leases last `spec.leaseSeconds`, default 120 s.
- Ends on `session.stop()`, when the plugin is closed, or after **fifteen minutes**, whichever
  comes first. The same elevated script that added the address removes it, even if the app is gone.
- One session per app; a new `start` replaces the old.

`start` resolves as soon as the address has been asked for, with a `DhcpSession` (`serverIp`,
`cidr`, `broadcast`, `stop()`). It **rejects**, with a message fit for the screen, when it cannot
start at all: the port already holds a DHCP lease from another server, no private /24 is free, or
an option is malformed. Everything after that arrives as events through `spec.onEvent`:

| Event      | Meaning                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `address`  | The address is on the port and port 67 is bound: the server is listening. `serverIp`, `cidr`.                    |
| `discover` | A client the spec allows asked. `mac`, and its `vendorClass` and `hostname` when it sent them.                   |
| `offer`    | `ip` was offered to `mac`.                                                                                       |
| `ack`      | A lease was granted or renewed. Renewals repeat every half lease.                                                |
| `release`  | The client gave `ip` back.                                                                                       |
| `ignored`  | A packet got silence: `reason` says why (another vendor class, relayed, a declined address).                     |
| `error`    | Something went wrong without ending the session (a full pool), or why a start failed.                            |
| `stopped`  | The session is over — `stop()`, the plugin closed, the cap, a refused prompt — and the address is being removed. |

A refused admin prompt, or no address within three minutes, arrives as `error` followed by
`stopped`, not as a rejection.

## NetInfo

`readNetInfo()` resolves to the `NetInfo` of `src/shared/types.ts`: `ipv4`, `prefix`, `dhcp`
(`enabled`, `server`, lease details where the OS reports them), `gateway`, `dns`, as the Ethernet
dashboard shows them. It is the app's own type and is part of plugin API 1 by reference: fields are
only ever added.

## What a plugin cannot do

- Run code in the renderer. Blocks are data; `html` is display only (see the CSP above).
- Receive `Esc` or `Tab`, or draw outside the shell: topbar, notice bar, status line and legend are
  the app's.
- Elevate through the host. `run` never does; the one elevated action is the address hold inside
  `dhcp.start`, which the user approves.
- Outlive its screen. Leaving stops everything the host started for it and drops its modules; a
  plugin that keeps a socket open past `deactivate()` is reported in the console.

## Trust

A plugin runs with the app's privileges, in the app's process. Placing a folder in
`Documents/magiceth/plugins` is the act of trusting it — and anything that can write there, a cloud
sync of Documents included, can place one. The chooser shows every plugin's origin and author before
it is opened, and nothing runs until it is. [SECURITY.md](../SECURITY.md) has the longer version.

## A worked example

`examples/plugins/hello` is a complete, commented plugin using text, table, list, log and form
blocks, storage and the key legend. Copy the folder into `Documents/magiceth/plugins`, open Configure
mode, and it is in the list. The repo's own checks run it: `test/example-plugin.test.ts` holds it to
the contract and `npm run ui-check` drives it in the app. For a plugin that uses the DHCP service,
`src/plugins/unifi-adopt` is the one shipped with the app, written in TypeScript against the same
contract.

Editor completion: in a checkout of this repo, a JavaScript plugin can point at the contract with
JSDoc —

```js
/** @type {import('../../src/shared/plugin').PluginModule} */
module.exports = { activate }
```

## Stability

**Version 1 is locked.** What this means:

- A plugin written against this page keeps working in every later app that reports api 1.
- The API grows by **addition only**: a new optional member on `PluginHost`, a new optional field on
  a block or a view, a new event kind. Nothing is renamed, removed, or changes meaning.
- A plugin that wants an addition checks for it — `typeof host.something === 'function'` — and
  works without it. An app that meets a block kind it does not know draws nothing.
- Bumping `PLUGIN_API` is the last resort, for a change that cannot be made additive. The chooser
  then lists plugins written for the old version greyed, with the reason, instead of loading them,
  and the CHANGELOG says what to change.

Every change, additive or not, is a line in [Changes to this API](#changes-to-this-api) and an edit
to `src/shared/plugin.ts`; the test that compares the two makes sure this page follows.

## The contract

`src/shared/plugin.ts`, verbatim. The doc comments are the member-by-member reference; the prose
above is what a type file cannot say.

<!-- plugin.ts -->

```ts
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
  | { kind: 'address'; serverIp: string; cidr: number }
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
   * The options every OFFER and ACK carries beyond the standard ones (53, 54, 51, 1, 3, 28).
   * Called once, when the link is known and before the admin prompt. `code` is 1–254; `hex` is the
   * raw value as hex digits, separators such as `:` allowed. A bad code or an odd number of digits
   * rejects `start()` before anything is prompted for.
   */
  options(link: DhcpLink): { code: number; hex: string }[]
  /** Only clients whose vendor class (option 60) starts with this are answered; everything else gets silence. */
  vendorClassPrefix?: string
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
```

<!-- /plugin.ts -->

## Changes to this API

- **1** — 2026-10-27. Initial version, locked. `PluginHost`: `device`, `readNetInfo`, `log`,
  `lines`, `clearLog`, `update`, `storage`, `run`, `dhcp.start`. Blocks: `text`, `table`, `list`,
  `log`, `form`, `html`.
