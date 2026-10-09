import { existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from '../util/run-command'
import { normalizeMac } from '../../shared/mac'
import { cidrToDotted, isValidIpv4 } from '../../shared/net'
import { runElevatedShell, shQuote } from '../privilege'
import { channelFromMhz } from '../capabilities/wifi-model'
import { LOOP_MAX_SECONDS, iwScanLoopScript, parseIwScan } from './iw'
import type { IwBss } from './iw'
import type { ElevatedPlan } from '../privilege'
import type {
  PingOptions,
  PingSpec,
  PlatformOps,
  RawAdapter,
  WifiScanOutcome,
  WifiSighting
} from './index'
import type { NetInfo, Profile } from '../../shared/types'

// Linux. Format per documentation — verify on real hardware (spike):
//  - List interfaces via /sys/class/net, MAC via /sys/class/net/<if>/address.
//  - `udevadm info -q property -p /sys/class/net/<if>` gives ID_BUS=usb + ID_VENDOR_ID/ID_MODEL_ID.

/** Parse KEY=VALUE output from `udevadm info -q property`. */
export function parseUdevProperties(output: string): Record<string, string> {
  const props: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) props[m[1]] = m[2]
  }
  return props
}

/**
 * Build a RawAdapter from udev properties. USB is `ID_BUS=usb`, which also carries the VID:PID the
 * chipset database is keyed on. Wireless is `DEVTYPE=wlan`, corroborated by the caller with the
 * `wireless` directory in sysfs; everything else physical is wired.
 *
 * Whether the interface is physical at all is the caller's decision — that is a filesystem
 * question, not a parsing one.
 */
export function udevToRawAdapter(
  iface: string,
  mac: string,
  props: Record<string, string>,
  wireless = false
): RawAdapter {
  const usb = props.ID_BUS === 'usb'
  const vid = (props.ID_VENDOR_ID ?? '').toLowerCase()
  const pid = (props.ID_MODEL_ID ?? '').toLowerCase()
  let normMac = mac
  try {
    normMac = normalizeMac(mac)
  } catch {
    normMac = mac
  }
  return {
    device: iface,
    portName: props.ID_MODEL_FROM_DATABASE || props.ID_MODEL || iface,
    mac: normMac,
    kind: usb ? 'usb' : wireless || props.DEVTYPE === 'wlan' ? 'wifi' : 'ethernet',
    usb:
      usb && vid && pid
        ? {
            vendorId: vid,
            productId: pid,
            vendorName: props.ID_VENDOR_FROM_DATABASE || props.ID_VENDOR,
            productName: props.ID_MODEL_FROM_DATABASE || props.ID_MODEL
          }
        : undefined
  }
}

/**
 * True if the interface is backed by real hardware. Every entry in /sys/class/net is a symlink into
 * /sys/devices, and only hardware-backed ones carry a `device` entry pointing at the PCI/USB node —
 * virtual interfaces resolve under /sys/devices/virtual/net instead. That single check drops lo,
 * docker0, veth*, br-*, virbr*, tun*, wg* and bonds without matching a single name, and it also
 * spares us running udevadm once per interface on a machine full of containers.
 */
function isPhysical(iface: string): boolean {
  return existsSync(`/sys/class/net/${iface}/device`)
}

async function enumerateAdapters(): Promise<RawAdapter[]> {
  let ifaces: string[] = []
  try {
    ifaces = readdirSync('/sys/class/net')
  } catch {
    return []
  }
  const adapters: RawAdapter[] = []
  for (const iface of ifaces) {
    if (!isPhysical(iface)) continue
    let mac = ''
    try {
      mac = readFileSync(`/sys/class/net/${iface}/address`, 'utf8').trim()
    } catch {
      mac = ''
    }
    const wireless = existsSync(`/sys/class/net/${iface}/wireless`)
    const res = await run('udevadm', ['info', '-q', 'property', '-p', `/sys/class/net/${iface}`])
    // udev is what identifies a dongle (ID_BUS, and the VID:PID the chipset database is keyed on),
    // but sysfs alone already proved this is a real port and said whether it is wireless. Listing
    // it unidentified beats listing nothing at all on a system without udevadm.
    const props = res.code === 0 ? parseUdevProperties(res.stdout) : {}
    adapters.push(udevToRawAdapter(iface, mac, props, wireless))
  }
  return adapters
}

// --- Netinfo (M2) — format per documentation, verify on real hardware (spike). ---

interface IpAddrEntry {
  ifname?: string
  address?: string
  operstate?: string
  addr_info?: Array<{ family?: string; local?: string; prefixlen?: number; dynamic?: boolean }>
}

export interface IpAddrInfo {
  mac: string
  linkUp: boolean
  ipv4?: string
  cidr?: number
  dhcp: boolean
}

