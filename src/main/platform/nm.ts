// NetworkManager's view of a port, and a profile applied through it.
//
// On a desktop Linux the ports belong to NetworkManager: it runs the DHCP client (`dhclient` is not
// even installed on Ubuntu 24.04), hands the DNS servers to systemd-resolved, and puts its own
// address back on an interface someone else has flushed. Applying a profile with raw iproute2
// there is a fight the app loses within seconds. So on an Ethernet port NetworkManager manages,
// a profile is a connection of the app's own: in memory only (`save no`, gone at the next boot),
// named after the port, replaced whole on every apply, and first in line for autoconnect so that a
// replugged cable brings the profile back rather than the system's saved one — which is how the
// profile already behaves on macOS and Windows. Ports nobody manages keep the iproute2 script.

import { shQuote } from '../privilege'
import type { Profile } from '../../shared/types'

export interface NmDevice {
  /** `ethernet`, `wifi`, `loopback`, … as nmcli names them. */
  type: string
  /** False for state 10 (unmanaged) only; a port NetworkManager drives is managed in every state. */
  managed: boolean
}

/**
 * `nmcli -t -f GENERAL.TYPE,GENERAL.STATE device show <dev>`: one `FIELD:value` per line, the
 * state as a number followed by its name (`100 (connected)`), and an error instead for a device
 * NetworkManager has never heard of. The number is what is read, so a translated name changes
 * nothing.
 */
export function parseNmDevice(text: string): NmDevice | undefined {
  let type: string | undefined
  let state: number | undefined
  for (const line of text.split('\n')) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const field = line.slice(0, i).trim()
    const value = line.slice(i + 1).trim()
    if (field === 'GENERAL.TYPE') type = value
    else if (field === 'GENERAL.STATE') {
      const m = /^(\d+)/.exec(value)
      if (m) state = Number(m[1])
    }
  }
  if (type === undefined || state === undefined) return undefined
  return { type, managed: state !== 10 }
}

export function nmConnectionName(device: string): string {
  return `magiceth-${device}`
}

/** How long `connection up` may wait for an address. DHCP on a port without a server fails here. */
export const NM_UP_TIMEOUT_S = 20

/**
 * The elevated script for one profile on a managed Ethernet port. The previous profile goes first
 * (there may be none, so its failure is ignored), the MAC override is the same down/address/up
 * that rolling a MAC uses — NetworkManager's default `cloned-mac-address=preserve` leaves it in
 * place, and keeping the MAC out of the connection means a later roll is not undone on the next
 * activation — then the connection is added and brought up. Everything the user typed is quoted.
 */
export function nmProfileScript(device: string, profile: Profile): string {
  const d = shQuote(device)
  const name = shQuote(nmConnectionName(device))
  const steps: string[] = []
  if (profile.macOverride) {
    const mac = shQuote(profile.macOverride)
    steps.push(
      `ip link set dev ${d} down`,
      `ip link set dev ${d} address ${mac}`,
      `ip link set dev ${d} up`
    )
  }
  const settings = [
    'save no',
    'type ethernet',
    `ifname ${d}`,
    `con-name ${name}`,
    'connection.autoconnect yes',
    'connection.autoconnect-priority 100'
  ]
  if (profile.mode === 'dhcp') {
    settings.push('ipv4.method auto')
  } else {
    settings.push(
      'ipv4.method manual',
      `ipv4.addresses ${shQuote(`${profile.ip ?? ''}/${profile.cidr ?? 24}`)}`
    )
    if (profile.gateway) settings.push(`ipv4.gateway ${shQuote(profile.gateway)}`)
    if (profile.dns && profile.dns.length > 0)
      settings.push(`ipv4.dns ${shQuote(profile.dns.join(' '))}`)
  }
  steps.push(`nmcli connection add ${settings.join(' ')}`)
  steps.push(`nmcli -w ${NM_UP_TIMEOUT_S} connection up id ${name}`)
  return `nmcli connection delete id ${name} >/dev/null 2>&1; ${steps.join(' && ')}`
}
