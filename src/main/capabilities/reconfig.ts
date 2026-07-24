import { getPlatform } from '../platform'
import { runElevatedPlan } from '../privilege'
import { randomLocallyAdministeredMac } from '../../shared/mac'
import type { NetInfo, Profile, ReconfigResult } from '../../shared/types'

// Active, privileged reconfiguration. Each action: read current state (for undo) -> run elevated
// -> re-read and verify. Electron-free (testable where possible; the actual execution requires sudo).

type UndoAction = { kind: 'mac'; mac: string } | { kind: 'profile'; profile: Profile }

const undoStore = new Map<string, UndoAction>()

/** Build a profile that restores a previous netinfo state (for undo). */
function profileFromNet(net: NetInfo): Profile {
  if (net.dhcp.enabled || !net.ipv4) return { id: 'undo', name: 'Undo', mode: 'dhcp' }
  return {
    id: 'undo',
    name: 'Undo',
    mode: 'static',
    ip: net.ipv4,
    cidr: net.cidr,
    gateway: net.gateway,
    dns: net.dnsServers.length > 0 ? [...net.dnsServers] : undefined
  }
}

export async function rollMac(device: string): Promise<ReconfigResult> {
  const before = await getPlatform().readNetInfo(device)
  const newMac = randomLocallyAdministeredMac()
  const plan = await getPlatform().buildSetMacPlan(device, newMac)
  try {
    await runElevatedPlan(plan)
  } catch (e) {
    return { ok: false, message: `Elevation failed: ${String(e)}`, oldMac: before.mac }
  }
  const after = await getPlatform().readNetInfo(device)
  const verified = after.mac.toLowerCase() === newMac.toLowerCase()
  if (before.mac) undoStore.set(device, { kind: 'mac', mac: before.mac })
  return {
    ok: verified,
    oldMac: before.mac,
    newMac,
    net: after,
    message: verified
      ? undefined
      : 'MAC was not verified — the chipset/OS may not allow changing it (see SUDO-TEST.md).'
  }
}

export async function applyProfile(device: string, profile: Profile): Promise<ReconfigResult> {
  const before = await getPlatform().readNetInfo(device)
  const plan = await getPlatform().buildProfilePlan(device, profile)
  try {
    await runElevatedPlan(plan)
  } catch (e) {
    return { ok: false, message: `Elevation failed: ${String(e)}` }
  }
  const after = await getPlatform().readNetInfo(device)
  undoStore.set(device, { kind: 'profile', profile: profileFromNet(before) })
  const ok = profile.mode === 'static' ? after.ipv4 === profile.ip : after.linkUp
  return { ok, net: after, message: ok ? undefined : 'Could not verify the new configuration.' }
}

export async function undo(device: string): Promise<ReconfigResult> {
  const action = undoStore.get(device)
  if (!action) return { ok: false, message: 'Nothing to undo.' }
  const plan =
    action.kind === 'mac'
      ? await getPlatform().buildSetMacPlan(device, action.mac)
      : await getPlatform().buildProfilePlan(device, action.profile)
  try {
    await runElevatedPlan(plan)
  } catch (e) {
    return { ok: false, message: `Elevation failed: ${String(e)}` }
  }
  undoStore.delete(device)
  return { ok: true, net: await getPlatform().readNetInfo(device) }
}
