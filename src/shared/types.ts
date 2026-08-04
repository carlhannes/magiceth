// Shared types between main, preload and renderer.

// --- Dongle identification (M1) ---

export interface UsbInfo {
  vendorId: string // hex, lowercase, e.g. "0b95"
  productId: string // hex, lowercase, e.g. "1790"
  vendorName?: string
  productName?: string
}

export interface ChipsetInfo {
  vendor: string
  chipset: string
  maxSpeedMbps: number
  vlan: boolean
  brands?: string[]
  notes?: string
}

export interface Dongle {
  device: string // OS interface name, e.g. "en9" / "eth0" / "Ethernet 2"
  portName: string // human-friendly port name from the OS
  mac: string
  usb?: UsbInfo
  chipset?: ChipsetInfo // looked up from chipsets.json, if known
  known: boolean // true if the chipset could be looked up
}

// --- Diagnostics (M2) ---

export interface DhcpInfo {
  enabled: boolean // true if ConfigMethod == DHCP
  server?: string
  domain?: string
  leaseStart?: string
  leaseExpiration?: string
  state?: string // e.g. "BOUND"
}

export interface NetInfo {
  device: string
  linkUp: boolean
  mac: string
  ipv4?: string
  netmask?: string // dotted, e.g. "255.255.254.0"
  cidr?: number // prefix length, e.g. 23
  gateway?: string
  dnsServers: string[]
  dhcp: DhcpInfo
  linkSpeedMbps?: number
  duplex?: string // "full" | "half"
  mediaRaw?: string
}

export interface PingResult {
  target: string
  label: string
  ok: boolean
  lossPct?: number
  avgMs?: number
}

export interface DnsResult {
  ok: boolean
  server?: string
  host: string
  addresses: string[]
  ms?: number
}

export interface Diagnostics {
  device: string
  net: NetInfo
  gatewayPing?: PingResult
  internetPings: PingResult[]
  dns?: DnsResult
  ranAt: string // ISO timestamp
}

// --- Port survey: VLANs on the wire, plus the switch itself when it says so (M3) ---

export interface Neighbor {
  protocol: 'LLDP' | 'CDP'
  systemName?: string // switch name
  portId?: string // port on the switch
  vlan?: number // native/PVID
  mgmtAddress?: string // the switch's mgmt IP
}

/**
 * One 802.1Q VLAN seen on the wire. This is the part that works on any switch: a trunk floods
 * tagged broadcast/multicast for every VLAN it carries, so the IDs can be read off the wire
 * without the switch advertising anything.
 *
 * `addresses` are source addresses observed inside that VLAN — never a subnet, because a capture
 * shows addresses and never netmasks.
 */
export interface VlanSighting {
  id: number
  frames: number
  addresses: string[]
}

export type SurveyStatus = 'ok' | 'none-seen' | 'no-tool' | 'needs-privilege' | 'error'

export interface SurveyResult {
  status: SurveyStatus
  /** True while the capture is still running — results accumulate and are pushed as they arrive. */
  running: boolean
  device?: string
  neighbors: Neighbor[]
  vlans: VlanSighting[]
  /** Total frames captured, so the UI can show progress even before anything is identified. */
  frames: number
  /** How long the capture has been running, and after stopping, how long it ran for. */
  elapsedSec: number
  message?: string
}

// --- Active control: profiles & reconfig (M4) ---

export interface Profile {
  id: string
  name: string
  mode: 'dhcp' | 'static'
  ip?: string
  cidr?: number
  gateway?: string
  dns?: string[]
  macOverride?: string // if set: also set the MAC when the profile is applied
}

export interface ReconfigResult {
  ok: boolean
  message?: string
  oldMac?: string
  newMac?: string
  net?: NetInfo // re-read after the change (for verification)
}

// The API that preload exposes on window.api (contract between main and renderer).
export interface MagicethApi {
  listDongles(): Promise<Dongle[]>
  onDonglesChanged(cb: (dongles: Dongle[]) => void): () => void
  runDiagnostics(device: string): Promise<Diagnostics>
  startSurvey(device: string): Promise<SurveyResult>
  /** Resolves with everything the survey collected, or null when none was running. */
  stopSurvey(): Promise<SurveyResult | null>
  onSurveyUpdate(cb: (result: SurveyResult) => void): () => void
  rollMac(device: string): Promise<ReconfigResult>
  applyProfile(device: string, profileId: string): Promise<ReconfigResult>
  undo(device: string): Promise<ReconfigResult>
  listProfiles(): Promise<Profile[]>
  saveCurrentAsProfile(device: string, name: string): Promise<Profile[]>
  saveProfile(profile: Profile): Promise<Profile[]>
  deleteProfile(id: string): Promise<Profile[]>
}
