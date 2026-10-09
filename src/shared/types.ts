// Shared types between main, preload and renderer.

// --- Adapter identification (M1) ---

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

/**
 * What kind of port this is. USB dongles are the tool's reason for existing and sort first, but a
 * machine's own Wi-Fi and Ethernet are ports worth diagnosing too. Everything else an OS calls a
 * network interface — loopback, bridges, Docker/veth, VPN tunnels, internal plumbing — is filtered
 * out in the platform layer and never reaches this type.
 */
export type AdapterKind = 'usb' | 'ethernet' | 'wifi'

export interface Adapter {
  device: string // OS interface name, e.g. "en9" / "eth0" / "Ethernet 2"
  portName: string // human-friendly port name from the OS
  mac: string
  kind: AdapterKind
  usb?: UsbInfo // USB dongles only
  chipset?: ChipsetInfo // looked up from chipsets.json, if known
  known: boolean // true if the chipset could be looked up — only ever meaningful for a dongle
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
  /**
   * Standard deviation of the round-trip times — how much the port wobbles, which is what a
   * technician reads as "is this link steady". Undefined on Windows: its ping reports
   * minimum/maximum/average and no deviation at all.
   */
  jitterMs?: number
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

// --- Speed test: what the uplink behind the port actually delivers (M5) ---

/**
 * One direction of a speed test. Both figures are trailing one-second windows, not
 * total ÷ elapsed: TCP slow start on the way down and buffer fill on the way up both distort an
 * average taken over the whole run, and a window that moves past them does not care.
 */
export interface SpeedPhase {
  kind: 'download' | 'upload'
  /** Best trailing second of the phase — the headline figure. */
  peakMbps?: number
  /** Most recent trailing second, for the live readout while the phase runs. */
  nowMbps?: number
  bytes: number
  seconds: number
  done: boolean
  /** Why this direction produced nothing, when it produced nothing. */
  message?: string
}

export type SpeedTestStatus = 'ok' | 'no-tool' | 'no-address' | 'error'

export interface SpeedTestResult {
  status: SpeedTestStatus
  /** True while a transfer is still running — phases are pushed as they progress. */
  running: boolean
  device?: string
  /** Download first, then upload. A phase appears once it starts. */
  phases: SpeedPhase[]
  /** Wall clock for the whole test, including the gap between the two phases. */
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
// --- Wi-Fi scanning (WLAN mode) ---

export type WifiBand = '2.4' | '5' | '6' | '?'

/** One access point: a single BSSID heard on one channel. Several of these make up an SSID. */
export interface WifiBss {
  bssid: string
  ssid: string // '' for a hidden network
  rssi: number // dBm
  noise?: number // dBm
  channel: number
  band: WifiBand
  widthMhz?: number
  phy?: string // '802.11ax', '802.11be', …  derived from the capability elements
  streams?: number // spatial streams, so MIMO 2x2 is streams === 2
  security: string
  clients?: number // from the BSS Load element — what the AP says it is serving
  utilizationPct?: number // from the BSS Load element
  vendor?: string
  model?: string
  /**
   * True when the BSSID has the locally-administered bit set, which modern APs use for virtual
   * SSIDs. No OUI lookup is possible for one, so the UI must say that rather than show "unknown".
   */
  locallyAdministered: boolean
  countryCode?: string
}

/** Every AP broadcasting the same network name, which is what you actually pick in the list. */
export interface WifiNetwork {
  ssid: string
  bestRssi: number
  bands: WifiBand[]
  security: string
  bssids: WifiBss[]
}

/** How a value moved across a recording. `avg` is over the sightings, not over wall-clock time. */
export interface WifiRange {
  min: number
  max: number
  avg: number
  last: number
}

/**
 * One BSSID across a whole recording. Kept even after the AP stops being heard — walking out of
 * range is a result, not a reason to forget the AP was there.
 */
export interface WifiTrack {
  bssid: string
  ssid: string
  channel: number
  band: WifiBand
  sightings: number
  firstSeenSec: number
  lastSeenSec: number
  rssi: WifiRange
  clients?: WifiRange
  utilizationPct?: WifiRange
  // The descriptive attributes, carried from the newest sighting so a track describes itself.
  // A saved recording is nothing but tracks, and an exported row has to say which access point it
  // came from — "MIMO 4x4, WPA3, Ubiquiti" is most of why the export is worth having.
  security: string
  phy?: string
  streams?: number
  widthMhz?: number
  vendor?: string
  model?: string
  locallyAdministered: boolean
  countryCode?: string
}

/** One channel's worth of congestion, for answering "where is the interference". */
export interface ChannelLoad {
  channel: number
  band: WifiBand
  accessPoints: number
  /** Strongest signal heard on the channel — how much of this load is actually near you. */
  bestRssi: number
  /** Highest utilization any access point on the channel advertised, where any of them did. */
  maxUtilizationPct?: number
  /**
   * Stations on the channel, counted once per radio rather than once per SSID. Undefined when no
   * access point advertised a count, which is different from none being connected.
   */
  clients?: number
  /** How many access points contributed a count, so the UI can qualify the total honestly. */
  clientsFromAps: number
  /**
   * Access points whose occupied spectrum touches this channel, including those on it. This is
   * the number that matters on 2.4 GHz, where channels are 5 MHz apart but 20 MHz wide.
   */
  overlappingAps: number
}

/**
 * A block of adjacent channels treated as one lump — the conventional non-overlapping thirds on
 * 2.4 GHz, and the named regulatory blocks on 5 and 6 GHz.
 */
export interface ChannelBucket {
  band: WifiBand
  label: string
  fromChannel: number
  toChannel: number
  channels: number[]
  accessPoints: number
  bestRssi: number
  clients?: number
  clientsFromAps: number
  maxUtilizationPct?: number
}

/** A recording on disk, described well enough to list without reading the whole file. */
export interface RecordingSummary {
  id: string
  startedAt: string
  durationSec: number
  accessPoints: number
  networks: number
  /** Absolute path of the aggregate file, which is what "show in folder" reveals. */
  path: string
}

export interface SavedRecording {
  summary: RecordingSummary
  tracks: WifiTrack[]
  /**
   * The same derived views a live scan carries, computed in main. The renderer must never import
   * from main/, so anything derived is derived on that side of the IPC boundary — the same reason
   * sortAdapters and validateProfileDraft live in shared/.
   */
  networks: WifiNetwork[]
  channels: ChannelLoad[]
  buckets: ChannelBucket[]
}

export type WifiScanStatus =
  'ok' | 'unsupported' | 'no-helper' | 'no-tool' | 'needs-permission' | 'needs-privilege' | 'error'

export interface WifiScanResult {
  status: WifiScanStatus
  /** True while the continuous recording loop is running. */
  running: boolean
  device: string
  networks: WifiNetwork[]
  tracks: WifiTrack[]
  /** Congestion per channel, derived in main so the renderer stays a view. */
  channels: ChannelLoad[]
  /** The same thing rolled up into bands' non-overlapping blocks. */
  buckets: ChannelBucket[]
  scans: number
  elapsedSec: number
  /**
   * Where this recording is being written. Absent while merely scanning, and absent during a
   * recording that could not open a file — which is how the UI can say so rather than quietly
   * dropping the walk.
   */
  savedTo?: string
  message?: string
}

export interface MagicethApi {
  listAdapters(): Promise<Adapter[]>
  onAdaptersChanged(cb: (adapters: Adapter[]) => void): () => void
  runDiagnostics(device: string): Promise<Diagnostics>
  startSurvey(device: string): Promise<SurveyResult>
  /** Resolves with everything the survey collected, or null when none was running. */
  stopSurvey(): Promise<SurveyResult | null>
  onSurveyUpdate(cb: (result: SurveyResult) => void): () => void
  startSpeedTest(device: string): Promise<SpeedTestResult>
  /** Resolves with everything the test measured, or null when none was running. */
  stopSpeedTest(): Promise<SpeedTestResult | null>
  onSpeedTestUpdate(cb: (result: SpeedTestResult) => void): () => void
  rollMac(device: string): Promise<ReconfigResult>
  applyProfile(device: string, profileId: string): Promise<ReconfigResult>
  undo(device: string): Promise<ReconfigResult>
  /** `mode: 'record'` clears the accumulator and keeps scanning; `'once'` adds a single sample. */
  startWifiScan(device: string, mode: 'once' | 'record'): Promise<WifiScanResult>
  /** Resolves with everything the scan collected, or null when none was running. */
  stopWifiScan(): Promise<WifiScanResult | null>
  onWifiUpdate(cb: (result: WifiScanResult) => void): () => void
  listRecordings(): Promise<RecordingSummary[]>
  readRecording(id: string): Promise<SavedRecording | null>
  /** Opens the platform file manager with the recording selected. */
  revealRecording(id: string): Promise<void>
  listProfiles(): Promise<Profile[]>
  saveCurrentAsProfile(device: string, name: string): Promise<Profile[]>
  saveProfile(profile: Profile): Promise<Profile[]>
  deleteProfile(id: string): Promise<Profile[]>
}
