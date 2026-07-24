import { getPlatform } from '../platform'
import { dnsTest, pingTarget } from './probe'
import type { Diagnostics } from '../../shared/types'

/**
 * Run full diagnostics for an interface: read netinfo, and if the link is up —
 * ping gateway + internet (1.1.1.1, 8.8.8.8) and test DNS, all in parallel.
 */
export async function runDiagnostics(device: string): Promise<Diagnostics> {
  const net = await getPlatform().readNetInfo(device)
  const ranAt = new Date().toISOString()

  if (!net.linkUp) {
    return { device, net, internetPings: [], ranAt }
  }

  const [gatewayPing, ping1, ping2, dns] = await Promise.all([
    net.gateway ? pingTarget(net.gateway, 'Gateway', net) : Promise.resolve(undefined),
    pingTarget('1.1.1.1', '1.1.1.1', net),
    pingTarget('8.8.8.8', '8.8.8.8', net),
    net.dnsServers[0] ? dnsTest(net.dnsServers[0]) : Promise.resolve(undefined)
  ])

  return { device, net, gatewayPing, internetPings: [ping1, ping2], dns, ranAt }
}
