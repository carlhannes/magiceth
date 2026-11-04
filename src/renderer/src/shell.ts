// The shell around the modes: what they share, and the screen you pick between them on.
//
// Everything here is deliberately mode-agnostic. The Ethernet dashboard, the WLAN scanner and
// Configure mode all import from this file; this file imports none of them, so the dependency only
// ever points one way and main.ts is the single place that knows they all exist.

import { escapeHtml, keyLabel, renderHints } from './view'
import type { Hint } from './view'

export const app = document.getElementById('app') as HTMLElement
export const APP_VERSION = __APP_VERSION__

/**
 * Ethernet is everything the tool did before; WLAN scans the air; Configure runs a plugin that
 * sets something up through the port. The chooser is the way in.
 */
export type Mode = 'chooser' | 'ethernet' | 'wlan' | 'configure'

let mode: Mode = 'chooser'

export function getMode(): Mode {
  return mode
}

export function setMode(next: Mode): void {
  mode = next
}

// --- The notice bar ---
// One slot carrying both results and questions. Sticky in CSS on purpose: the window scrolls past a
// static one, and a confirmation you cannot see is worse than none — the first press looks like it
// did nothing, so you press again, and that is the press that acts.
let notice: string | null = null

export function getNotice(): string | null {
  return notice
}

export function setNotice(value: string | null): void {
  notice = value
}

// --- Pending confirmations ---
export interface PendingAction {
  key: string
  device: string
}

let pendingAction: PendingAction | null = null

export function getPending(): PendingAction | null {
  return pendingAction
}

export function setPending(value: PendingAction | null): void {
  pendingAction = value
}

/**
 * Take whatever confirmation was outstanding and clear it in one step.
 *
 * Called once per keystroke before anything is dispatched, so only the very next press of the same
 * key can confirm and anything in between cancels. Deliberately not on a timer — self-clearing
 * notices are a separate open question.
 */
export function consumePending(): PendingAction | null {
  const previous = pendingAction
  pendingAction = null
  return previous
}

// --- Re-render hook ---
// main.ts owns the actual render() because only it knows which mode is on screen. The modes reach
// it through here rather than importing main.ts, which would close the dependency cycle.
let renderer: () => void = () => {}

export function setRenderer(fn: () => void): void {
  renderer = fn
}

export function requestRender(): void {
  renderer()
}

// While a form is open the screen must not be repainted, or a background event would wipe what is
// being typed. Background flows keep updating data in memory; the next render shows it.
let suspended = false

export function setRenderSuspended(value: boolean): void {
  suspended = value
}

export function isRenderSuspended(): boolean {
  return suspended
}

/**
 * Ask once, act on the next press of the same key. Returns true when the caller should go ahead.
 *
 * `pending` is whatever was outstanding when this keystroke arrived. The message doubles as the
 * explanation of what is about to happen, which is why the expensive actions use this instead of
 * standing paragraphs of hint text nobody reads twice.
 */
export function confirmStep(
  key: string,
  device: string,
  message: string,
  pending: PendingAction | null,
  verb = 'start'
): boolean {
  if (pending && pending.key === key && pending.device === device) return true
  pendingAction = { key, device }
  notice = `${message} Press ${keyLabel(key)} again to ${verb}.`
  requestRender()
  return false
}

/**
 * One screen, in the parts the shell puts in fixed places.
 *
 * Only `body` scrolls. The topbar, the notice and the status line stay at the top and the key
 * legend stays at the bottom, because a legend nobody can see is a legend nobody reads.
 */
export interface ModeView {
  /**
   * Identifies the screen. The scroll position is carried across renders of the same one — push
   * updates arrive about once a second while scanning — and reset when it changes, so opening a
   * different screen starts at the top rather than halfway down.
   */
  key: string
  busy?: boolean
  status?: string
  body: string
  /** The key legend. Data rather than markup, because every entry is also the button for its key. */
  footer: Hint[]
}

/**
 * A legend anywhere on a screen: the footer, or a line inside a card. Drawn here rather than by the
 * modes so the one key waiting for a confirming press is marked wherever it appears.
 */
export function hints(list: Hint[]): string {
  return renderHints(list, pendingAction?.key)
}

/** A form's legend: Save and Cancel are buttons on the form itself; Esc is the one key it hands back. */
export const FORM_FOOTER: Hint[] = [
  { keys: [], label: 'Save or Cancel below' },
  { keys: ['Escape'], label: 'cancels' }
]

export function renderShell(view: ModeView): string {
  return `
    ${renderTopbar(view.busy)}
    ${renderNotice()}
    ${view.status ?? ''}
    <div class="scroll" data-view="${escapeHtml(view.key)}">${view.body}</div>
    <footer class="hint">${hints(view.footer)}</footer>`
}

export function renderTopbar(busy = false): string {
  const spinner = busy ? '<span class="spin">⟳</span>' : ''
  const where =
    mode === 'ethernet'
      ? 'Ethernet'
      : mode === 'wlan'
        ? 'Wi-Fi'
        : mode === 'configure'
          ? 'Configure'
          : ''
  const tag = where ? `<span class="mode-tag">${where}</span>` : ''
  return `<header class="topbar"><h1>magiceth</h1>${tag}<span class="ver">v${APP_VERSION}</span>${spinner}</header>`
}

/** A question in the notice bar is tappable: the tap is the confirming second press it asks for. */
export function renderNotice(): string {
  if (!notice) return ''
  const press = pendingAction ? ` confirm" data-press="${escapeHtml(pendingAction.key)}` : ''
  return `<div class="notice${press}">${escapeHtml(notice)}</div>`
}

/**
 * The first screen. Three jobs, and the tool does them differently enough that mixing them on
 * one screen would cost the glanceability the whole thing is built around. Each card is the key
 * it names, so a tap on it is that key.
 */
export function renderChooser(): string {
  return renderShell({
    key: 'chooser',
    footer: [
      { keys: ['1', 'e'], label: 'ethernet' },
      { keys: ['2', 'w'], label: 'wi-fi' },
      { keys: ['3', 'c'], label: 'configure' }
    ],
    body: `
    <section class="chooser">
      <div class="mode-card" data-press="1">
        <span class="mode-key">1</span>
        <h2>Ethernet</h2>
        <p>A wired port through a USB dongle — IP, DHCP, gateway, DNS, ping, throughput and the VLANs on the wire.</p>
      </div>
      <div class="mode-card" data-press="2">
        <span class="mode-key">2</span>
        <h2>Wi-Fi</h2>
        <p>The air around you — every network, the access points behind it, their channels, width, load and signal.</p>
      </div>
      <div class="mode-card" data-press="3">
        <span class="mode-key">3</span>
        <h2>Configure</h2>
        <p>Set a device up through the port — adopt a UniFi switch to a remote controller, or run a plugin of your own.</p>
      </div>
    </section>`
  })
}
