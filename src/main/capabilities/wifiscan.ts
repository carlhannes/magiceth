// WLAN scanning: the active scan, the recording loop, and the one place a sighting becomes an
// access point with a vendor. How the air is actually read differs per OS and lives behind
// PlatformOps.scanWifi — the macOS helper .app, `iw` on Linux, a PowerShell helper on Windows —
// so nothing in here knows which one it is talking to.
//
// The shape of this module is survey.ts's: one active run held at module level, every asynchronous
// continuation re-checking that it is still the current one, and a typed result with a human
// message on every degraded path rather than a thrown error.

import { getPlatform } from '../platform'
import type { PlatformOps, WifiScanOutcome, WifiSighting } from '../platform'
import {
  channelBuckets,
  channelSummary,
  foldSighting,
  groupBySsid,
  toBss,
  toTracks
} from './wifi-model'
import type { TrackStore } from './wifi-model'
import { appendSnapshot, beginRecording, finishRecording } from './recordings'
import type { RecordingPaths } from './recordings'
import type { WifiAccessResult, WifiBss, WifiScanResult } from '../../shared/types'

/**
 * Gap between scans. A scan takes about five seconds by itself — the radio has to visit every
 * channel — so this only controls how hard we lean on it, not the cadence.
 */
const SCAN_GAP_MS = 750

/** A recording left running is still moving the radio off-channel, so it does not run forever. */
const MAX_SECONDS = 1800

/**
 * Shortest gap between snapshots of everything the radio can hear. A row per access point per
 * scan would be a large file describing a walk at a resolution nobody reads; at walking pace two
 * seconds is roughly one reading every three metres.
 *
 * A floor, not a cadence. Snapshots can only be taken when a scan returns, and a full sweep of
 * every channel sometimes takes six seconds, so gaps in a real log vary between two and about
 * seven seconds. Re-emitting the previous reading to fill those gaps would only invent data.
 */
const SNAPSHOT_MS = 2000

interface ActiveScan {
  platform: PlatformOps
  device: string
  startedAt: number
  scans: number
  /** The most recent scan alone — what is in earshot right now. */
  latest: WifiBss[]
  /**
   * Every access point met since the accumulator was last cleared, at its newest values. A
   * recording is taken while walking, so the list has to hold what was encountered along the way;
   * showing only the last scan would drop an access point the moment you stepped away from it.
   */
  seen: Map<string, WifiBss>
  store: TrackStore
  recording: boolean
  /** Once a recording has run, the list stays cumulative — that is the result you walked for. */
  hasRecorded: boolean
  /** Where this recording is being written, when one could be opened. */
  paths?: RecordingPaths
  snapshots: number
  lastSnapshotAt: number
  timer?: NodeJS.Timeout
  onUpdate: (result: WifiScanResult) => void
}

let active: ActiveScan | null = null

/**
 * Bumped by every start. A start has to await the first scan before it can install itself, and a
 * second press arriving inside that window would otherwise be overwritten by the first call
 * resuming — leaving the newer recording running but unreachable. Comparing generations lets the
 * superseded call bow out instead.
 */
let generation = 0

function elapsed(s: ActiveScan): number {
  return Math.round((Date.now() - s.startedAt) / 1000)
}

function snapshot(s: ActiveScan, running: boolean): WifiScanResult {
  // A plain one-off scan answers "what is here now", so it shows only what it just heard. A
  // recording answers "what did I pass", so it shows everything since it started.
  const shown = s.hasRecorded ? [...s.seen.values()] : s.latest
  const tracks = toTracks(s.store)
  return {
    status: 'ok',
    running,
    device: s.device,
    networks: groupBySsid(shown),
    tracks,
    channels: channelSummary(tracks),
    buckets: channelBuckets(tracks),
    scans: s.scans,
    elapsedSec: elapsed(s),
    savedTo: s.paths?.aggregate
  }
}

function fail(device: string, status: WifiScanResult['status'], message: string): WifiScanResult {
  return {
    status,
    running: false,
    device,
    networks: [],
    tracks: [],
    channels: [],
    buckets: [],
    scans: 0,
    elapsedSec: 0,
    message
  }
}

/** The OS this is running on, or null where none of the three implementations applies. */
function platform(): PlatformOps | null {
  try {
    return getPlatform()
  } catch {
    return null
  }
}

/** One sweep. The platform promises never to throw, but a bug there must not take the loop down. */
async function scanOnce(p: PlatformOps, device: string): Promise<WifiScanOutcome> {
  try {
    return await p.scanWifi(device)
  } catch (err) {
    return { status: 'error', message: `Wi-Fi scan failed: ${String(err)}` }
  }
}