/** Parse `ip -j addr show dev <if>`. */
export function parseIpAddr(json: string, device: string): IpAddrInfo {
  const arr = JSON.parse(json) as IpAddrEntry[]
  const iface = arr.find((x) => x.ifname === device) ?? arr[0]
  const inet = iface?.addr_info?.find((a) => a.family === 'inet')
  return {
    mac: (iface?.address ?? '').toLowerCase(),
    linkUp: (iface?.operstate ?? '').toUpperCase() === 'UP',
    ipv4: inet?.local,
    cidr: inet?.prefixlen,
    // Best effort, not yet verified on hardware: iproute2 prints "dynamic" for addresses with a
    // finite lifetime, which is what a DHCP lease produces. The key is omitted when the flag is
    // not set, so a static address reads false — the same result as before this was inferred at
    // all. If it turns out unreliable, `ip -j route show default` also carries "protocol":"dhcp".
    dhcp: inet?.dynamic === true
  }
}

/** Parse `ip -j route show default` and pick the gateway for a device. */
export function parseIpRoute(json: string, device: string): string | undefined {
  const arr = JSON.parse(json) as Array<{ dst?: string; gateway?: string; dev?: string }>
  const def =
    arr.find((r) => r.dst === 'default' && r.dev === device) ?? arr.find((r) => r.dst === 'default')
  return def?.gateway
}

/**
 * Parse nameserver lines from /etc/resolv.conf or `resolvectl dns` output. Everything is run
 * through isValidIpv4 so NetInfo.dnsServers only ever holds real IPv4 addresses — resolvectl also
 * lists IPv6 servers, and a loose "digits and dots" filter would let "1.2.3" through.
 */
export function parseDnsServers(output: string): string[] {
  const servers: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const rc = line.match(/^\s*nameserver\s+(\S+)/)
    if (rc) servers.push(rc[1])
    const rl = line.match(/Link\s+\d+\s+\([^)]+\):\s*(.+)$/)
    if (rl) servers.push(...rl[1].split(/[,\s]+/))
  }
  return servers.filter(isValidIpv4)
}

function readSysNumber(path: string): number | undefined {
  try {
    const n = parseInt(readFileSync(path, 'utf8').trim(), 10)
    return Number.isNaN(n) ? undefined : n
  } catch {
    return undefined
  }
}

