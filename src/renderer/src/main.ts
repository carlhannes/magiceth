// Entry point. Mounts the app, decides which mode is on screen, and routes keystrokes to it.
//
// This file is the only one that knows both modes exist. shell.ts holds what they share, and
// neither ethernet.ts nor wlan.ts imports the other, so the dependency graph stays a tree.

import './styles.css'
import {
  app,
  getMode,
  isRenderSuspended,
  renderChooser,
  requestRender,
  setMode,
  setNotice,
  setPending,
  setRenderer
} from './shell'
import type { Mode } from './shell'
import { handleEthernetKey, initEthernet, leaveEthernet, renderEthernet } from './ethernet'
import { enterWlan, handleWlanKey, initWlan, leaveWlan, renderWlan } from './wlan'

/**
 * Which row was highlighted at the last paint, as view plus position. Compared rather than stored
 * as a flag so the selection is only scrolled into view when it actually moved — a push update
 * arriving while someone is reading further down the list must not drag them back to it.
 */
let lastSelection = ''

function render(): void {
  // A form that draws itself also owns repainting, or a background event would wipe what is being
  // typed. The mode raises this flag while its editor is up.
  if (isRenderSuspended()) return

  // Replacing the markup destroys the scrolling element and with it the reader's place. Push
  // updates land about once a second while scanning, so without this a long list would snap back
  // to the top continuously — exactly when someone is trying to read it.
  const previous = app.querySelector<HTMLElement>('.scroll')
  const previousKey = previous?.dataset.view
  const offset = previous?.scrollTop ?? 0

  switch (getMode()) {
    case 'chooser':
      app.innerHTML = renderChooser()
      break
    case 'ethernet':
      app.innerHTML = renderEthernet()
      break
    case 'wlan':
      app.innerHTML = renderWlan()
      break
  }

  const next = app.querySelector<HTMLElement>('.scroll')
  // Only the same screen gets its offset back; a different one starts at the top.
  if (next && previousKey !== undefined && next.dataset.view === previousKey) {
    // Read a layout property first. Without it the browser may still be holding the previous,
    // shorter height and will clamp the offset down — which, once per push update, walks a
    // scrolled list steadily back towards the top.
    void next.scrollHeight
    next.scrollTop = offset
  }
  followSelection(next)
}

/**
 * Keep the highlighted row on screen. Arrow keys move the selection through a list that is taller
 * than the window, so without this it walks off the bottom and you are left steering something you
 * cannot see. `block: 'nearest'` scrolls the least it can get away with, and does nothing at all
 * when the row is already visible.
 */
function followSelection(scroll: HTMLElement | null): void {
  const selected = scroll?.querySelector<HTMLElement>('.sel')
  const siblings = selected?.parentElement?.children
  const position = selected && siblings ? [...siblings].indexOf(selected) : -1
  const selection = `${scroll?.dataset.view ?? ''}#${position}`
  if (selection === lastSelection) return
  lastSelection = selection
  selected?.scrollIntoView({ block: 'nearest' })
}

/**
 * Leaving a mode stops whatever that mode had running. A capture or a scan belongs to the screen
 * it was started from, and one still going on a screen nobody is looking at is exactly how a
 * privileged tcpdump gets orphaned.
 */
function switchTo(next: Mode): void {
  const current = getMode()
  if (current === next) return
  if (current === 'ethernet') leaveEthernet()
  if (current === 'wlan') leaveWlan()
  // A confirmation asked about the other mode's port must not survive the move: the next press
  // would answer a question about something no longer on screen.
  setPending(null)
  setNotice(null)
  setMode(next)
  requestRender()
  if (next === 'wlan') enterWlan()
}

function handleChooserKey(e: KeyboardEvent): void {
  if (e.key === '1' || e.key === 'e' || e.key === 'E') switchTo('ethernet')
  else if (e.key === '2' || e.key === 'w' || e.key === 'W') switchTo('wlan')
  else return
  e.preventDefault()
}

document.addEventListener('keydown', (e) => {
  const mode = getMode()
  // While a form owns the screen it owns every key, so the mode-level shortcuts stay out of the
  // way — Tab has to reach the field it is meant to move between.
  if (!isRenderSuspended()) {
    if (mode === 'chooser') {
      handleChooserKey(e)
      return
    }
    if (e.key === 'Tab') {
      switchTo(mode === 'ethernet' ? 'wlan' : 'ethernet')
      e.preventDefault()
      return
    }
  }
  if (mode === 'ethernet') handleEthernetKey(e)
  else if (mode === 'wlan') handleWlanKey(e)
})

async function init(): Promise<void> {
  setRenderer(render)
  initWlan()
  render()
  // Ethernet sets itself up behind the chooser. Everything it does on startup is a cheap read, and
  // doing it now means picking Ethernet shows a filled-in port rather than "waiting for a port…".
  await initEthernet()
}

init().catch((err) => {
  app.textContent = `Error on startup: ${String(err)}`
})
