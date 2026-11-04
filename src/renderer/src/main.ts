// Entry point. Mounts the app, decides which mode is on screen, and routes keystrokes to it.
//
// This file is the only one that knows all the modes exist. shell.ts holds what they share, and
// no mode imports another, so the dependency graph stays a tree.
//
// It is also where a tap becomes a keypress. Legend buttons, mode cards, the confirmation notice
// and list rows are handled by two delegated listeners at the bottom, which dispatch the same
// synthetic keydown that scripts/ui-check.mjs uses — so each mode's key handler stays the only
// input handler there is, for a finger as much as for a keyboard.

import './styles.css'
import {
  app,
  consumePending,
  getMode,
  isRenderSuspended,
  renderChooser,
  requestRender,
  setMode,
  setNotice,
  setPending,
  setRenderer
} from './shell'
import { handleSetupKey, initSetup, renderSetupCard, setupBusy, setupLegend } from './setup'
import type { Mode } from './shell'
import { handleEthernetKey, initEthernet, leaveEthernet, renderEthernet } from './ethernet'
import { enterWlan, handleWlanKey, initWlan, leaveWlan, renderWlan } from './wlan'
import {
  configureAllowsLeaving,
  enterConfigure,
  handleConfigureKey,
  initConfigure,
  leaveConfigure,
  renderConfigure
} from './configure'

/** Tab walks the modes in the order the chooser lists them. */
const TAB_ORDER: Mode[] = ['ethernet', 'wlan', 'configure']

/**
 * Which row was highlighted at the last paint, as view plus position. Compared rather than stored
 * as a flag so the selection is only scrolled into view when it actually moved — a push update
 * arriving while someone is reading further down the list must not drag them back to it.
 */
let lastSelection = ''

// A finger on the screen holds repaints back. The WLAN lists re-sort on every push, so a render
// landing between the touch and the click it becomes would put another row under the finger and
// the tap would open the wrong network. The click arrives as its own task after touchend, so the
// flush waits a moment for it.
let touching = false
let dirty = false

function render(): void {
  // A form that draws itself also owns repainting, or a background event would wipe what is being
  // typed. The mode raises this flag while its editor is up.
  if (isRenderSuspended()) return
  if (touching) {
    dirty = true
    return
  }

  // Replacing the markup destroys the scrolling element and with it the reader's place. Push
  // updates land about once a second while scanning, so without this a long list would snap back
  // to the top continuously — exactly when someone is trying to read it.
  const previous = app.querySelector<HTMLElement>('.scroll')
  const previousKey = previous?.dataset.view
  const offset = previous?.scrollTop ?? 0

  switch (getMode()) {
    case 'chooser':
      app.innerHTML = renderChooser({
        card: renderSetupCard(),
        legend: setupLegend(),
        busy: setupBusy()
      })
      break
    case 'ethernet':
      app.innerHTML = renderEthernet()
      break
    case 'wlan':
      app.innerHTML = renderWlan()
      break
    case 'configure':
      app.innerHTML = renderConfigure()
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
  if (current === 'configure') leaveConfigure()
  // A confirmation asked about the other mode's port must not survive the move: the next press
  // would answer a question about something no longer on screen.
  setPending(null)
  setNotice(null)
  setMode(next)
  requestRender()
  if (next === 'wlan') enterWlan()
  if (next === 'configure') enterConfigure()
}

function handleChooserKey(e: KeyboardEvent): void {
  // The setup card's keys first; they are the only ones here that may ask for a second press, and
  // any other key takes the question off the screen, as in every mode.
  const pending = consumePending()
  if (handleSetupKey(e, pending)) {
    e.preventDefault()
    return
  }
  if (pending) {
    setNotice(null)
    requestRender()
  }
  if (e.key === '1' || e.key === 'e' || e.key === 'E') switchTo('ethernet')
  else if (e.key === '2' || e.key === 'w' || e.key === 'W') switchTo('wlan')
  else if (e.key === '3' || e.key === 'c' || e.key === 'C') switchTo('configure')
  // Tab cycles the modes from anywhere, the chooser included: it starts the cycle.
  else if (e.key === 'Tab') switchTo(TAB_ORDER[0])
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
      // A plugin with something running gets to ask for a second press first.
      if (mode !== 'configure' || configureAllowsLeaving()) {
        switchTo(TAB_ORDER[(TAB_ORDER.indexOf(mode) + 1) % TAB_ORDER.length])
      }
      e.preventDefault()
      return
    }
  }
  if (mode === 'ethernet') handleEthernetKey(e)
  else if (mode === 'wlan') handleWlanKey(e)
  else if (mode === 'configure') handleConfigureKey(e)
})

// --- A tap is a keypress ---

/** What the keyboard would do. Dispatched on the document, so it takes exactly the path a key does. */
function press(key: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** What a finger can land on besides a legend key: list rows, and the adapter or port chips. */
const ITEM = '.profile, .chip'

app.addEventListener('click', (e) => {
  const target = e.target as Element | null
  const pressed = target?.closest<HTMLElement>('[data-press]')
  if (pressed) {
    press(pressed.dataset.press ?? '')
    return
  }
  // A row is reached the way the arrow keys reach it: steps from the selected row, the short way
  // round since every list wraps. That is what lets a plugin's list — whose selection the plugin
  // owns and the app cannot set — behave exactly like the app's own. The indices are taken from
  // the markup once, before the first step repaints it. Tapping the selected row again opens it,
  // as Enter does; a chip only selects.
  const item = target?.closest<HTMLElement>(ITEM)
  const list = item?.parentElement
  if (!item || !list) return
  const items = [...list.children].filter((c) => c.matches(ITEM))
  const current = items.findIndex((c) => c.matches('.sel, .active'))
  const wanted = items.indexOf(item)
  if (current < 0 || wanted < 0) return
  const [back, forth] = (list.dataset.step ?? 'ArrowUp ArrowDown').split(' ')
  const n = items.length
  const ahead = (wanted - current + n) % n
  if (ahead === 0) {
    if (item.matches('.profile')) press('Enter')
    return
  }
  const behind = n - ahead
  const key = ahead <= behind ? forth : back
  for (let i = 0; i < Math.min(ahead, behind); i++) press(key)
})

// Keep focus where it is: a legend button left focused would fire again on the next Enter, and a
// second tap on a row must open the row, not select its text.
app.addEventListener('mousedown', (e) => {
  if ((e.target as Element | null)?.closest(`[data-press], ${ITEM}`)) e.preventDefault()
})

function release(e: TouchEvent): void {
  if (e.touches.length > 0) return
  touching = false
  setTimeout(() => {
    if (!dirty) return
    dirty = false
    render()
  }, 150)
}
app.addEventListener(
  'touchstart',
  () => {
    touching = true
  },
  { passive: true }
)
app.addEventListener('touchend', release, { passive: true })
app.addEventListener('touchcancel', release, { passive: true })

async function init(): Promise<void> {
  setRenderer(render)
  initWlan()
  initConfigure()
  render()
  // What this computer is missing, for the card on the start screen. A few PATH lookups in main.
  void initSetup()
  // Ethernet sets itself up behind the chooser. Everything it does on startup is a cheap read, and
  // doing it now means picking Ethernet shows a filled-in port rather than "waiting for a port…".
  await initEthernet()
}

init().catch((err) => {
  app.textContent = `Error on startup: ${String(err)}`
})
