// Pure: what listening has learned so far, folded one frame at a time.
//
// The shape is wifi-model.ts's — a store, a fold, a projection — with the same property: nothing
// here knows where a frame came from, so a recorded file and a live capture go through the same
// code. It keeps three kinds of fact and nothing else:
//
//   · access points: the beacons and probe responses they send, averaged over one sweep of the
//     channels into a sighting, the same object a scan produces;
//   · per access point: how many frames named its BSSID, how many were retries, how many
//     deauthentications and disassociations — counts, keyed by the access point's own address;
//   · per channel: how many frames were heard and how many dwells the radio spent there.
//
// There is no store of stations. The decoder never hands over a client's address, so there is
// nothing here that could remember one.

import { channelFromMhz } from '../wifi-model'
import type { BeaconFacts } from '../ie80211'
import type { WifiSighting } from '../../platform'
import type { ChannelAir, MonitorStatus } from '../../../shared/types'
import type { DecodedFrame } from './dot11'
import { DWELL_MS } from './plan'

/** Upper bound on access points tracked; a long session in a dense city must not grow without limit. */
export const MAX_APS = 512

interface WindowAp {
  rssiSum: number
  count: number
  freqMhz?: number
  facts: BeaconFacts
}

interface ApCounts {
  frames: number
  retries: number
  deauths: number
  /** Where it was last heard, which decides how long the radio was listening for it. */
  freqMhz?: number
}

interface ChannelCounts {
  frames: number
  retries: number
  /** Dwells that began, and tuning attempts the card refused. */
  visits: number
  failed: number
}

export interface MonitorState {
  /** Access points heard since the current sweep began. */
  window: Map<string, WindowAp>
  aps: Map<string, ApCounts>
  channels: Map<number, ChannelCounts>
  /** The sweep the journal is on; a higher number in a new line means the last one is complete. */
  pass: number
  frames: number
  bytes: number
}

export function createMonitorState(): MonitorState {
  return { window: new Map(), aps: new Map(), channels: new Map(), pass: 0, frames: 0, bytes: 0 }
}

function channelCounts(state: MonitorState, freqMhz: number): ChannelCounts {
  let c = state.channels.get(freqMhz)
  if (!c) {
    c = { frames: 0, retries: 0, visits: 0, failed: 0 }
    state.channels.set(freqMhz, c)
  }
  return c
}

function apCounts(state: MonitorState, bssid: string): ApCounts | undefined {
  let c = state.aps.get(bssid)
  if (!c) {
    if (state.aps.size >= MAX_APS) return undefined
    c = { frames: 0, retries: 0, deauths: 0 }
    state.aps.set(bssid, c)
  }
  return c
}

/**
 * The fields of `facts` that hold a value, so a sparse frame cannot blank a full one. A hidden
 * network's beacon carries an empty SSID, and must not wipe the name a probe response gave.
 */
function defined(facts: BeaconFacts): Partial<BeaconFacts> {
  return Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined && v !== ''))
}

function foldAccessPoint(
  state: MonitorState,
  frame: DecodedFrame,
  bssid: string,
  facts: BeaconFacts,
  isBeacon: boolean
): void {
  if (frame.rssi === undefined) return // a sighting without a signal says nothing about distance
  const existing = state.window.get(bssid)
  if (!existing) {
    if (state.window.size >= MAX_APS) return
    state.window.set(bssid, { rssiSum: frame.rssi, count: 1, freqMhz: frame.freqMhz, facts })
    return
  }
  existing.rssiSum += frame.rssi
  existing.count++
  existing.freqMhz = frame.freqMhz ?? existing.freqMhz
  // A beacon is the fuller description; a probe response only fills what the beacons left out.
  existing.facts = (
    isBeacon ? { ...existing.facts, ...defined(facts) } : { ...defined(facts), ...existing.facts }
  ) as BeaconFacts
}

/** Add one decoded frame. */
export function foldFrame(state: MonitorState, frame: DecodedFrame): void {
  state.frames++
  state.bytes += frame.bytes
  if (frame.freqMhz !== undefined) {
    const c = channelCounts(state, frame.freqMhz)
    c.frames++
    if (frame.retry) c.retries++
  }

  const { body } = frame
  const bssid = body.kind === 'other' ? undefined : body.bssid
  if (bssid === undefined) return
  const ap = apCounts(state, bssid)
  if (ap) {
    ap.frames++
    if (frame.retry) ap.retries++
    if (frame.freqMhz !== undefined) ap.freqMhz = frame.freqMhz
    if (body.kind === 'deauth' || body.kind === 'disassoc') ap.deauths++
  }
  if (body.kind === 'beacon' || body.kind === 'probe-response') {
    foldAccessPoint(state, frame, bssid, body.facts, body.kind === 'beacon')
  }
}

