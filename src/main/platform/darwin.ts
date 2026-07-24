import { run } from '../util/run-command'
import { normalizeMac } from '../../shared/mac'
import { cidrToDotted } from '../../shared/net'
import { shQuote } from '../privilege'
import type { ElevatedPlan } from '../privilege'
import type { PingOptions, PingSpec, PlatformOps, RawAdapter } from './index'
import type { NetInfo, Profile } from '../../shared/types'

// macOS. Verified against real output (ASIX AX88179A dongle):
//  - `networksetup -listallhardwareports` gives port name, device (enX) and MAC.
//  - `ioreg -r -c IOUSBHostDevice -l` gives VID/PID + IOMACAddress for USB devices.
// The join is done on MAC address (the USB device's IOMACAddress == the port's Ethernet Address).

export interface HardwarePort {
  portName: string
  device: string
  mac: string
}

export interface UsbMacEntry {
  mac: string
  vendorId: string
  productId: string
  vendorName?: string
  productName?: string
}

/** Parse the blocks from `networksetup -listallhardwareports`. */
export function parseHardwarePorts(output: string): HardwarePort[] {
  const ports: HardwarePort[] = []
  let cur: Partial<HardwarePort> = {}
  const flush = (): void => {
    if (cur.device) {
      ports.push({ portName: cur.portName ?? '', device: cur.device, mac: cur.mac ?? '' })
    }
    cur = {}
  }
  for (const line of output.split(/\r?\n/)) {
    const port = line.match(/^Hardware Port:\s*(.*)$/)
    const dev = line.match(/^Device:\s*(.*)$/)
    const eth = line.match(/^Ethernet Address:\s*(.*)$/)
    if (port) {
      flush()
      cur.portName = port[1].trim()
    } else if (dev) {
      cur.device = dev[1].trim()
    } else if (eth) {
      const value = eth[1].trim()
      cur.mac = /^[0-9a-fA-F:]{17}$/.test(value) ? value.toLowerCase() : ''
    }
  }
  flush()
  return ports
}

function toHex4(decimal: string): string {
  return (parseInt(decimal, 10) & 0xffff).toString(16).padStart(4, '0')
}

/**
 * Parse USB devices from `ioreg ... -l`. VID/PID is copied by the USB stack down to
 * the child nodes, so we carry forward the most recently seen values and emit when IOMACAddress appears.
 */
export function parseIoregUsbMacs(output: string): UsbMacEntry[] {
  const entries: UsbMacEntry[] = []
  let vid = ''
  let pid = ''
  let vendorName: string | undefined
  let productName: string | undefined
  for (const line of output.split(/\r?\n/)) {
    let m: RegExpMatchArray | null
    if ((m = line.match(/"idVendor"\s*=\s*(\d+)/))) {
      vid = toHex4(m[1])
    } else if ((m = line.match(/"idProduct"\s*=\s*(\d+)/))) {
      pid = toHex4(m[1])
    } else if ((m = line.match(/"USB Vendor Name"\s*=\s*"([^"]*)"/))) {
      vendorName = m[1]
    } else if ((m = line.match(/"USB Product Name"\s*=\s*"([^"]*)"/))) {
      productName = m[1]
    } else if ((m = line.match(/"IOMACAddress"\s*=\s*<([0-9a-fA-F]+)>/))) {
      const hex = m[1].toLowerCase()
      if (hex.length === 12 && vid && pid) {
        entries.push({
          mac: (hex.match(/.{2}/g) as string[]).join(':'),
          vendorId: vid,
          productId: pid,
          vendorName,
          productName
        })
      }
    }
  }
  return entries
}

