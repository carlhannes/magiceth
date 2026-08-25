import { Resolver } from 'node:dns/promises'
import { run } from '../util/run-command'
import { getPlatform } from '../platform'
import type { DnsResult, NetInfo, PingResult } from '../../shared/types'

/**
 * Parse ping output. Tolerant regexes that cover macOS/Linux ("0.0% packet loss",
 * "min/avg/max/stddev = a/b/c/d") and Windows ("(0% loss)", "Average = Nms").
 *
 * The deviation is the fourth field on macOS ("stddev") and Linux ("mdev") and is absent from
 * Windows output entirely, so jitter is optional rather than assumed.
 */
export function parsePing(output: string, target: string, label: string): PingResult {
  const loss = output.match(/([\d.]+)%\s*(?:packet\s*)?loss/i)
  const lossPct = loss ? parseFloat(loss[1]) : undefined
  let avgMs: number | undefined
  let jitterMs: number | undefined
  const rtt = output.match(/=\s*[\d.]+\/([\d.]+)\/[\d.]+(?:\/([\d.]+))?/)
  if (rtt) {
    avgMs = parseFloat(rtt[1])
    if (rtt[2] !== undefined) jitterMs = parseFloat(rtt[2])
  } else {
    const win = output.match(/Average\s*=\s*(\d+)\s*ms/i)
    if (win) avgMs = parseFloat(win[1])
  }
  const ok = lossPct !== undefined ? lossPct < 100 : /ttl[=<]/i.test(output)
  return { target, label, ok, lossPct, avgMs, jitterMs }
}

/**
 * How many echo requests each ping sends. Loss is a fraction of this, so two packets could only
 * ever report 0/50/100% — five gives a figure worth showing. macOS and Linux space them 0.2 s
 * apart and finish in about a second; Windows has no interval flag and takes about four.
 */
const PING_COUNT = 5

/** Ping a target bound to the adapter's interface/source IP. */
export async function pingTarget(target: string, label: string, net: NetInfo): Promise<PingResult> {
  const spec = getPlatform().pingCommand(target, {
    device: net.device,
    srcIp: net.ipv4,
    count: PING_COUNT
  })
  // Long enough for the Windows pace (a second per packet, plus the last reply's own timeout).
  const res = await run(spec.file, spec.args, { timeoutMs: 9000 })
  return parsePing(`${res.stdout}\n${res.stderr}`, target, label)
}

/**
 * Test DNS resolution against a specific server (the DHCP-assigned one). Unlike the pings this
 * is not bound to the adapter — Node's Resolver has no interface binding, so the query follows the
 * OS routing table. It still answers "does the DNS server this port handed me actually work".
 */
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
