// The start screen's "set up this computer" card: the tools the app leans on that are missing, and
// on Linux the one-time rule that stops privileged actions asking for a password. Drawn under the
// three mode cards only while something is not right, so a machine where everything is in order
// never sees it. The checks and the fixing live in main (capabilities/setup.ts); this file shows
// the list and sends the two keys.

import type { SetupItem } from '../../shared/types'
import { escapeHtml } from './view'
import type { Hint } from './view'
import { confirmStep, requestRender, setNotice } from './shell'
import type { PendingAction } from './shell'

let items: SetupItem[] = []
let busy = false

/** What pressing A is about to do, in full. Shown as the confirmation, never assumed. */
const ADMIN_EXPLAINER =
  'Password-free admin — lets magiceth, and anything else running as this user, run commands as root without a password, through /usr/local/libexec/magiceth-elevate. Meant for a dedicated laptop; two files, removable with sudo rm.'

function todo(): SetupItem[] {
  return items.filter((item) => !item.ok)
}

export async function initSetup(): Promise<void> {
  try {
    items = await window.api.setupStatus()
  } catch (err) {
    console.error('setup status failed', err)
    items = []
  }
  requestRender()
}

export function setupBusy(): boolean {
  return busy
}

/** The card, or nothing when there is nothing to do. */
export function renderSetupCard(): string {
  const list = todo()
  if (list.length === 0) return ''
  const lines = list
    .map(
      (item) =>
        `<p class="setup-line"><b>${escapeHtml(item.label)}</b> — ${escapeHtml(item.detail)}</p>`
    )
    .join('')
  return `
      <div class="mode-card setup">
        <span class="mode-key">!</span>
        <h2>Set up this computer</h2>
        ${lines}
      </div>`
}

/** The keys that would do something right now, for the start screen's legend. */
export function setupLegend(): Hint[] {
  const fixable = todo().filter((item) => item.canInstall)
  const legend: Hint[] = []
  if (fixable.some((item) => item.key === 'k')) legend.push({ keys: ['k'], label: 'install tools' })
  if (fixable.some((item) => item.key === 'a')) legend.push({ keys: ['a'], label: 'admin once' })
  return legend
}

async function install(ids: string[], notice: string): Promise<void> {
  busy = true
  setNotice(notice)
  requestRender()
  try {
    const outcome = await window.api.installSetup(ids)
    items = outcome.items
    setNotice(outcome.message)
  } catch (err) {
    setNotice(`Setup failed: ${String(err)}`)
  } finally {
    busy = false
    requestRender()
  }
}

/** The start screen's two setup keys. Returns true when the key was one of them. */
export function handleSetupKey(e: KeyboardEvent, pending: PendingAction | null): boolean {
  if (busy) return false
  const fixable = todo().filter((item) => item.canInstall)
  if (e.key === 'k' || e.key === 'K') {
    const tools = fixable.filter((item) => item.key === 'k')
    if (tools.length === 0) return false
    void install(
      tools.map((item) => item.id),
      `Installing ${tools.map((item) => item.label).join(', ')}… approve the admin prompt if one appears.`
    )
    return true
  }
  if (e.key === 'a' || e.key === 'A') {
    const admin = fixable.find((item) => item.key === 'a')
    if (!admin) return false
    if (confirmStep('a', '', ADMIN_EXPLAINER, pending, 'set up')) {
      void install([admin.id], 'Setting up password-free admin… approve this one prompt.')
    }
    return true
  }
  return false
}
