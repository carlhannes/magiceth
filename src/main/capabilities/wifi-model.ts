// Pure shaping of scan results: grouping access points into networks, and folding repeated
// sightings of the same BSSID into a track with min/max/avg.
//
// Kept apart from wifiscan.ts so the accumulate-over-time logic can be unit-tested without a
// radio, which is the same split survey.ts uses for its VLAN tally.

import type {
  ChannelBucket,
  ChannelLoad,
  WifiBand,
  WifiBss,
  WifiNetwork,
  WifiRange,
  WifiTrack
} from '../../shared/types'

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
  ssid: string
  /**
   * The newest complete sighting. Everything that describes rather than measures — security, PHY,
   * streams, vendor, channel — is read back off this, so a new field on WifiBss reaches the track
   * without another place to update.
   */
  last: WifiBss
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
      ssid: bss.ssid,
      last: bss,
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
  existing.last = bss
  // A hidden network answers with an empty name on some scans and its real one on others, so a
  // name once learned is kept rather than being blanked by the next quiet beacon.
  existing.ssid = bss.ssid || existing.ssid
  push(existing.rssi, bss.rssi)
  fold(existing, 'clients', bss.clients)
  fold(existing, 'utilizationPct', bss.utilizationPct)
}

/** Strongest last-seen signal first — the AP you are closest to right now is the one you want. */
export function toTracks(store: TrackStore): WifiTrack[] {
  return [...store.values()]
    .map((t) => ({
      bssid: t.last.bssid,
      ssid: t.ssid,
      channel: t.last.channel,
      band: t.last.band,
      sightings: t.sightings,
      firstSeenSec: t.firstSeenSec,
      lastSeenSec: t.lastSeenSec,
      rssi: project(t.rssi),
      clients: t.clients ? project(t.clients) : undefined,
      utilizationPct: t.utilizationPct ? project(t.utilizationPct) : undefined,
      security: t.last.security,
      phy: t.last.phy,
      streams: t.last.streams,
      widthMhz: t.last.widthMhz,
      vendor: t.last.vendor,
      model: t.last.model,
      locallyAdministered: t.last.locallyAdministered,
      countryCode: t.last.countryCode
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

/**
 * A track as a single reading, using its most recent values.
 *
 * This is what lets a recording read back off disk go through exactly the same grouping and the
 * same screens as a live scan: there is one `groupBySsid`, not one per source.
 */
export function trackToBss(t: WifiTrack): WifiBss {
  return {
    bssid: t.bssid,
    ssid: t.ssid,
    rssi: t.rssi.last,
    channel: t.channel,
    band: t.band,
    widthMhz: t.widthMhz,
    phy: t.phy,
    streams: t.streams,
    security: t.security,
    clients: t.clients?.last,
    utilizationPct: t.utilizationPct?.last,
    vendor: t.vendor,
    model: t.model,
    locallyAdministered: t.locallyAdministered,
    countryCode: t.countryCode
  }
}

/** How many of the six octets differ. Six means nothing at all in common. */
export function octetDistance(a: string, b: string): number {
  const left = a.split(':')
  const right = b.split(':')
  if (left.length !== 6 || right.length !== 6) return 6
  let differ = 0
  for (let i = 0; i < 6; i++) if (left[i] !== right[i]) differ++
  return differ
}

/**
 * Most BSSIDs of one radio differ in a single octet, but vendors disagree about which: Cisco walks
 * the last one (`…4a:e0` through `…4a:e8`) while Ubiquiti varies the first (`d0`/`da`/`de:21:…`).
 * Two is enough to cover both and still leave unrelated hardware far apart.
 */
const SAME_RADIO_OCTETS = 2

/**
 * Whether two access points on one channel are really one radio wearing several SSIDs.
 *
 * The station count in a BSS Load element belongs to the radio, so every SSID on that radio repeats
 * it. Requiring the counts to match as well as the addresses to be close is what separates a
 * multi-SSID radio from two neighbours that happen to serve the same number of people — and it is
 * the half that catches a pair like `ec:75:0c:10:73:aa` and `ee:75:0c:20:73:aa`, whose addresses
 * are registered to different vendors entirely.
 *
 * A heuristic, and wrong in both directions occasionally: see docs/BACKLOG.md.
 */
function sameRadio(a: WifiTrack, b: WifiTrack): boolean {
  const left = a.clients?.last
  const right = b.clients?.last
  // Without a count from both there is nothing to compare, so assume they are separate.
  if (left === undefined || right === undefined) return false
  return left === right && octetDistance(a.bssid, b.bssid) <= SAME_RADIO_OCTETS
}

/**
 * Split access points that share a channel into the radios behind them. A track only joins a group
 * it matches in full, so one odd member cannot drag unrelated hardware in behind it.
 */
export function distinctRadios(tracks: WifiTrack[]): WifiTrack[][] {
  const groups: WifiTrack[][] = []
  for (const track of tracks) {
    const home = groups.find((group) => group.every((member) => sameRadio(member, track)))
    if (home) home.push(track)
    else groups.push([track])
  }
  return groups
}

/** Stations on a set of access points, counted once per radio. */
function clientsOf(tracks: WifiTrack[]): { clients?: number; clientsFromAps: number } {
  const advertising = tracks.filter((t) => t.clients !== undefined)
  if (advertising.length === 0) return { clients: undefined, clientsFromAps: 0 }
  const clients = distinctRadios(advertising).reduce((sum, g) => sum + (g[0].clients?.last ?? 0), 0)
  return { clients, clientsFromAps: advertising.length }
}

/** Centre frequency of a channel, in MHz. Channel 14 is the one that breaks the arithmetic. */
export function channelCentreMhz(channel: number, band: WifiBand): number | undefined {
  if (channel <= 0) return undefined
  if (band === '2.4') return channel === 14 ? 2484 : 2407 + 5 * channel
  if (band === '5') return 5000 + 5 * channel
  if (band === '6') return 5950 + 5 * channel
  return undefined
}

/**
 * The inverse: which channel a centre frequency is, and on which band. Linux and Windows report a
 * frequency rather than a channel number, and it is the band that decides how 2.4 and 5 GHz
 * channel numbers that collide with 6 GHz ones are told apart. Channel 2 on 6 GHz sits at 5935,
 * off the 5950 + 5n grid every other 6 GHz channel follows; nothing else is special-cased.
 */
export function channelFromMhz(mhz: number): { channel: number; band: WifiBand } | undefined {
  if (!Number.isInteger(mhz)) return undefined
  if (mhz === 2484) return { channel: 14, band: '2.4' }
  if (mhz >= 2412 && mhz <= 2472 && (mhz - 2407) % 5 === 0) {
    return { channel: (mhz - 2407) / 5, band: '2.4' }
  }
  if (mhz >= 5150 && mhz <= 5920 && mhz % 5 === 0) return { channel: (mhz - 5000) / 5, band: '5' }
  if (mhz === 5935) return { channel: 2, band: '6' }
  if (mhz >= 5955 && mhz <= 7115 && mhz % 5 === 0) return { channel: (mhz - 5950) / 5, band: '6' }
  return undefined
}

/**
 * The stretch of spectrum an access point actually occupies.
 *
 * Approximation worth knowing about: CoreWLAN reports the *primary* channel, not the centre of a
 * wide one, so a 40/80/160 MHz access point is assumed to sit centred on its primary channel. For
 * 160 MHz that can be out by up to 70 MHz. Reading the real centre means decoding the
 * centre-frequency segment from the VHT/HE Operation elements — noted in docs/BACKLOG.md.
 */
export function occupiedSpan(track: WifiTrack): { loMhz: number; hiMhz: number } | undefined {
  const centre = channelCentreMhz(track.channel, track.band)
  if (centre === undefined) return undefined
  const half = (track.widthMhz ?? 20) / 2
  return { loMhz: centre - half, hiMhz: centre + half }
}

/** Touching edges do not count: channels 1 and 5 abut at 2422 MHz and are conventionally clear. */
function spansOverlap(
  a: { loMhz: number; hiMhz: number },
  b: { loMhz: number; hiMhz: number }
): boolean {
  return a.loMhz < b.hiMhz && a.hiMhz > b.loMhz
}

/**
 * Congestion per channel: how many access points share it, how many stations they are serving, how
 * close the nearest one is, the worst load any of them admits to, and how much else bleeds onto it.
 *
 * Takes tracks rather than a live scan so the same function answers the question for a recording
 * read back off disk. Ordered by band then channel, which is how a spectrum is read.
 */
export function channelSummary(tracks: WifiTrack[]): ChannelLoad[] {
  const byKey = new Map<string, WifiTrack[]>()
  for (const t of tracks) {
    const key = `${t.band}/${t.channel}`
    const group = byKey.get(key)
    if (group) group.push(t)
    else byKey.set(key, [t])
  }

  const spans = tracks
    .map((t) => occupiedSpan(t))
    .filter((s): s is { loMhz: number; hiMhz: number } => s !== undefined)

  const out: ChannelLoad[] = []
  for (const group of byKey.values()) {
    const { channel, band } = group[0]
    const centre = channelCentreMhz(channel, band)
    // A channel row stands for its own 20 MHz, whatever widths the access points on it use.
    const own = centre === undefined ? undefined : { loMhz: centre - 10, hiMhz: centre + 10 }
    const utils = group
      .map((t) => t.utilizationPct?.max)
      .filter((u): u is number => u !== undefined)
    out.push({
      channel,
      band,
      accessPoints: group.length,
      bestRssi: Math.max(...group.map((t) => t.rssi.max)),
      // An access point that never advertised a BSS Load must not read as 0% load.
      maxUtilizationPct: utils.length ? Math.max(...utils) : undefined,
      ...clientsOf(group),
      overlappingAps:
        own === undefined ? group.length : spans.filter((s) => spansOverlap(s, own)).length
    })
  }

  const bandOrder: WifiBand[] = ['2.4', '5', '6', '?']
  return out.sort(
    (a, b) => bandOrder.indexOf(a.band) - bandOrder.indexOf(b.band) || a.channel - b.channel
  )
}

/**
 * The blocks channels are grouped into. 2.4 GHz uses the conventional non-overlapping thirds; 5 and
 * 6 GHz use the named regulatory blocks, which is how anyone planning a deployment talks about them.
 */
const BUCKETS: { band: WifiBand; label: string; from: number; to: number }[] = [
  { band: '2.4', label: 'ch 1–5', from: 1, to: 5 },
  { band: '2.4', label: 'ch 6–10', from: 6, to: 10 },
  { band: '2.4', label: 'ch 11–14', from: 11, to: 14 },
  { band: '5', label: 'UNII-1', from: 36, to: 48 },
  { band: '5', label: 'UNII-2A', from: 52, to: 64 },
  { band: '5', label: 'UNII-2C', from: 100, to: 144 },
  { band: '5', label: 'UNII-3', from: 149, to: 165 },
  { band: '6', label: 'UNII-5', from: 1, to: 93 },
  { band: '6', label: 'UNII-6', from: 97, to: 113 },
  { band: '6', label: 'UNII-7', from: 117, to: 185 },
  { band: '6', label: 'UNII-8', from: 189, to: 233 }
]

/** The same picture as channelSummary, rolled up. Empty blocks are left out rather than shown as 0. */
export function channelBuckets(tracks: WifiTrack[]): ChannelBucket[] {
  const out: ChannelBucket[] = []
  for (const bucket of BUCKETS) {
    const inside = tracks.filter(
      (t) => t.band === bucket.band && t.channel >= bucket.from && t.channel <= bucket.to
    )
    if (inside.length === 0) continue
    const utils = inside
      .map((t) => t.utilizationPct?.max)
      .filter((u): u is number => u !== undefined)
    out.push({
      band: bucket.band,
      label: bucket.label,
      fromChannel: bucket.from,
      toChannel: bucket.to,
      channels: [...new Set(inside.map((t) => t.channel))].sort((a, b) => a - b),
      accessPoints: inside.length,
      bestRssi: Math.max(...inside.map((t) => t.rssi.max)),
      maxUtilizationPct: utils.length ? Math.max(...utils) : undefined,
      ...clientsOf(inside)
    })
  }
  return out
}
