// One DHCP session on one port: the address-hold script (elevated, survey.ts shape), then the
// unprivileged server once the address is there, then both taken down again.
//
// One active session at module level, every asynchronous continuation re-checking that it is
// still the current one — the pattern survey.ts and wifiscan.ts set.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getPlatform } from '../../platform'
import type { Upstream } from '../../platform'
import { runElevatedPlan } from '../../privilege'
import { isLinkLocalIpv4 } from '../../../shared/net'
import type { DhcpEvent, DhcpSession, DhcpSpec } from '../../../shared/plugin'
import { hexToBytes } from './codec'
import type { DhcpOption } from './codec'
import { DEFAULT_LEASE_SECONDS, POOL_END, POOL_START } from './lease'
import { startDhcpServer } from './server'
import type { DhcpServerHandle } from './server'
import { pickSubnet } from './subnet'
import type { LinkSubnet } from './subnet'

/** Hard cap, so a lost stop file can never leave an address on a port forever. */
export const MAX_SECONDS = 900
/** The password dialog can sit unanswered; the Wi-Fi helpers allow the same. */
const ADDRESS_WAIT_MS = 180_000
const POLL_MS = 500

interface ActiveSession {
  device: string
  subnet: LinkSubnet
  /** Set when the session shares this computer's internet with the link. */
  upstream?: Upstream
  stopFile: string
  startedAt: number
  server?: DhcpServerHandle
  poll?: NodeJS.Timeout
  cap?: NodeJS.Timeout
  onEvent: (event: DhcpEvent) => void
}

let active: ActiveSession | null = null

function hasAddress(device: string, ip: string): boolean {
  return (os.networkInterfaces()[device] ?? []).some((a) => a.family === 'IPv4' && a.address === ip)
}

function toOptions(spec: DhcpSpec, subnet: LinkSubnet): DhcpOption[] {
  return spec
    .options({ serverIp: subnet.serverIp, cidr: subnet.cidr, broadcast: subnet.broadcast })
    .map((o) => {
      if (!Number.isInteger(o.code) || o.code < 1 || o.code > 254) {
        throw new Error(`DHCP option code ${o.code} is out of range.`)
      }
      return { code: o.code, data: hexToBytes(o.hex) }
    })
}

/** The one place every end goes through, whatever the reason. */
function finish(s: ActiveSession, reason: string, error?: string): void {
  if (active !== s) return
  active = null
  if (s.poll) clearInterval(s.poll)
  if (s.cap) clearTimeout(s.cap)
  s.server?.close()
  // The elevated loop is watching for this and removes the address itself — no second prompt.
  try {
    fs.writeFileSync(s.stopFile, '')
  } catch {
    // The hard cap in the script is the backstop.
  }
  if (error) s.onEvent({ kind: 'error', message: error })
  s.onEvent({ kind: 'stopped', reason })
}

