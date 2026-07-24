// Shared types between main, preload and renderer.

export interface AddressInfo {
  address: string
  family: string
  mac: string
  internal: boolean
}

export interface InterfaceInfo {
  name: string
  addresses: AddressInfo[]
}

export interface SystemSnapshot {
  // The process.platform string (e.g. "darwin", "linux", "win32"). Kept platform-neutral
  // because the type is shared with the renderer (which lacks Node types).
  platform: string
  arch: string
  interfaces: InterfaceInfo[]
}

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

// --- VLAN/switch-port discovery (M3) ---

export interface Neighbor {
  protocol: 'LLDP' | 'CDP'
  systemName?: string // switch name
  portId?: string // port on the switch
  vlan?: number // native/PVID
  mgmtAddress?: string // the switch's mgmt IP
}

export type DiscoveryStatus = 'ok' | 'none-seen' | 'no-tool' | 'needs-privilege' | 'error'

export interface DiscoveryResult {
  status: DiscoveryStatus
  neighbors: Neighbor[]
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
  snapshot(): Promise<SystemSnapshot>
  onAdaptersChanged(cb: (snapshot: SystemSnapshot) => void): () => void
  listDongles(): Promise<Dongle[]>
  onDonglesChanged(cb: (dongles: Dongle[]) => void): () => void
  runDiagnostics(device: string): Promise<Diagnostics>
  discover(device: string): Promise<DiscoveryResult>
  rollMac(device: string): Promise<ReconfigResult>
  applyProfile(device: string, profileId: string): Promise<ReconfigResult>
  undo(device: string): Promise<ReconfigResult>
  listProfiles(): Promise<Profile[]>
  saveCurrentAsProfile(device: string, name: string): Promise<Profile[]>
  saveProfile(profile: Profile): Promise<Profile[]>
  deleteProfile(id: string): Promise<Profile[]>
}
