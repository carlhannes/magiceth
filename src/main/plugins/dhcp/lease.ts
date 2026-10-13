// Pure: what to answer a DHCP message with, if anything. Tested in test/dhcp-lease.test.ts.
//
// The server this feeds listens on every interface of a laptop that is usually also on an
// office LAN, so the rule is: answer only what unambiguously belongs to this link's pool, send
// every answer to this link's broadcast, and never send a NAK. A production access point renewing
// its lease over Wi-Fi must come out of here with nothing — see docs/ARCHITECTURE.md.

import { intToIp, ipToInt } from '../../../shared/net'
import type { DhcpEvent } from '../../../shared/plugin'
import {
  BOOTREQUEST,
  buildReply,
  DHCP,
  hostname,
  ipToBytes,
  messageType,
  OPT,
  requestedIp,
  serverId,
  u32,
  vendorClass
} from './codec'
import type { DhcpMessage, DhcpOption } from './codec'

/** The pool is `.10`–`.49` of the link's /24: forty devices is more than anyone plugs into one port. */
export const POOL_START = 10
export const POOL_END = 49
export const DEFAULT_LEASE_SECONDS = 120

export interface LeaseConfig {
  serverIp: string
  cidr: number
  netmask: string
  broadcast: string
  poolStart: number
  poolEnd: number
  leaseSeconds: number
  vendorClassPrefix?: string
  /** The plugin's options, appended to the standard ones on every OFFER and ACK. */
  extraOptions: DhcpOption[]
}

/** MAC → address. Immutable; every decision returns the next table. */
export type LeaseTable = Readonly<Record<string, string>>

export interface Decision {
  reply?: Buffer
  events: DhcpEvent[]
  table: LeaseTable
}

function networkOf(cfg: LeaseConfig): number {
  return (ipToInt(cfg.serverIp) & ipToInt(cfg.netmask)) >>> 0
}

function poolAddress(cfg: LeaseConfig, index: number): string {
  return intToIp(networkOf(cfg) + index)
}

export function inPool(cfg: LeaseConfig, ip: string): boolean {
  const offset = ipToInt(ip) - networkOf(cfg)
  return offset >= cfg.poolStart && offset <= cfg.poolEnd
}

function firstFree(cfg: LeaseConfig, table: LeaseTable): string | undefined {
  const taken = new Set(Object.values(table))
  for (let i = cfg.poolStart; i <= cfg.poolEnd; i++) {
    const ip = poolAddress(cfg, i)
    if (!taken.has(ip)) return ip
  }
  return undefined
}

function reply(msg: DhcpMessage, cfg: LeaseConfig, type: number, ip: string): Buffer {
  const options: DhcpOption[] = [
    { code: OPT.MESSAGE_TYPE, data: Buffer.from([type]) },
    { code: OPT.SERVER_ID, data: ipToBytes(cfg.serverIp) },
    { code: OPT.LEASE_TIME, data: u32(cfg.leaseSeconds) },
    { code: OPT.SUBNET_MASK, data: ipToBytes(cfg.netmask) },
    // The router is this machine. Nothing is forwarded, so it costs nothing, and a client that
    // insists on a default route gets one that goes nowhere rather than no lease at all.
    { code: OPT.ROUTER, data: ipToBytes(cfg.serverIp) },
    { code: OPT.BROADCAST, data: ipToBytes(cfg.broadcast) },
    ...cfg.extraOptions
  ]
  return buildReply({
    xid: msg.xid,
    flags: msg.flags,
    htype: msg.htype,
    hlen: msg.hlen,
    chaddr: msg.chaddr,
    ciaddr: msg.ciaddr !== '0.0.0.0' ? msg.ciaddr : undefined,
    yiaddr: ip,
    options
  })
}

function silent(table: LeaseTable): Decision {
  return { events: [], table }
}

function ignored(table: LeaseTable, mac: string, reason: string): Decision {
  return { events: [{ kind: 'ignored', mac, reason }], table }
}

function without(table: LeaseTable, mac: string): LeaseTable {
  const next = { ...table }
  delete next[mac]
  return next
}

export function decide(msg: DhcpMessage, table: LeaseTable, cfg: LeaseConfig): Decision {
  if (msg.op !== BOOTREQUEST) return silent(table)
  const mac = msg.mac
  if (msg.giaddr !== '0.0.0.0') return ignored(table, mac, 'relayed through a gateway')
  const type = messageType(msg)
  if (type === undefined) return ignored(table, mac, 'no DHCP message type (plain BOOTP)')

  const vc = vendorClass(msg)
  if (cfg.vendorClassPrefix && !(vc ?? '').startsWith(cfg.vendorClassPrefix)) {
    return ignored(table, mac, vc ? `vendor class "${vc}"` : 'no vendor class')
  }

  switch (type) {
    case DHCP.DISCOVER: {
      const events: DhcpEvent[] = [
        { kind: 'discover', mac, vendorClass: vc, hostname: hostname(msg) }
      ]
      const ip = table[mac] ?? firstFree(cfg, table)
      if (!ip) {
        events.push({ kind: 'error', message: 'The address pool is full.' })
        return { events, table }
      }
      events.push({ kind: 'offer', mac, ip })
      return { reply: reply(msg, cfg, DHCP.OFFER, ip), events, table: { ...table, [mac]: ip } }
    }
    case DHCP.REQUEST: {
      // Another server's client, or one that never had an address from this pool: not ours to
      // answer, and not ours to refuse either — a NAK here would reach the office LAN.
      const sid = serverId(msg)
      if (sid && sid !== cfg.serverIp) return silent(table)
      const wanted = requestedIp(msg) ?? (msg.ciaddr !== '0.0.0.0' ? msg.ciaddr : undefined)
      if (!wanted || !inPool(cfg, wanted)) return silent(table)
      const holder = Object.entries(table).find(([m, ip]) => ip === wanted && m !== mac)
      if (holder) return silent(table)
      return {
        reply: reply(msg, cfg, DHCP.ACK, wanted),
        events: [{ kind: 'ack', mac, ip: wanted }],
        table: { ...table, [mac]: wanted }
      }
    }
    case DHCP.RELEASE: {
      const ip = table[mac]
      if (!ip) return silent(table)
      return { events: [{ kind: 'release', mac, ip }], table: without(table, mac) }
    }
    case DHCP.DECLINE: {
      // The client found the address in use. Forget it; the next DISCOVER gets the next one.
      if (!table[mac]) return silent(table)
      return {
        events: [{ kind: 'ignored', mac, reason: 'declined its address' }],
        table: without(table, mac)
      }
    }
    default:
      return silent(table)
  }
}
