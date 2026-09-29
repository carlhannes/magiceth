// Pure shaping of scan results: grouping access points into networks, and folding repeated
// sightings of the same BSSID into a track with min/max/avg.
//
// Kept apart from wifiscan.ts so the accumulate-over-time logic can be unit-tested without a
// radio, which is the same split survey.ts uses for its VLAN tally.

import type { WifiBand, WifiBss, WifiNetwork, WifiRange, WifiTrack } from '../../shared/types'

/**
 * Upper bound on tracked access points. A recording taken while walking through an office block
 * can meet a great many, and an unbounded map is how a long run turns into a memory problem.
 */
export const MAX_TRACKS = 512

interface Accumulator {
  min: number
  max: number
  sum: number
  count: number
  last: number
}

interface TrackState {
  bssid: string
  ssid: string
  channel: number
  band: WifiBand
  sightings: number
  firstSeenSec: number
  lastSeenSec: number
  rssi: Accumulator
  clients?: Accumulator
  utilizationPct?: Accumulator
}

export type TrackStore = Map<string, TrackState>

function start(value: number): Accumulator {
  return { min: value, max: value, sum: value, count: 1, last: value }
}

function push(acc: Accumulator, value: number): void {
  acc.min = Math.min(acc.min, value)
  acc.max = Math.max(acc.max, value)
  acc.sum += value
  acc.count++
  acc.last = value
}

function project(acc: Accumulator): WifiRange {
  return {
    min: acc.min,
    max: acc.max,
    avg: Math.round((acc.sum / acc.count) * 10) / 10,
    last: acc.last
  }
}

function fold(
  state: TrackState | undefined,
  key: keyof TrackState,
  value: number | undefined
): void {
  if (state === undefined || value === undefined) return
  const existing = state[key] as Accumulator | undefined
  if (existing) push(existing, value)
  else (state[key] as Accumulator) = start(value)
}

/**
 * Add one sighting. Attributes that can change between scans (SSID, channel) take the newest
 * value; an AP that moves band mid-recording is reporting the truth about now.
 */
export function foldSighting(store: TrackStore, bss: WifiBss, atSec: number): void {
  const existing = store.get(bss.bssid)
  if (!existing) {
    if (store.size >= MAX_TRACKS) return
    store.set(bss.bssid, {
      bssid: bss.bssid,
      ssid: bss.ssid,
      channel: bss.channel,
      band: bss.band,
      sightings: 1,
      firstSeenSec: atSec,
      lastSeenSec: atSec,
      rssi: start(bss.rssi),
      clients: bss.clients === undefined ? undefined : start(bss.clients),
      utilizationPct: bss.utilizationPct === undefined ? undefined : start(bss.utilizationPct)
    })
    return
  }
  existing.sightings++
  existing.lastSeenSec = atSec
  existing.ssid = bss.ssid || existing.ssid
  existing.channel = bss.channel
  existing.band = bss.band
  push(existing.rssi, bss.rssi)
  fold(existing, 'clients', bss.clients)
  fold(existing, 'utilizationPct', bss.utilizationPct)
}

/** Strongest last-seen signal first — the AP you are closest to right now is the one you want. */
export function toTracks(store: TrackStore): WifiTrack[] {
  return [...store.values()]
    .map((t) => ({
      bssid: t.bssid,
      ssid: t.ssid,
      channel: t.channel,
      band: t.band,
      sightings: t.sightings,
      firstSeenSec: t.firstSeenSec,
      lastSeenSec: t.lastSeenSec,
      rssi: project(t.rssi),
      clients: t.clients ? project(t.clients) : undefined,
      utilizationPct: t.utilizationPct ? project(t.utilizationPct) : undefined
    }))
    .sort((a, b) => b.rssi.last - a.rssi.last)
}

/**
 * Whole-recording fold, from a list of scans to a list of tracks. This is the exported pure
 * wrapper the tests drive; the live path folds the same function one scan at a time.
 */
export function accumulate(scans: { atSec: number; bssids: WifiBss[] }[]): WifiTrack[] {
  const store: TrackStore = new Map()
  for (const scan of scans) for (const bss of scan.bssids) foldSighting(store, bss, scan.atSec)
  return toTracks(store)
}

/**
 * Group access points under the network name they advertise, strongest network first. A hidden
 * network has no name to group on, so each of its BSSIDs stands alone.
 */
export function groupBySsid(bssids: WifiBss[]): WifiNetwork[] {
  const byName = new Map<string, WifiBss[]>()
  for (const bss of bssids) {
    const key = bss.ssid === '' ? `\u0000hidden:${bss.bssid}` : bss.ssid
    const list = byName.get(key)
    if (list) list.push(bss)
    else byName.set(key, [bss])
  }
  return [...byName.values()]
    .map((list) => {
      const sorted = [...list].sort((a, b) => b.rssi - a.rssi)
      const bands: WifiBand[] = []
      for (const bss of sorted) if (!bands.includes(bss.band)) bands.push(bss.band)
      return {
        ssid: sorted[0].ssid,
        bestRssi: sorted[0].rssi,
        bands: bands.sort(),
        security: sorted[0].security,
        bssids: sorted
      }
    })
    .sort((a, b) => b.bestRssi - a.bestRssi)
}