async function bindServer(
  s: ActiveSession,
  options: DhcpOption[],
  leaseSeconds: number,
  vendorClassPrefix?: string
): Promise<void> {
  try {
    const server = await startDhcpServer(
      {
        serverIp: s.subnet.serverIp,
        cidr: s.subnet.cidr,
        netmask: s.subnet.netmask,
        broadcast: s.subnet.broadcast,
        poolStart: POOL_START,
        poolEnd: POOL_END,
        leaseSeconds,
        vendorClassPrefix,
        dnsServers: s.upstream?.dnsServers,
        extraOptions: options
      },
      (event) => {
        if (active === s) s.onEvent(event)
      }
    )
    if (active !== s) {
      server.close()
      return
    }
    s.server = server
    s.onEvent({
      kind: 'address',
      serverIp: s.subnet.serverIp,
      cidr: s.subnet.cidr,
      ...(s.upstream ? { upstream: s.upstream } : {})
    })
    s.cap = setTimeout(() => finish(s, 'the 15-minute cap was reached'), MAX_SECONDS * 1000)
  } catch (err) {
    finish(s, 'could not start', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Start a session. Resolves as soon as the elevated hold is launched; the `address` event says
 * when the server is actually listening. Rejects with a human-readable message when it cannot
 * start at all — another DHCP server on the link, no free subnet, a bad option.
 */
export async function startDhcpSession(device: string, spec: DhcpSpec): Promise<DhcpSession> {
  stopDhcpSession('replaced by a new session')

  const net = await getPlatform().readNetInfo(device)
  if (net.dhcp.enabled && net.ipv4 && !isLinkLocalIpv4(net.ipv4)) {
    const who = net.dhcp.server ? ` (${net.dhcp.server})` : ''
    throw new Error(
      `This port already has a DHCP server${who}. Connect the device to this port and nothing else, then try again.`
    )
  }

  const subnet = pickSubnet(os.networkInterfaces())
  if (!subnet) {
    throw new Error(
      'No free private subnet for the link — every candidate overlaps a network this computer is on.'
    )
  }
  const options = toOptions(spec, subnet)
  const leaseSeconds = spec.leaseSeconds ?? DEFAULT_LEASE_SECONDS

  // Sharing needs somewhere to send the traffic. Every way that can fail is checked here, before
  // the prompt, so a refusal costs no password.
  let upstream: Upstream | undefined
  if (spec.shareInternet) {
    const readUpstream = getPlatform().readUpstream
    if (!readUpstream) {
      throw new Error(
        "Sharing this computer's internet with the port is not available on this OS yet."
      )
    }
    upstream = await readUpstream()
    if (!upstream) {
      throw new Error(
        'This computer has no internet connection to share — connect it (Wi-Fi, a phone) first.'
      )
    }
    if (upstream.device === device) {
      throw new Error(
        `${device} is this computer's own internet connection; use another port for the device.`
      )
    }
    if (upstream.dnsServers.length === 0) {
      throw new Error(
        `No DNS servers are known on ${upstream.device}, so the device would have none.`
      )
    }
  }

  const stopFile = path.join(os.tmpdir(), `magiceth-dhcp-${process.pid}-${Date.now()}.stop`)
  const plan = await getPlatform().buildAddressHoldPlan(
    device,
    { ip: subnet.serverIp, cidr: subnet.cidr, upstream: upstream?.device },
    stopFile,
    MAX_SECONDS
  )

  // Everything from here to the launch is synchronous, so a second start cannot take over
  // `active` in between and leave a hold script nothing is tracking.
  const s: ActiveSession = {
    device,
    subnet,
    upstream,
    stopFile,
    startedAt: Date.now(),
    onEvent: spec.onEvent
  }
  active = s

  runElevatedPlan(plan, MAX_SECONDS * 1000 + 30_000)
    .then((r) => {
      if (active !== s) return
      // Still current when the script returned: either the prompt was refused (non-zero exit,
      // or the OS saying so), or the cap in the script ran out before ours did.
      if (r.code !== 0 || /not authorized|cancel/i.test(r.stderr)) {
        finish(
          s,
          'could not start',
          'The address could not be put on the port — the admin prompt was cancelled, or the command failed.'
        )
      } else {
        finish(s, 'the address hold ended')
      }
    })
    .catch((err) => {
      if (active !== s) return
      finish(
        s,
        'could not start',
        `Elevation failed: ${err instanceof Error ? err.message : String(err)}`
      )
    })

  s.poll = setInterval(() => {
    if (active !== s) return
    if (hasAddress(device, subnet.serverIp)) {
      clearInterval(s.poll)
      s.poll = undefined
      void bindServer(s, options, leaseSeconds, spec.vendorClassPrefix)
    } else if (Date.now() - s.startedAt > ADDRESS_WAIT_MS) {
      finish(s, 'could not start', 'No address appeared on the port within three minutes.')
    }
  }, POLL_MS)

  return {
    serverIp: subnet.serverIp,
    cidr: subnet.cidr,
    broadcast: subnet.broadcast,
    stop: () => {
      if (active === s) finish(s, 'stopped')
    }
  }
}

/** Stop the running session, if any. Safe to call when none is running; synchronous. */
export function stopDhcpSession(reason = 'stopped'): void {
  if (active) finish(active, reason)
}

export function dhcpSessionRunning(): boolean {
  return active !== null
}
