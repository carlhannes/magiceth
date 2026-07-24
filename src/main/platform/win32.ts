import { run } from '../util/run-command'
import { normalizeMac } from '../../shared/mac'
import { cidrToDotted } from '../../shared/net'
import type { ElevatedPlan } from '../privilege'
import type { PingOptions, PingSpec, PlatformOps, RawAdapter } from './index'
import type { NetInfo, Profile } from '../../shared/types'

// Windows. Format per documentation — verify on real hardware (spike):
//  - `Get-NetAdapter | Select ... | ConvertTo-Json` gives adapters; USB dongles have
//    a PnpDeviceID starting with "USB\VID_xxxx&PID_xxxx".

// The keys are intentionally lowercase and come from calculated properties in the PowerShell below,
// so we never depend on the casing of the CIM properties (e.g. PNPDeviceID).
interface NetAdapterRaw {
  name?: string
  desc?: string
  mac?: string
  pnp?: string
}

/** Parse JSON from Get-NetAdapter and extract USB dongles with VID:PID from PNPDeviceID. */
export function parseGetNetAdapter(json: string): RawAdapter[] {
  const parsed: unknown = JSON.parse(json)
  const data: NetAdapterRaw[] = Array.isArray(parsed)
    ? (parsed as NetAdapterRaw[])
    : [parsed as NetAdapterRaw]
  const adapters: RawAdapter[] = []
  for (const a of data) {
    const pnp = a.pnp ?? ''
    if (!/^USB/i.test(pnp)) continue
    const m = pnp.match(/VID_([0-9A-Fa-f]{4}).*?PID_([0-9A-Fa-f]{4})/)
    let mac = ''
    try {
      mac = normalizeMac(a.mac ?? '')
    } catch {
      mac = ''
    }
    adapters.push({
      device: a.name ?? '',
      portName: a.desc ?? a.name ?? '',
      mac,
      usb: m
        ? { vendorId: m[1].toLowerCase(), productId: m[2].toLowerCase(), productName: a.desc }
        : undefined
    })
  }
  return adapters
}

async function enumerateAdapters(): Promise<RawAdapter[]> {
  // Calculated properties -> guaranteed JSON keys regardless of the CIM properties' casing.
  const cmd =
    'Get-NetAdapter | Select-Object ' +
    "@{N='name';E={$_.Name}}," +
    "@{N='desc';E={$_.InterfaceDescription}}," +
    "@{N='mac';E={$_.MacAddress}}," +
    "@{N='pnp';E={$_.PNPDeviceID}} | ConvertTo-Json -Compress"
  const res = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    timeoutMs: 10000
  })
  if (res.code !== 0 || !res.stdout.trim()) return []
  try {
    return parseGetNetAdapter(res.stdout)
  } catch {
    return []
  }
}

// --- Netinfo (M2) — format per documentation, verify on real hardware (spike). ---

/** "1 Gbps" -> 1000, "100 Mbps" -> 100, "2.5 Gbps" -> 2500. */
export function parseLinkSpeedMbps(value?: string): number | undefined {
  if (!value) return undefined
  const m = value.match(/([\d.]+)\s*(gbps|mbps|kbps)/i)
  if (!m) return undefined
  const n = parseFloat(m[1])
  const unit = m[2].toLowerCase()
  if (unit === 'gbps') return Math.round(n * 1000)
  if (unit === 'mbps') return Math.round(n)
  return Math.round(n / 1000)
}

interface WinNetRaw {
  mac?: string
  status?: string
  linkSpeed?: string
  ip?: string
  prefix?: number
  origin?: string
  gateway?: string
  dns?: string[] | string
}

