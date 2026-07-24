import { Resolver } from 'node:dns/promises'
import { run } from '../util/run-command'
import { getPlatform } from '../platform'
import type { DnsResult, NetInfo, PingResult } from '../../shared/types'

/**
 * Parse ping output. Tolerant regexes that cover macOS/Linux ("0.0% packet loss",
 * "min/avg/max = a/b/c") and Windows ("(0% loss)", "Average = Nms").
 */
export function parsePing(output: string, target: string, label: string): PingResult {
  const loss = output.match(/([\d.]+)%\s*(?:packet\s*)?loss/i)
  const lossPct = loss ? parseFloat(loss[1]) : undefined
  let avgMs: number | undefined
  const rtt = output.match(/=\s*[\d.]+\/([\d.]+)\/[\d.]+/)
  if (rtt) {
    avgMs = parseFloat(rtt[1])
  } else {
    const win = output.match(/Average\s*=\s*(\d+)\s*ms/i)
    if (win) avgMs = parseFloat(win[1])
  }
  const ok = lossPct !== undefined ? lossPct < 100 : /ttl[=<]/i.test(output)
  return { target, label, ok, lossPct, avgMs }
}

/** Ping a target bound to the dongle's interface/source IP. */
export async function pingTarget(target: string, label: string, net: NetInfo): Promise<PingResult> {
  const spec = getPlatform().pingCommand(target, { device: net.device, srcIp: net.ipv4, count: 2 })
  const res = await run(spec.file, spec.args, { timeoutMs: 7000 })
  return parsePing(`${res.stdout}\n${res.stderr}`, target, label)
}

/** Test DNS resolution against a specific server (the DHCP-assigned one), via the dongle's path. */
export async function dnsTest(server: string, host = 'one.one.one.one'): Promise<DnsResult> {
  const resolver = new Resolver({ timeout: 3000, tries: 1 })
  resolver.setServers([server])
  const start = Date.now()
  try {
    const addresses = await resolver.resolve4(host)
    return { ok: addresses.length > 0, server, host, addresses, ms: Date.now() - start }
  } catch {
    return { ok: false, server, host, addresses: [], ms: Date.now() - start }
  }
}