/** Join on MAC: pair USB devices with hardware ports. Only matching USB dongles are returned. */
export function joinDarwinAdapters(ports: HardwarePort[], usb: UsbMacEntry[]): RawAdapter[] {
  const byMac = new Map<string, HardwarePort>()
  for (const port of ports) {
    if (!port.mac) continue
    try {
      byMac.set(normalizeMac(port.mac), port)
    } catch {
      continue
    }
  }
  const adapters: RawAdapter[] = []
  for (const entry of usb) {
    let key: string
    try {
      key = normalizeMac(entry.mac)
    } catch {
      continue
    }
    const port = byMac.get(key)
    if (!port) continue
    adapters.push({
      device: port.device,
      portName: port.portName,
      mac: key,
      usb: {
        vendorId: entry.vendorId,
        productId: entry.productId,
        vendorName: entry.vendorName,
        productName: entry.productName
      }
    })
  }
  return adapters
}

async function enumerateAdapters(): Promise<RawAdapter[]> {
  const [ports, usb] = await Promise.all([
    run('networksetup', ['-listallhardwareports']),
    run('ioreg', ['-r', '-c', 'IOUSBHostDevice', '-l'], { timeoutMs: 10000 })
  ])
  return joinDarwinAdapters(parseHardwarePorts(ports.stdout), parseIoregUsbMacs(usb.stdout))
}

// --- Netinfo (M2) ---

/** Hex netmask (0xfffffe00) -> dotted (255.255.254.0) + prefix length (23). */
function hexNetmaskToParts(hex: string): { dotted: string; cidr: number } {
  const n = parseInt(hex, 16) >>> 0
  const octets = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  const cidr = octets.reduce((sum, o) => sum + (o.toString(2).match(/1/g) ?? []).length, 0)
  return { dotted: octets.join('.'), cidr }
}

export interface IfconfigInfo {
  mac?: string
  ipv4?: string
  netmask?: string
  cidr?: number
  linkUp: boolean
  linkSpeedMbps?: number
  duplex?: string
  mediaRaw?: string
}

export function parseIfconfig(output: string): IfconfigInfo {
  const info: IfconfigInfo = { linkUp: false }
  const ether = output.match(/\bether\s+([0-9a-f:]{17})/i)
  if (ether) info.mac = ether[1].toLowerCase()
  const inet = output.match(/\binet\s+(\d+\.\d+\.\d+\.\d+)\s+netmask\s+(0x[0-9a-f]+)/i)
  if (inet) {
    info.ipv4 = inet[1]
    const nm = hexNetmaskToParts(inet[2])
    info.netmask = nm.dotted
    info.cidr = nm.cidr
  }
  const media = output.match(/media:\s*(.+)/)
  if (media) {
    info.mediaRaw = media[1].trim()
    const speed = media[1].match(/(\d+)base/i)
    if (speed) info.linkSpeedMbps = parseInt(speed[1], 10)
    const duplex = media[1].match(/<([^>]*duplex[^>]*)>/i)
    if (duplex) info.duplex = duplex[1].replace(/-duplex/i, '')
  }
  const status = output.match(/status:\s*(\w+)/)
  if (status) info.linkUp = status[1].toLowerCase() === 'active'
  return info
}

export interface SummaryInfo {
  dhcp: boolean
  gateway?: string
  dhcpServer?: string
  dnsServers: string[]
  domain?: string
  leaseStart?: string
  leaseExpiration?: string
  state?: string
}

export function parseIpconfigSummary(output: string): SummaryInfo {
  const info: SummaryInfo = { dhcp: false, dnsServers: [] }
  const cfg = output.match(/ConfigMethod\s*:\s*(\w+)/)
  if (cfg) info.dhcp = cfg[1].toUpperCase() === 'DHCP'
  const router = output.match(/\n\s*Router\s*:\s*([\d.]+)/)
  if (router) info.gateway = router[1]
  const server = output.match(/server_identifier \(ip\):\s*([\d.]+)/)
  if (server) info.dhcpServer = server[1]
  const dns = output.match(/domain_name_server \(ip_mult\):\s*\{([^}]*)\}/)
  if (dns) {
    info.dnsServers = dns[1]
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  const domain = output.match(/domain_name \(string\):\s*(.+)/)
  if (domain) info.domain = domain[1].trim()
  const ls = output.match(/LeaseStartTime\s*:\s*(.+)/)
  if (ls) info.leaseStart = ls[1].trim()
  const le = output.match(/LeaseExpirationTime\s*:\s*(.+)/)
  if (le) info.leaseExpiration = le[1].trim()
  const state = output.match(/\bState\s*:\s*(\w+)/)
  if (state) info.state = state[1]
  return info
}

