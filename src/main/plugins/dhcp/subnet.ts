// Pure: a private /24 for the link that collides with nothing this machine is already on.
// Tested in test/dhcp-subnet.test.ts.

import type { NetworkInterfaceInfo } from 'node:os'
import { cidrToDotted, intToIp, ipToInt } from '../../../shared/net'

export interface LinkSubnet {
  serverIp: string
  cidr: number
  netmask: string
  network: string
  broadcast: string
}

/**
 * Unusual on purpose. 192.168.0/1.x is every home router, 10.0.0.x every office; the top of each
 * private range is where nobody puts anything. Three, so one clash still leaves two.
 */
export const CANDIDATE_NETWORKS = ['10.254.254.0', '172.31.254.0', '192.168.254.0']
const CIDR = 24

function overlaps(candidate: number, candMask: number, addr: number, mask: number): boolean {
  const theirs = (addr & mask) >>> 0
  // Two prefixes overlap when the shorter one contains the longer one's network address.
  return (candidate & mask) >>> 0 === theirs || (theirs & candMask) >>> 0 === candidate
}

export function pickSubnet(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>
): LinkSubnet | undefined {
  const mask = ipToInt(cidrToDotted(CIDR))
  const inUse: { addr: number; mask: number }[] = []
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4') continue
      inUse.push({ addr: ipToInt(a.address), mask: ipToInt(a.netmask) })
    }
  }
  for (const net of CANDIDATE_NETWORKS) {
    const candidate = ipToInt(net)
    if (inUse.some((u) => overlaps(candidate, mask, u.addr, u.mask))) continue
    return {
      serverIp: intToIp(candidate + 1),
      cidr: CIDR,
      netmask: cidrToDotted(CIDR),
      network: net,
      broadcast: intToIp((candidate | ~mask) >>> 0)
    }
  }
  return undefined
}