/** Parse the aggregated JSON object from the readNetInfo script. */
export function parseWinNetInfo(json: string, device: string): NetInfo {
  const r = JSON.parse(json) as WinNetRaw
  let mac = ''
  try {
    mac = normalizeMac(r.mac ?? '')
  } catch {
    mac = (r.mac ?? '').toLowerCase()
  }
  const dnsServers = Array.isArray(r.dns) ? r.dns : r.dns ? [r.dns] : []
  return {
    device,
    linkUp: (r.status ?? '').toLowerCase() === 'up',
    mac,
    ipv4: r.ip,
    netmask: r.prefix != null ? cidrToDotted(r.prefix) : undefined,
    cidr: r.prefix,
    gateway: r.gateway,
    dnsServers,
    dhcp: { enabled: (r.origin ?? '').toLowerCase() === 'dhcp' },
    linkSpeedMbps: parseLinkSpeedMbps(r.linkSpeed)
  }
}

async function readNetInfo(device: string): Promise<NetInfo> {
  const dev = device.replace(/'/g, "''")
  const script = `$ErrorActionPreference='SilentlyContinue';$dev='${dev}';` +
    `$a=Get-NetAdapter -Name $dev;` +
    `$ip=Get-NetIPAddress -InterfaceAlias $dev -AddressFamily IPv4 | Select-Object -First 1;` +
    `$gw=(Get-NetRoute -InterfaceAlias $dev -DestinationPrefix '0.0.0.0/0' | Select-Object -First 1).NextHop;` +
    `$dns=(Get-DnsClientServerAddress -InterfaceAlias $dev -AddressFamily IPv4).ServerAddresses;` +
    `[pscustomobject]@{mac=$a.MacAddress;status=[string]$a.Status;linkSpeed=$a.LinkSpeed;ip=$ip.IPAddress;prefix=$ip.PrefixLength;origin=[string]$ip.PrefixOrigin;gateway=$gw;dns=$dns} | ConvertTo-Json -Compress`
  const res = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeoutMs: 10000
  })
  return parseWinNetInfo(res.stdout, device)
}

function pingCommand(target: string, opts: PingOptions): PingSpec {
  // Windows: -n count, -w timeout in ms, -S binds source IP (interface binding is not available).
  const args = ['-n', String(opts.count), '-w', '1000']
  if (opts.srcIp) args.push('-S', opts.srcIp)
  args.push(target)
  return { file: 'ping', args }
}

// --- Active control (M4) — documented (PowerShell/netsh), verify on real hardware. ---
// The scripts are base64-encoded before execution (runElevatedPlan) so quotes are harmless.

export function winSetMacScript(device: string, mac: string): string {
  const bare = mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  // Requires the driver to expose the NetworkAddress property (most USB NICs do).
  return (
    `Set-NetAdapterAdvancedProperty -Name "${device}" -RegistryKeyword "NetworkAddress" ` +
    `-RegistryValue "${bare}" -NoRestart; Restart-NetAdapter -Name "${device}"`
  )
}

export function winProfileScript(device: string, profile: Profile): string {
  const cmds: string[] = []
  if (profile.macOverride) cmds.push(winSetMacScript(device, profile.macOverride))
  if (profile.mode === 'dhcp') {
    cmds.push(`netsh interface ip set address name="${device}" source=dhcp`)
    cmds.push(`netsh interface ip set dns name="${device}" source=dhcp`)
  } else {
    const mask = cidrToDotted(profile.cidr ?? 24)
    cmds.push(
      `netsh interface ip set address name="${device}" static ${profile.ip ?? ''} ${mask} ${profile.gateway ?? ''}`
    )
    if (profile.dns && profile.dns.length > 0) {
      cmds.push(`netsh interface ip set dns name="${device}" static ${profile.dns[0]}`)
    }
  }
  return cmds.join('; ')
}

async function buildSetMacPlan(device: string, mac: string): Promise<ElevatedPlan> {
  return { interpreter: 'powershell', script: winSetMacScript(device, mac) }
}

async function buildProfilePlan(device: string, profile: Profile): Promise<ElevatedPlan> {
  return { interpreter: 'powershell', script: winProfileScript(device, profile) }
}

export const win32: PlatformOps = {
  id: 'win32',
  enumerateAdapters,
  readNetInfo,
  pingCommand,
  buildSetMacPlan,
  buildProfilePlan
}
