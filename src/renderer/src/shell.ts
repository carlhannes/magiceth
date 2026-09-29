// The shell around the two modes: what they share, and the screen you pick between them on.
//
// Everything here is deliberately mode-agnostic. The Ethernet dashboard and the WLAN scanner both
// import from this file; this file imports neither of them, so the dependency only ever points one
// way and main.ts is the single place that knows both exist.

import { escapeHtml, keyLabel } from './view'

export const app = document.getElementById('app') as HTMLElement
export const APP_VERSION = __APP_VERSION__

/** Ethernet is everything the tool did before; WLAN scans the air. The chooser is the way in. */
export type Mode = 'chooser' | 'ethernet' | 'wlan'

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
  pending: PendingAction | null
): boolean {
  if (pending && pending.key === key && pending.device === device) return true
  pendingAction = { key, device }
  notice = `${message} Press ${keyLabel(key)} again to start.`
  requestRender()
  return false
}

export function renderTopbar(busy = false): string {
  const spinner = busy ? '<span class="spin">⟳</span>' : ''
  const where = mode === 'ethernet' ? 'Ethernet' : mode === 'wlan' ? 'Wi-Fi' : ''
  const tag = where ? `<span class="mode-tag">${where}</span>` : ''
  return `<header class="topbar"><h1>magiceth</h1>${tag}<span class="ver">v${APP_VERSION}</span>${spinner}</header>`
}

export function renderNotice(): string {
  if (!notice) return ''
  return `<div class="notice${pendingAction ? ' confirm' : ''}">${escapeHtml(notice)}</div>`
}

/**
 * The first screen. Two jobs, and the tool does them differently enough that mixing them on one
 * screen would cost the glanceability the whole thing is built around.
 */
export function renderChooser(): string {
  return `
    ${renderTopbar()}
    <section class="chooser">
      <div class="mode-card">
        <span class="mode-key">1</span>
        <h2>Ethernet</h2>
        <p>A wired port through a USB dongle — IP, DHCP, gateway, DNS, ping, throughput and the VLANs on the wire.</p>
      </div>
      <div class="mode-card">
        <span class="mode-key">2</span>
        <h2>Wi-Fi</h2>
        <p>The air around you — every network, the access points behind it, their channels, width, load and signal.</p>
      </div>
    </section>
    <footer class="hint"><b>1</b>/<b>E</b> ethernet · <b>2</b>/<b>W</b> wi-fi · <b>Tab</b> switches anytime</footer>`
}
