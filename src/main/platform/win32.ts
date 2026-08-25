import { run } from '../util/run-command'
import { normalizeMac } from '../../shared/mac'
import { cidrToDotted, isValidIpv4 } from '../../shared/net'
import { psEscapeDouble } from '../privilege'
import type { ElevatedPlan } from '../privilege'
import type { PingOptions, PingSpec, PlatformOps, RawAdapter } from './index'
import type { NetInfo, Profile } from '../../shared/types'

// Windows. Format per documentation — verify on real hardware (spike):
//  - `Get-NetAdapter | Select ... | ConvertTo-Json` gives adapters; USB dongles have
//    a PnpDeviceID starting with "USB\VID_xxxx&PID_xxxx".
//  - `Virtual` is the documented split for Hyper-V, WSL, VPN and loopback adapters.
//  - `NdisPhysicalMedium` 9 is Native 802.11 and 1 is Wireless LAN; 14 is 802.3.

// The keys are intentionally lowercase and come from calculated properties in the PowerShell below,
// so we never depend on the casing of the CIM properties (e.g. PNPDeviceID).
interface NetAdapterRaw {
  name?: string
  desc?: string
  mac?: string
  pnp?: string
  virtual?: boolean
  hardware?: boolean
  media?: string
  ndis?: number
}

/**
 * Parse JSON from Get-NetAdapter into the ports worth showing.
 *
 * Filtering happens here rather than through the cmdlet's -Physical switch on purpose: if that
 * switch were ever unavailable the command would fail and the app would show *no* adapters at all,
 * whereas a property this parser cannot see simply leaves the adapter in. Erring towards showing
 * something is the right direction for the one platform with no hardware to test on.
 */
export function parseGetNetAdapter(json: string): RawAdapter[] {
  const parsed: unknown = JSON.parse(json)
  const data: NetAdapterRaw[] = Array.isArray(parsed)
    ? (parsed as NetAdapterRaw[])
    : [parsed as NetAdapterRaw]
  const adapters: RawAdapter[] = []
  for (const a of data) {
    if (a.virtual === true || a.hardware === false) continue
    const pnp = a.pnp ?? ''
    const usb = /^USB/i.test(pnp)
    const m = pnp.match(/VID_([0-9A-Fa-f]{4}).*?PID_([0-9A-Fa-f]{4})/)
    const wireless = /802\.11|wireless|wi-?fi/i.test(a.media ?? '') || a.ndis === 9 || a.ndis === 1
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
      // A USB Wi-Fi stick is still a dongle: USB wins, because that is what the chipset database
      // is keyed on and what the tool is built around.
      kind: usb ? 'usb' : wireless ? 'wifi' : 'ethernet',
      usb:
        usb && m
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
    "@{N='pnp';E={$_.PNPDeviceID}}," +
    "@{N='virtual';E={$_.Virtual}}," +
    "@{N='hardware';E={$_.HardwareInterface}}," +
    "@{N='media';E={$_.PhysicalMediaType}}," +
    "@{N='ndis';E={$_.NdisPhysicalMedium}} | ConvertTo-Json -Compress"
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
  const dnsServers = (Array.isArray(r.dns) ? r.dns : r.dns ? [r.dns] : []).filter(isValidIpv4)
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
  const script =
    `$ErrorActionPreference='SilentlyContinue';$dev='${dev}';` +
    `$a=Get-NetAdapter -Name $dev;` +
    `$ip=Get-NetIPAddress -InterfaceAlias $dev -AddressFamily IPv4 | Select-Object -First 1;` +
    `$gw=(Get-NetRoute -InterfaceAlias $dev -DestinationPrefix '0.0.0.0/0' | Select-Object -First 1).NextHop;` +
    `$dns=(Get-DnsClientServerAddress -InterfaceAlias $dev -AddressFamily IPv4).ServerAddresses;` +
    `[pscustomobject]@{mac=$a.MacAddress;status=[string]$a.Status;linkSpeed=$a.LinkSpeed;ip=$ip.IPAddress;prefix=$ip.PrefixLength;origin=[string]$ip.PrefixOrigin;gateway=$gw;dns=$dns} | ConvertTo-Json -Compress`
  const res = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeoutMs: 10000
  })
  // Fail loudly rather than with a raw JSON.parse SyntaxError — the renderer shows this text.
  // A fake "link down" result was the alternative and would have been actively misleading.
  if (!res.stdout.trim()) {
    throw new Error(`Could not read network info for "${device}" (PowerShell returned no output).`)
  }
  try {
    return parseWinNetInfo(res.stdout, device)
  } catch {
    throw new Error(`Could not parse network info for "${device}".`)
  }
}

function pingCommand(target: string, opts: PingOptions): PingSpec {
  // Windows: -n count, -w timeout in ms, -S binds source IP (interface binding is not available).
  // There is no interval flag, so Windows always spends about a second per packet — the one place
  // where a five-packet run is noticeably slower than the two-packet one it replaced.
  const args = ['-n', String(opts.count), '-w', '1000']
  if (opts.srcIp) args.push('-S', opts.srcIp)
  args.push(target)
  return { file: 'ping', args }
}

// --- Active control (M4) — documented (PowerShell/netsh), verify on real hardware. ---
// The scripts are base64-encoded before execution (runElevatedPlan) so quotes are harmless.
// The adapter name is user-renameable and lands inside PowerShell "…" strings, so it goes
// through psEscapeDouble — ordinary names ("Ethernet 3") come out byte-identical.
// The IP fields come from a profile that parseProfiles has already format-validated.

export function winSetMacScript(device: string, mac: string): string {
  const bare = mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  const dev = psEscapeDouble(device)
  // Requires the driver to expose the NetworkAddress property (most USB NICs do).
  return (
    `Set-NetAdapterAdvancedProperty -Name "${dev}" -RegistryKeyword "NetworkAddress" ` +
    `-RegistryValue "${bare}" -NoRestart; Restart-NetAdapter -Name "${dev}"`
  )
}

export function winProfileScript(device: string, profile: Profile): string {
  const dev = psEscapeDouble(device)
  const cmds: string[] = []
  if (profile.macOverride) cmds.push(winSetMacScript(device, profile.macOverride))
  if (profile.mode === 'dhcp') {
    cmds.push(`netsh interface ip set address name="${dev}" source=dhcp`)
    cmds.push(`netsh interface ip set dns name="${dev}" source=dhcp`)
  } else {
    const mask = cidrToDotted(profile.cidr ?? 24)
    cmds.push(
      `netsh interface ip set address name="${dev}" static ${profile.ip ?? ''} ${mask} ${profile.gateway ?? ''}`
    )
    if (profile.dns && profile.dns.length > 0) {
      cmds.push(`netsh interface ip set dns name="${dev}" static ${profile.dns[0]}`)
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

function speedTestBind(_device: string, srcIp?: string): string | undefined {
  // Windows has no bind-by-interface, and curl would try to resolve an adapter name like
  // "Ethernet 2" as a host. Without an address there is nothing to bind and no test to run.
  return srcIp
}

export const win32: PlatformOps = {
  id: 'win32',
  enumerateAdapters,
  readNetInfo,
  pingCommand,
  speedTestBind,
  buildSetMacPlan,
  buildProfilePlan
}
