// The start screen's "set up this computer": the tools the app leans on but does not ship, and on
// Linux the one-time rule that makes privileged actions stop asking for a password. Each row knows
// how to check itself and, where the app can, how to put itself right — by the OS's own package
// manager, through the same elevated path everything else uses. Nothing here runs until a key is
// pressed on the start screen, and nothing is shown while everything is in order.

import os from 'node:os'
import {
  LINUX_HELPER,
  LINUX_USERNAME,
  elevationRefused,
  linuxAdminSetupScript,
  linuxCanElevate,
  linuxElevator,
  runElevatedPlan
} from '../privilege'
import type { ElevatedPlan } from '../privilege'
import { toolPath } from '../util/tools'
import { detectPackageManager, installPackagesScript } from './setup-core'
import type { SetupItem, SetupOutcome } from '../../shared/types'

interface SetupRow {
  id: string
  /** The key on the start screen that acts on it: `k` installs tools, `a` sets up admin. */
  key: 'k' | 'a'
  label: string
  /** What it is for, finishing the sentence "… — not installed". */
  why: string
  check: () => Promise<boolean> | boolean
  canInstall: () => Promise<boolean> | boolean
  /** Distro packages; rows sharing this are installed in one go. */
  packages?: string[]
  /** Anything that is not a package. */
  plan?: () => ElevatedPlan
  /** What to do when the app cannot: a sentence, shown instead of an offer. */
  manual: string
}

/** A package install can pull a hundred megabytes on a slow link. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

const has = (name: string): boolean => toolPath(name) !== undefined

/**
 * A tool on PATH, installable where there is a package manager and a way to elevate — pkexec or
 * the admin rule, the two routes `runElevatedShell` takes; sudo on its own would ask for a password
 * nobody can type.
 */
function tool(id: string, why: string, manual: string): SetupRow {
  return {
    id,
    key: 'k',
    label: id,
    why,
    check: () => has(id),
    canInstall: async () =>
      process.platform === 'linux' &&
      detectPackageManager(has) !== undefined &&
      (await linuxCanElevate()),
    packages: process.platform === 'linux' ? [id] : undefined,
    manual
  }
}

function adminRow(): SetupRow {
  const user = os.userInfo().username
  return {
    id: 'admin',
    key: 'a',
    label: 'Admin password',
    why: 'asked for every privileged action',
    check: async () => (await linuxElevator()) === 'sudo',
    canInstall: () => has('sudo') && has('visudo') && has('pkexec') && LINUX_USERNAME.test(user),
    plan: () => ({ interpreter: 'sh', script: linuxAdminSetupScript(user) }),
    manual:
      'Needs sudo, visudo and pkexec, or the rule written by hand (README, "Privileged actions").'
  }
}

/** Every row for this OS. The admin row comes first so that `A` then `K` is exactly one prompt. */
function rows(): SetupRow[] {
  const curl = (manual: string): SetupRow => tool('curl', 'for the speed test (T)', manual)
  const tcpdump = (manual: string): SetupRow => tool('tcpdump', 'for the port survey (C)', manual)
  const byHand = 'Install it with your package manager.'
  switch (process.platform) {
    case 'linux':
      return [adminRow(), tcpdump(byHand), tool('iw', 'for Wi-Fi scanning', byHand), curl(byHand)]
    case 'darwin': {
      const mac = 'It ships with macOS, so check that /usr/bin and /usr/sbin are on PATH.'
      return [tcpdump(mac), curl(mac)]
    }
    default:
      return [curl('It ships with Windows 10 and later; check PATH.')]
  }
}

async function describe(row: SetupRow): Promise<SetupItem> {
  const ok = await row.check()
  const canInstall = !ok && (await row.canInstall())
  const state = row.id === 'admin' ? `${row.why}.` : `${row.why} — not installed.`
  const detail = ok
    ? row.id === 'admin'
      ? `password-free, through ${LINUX_HELPER}`
      : `${row.why} — installed`
    : canInstall
      ? state
      : `${state} ${row.manual}`
  return { id: row.id, key: row.key, label: row.label, detail, ok, canInstall }
}

export async function setupStatus(): Promise<SetupItem[]> {
  const items: SetupItem[] = []
  for (const row of rows()) items.push(await describe(row))
  return items
}

/** One elevated run, reported in a sentence when it did not succeed. */
async function runPlan(plan: ElevatedPlan, what: string): Promise<string | undefined> {
  try {
    const r = await runElevatedPlan(plan, INSTALL_TIMEOUT_MS)
    if (r.code === 0) return undefined
    if (elevationRefused(r))
      return `The admin prompt was cancelled, so nothing was done to ${what}.`
    const last = r.stderr.trim().split('\n').filter(Boolean).pop() ?? `exit ${r.code}`
    return `Could not ${what}: ${last}`
  } catch (err) {
    return `Could not ${what}: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Put the named rows right: every package in one package-manager call, then each plan of its own.
 * Re-checks afterwards, and says in one line what happened — the renderer never composes it.
 */
export async function installSetup(ids: string[]): Promise<SetupOutcome> {
  const chosen: SetupRow[] = []
  for (const row of rows()) {
    if (ids.includes(row.id) && (await row.canInstall())) chosen.push(row)
  }
  const problems: string[] = []
  const packages = [...new Set(chosen.flatMap((row) => row.packages ?? []))]
  if (packages.length > 0) {
    const pm = detectPackageManager(has)
    const what = `install ${packages.join(', ')}`
    const problem = pm
      ? await runPlan({ interpreter: 'sh', script: installPackagesScript(pm, packages) }, what)
      : 'No package manager found (apt-get, dnf, pacman or zypper).'
    if (problem) problems.push(problem)
  }
  for (const row of chosen) {
    if (!row.plan) continue
    const problem = await runPlan(row.plan(), `set up ${row.label.toLowerCase()}`)
    if (problem) problems.push(problem)
  }
  const items = await setupStatus()
  const still = items.filter((item) => ids.includes(item.id) && !item.ok)
  let message: string
  if (problems.length > 0) message = problems.join(' ')
  else if (still.length > 0)
    message = `${still.map((item) => item.label).join(', ')} still missing.`
  else if (chosen.some((row) => row.id === 'admin'))
    message = 'Done — admin actions no longer ask for a password on this computer.'
  else message = `Done — ${packages.join(', ')} installed.`
  return { items, message }
}
