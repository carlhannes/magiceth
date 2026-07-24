// Platform dispatch. Capability modules call getPlatform() and delegate to
// the correct OS implementation. The interface grows along with the milestones.

import { darwin } from './darwin'
import { linux } from './linux'
import { win32 } from './win32'
import type { ElevatedPlan } from '../privilege'
import type { NetInfo, Profile, UsbInfo } from '../../shared/types'

export interface PingSpec {
  file: string
  args: string[]
}

export interface PingOptions {
  device: string
  srcIp?: string
  count: number
}

// Raw data from the platform layer, before chipset lookup. Only USB dongles are returned
// (built-in interfaces like Wi-Fi are filtered out).
export interface RawAdapter {
  device: string
  portName: string
  mac: string
  usb?: UsbInfo
}

export interface PlatformOps {
  readonly id: NodeJS.Platform
  /** List connected USB ethernet dongles with device, port name, MAC and (if possible) VID:PID. */
  enumerateAdapters(): Promise<RawAdapter[]>
  /** Read link, IP, DHCP and DNS info for an interface (read-only, no privileges). */
  readNetInfo(device: string): Promise<NetInfo>
  /** Build a ping command bound to the dongle's interface/source IP (flags differ per OS). */
  pingCommand(target: string, opts: PingOptions): PingSpec
  /** Build an elevation plan that sets the MAC address on an interface (M4, privileged). */
  buildSetMacPlan(device: string, mac: string): Promise<ElevatedPlan>
  /** Build an elevation plan that applies a profile (DHCP/static + optional MAC) (M4, privileged). */
  buildProfilePlan(device: string, profile: Profile): Promise<ElevatedPlan>
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
