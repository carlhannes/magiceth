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

function render(): void {
  // A form that draws itself also owns repainting, or a background event would wipe what is being
  // typed. The mode raises this flag while its editor is up.
  if (isRenderSuspended()) return
  switch (getMode()) {
    case 'chooser':
      app.innerHTML = renderChooser()
      return
    case 'ethernet':
      app.innerHTML = renderEthernet()
      return
    case 'wlan':
      app.innerHTML = renderWlan()
      return
  }
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
