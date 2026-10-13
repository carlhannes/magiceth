// Configure mode — a chooser of plugins, and the screen of whichever one is active.
//
// The renderer knows nothing about any plugin. It draws the view the main process pushes, sends
// every key back, and takes over only for a form, where typed input must survive background
// events the same way the profile editor's does. Esc leaves and unloads the plugin, after a
// second press when the plugin says something is running.

import type { Adapter } from '../../shared/types'
import type { Block, PluginManifest, PluginScreen } from '../../shared/plugin'
import { pickSelected } from '../../shared/adapter'
import { escapeHtml } from './view'
import {
  app,
  confirmStep,
  consumePending,
  renderShell,
  requestRender,
  setMode,
  setNotice,
  setRenderSuspended
} from './shell'
import { renderBlocks } from './plugin-view'

type FormBlock = Extract<Block, { kind: 'form' }>

let adapters: Adapter[] = []
let selected = 0
let plugins: PluginManifest[] = []
let pluginSel = 0
let screen: PluginScreen | null = null
let activating = false
let formOpen: { id: string; error?: string } | null = null

const LEAVE_EXPLAINER = 'Leaving closes the plugin and stops what it is running.'

function currentDevice(): string | undefined {
  return adapters[selected]?.device
}

// --- The chooser ---

function portLine(): string {
  if (adapters.length === 0)
    return `<div class="selector"><span class="selector-hint">waiting for a port…</span></div>`
  const chips = adapters
    .map((d, i) => {
      const name = `${d.device} · ${d.chipset ? d.chipset.chipset : d.portName || 'USB Ethernet'}`
      return `<span class="chip${i === selected ? ' active' : ''}">${escapeHtml(name)}</span>`
    })
    .join('')
  return `<div class="selector">${chips}<span class="selector-hint">← → port</span></div>`
}

function pluginRows(list: PluginManifest[], offset: number): string {
  return list
    .map((m, i) => {
      const idx = offset + i
      const sub = m.problem ?? m.description
      const by = m.origin === 'user' ? ` · ${m.dir}${m.author ? ` · by ${m.author}` : ''}` : ''
      return `<li class="profile${idx === pluginSel ? ' sel' : ''}${m.problem ? ' muted' : ''}">
        <span class="pi">${idx + 1}</span>
        <span class="pn">${escapeHtml(m.title)}<br><span class="sub-line">${escapeHtml(sub)}${escapeHtml(by)}</span></span>
        <span class="pd">${escapeHtml(m.version)}</span>
      </li>`
    })
    .join('')
}

function renderChooser(): string {
  const builtIn = plugins.filter((m) => m.origin === 'built-in')
  const user = plugins.filter((m) => m.origin === 'user')
  const userList =
    user.length > 0
      ? `<ul class="profiles">${pluginRows(user, builtIn.length)}</ul>`
      : `<p class="status-msg">None yet. A plugin is a folder with a package.json and an index.js in Documents/magiceth/plugins — see the README.</p>`
  return renderShell({
    key: 'configure:chooser',
    busy: activating,
    status: portLine(),
    footer: `<b>↑↓</b> select · <b>Enter</b> open · <b>←→</b> port · <b>Esc</b> back · <b>Tab</b> ethernet`,
    body: `<section class="panel-card">
      <div class="section-title">Built in</div>
      <ul class="profiles">${pluginRows(builtIn, 0)}</ul>
      <div class="section-title">Your plugins — Documents/magiceth/plugins</div>
      ${userList}
    </section>`
  })
}

// --- The active plugin ---

function statusLine(s: PluginScreen): string {
  const parts = [s.title, s.device, s.view.status].filter(Boolean) as string[]
  return `<div class="selector"><span class="selector-hint">${parts.map(escapeHtml).join(' · ')}</span></div>`
}

function renderActive(s: PluginScreen): string {
  const keys = s.view.keys.map((k) => `<b>${escapeHtml(k.key)}</b> ${escapeHtml(k.label)}`)
  keys.push('<b>Esc</b> leave')
  return renderShell({
    key: `configure:${s.pluginId}`,
    busy: s.view.busy,
    status: statusLine(s),
    footer: keys.join(' · '),
    body: `<section class="panel-card">${renderBlocks(s.view.blocks)}</section>`
  })
}

export function renderConfigure(): string {
  return screen ? renderActive(screen) : renderChooser()
}

// --- Forms ---

function fieldId(i: number): string {
  return `pf-${i}`
}

function drawForm(s: PluginScreen, block: FormBlock): void {
  const fields = block.fields
    .map(
      (f, i) =>
        `<label class="fld">${escapeHtml(f.label)}<input id="${fieldId(i)}" data-key="${escapeHtml(f.key)}" type="text" value="${escapeHtml(f.value ?? '')}" placeholder="${escapeHtml(f.hint ?? '')}" /></label>`
    )
    .join('')
  app.innerHTML = renderShell({
    key: `configure:${s.pluginId}:form:${block.id}`,
    status: statusLine(s),
    footer: 'Fill in with the mouse · <b>Esc</b> cancels',
    body: `<section class="editor">
      <div class="section-title">${escapeHtml(block.title)}</div>
      ${fields}
      <p id="f-error" class="form-error">${escapeHtml(block.error ?? '')}</p>
      <div class="form-actions">
        <button id="f-save" class="btn primary">Save</button>
        <button id="f-cancel" class="btn">Cancel</button>
      </div>
    </section>`
  })
  const submit = (): void => {
    const values: Record<string, string> = {}
    for (const input of app.querySelectorAll<HTMLInputElement>('input[data-key]')) {
      values[input.dataset.key ?? ''] = input.value
    }
    void window.api.submitPluginForm(block.id, values)
  }
  ;(document.getElementById('f-save') as HTMLElement).addEventListener('click', submit)
  ;(document.getElementById('f-cancel') as HTMLElement).addEventListener('click', () =>
    cancelForm()
  )
  // Enter in any field saves: macOS does not move keyboard focus onto buttons, so without this
  // the form could only be submitted with the mouse.
  for (const input of app.querySelectorAll<HTMLInputElement>('input[data-key]')) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        submit()
      }
    })
  }
  ;(document.getElementById(fieldId(0)) as HTMLInputElement | null)?.focus()
}