async function readNetInfo(device: string): Promise<NetInfo> {
  const [ifc, sum] = await Promise.all([
    run('ifconfig', [device]),
    run('ipconfig', ['getsummary', device], { timeoutMs: 6000 })
  ])
  const i = parseIfconfig(ifc.stdout)
  const s = parseIpconfigSummary(sum.stdout)
  return {
    device,
    linkUp: i.linkUp,
    mac: i.mac ?? '',
    ipv4: i.ipv4,
    netmask: i.netmask,
    cidr: i.cidr,
    gateway: s.gateway,
    dnsServers: s.dnsServers,
    dhcp: {
      enabled: s.dhcp,
      server: s.dhcpServer,
      domain: s.domain,
      leaseStart: s.leaseStart,
      leaseExpiration: s.leaseExpiration,
      state: s.state
    },
    linkSpeedMbps: i.linkSpeedMbps,
    duplex: i.duplex,
    mediaRaw: i.mediaRaw
  }
}

function pingCommand(target: string, opts: PingOptions): PingSpec {
  // macOS: -c count, -W response time in ms, -b binds to interface.
  return { file: 'ping', args: ['-c', String(opts.count), '-W', '1000', '-b', opts.device, target] }
}

// --- Active control (M4). Pure script builders are tested; the actual execution requires sudo (SUDO-TEST.md). ---

/** Look up the network service name (which networksetup requires) for a device via listnetworkserviceorder. */
export function parseNetworkServiceName(output: string, device: string): string | undefined {
  const lines = output.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`Device: ${device})`)) {
      const m = lines[i - 1]?.match(/^\(\d+\)\s*(.+)$/)
      if (m) return m[1].trim()
    }
  }
  return undefined
}

export function macSetMacScript(device: string, mac: string): string {
  return `ifconfig ${shQuote(device)} ether ${shQuote(mac)}`
}

export function macProfileScript(device: string, service: string, profile: Profile): string {
  const cmds: string[] = []
  if (profile.macOverride) cmds.push(macSetMacScript(device, profile.macOverride))
  if (profile.mode === 'dhcp') {
    cmds.push(`networksetup -setdhcp ${shQuote(service)}`)
  } else {
    const mask = cidrToDotted(profile.cidr ?? 24)
    cmds.push(
      `networksetup -setmanual ${shQuote(service)} ${shQuote(profile.ip ?? '')} ${shQuote(mask)} ${shQuote(profile.gateway ?? '')}`
    )
    if (profile.dns && profile.dns.length > 0) {
      cmds.push(`networksetup -setdnsservers ${shQuote(service)} ${profile.dns.map(shQuote).join(' ')}`)
    }
  }
  return cmds.join(' && ')
}

async function serviceNameFor(device: string): Promise<string> {
  const r = await run('networksetup', ['-listnetworkserviceorder'])
  return parseNetworkServiceName(r.stdout, device) ?? device
}

async function buildSetMacPlan(device: string, mac: string): Promise<ElevatedPlan> {
  return { interpreter: 'sh', script: macSetMacScript(device, mac) }
}

async function buildProfilePlan(device: string, profile: Profile): Promise<ElevatedPlan> {
  const service = await serviceNameFor(device)
  return { interpreter: 'sh', script: macProfileScript(device, service, profile) }
}

export const darwin: PlatformOps = {
  id: 'darwin',
  enumerateAdapters,
  readNetInfo,
  pingCommand,
  buildSetMacPlan,
  buildProfilePlan
}
