// Platform dispatch. Capability modules call getPlatform() and delegate to
// the correct OS implementation. The interface grows along with the milestones.

import { darwin } from './darwin'
import { linux } from './linux'
import { win32 } from './win32'
import type { ElevatedPlan } from '../privilege'
import type { BeaconFacts } from '../capabilities/ie80211'
import type {
  AdapterKind,
  NetInfo,
  Profile,
  UsbInfo,
  WifiAccessResult,
  WifiBand
} from '../../shared/types'

export interface PingSpec {
  file: string
  args: string[]
}

export interface PingOptions {
  device: string
  srcIp?: string
  count: number
}

// Raw data from the platform layer, before chipset lookup. Each platform decides what counts as a
// port worth showing — the signal differs per OS — and tags it with a kind. Virtual interfaces
// (loopback, bridges, Docker/veth, VPN tunnels) never make it out of here.
export interface RawAdapter {
  device: string
  portName: string
  mac: string
  kind: AdapterKind
  usb?: UsbInfo
}

/**
 * One access point as the OS reported it, before vendor lookup. The beacon facts are decoded by
 * whichever side had the elements: macOS and Windows hand over the raw bytes, Linux hands over
 * `iw`'s already-decoded text, and both end up as the same BeaconFacts so everything downstream
 * — tracks, recordings, the screens — never learns which OS it is on.
 */
export interface WifiSighting {
  bssid: string // lowercase
  ssid: string // '' when hidden
  rssi: number // dBm
  noise?: number // dBm; macOS is the only OS that reports one per access point
  channel: number // 0 when unknown
  band: WifiBand
  /** The OS's own claim (CoreWLAN). Absent, the beacon's operation elements decide. */
  widthMhz?: number
  countryCode?: string
  beacon: BeaconFacts
}

export type WifiScanOutcome =
  | { status: 'ok'; sightings: WifiSighting[] }
  | {
      status: 'needs-permission' | 'needs-privilege' | 'no-tool' | 'no-helper' | 'error'
      /** Written for the OS it happened on; the renderer shows it as-is. */
      message: string
    }

export interface PlatformOps {
  readonly id: NodeJS.Platform
  /** List connected USB ethernet adapters with device, port name, MAC and (if possible) VID:PID. */
  enumerateAdapters(): Promise<RawAdapter[]>
  /** Read link, IP, DHCP and DNS info for an interface (read-only, no privileges). */
  readNetInfo(device: string): Promise<NetInfo>
  /** Build a ping command bound to the adapter's interface/source IP (flags differ per OS). */
  pingCommand(target: string, opts: PingOptions): PingSpec
  /**
   * Value for curl's --interface, so a speed test measures this port and not whatever the default
   * route happens to be. macOS and Linux bind by interface name; Windows has no equivalent and can
   * only bind the source address, exactly as pingCommand already reflects. Undefined means there
   * is nothing to bind to and the test must not run.
   */
  speedTestBind(device: string, srcIp?: string): string | undefined
  /** Build an elevation plan that sets the MAC address on an interface (M4, privileged). */
  buildSetMacPlan(device: string, mac: string): Promise<ElevatedPlan>
  /** Build an elevation plan that applies a profile (DHCP/static + optional MAC) (M4, privileged). */
  buildProfilePlan(device: string, profile: Profile): Promise<ElevatedPlan>
  /**
   * One fresh sweep of the air on `device` ('' = the default wireless interface). Resolves only
   * once the OS has *new* results — the recording loop assumes one call takes about one sweep.
   * Never throws: every degraded path is a status plus a message written for that OS.
   */
  scanWifi(device: string): Promise<WifiScanOutcome>
  /** Raise whatever the OS gates Wi-Fi behind. Fire and forget; a no-op where nothing is gated. */
  requestWifiAccess(): void
  /** Tear down anything long-lived the scanner started. Called when the app quits. */
  endWifiSession(): void
  /**
   * Where the OS can be told to allow Wi-Fi access rather than merely asked — Windows, whose
   * Location switches are often pinned off by a policy key. Elevated, opt-in, verified by
   * re-reading. Absent on an OS where the user has to answer a prompt themselves.
   */
  enableWifiAccess?(): Promise<WifiAccessResult>
}

export function getPlatform(): PlatformOps {
  switch (process.platform) {
    case 'darwin':
      return darwin
    case 'linux':
      return linux
    case 'win32':
      return win32
    default:
      throw new Error(`Platform not supported: ${process.platform}`)
  }
}