function readSysString(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

async function readNetInfo(device: string): Promise<NetInfo> {
  const [addrRes, routeRes, dnsRes] = await Promise.all([
    run('ip', ['-j', 'addr', 'show', 'dev', device]),
    run('ip', ['-j', 'route', 'show', 'default']),
    run('resolvectl', ['dns', device])
  ])

  let addr: IpAddrInfo = { mac: '', linkUp: false, dhcp: false }
  try {
    addr = parseIpAddr(addrRes.stdout, device)
  } catch {
    addr = { mac: '', linkUp: false, dhcp: false }
  }

  let gateway: string | undefined
  try {
    gateway = parseIpRoute(routeRes.stdout, device)
  } catch {
    gateway = undefined
  }

  let dnsServers = parseDnsServers(dnsRes.stdout)
  if (dnsServers.length === 0) {
    dnsServers = parseDnsServers(readSysString('/etc/resolv.conf') ?? '')
  }

  const speed = readSysNumber(`/sys/class/net/${device}/speed`)
  const duplex = readSysString(`/sys/class/net/${device}/duplex`)

  return {
    device,
    linkUp: addr.linkUp,
    mac: addr.mac,
    ipv4: addr.ipv4,
    netmask: addr.cidr != null ? cidrToDotted(addr.cidr) : undefined,
    cidr: addr.cidr,
    gateway,
    dnsServers,
    // Only the on/off flag is inferred (see parseIpAddr). Server, lease and domain would need
    // nmcli or lease-file parsing — left out; the renderer treats them as optional.
    dhcp: { enabled: addr.dhcp },
    linkSpeedMbps: speed && speed > 0 ? speed : undefined,
    duplex: duplex ?? undefined
  }
}

function pingCommand(target: string, opts: PingOptions): PingSpec {
  // Linux: -c count, -i interval in seconds, -W timeout in seconds, -I binds to interface.
  // 0.2 s is exactly iputils' floor for an unprivileged user, so five packets take about a second.
  return {
    file: 'ping',
    args: ['-c', String(opts.count), '-i', '0.2', '-W', '1', '-I', opts.device, target]
  }
}

// --- Active control (M4) — documented (iproute2/dhclient), verify on real hardware. ---
// NOTE: raw iproute2 can clash with NetworkManager if it is active (see SUDO-TEST.md).

export function linuxSetMacScript(device: string, mac: string): string {
  const d = shQuote(device)
  return `ip link set dev ${d} down && ip link set dev ${d} address ${shQuote(mac)} && ip link set dev ${d} up`
}

export function linuxProfileScript(device: string, profile: Profile): string {
  const d = shQuote(device)
  const cmds: string[] = []
  if (profile.macOverride) cmds.push(`ip link set dev ${d} address ${shQuote(profile.macOverride)}`)
  cmds.push(`ip addr flush dev ${d}`)
  if (profile.mode === 'dhcp') {
    cmds.push(`sh -c 'dhclient -r ${device} 2>/dev/null; dhclient ${device}'`)
  } else {
    cmds.push(`ip addr add ${shQuote(`${profile.ip ?? ''}/${profile.cidr ?? 24}`)} dev ${d}`)
    if (profile.gateway) {
      cmds.push(`ip route replace default via ${shQuote(profile.gateway)} dev ${d}`)
    }
  }
  return cmds.join(' && ')
}

async function buildSetMacPlan(device: string, mac: string): Promise<ElevatedPlan> {
  return { interpreter: 'sh', script: linuxSetMacScript(device, mac) }
}

async function buildProfilePlan(device: string, profile: Profile): Promise<ElevatedPlan> {
  return { interpreter: 'sh', script: linuxProfileScript(device, profile) }
}

function speedTestBind(device: string): string | undefined {
  // Linux binds a socket to an interface by name, which is what curl --interface does here.
  return device || undefined
}

// --- WLAN mode — documented formats, not yet run on hardware (see docs/WIFI-FINDINGS.md). ---
//
// Reading the kernel's scan cache needs no privilege: `iw dev <if> scan dump`. Triggering a fresh
// sweep does. On a NetworkManager desktop the request goes through it — polkit lets an active
// session ask — and the cache is read afterwards. Without NetworkManager, one password buys an
// elevated loop that scans continuously (iw.ts) and this side waits for each result to land.

/** NetworkManager rejects a rescan inside ten seconds of the previous one, so calls are spaced out. */
const NM_RESCAN_INTERVAL_MS = 10_000
/** A full sweep of every channel; what the Windows API also budgets, with a second to spare. */
const SWEEP_MS = 5000
/** Entries older than this came from an earlier sweep, and re-reading them would be inventing data. */
const MAX_AGE_MS = 15_000
/** The password dialog can sit unanswered; the macOS helper allows the same. */
const FIRST_RESULT_MS = 180_000
const NEXT_RESULT_MS = 15_000
const POLL_MS = 500

let lastRescanAt = 0

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The named interface, or the first wireless one sysfs knows about. */
function wifiInterface(device: string): string | undefined {
  if (device) return device
  try {
    return readdirSync('/sys/class/net').find((i) => existsSync(`/sys/class/net/${i}/wireless`))
  } catch {
    return undefined
  }
}

async function toolPresent(file: string): Promise<boolean> {
  return (await run(file, ['--version'], { timeoutMs: 3000 })).code === 0
}

function toSighting(b: IwBss): WifiSighting | undefined {
  if (b.rssi === undefined) return undefined
  const placed = b.freqMhz === undefined ? undefined : channelFromMhz(b.freqMhz)
  return {
    bssid: b.bssid,
    ssid: b.ssid,
    rssi: b.rssi,
    channel: placed?.channel ?? 0,
    band: placed?.band ?? '?',
    countryCode: b.facts.countryCode,
    beacon: b.facts
  }
}

/**
 * The cache holds up to thirty seconds of history. Everything heard by the latest sweep is kept;
 * if nothing is that fresh — the rescan was refused and nothing else scanned — the older entries
 * are better than a blank screen on a once-scan, and the recording floor already limits the harm.
 */
export function dumpToOutcome(text: string): WifiScanOutcome {
  const all = parseIwScan(text)
  const fresh = all.filter((b) => b.ageMs === undefined || b.ageMs <= MAX_AGE_MS)
  const chosen = fresh.length > 0 ? fresh : all
  return {
    status: 'ok',
    sightings: chosen.map(toSighting).filter((s): s is WifiSighting => s !== undefined)
  }
}

async function scanViaNetworkManager(iface: string): Promise<WifiScanOutcome> {
  const wait = NM_RESCAN_INTERVAL_MS - (Date.now() - lastRescanAt)
  if (wait > 0) await sleep(wait)
  lastRescanAt = Date.now()
  // The answer is deliberately ignored: a refusal inside the window, or an interface NetworkManager
  // does not manage, both leave a cache worth reading. Never `wifi list --rescan yes` — that form
  // blocks for fifteen seconds when the request is refused.
  await run('nmcli', ['device', 'wifi', 'rescan', 'ifname', iface], { timeoutMs: 5000 })
  await sleep(SWEEP_MS)
  const dump = await run('iw', ['dev', iface, 'scan', 'dump'], { timeoutMs: 8000 })
  if (dump.code !== 0) {
    return {
      status: 'error',
      message: `iw could not read the scan results: ${dump.stderr.trim() || `exit ${dump.code}`}`
    }
  }
  return dumpToOutcome(dump.stdout)
}

interface ScanSession {
  device: string
  outFile: string
  stopFile: string
  keepFile: string
  lastMtime: number
  done: boolean
  /** Set when pkexec refused or the user cancelled the dialog. */
  refused: boolean
}

let session: ScanSession | null = null

function touch(file: string): void {
  try {
    writeFileSync(file, '', { flag: 'a' })
    const now = new Date()
    utimesSync(file, now, now)
  } catch {
    // The loop will time out on its own.
  }
}

function mtimeOf(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs
  } catch {
    return undefined
  }
}