function ingest(s: ActiveScan, sightings: WifiSighting[]): void {
  const seen = sightings.map(toBss)
  s.latest = seen
  s.scans++
  const at = elapsed(s)
  for (const bss of seen) {
    s.seen.set(bss.bssid, bss)
    foldSighting(s.store, bss, at)
  }
  // Write as we go rather than at the end, so a crash, a quit or a flat battery still leaves the
  // walk on disk. The aggregate is the only thing that waits for the stop.
  const now = Date.now()
  if (s.paths && now - s.lastSnapshotAt >= SNAPSHOT_MS) {
    s.lastSnapshotAt = now
    s.snapshots++
    appendSnapshot(s.paths, at, new Date(now).toISOString(), seen)
  }
}

/** Schedule the next scan of a recording, unless this run has been superseded or capped. */
function loop(s: ActiveScan): void {
  if (active !== s || !s.recording) return
  if (elapsed(s) >= MAX_SECONDS) {
    stopWifiScan()
    return
  }
  s.timer = setTimeout(() => {
    if (active !== s) return
    void scanOnce(s.platform, s.device).then((out) => {
      if (active !== s) return
      if (out.status === 'ok') {
        ingest(s, out.sightings)
        // Report the state as it is now, not as it was when this scan was launched. A stop that
        // lands while a scan is in flight would otherwise be undone by the result arriving after
        // it and announcing `running: true` again.
        s.onUpdate(snapshot(s, s.recording))
      }
      loop(s)
    })
  }, SCAN_GAP_MS)
}

/**
 * `once` adds a single sample to whatever has already been collected; `record` clears the history
 * and keeps scanning until stopped, which is what makes min/max/avg mean anything.
 */
export async function startWifiScan(
  device: string,
  mode: 'once' | 'record',
  onUpdate: (result: WifiScanResult) => void
): Promise<WifiScanResult> {
  const previous = active
  if (previous?.recording) stopWifiScan()
  const mine = ++generation

  const p = platform()
  if (!p) {
    return fail(device, 'unsupported', `Wi-Fi scanning is not available on ${process.platform}.`)
  }

  const out = await scanOnce(p, device)
  // Someone pressed again while this scan was in the air; that call owns the state now.
  if (mine !== generation)
    return active
      ? snapshot(active, active.recording)
      : fail(device, 'error', 'Superseded by a newer scan.')
  if (out.status !== 'ok') {
    // Only a refusal is worth asking about; a missing tool or a broken helper is not a prompt.
    if (out.status === 'needs-permission') p.requestWifiAccess()
    const result = fail(device, out.status, out.message)
    if (out.status === 'needs-permission' && p.enableWifiAccess) result.canEnableAccess = true
    return result
  }

  // Keep the history across a one-off scan so repeated presses build a picture; a new recording
  // starts from nothing, because that is what pressing record means.
  const keep = mode === 'once' && previous ? previous : null
  const s: ActiveScan = {
    platform: p,
    device,
    startedAt: keep?.device === device ? keep.startedAt : Date.now(),
    scans: keep?.device === device ? keep.scans : 0,
    latest: [],
    seen: keep?.device === device ? keep.seen : new Map(),
    store: keep?.device === device ? keep.store : new Map(),
    recording: mode === 'record',
    hasRecorded: mode === 'record' || (keep?.device === device && keep.hasRecorded === true),
    paths: mode === 'record' ? beginRecording(new Date()) : undefined,
    snapshots: 0,
    lastSnapshotAt: 0,
    onUpdate
  }
  active = s
  ingest(s, out.sightings)
  if (s.recording) loop(s)
  return snapshot(s, s.recording)
}

/** Safe to call when nothing is running. */
export function stopWifiScan(): WifiScanResult | null {
  const s = active
  if (!s) return null
  const wasRecording = s.recording
  s.recording = false
  if (s.timer) clearTimeout(s.timer)
  s.timer = undefined
  if (wasRecording && s.paths) {
    const written = finishRecording(s.paths, toTracks(s.store), s.snapshots)
    // A run too short to be worth keeping deletes itself, so stop claiming it was saved.
    if (!written) s.paths = undefined
  }
  return snapshot(s, false)
}

/** On quit: stop whatever long-lived thing the OS half may have started (the Linux scan loop). */
export function endWifiSession(): void {
  platform()?.endWifiSession()
}

/** The opt-in Location fix, where the OS has one. Never throws: the renderer shows the message. */
export async function enableWifiAccess(): Promise<WifiAccessResult> {
  const p = platform()
  if (!p?.enableWifiAccess) return { ok: false, message: 'Nothing to change on this system.' }
  try {
    return await p.enableWifiAccess()
  } catch (err) {
    return { ok: false, message: `Could not change the Location settings: ${String(err)}` }
  }
}
