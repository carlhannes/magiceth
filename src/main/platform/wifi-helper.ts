// The JSON contract both Wi-Fi helpers speak: the Swift .app on macOS and the PowerShell script on
// Windows. A helper stays deliberately stupid — it reports what the OS handed it, with the beacon
// elements as hex — and everything is decoded here, once, where it can be tested without a radio.
//
//   { status, message?, interface?, interfaces?, networks: [ { bssid, ssid, rssi, noise?, ie,
//       channel? band? width?   — CoreWLAN's own enums (macOS)
//       freqMhz?                — a centre frequency instead (Windows)
//       countryCode? } ] }
//
// Exit codes: 0 ok, 2 needs-permission, 3 no-interface, 4 error. `status` says the same thing, so
// the code is only a convenience for anyone running a helper by hand.

import { readBeacon } from '../capabilities/ie80211'
import { channelFromMhz } from '../capabilities/wifi-model'
import type { WifiScanOutcome, WifiSighting } from './index'
import type { WifiBand } from '../../shared/types'

export interface HelperNetwork {
  ssid?: string
  bssid?: string
  rssi?: number
  noise?: number
  channel?: number
  band?: number
  width?: number
  freqMhz?: number
  ie?: string
  countryCode?: string
}

export interface HelperOutput {
  status?: string
  message?: string
  interface?: string
  interfaces?: string[]
  networks?: HelperNetwork[]
}

/** CWChannelBand: 1 = 2.4 GHz, 2 = 5 GHz, 3 = 6 GHz. */
export function bandOf(raw?: number): WifiBand {
  if (raw === 1) return '2.4'
  if (raw === 2) return '5'
  if (raw === 3) return '6'
  return '?'
}

/** CWChannelWidth: 1 = 20, 2 = 40, 3 = 80, 4 = 160 MHz. */
export function widthOf(raw?: number): number | undefined {
  return { 1: 20, 2: 40, 3: 80, 4: 160 }[raw ?? 0]
}

/**
 * Helper output to sightings. `permissionMessage` is the OS's own wording for what to do about a
 * refused scan — the helper knows only that it was refused.
 */
export function parseWifiHelper(text: string, permissionMessage: string): WifiScanOutcome {
  let output: HelperOutput
  try {
    output = JSON.parse(text) as HelperOutput
  } catch {
    return { status: 'error', message: 'The Wi-Fi helper produced output that could not be read.' }
  }
  if (output.status === 'needs-permission') {
    return { status: 'needs-permission', message: output.message || permissionMessage }
  }
  if (output.status !== 'ok') {
    return {
      status: 'error',
      message: output.message || `The Wi-Fi helper reported "${output.status ?? 'nothing'}".`
    }
  }
  const sightings: WifiSighting[] = []
  for (const n of output.networks ?? []) {
    if (typeof n.bssid !== 'string' || n.bssid === '' || typeof n.rssi !== 'number') continue
    const placed =
      n.channel !== undefined && n.band !== undefined
        ? { channel: n.channel, band: bandOf(n.band) }
        : n.freqMhz !== undefined
          ? channelFromMhz(n.freqMhz)
          : undefined
    sightings.push({
      bssid: n.bssid.toLowerCase(),
      ssid: n.ssid ?? '',
      rssi: n.rssi,
      // CoreWLAN reports 0 when it has no noise figure, which is not a measurement.
      noise: n.noise === 0 ? undefined : n.noise,
      channel: placed?.channel ?? 0,
      band: placed?.band ?? '?',
      widthMhz: widthOf(n.width),
      countryCode: n.countryCode,
      beacon: readBeacon(n.ie ?? '')
    })
  }
  return { status: 'ok', sightings }
}