function openForm(s: PluginScreen, block: FormBlock): void {
  formOpen = { id: block.id, error: block.error }
  setRenderSuspended(true)
  drawForm(s, block)
}

function closeForm(): void {
  if (!formOpen) return
  formOpen = null
  setRenderSuspended(false)
}

/** The plugin owns the form's state, so cancelling is a key it handles: it drops the form and re-renders. */
function cancelForm(): void {
  void window.api.sendPluginKey({
    key: 'Escape',
    shift: false,
    alt: false,
    ctrl: false,
    meta: false
  })
}

// --- Screens arriving from main ---

function applyScreen(next: PluginScreen): void {
  // A late push after leaving must not resurrect the plugin's screen.
  if (screen === null && !activating) return
  screen = next
  const form = next.view.blocks.find((b): b is FormBlock => b.kind === 'form')
  if (form) {
    // Redraw only when there is something new for the form: first open, or a validation error.
    // Anything else would wipe what is being typed.
    if (!formOpen || formOpen.id !== form.id || formOpen.error !== form.error) openForm(next, form)
  } else {
    closeForm()
  }
  requestRender()
}

async function activate(): Promise<void> {
  const m = plugins[pluginSel]
  const device = currentDevice()
  if (!m || activating) return
  if (m.problem) {
    setNotice(m.problem)
    requestRender()
    return
  }
  if (!device) {
    setNotice('No port to run it on — plug in a dongle first.')
    requestRender()
    return
  }
  activating = true
  setNotice(null)
  requestRender()
  try {
    const result = await window.api.activatePlugin(m.id, device)
    if (result.ok) applyScreen(result.screen)
    else setNotice(result.message)
  } catch (err) {
    setNotice(`Could not start ${m.title}: ${String(err)}`)
  } finally {
    activating = false
    requestRender()
  }
}

async function leaveActive(): Promise<void> {
  screen = null
  closeForm()
  requestRender()
  try {
    await window.api.deactivatePlugin()
  } catch (err) {
    console.error('deactivating the plugin failed', err)
  }
  await refreshPlugins()
}

async function refreshPlugins(): Promise<void> {
  try {
    plugins = await window.api.listPlugins()
  } catch (err) {
    console.error('listing plugins failed', err)
    plugins = []
  }
  pluginSel = Math.min(pluginSel, Math.max(0, plugins.length - 1))
  requestRender()
}

function onAdapters(next: Adapter[]): void {
  const previous = adapters
  adapters = next
  selected = pickSelected(previous, next, previous[selected]?.device)
  if (screen && !next.some((a) => a.device === screen?.device)) {
    setNotice(`${screen.device} went away — the plugin was closed.`)
    void leaveActive()
    return
  }
  requestRender()
}

// --- Keys ---

/** Whether Tab may switch modes right now: yes unless the plugin is running something, then on the second press. */
export function configureAllowsLeaving(): boolean {
  if (!screen?.running) return true
  const pending = consumePending()
  return confirmStep('Tab', screen.device, LEAVE_EXPLAINER, pending, 'switch')
}

export function handleConfigureKey(e: KeyboardEvent): void {
  if (formOpen) {
    if (e.key === 'Escape') {
      cancelForm()
      e.preventDefault()
    }
    return
  }
  const pending = consumePending()
  if (pending) {
    setNotice(null)
    requestRender()
  }

  if (screen) {
    if (e.key === 'Escape') {
      if (
        !screen.running ||
        confirmStep('Escape', screen.device, LEAVE_EXPLAINER, pending, 'leave')
      ) {
        void leaveActive()
      }
    } else if (!activating) {
      void window.api.sendPluginKey({
        key: e.key,
        shift: e.shiftKey,
        alt: e.altKey,
        ctrl: e.ctrlKey,
        meta: e.metaKey
      })
    }
    e.preventDefault()
    return
  }

  const n = plugins.length
  if (e.key === 'ArrowDown') {
    if (n > 0) pluginSel = (pluginSel + 1) % n
  } else if (e.key === 'ArrowUp') {
    if (n > 0) pluginSel = (pluginSel - 1 + n) % n
  } else if (e.key === 'ArrowRight') {
    if (adapters.length > 0) selected = (selected + 1) % adapters.length
  } else if (e.key === 'ArrowLeft') {
    if (adapters.length > 0) selected = (selected - 1 + adapters.length) % adapters.length
  } else if (e.key === 'Enter') {
    void activate()
  } else if (e.key === 'Escape') {
    setMode('chooser')
  } else {
    return
  }
  requestRender()
  e.preventDefault()
}

/** Leaving the mode closes the plugin: whatever it runs belongs to the screen it was started from. */
export function leaveConfigure(): void {
  if (screen) void leaveActive()
}

/** Entering re-reads the folders, so a plugin dropped in since last time is already in the list. */
export function enterConfigure(): void {
  void refreshPlugins()
  void window.api
    .listAdapters()
    .then((list) => onAdapters(list))
    .catch(() => undefined)
}

export function initConfigure(): void {
  window.api.onAdaptersChanged(onAdapters)
  window.api.onPluginView(applyScreen)
}