/**
 * Add one line of the session's hop journal: `ok <pass> <freq>` for a dwell that began,
 * `fail <pass> <freq>` for a channel the card would not tune to. Returns true when the line
 * starts a new sweep, which is the moment the previous one can be closed. Anything that is not a
 * journal line is ignored.
 */
export function foldHop(state: MonitorState, line: string): boolean {
  const m = /^(ok|fail) (\d+) (\d+)$/.exec(line.trim())
  if (!m) return false
  const pass = Number(m[2])
  const c = channelCounts(state, Number(m[3]))
  if (m[1] === 'ok') c.visits++
  else c.failed++
  const started = pass > state.pass
  if (started) state.pass = pass
  return started
}

/**
 * The sweep that just ended, as the sightings a scan would have produced, and start the next one.
 * The channel is the one the access point names in its own elements; the radio's channel is only
 * where it happened to be listening, and a frame leaks onto neighbouring channels.
 */
export function closeWindow(state: MonitorState): WifiSighting[] {
  const out: WifiSighting[] = []
  for (const [bssid, ap] of state.window) {
    const radio = ap.freqMhz === undefined ? undefined : channelFromMhz(ap.freqMhz)
    out.push({
      bssid,
      ssid: ap.facts.ssid ?? '',
      rssi: Math.round(ap.rssiSum / ap.count),
      channel: ap.facts.primaryChannel ?? radio?.channel ?? 0,
      band: radio?.band ?? '?',
      beacon: ap.facts
    })
  }
  state.window.clear()
  return out
}

/** Frames per second is ≈: the dwell is nominal, and the sweep's first partial dwell counts whole. */
function framesPerSec(frames: number, visits: number, dwellMs: number): number | undefined {
  return visits > 0 ? Math.round((frames / ((visits * dwellMs) / 1000)) * 10) / 10 : undefined
}

const retryPct = (retries: number, frames: number): number =>
  frames > 0 ? Math.round((retries / frames) * 100) : 0

/**
 * What listening measured on every channel it tried, quiet and unreachable ones included. A
 * channel with frames but no journal line yet is left out until the journal catches up: without a
 * dwell count there is nothing to divide by, and "could not tune" would be the wrong thing to say.
 */
export function channelAir(state: MonitorState, dwellMs = DWELL_MS): ChannelAir[] {
  const out: ChannelAir[] = []
  for (const [freqMhz, c] of state.channels) {
    const where = channelFromMhz(freqMhz)
    if (!where || (c.visits === 0 && c.failed === 0)) continue
    out.push({
      ...where,
      visited: c.visits,
      framesPerSec: framesPerSec(c.frames, c.visits, dwellMs) ?? 0,
      retryPct: retryPct(c.retries, c.frames)
    })
  }
  return out
}

export interface ApAir {
  deauths: number
  /** Absent until the radio has dwelt on the access point's channel at least once. */
  framesPerSec?: number
  retryPct: number
}

/** Per access point, keyed by BSSID: how much of the channel's airtime named it, and how clean. */
export function apAir(state: MonitorState, dwellMs = DWELL_MS): Map<string, ApAir> {
  const out = new Map<string, ApAir>()
  for (const [bssid, ap] of state.aps) {
    const visits = ap.freqMhz === undefined ? 0 : (state.channels.get(ap.freqMhz)?.visits ?? 0)
    out.set(bssid, {
      deauths: ap.deauths,
      framesPerSec: framesPerSec(ap.frames, visits, dwellMs),
      retryPct: retryPct(ap.retries, ap.frames)
    })
  }
  return out
}

/** The counts the status line shows; the session adds what only it knows (file size, clock). */
export function monitorCounts(
  state: MonitorState
): Pick<MonitorStatus, 'frames' | 'bytes' | 'passes' | 'channelsVisited' | 'channelsFailed'> {
  let visited = 0
  let failed = 0
  for (const c of state.channels.values()) {
    if (c.visits > 0) visited++
    else if (c.failed > 0) failed++
  }
  // The sweep the journal is on is still running, so it is not counted as complete.
  return {
    frames: state.frames,
    bytes: state.bytes,
    passes: Math.max(0, state.pass - 1),
    channelsVisited: visited,
    channelsFailed: failed
  }
}