function endSession(s: ScanSession): void {
  try {
    writeFileSync(s.stopFile, '')
  } catch {
    // The hard cap in the script is the backstop.
  }
  if (session === s) session = null
}

function startSession(device: string): ScanSession {
  const stamp = `${process.pid}-${Date.now()}`
  const base = path.join(os.tmpdir(), `magiceth-wifi-${stamp}`)
  const s: ScanSession = {
    device,
    outFile: `${base}.txt`,
    stopFile: `${base}.stop`,
    keepFile: `${base}.keep`,
    lastMtime: 0,
    done: false,
    refused: false
  }
  touch(s.keepFile)
  // Fire and forget: this only returns when the loop ends, and the password prompt is inside it.
  // pkexec exits 126 when the dialog is dismissed and 127 when authorization fails.
  runElevatedShell(
    iwScanLoopScript(device, s.outFile, s.stopFile, s.keepFile),
    LOOP_MAX_SECONDS * 1000 + 30_000
  )
    .then((r) => {
      s.done = true
      s.refused = r.code === 126 || r.code === 127
    })
    .catch(() => {
      s.done = true
      s.refused = true
    })
  return s
}

async function scanElevated(iface: string): Promise<WifiScanOutcome> {
  let s = session
  if (s && (s.done || s.device !== iface)) {
    endSession(s)
    s = null
  }
  const fresh = s === null
  if (!s) {
    s = startSession(iface)
    session = s
  }
  touch(s.keepFile)
  const deadline = Date.now() + (fresh ? FIRST_RESULT_MS : NEXT_RESULT_MS)
  while (Date.now() < deadline) {
    if (s.refused) {
      endSession(s)
      return {
        status: 'needs-privilege',
        message:
          'Scanning was cancelled. Without NetworkManager, Linux needs admin rights to ask the Wi-Fi card for a sweep — press R to try again.'
      }
    }
    const mtime = mtimeOf(s.outFile)
    if (mtime !== undefined && mtime > s.lastMtime) {
      s.lastMtime = mtime
      let text = ''
      try {
        text = readFileSync(s.outFile, 'utf8')
      } catch {
        text = ''
      }
      // A sweep refused by the driver (busy, down) prints an error and no BSS; the next one is
      // along in a few seconds, so keep waiting rather than reporting an empty sky.
      if (!/^BSS /m.test(text) && /command failed/.test(text)) {
        continue
      }
      return dumpToOutcome(text)
    }
    if (s.done) break
    await sleep(POLL_MS)
  }
  return { status: 'error', message: 'No scan result arrived from the elevated iw loop.' }
}

async function scanWifi(device: string): Promise<WifiScanOutcome> {
  const iface = wifiInterface(device)
  if (!iface) return { status: 'error', message: 'This machine has no Wi-Fi interface.' }
  if (!(await toolPresent('iw'))) {
    return { status: 'no-tool', message: 'Wi-Fi scanning needs `iw` — install the iw package.' }
  }
  if (await toolPresent('nmcli')) return scanViaNetworkManager(iface)
  if (!(await toolPresent('pkexec'))) {
    return {
      status: 'no-tool',
      message:
        'Triggering a Wi-Fi scan needs NetworkManager (nmcli) or pkexec; neither is installed.'
    }
  }
  return scanElevated(iface)
}

/** Nothing on Linux gates the scan behind a consent dialog; the privilege path asks by itself. */
function requestWifiAccess(): void {}

function endWifiSession(): void {
  if (session) endSession(session)
}

export const linux: PlatformOps = {
  id: 'linux',
  enumerateAdapters,
  readNetInfo,
  pingCommand,
  speedTestBind,
  buildSetMacPlan,
  buildProfilePlan,
  scanWifi,
  requestWifiAccess,
  endWifiSession
}
