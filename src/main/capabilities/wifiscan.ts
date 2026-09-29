// WLAN scanning. macOS only for now.
//
// The scan itself is done by a small Swift helper shipped as a .app bundle, because macOS reveals
// BSSIDs and beacon information elements only to a process holding a Location Services grant, and
// only ever offers that grant to a real bundle. See docs/WIFI-FINDINGS.md for the evidence.
//
// The shape of this module is survey.ts's: one active run held at module level, every asynchronous
// continuation re-checking that it is still the current one, and a typed result with a human
// message on every degraded path rather than a thrown error.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../util/run-command'
import { readBeacon } from './ie80211'
import { resolveVendor } from './oui'
import { channelSummary, foldSighting, groupBySsid, toTracks } from './wifi-model'
import type { TrackStore } from './wifi-model'
import { appendSnapshot, beginRecording, finishRecording } from './recordings'
import type { RecordingPaths } from './recordings'
import type { WifiBand, WifiBss, WifiScanResult } from '../../shared/types'

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

const HELPER_TIMEOUT_MS = 30_000

interface HelperNetwork {
  ssid?: string
  bssid?: string
  rssi: number
  noise?: number
  channel?: number
  band?: number
  width?: number
  ie?: string
  countryCode?: string
}

interface HelperOutput {
  status: string
  auth?: string
  networks?: HelperNetwork[]
  message?: string
}

/**
 * Where the helper bundle lives. The development copy wins when it is present, which is exactly
 * right: it only exists in a checkout, never inside a packaged app.
 */
export function helperPath(): string {
  const executable = 'magiceth-wifi.app/Contents/MacOS/magiceth-wifi'
  const dev = join(__dirname, '../../resources/wifi-helper/build', executable)
  if (existsSync(dev)) return dev
  return join(process.resourcesPath ?? '', 'wifi-helper', executable)
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
 * The second-least-significant bit of the first octet is the locally-administered bit. Modern APs
 * set it on the virtual BSSIDs they invent per SSID, and no OUI lookup can succeed for one — so it
 * is recorded rather than silently producing an "unknown vendor".
 */
export function isLocallyAdministered(bssid: string): boolean {
  const first = Number.parseInt(bssid.slice(0, 2), 16)
  return Number.isFinite(first) && (first & 0x02) !== 0
}

/** One helper record to one access point. Pure, so the whole mapping is testable from a fixture. */
export function toBss(n: HelperNetwork): WifiBss | undefined {
  if (!n.bssid) return undefined
  const beacon = n.ie ? readBeacon(n.ie) : { vendorOuis: [] as string[] }
  const bssid = n.bssid.toLowerCase()
  return {
    bssid,
    // The SSID element in the beacon is the authoritative one; CoreWLAN's copy is a convenience.
    ssid: n.ssid || beacon.ssid || '',
    rssi: n.rssi,
    noise: n.noise === 0 ? undefined : n.noise,
    channel: n.channel ?? 0,
    band: bandOf(n.band),
    widthMhz: widthOf(n.width),
    phy: beacon.phy,
    streams: beacon.streams,
    security: beacon.security ?? 'Open',
    clients: beacon.clients,
    utilizationPct: beacon.utilizationPct,
    // A model name broadcast in a WPS element is self-declared and beats any lookup; otherwise
    // the address, or the beacon's vendor elements when the address is randomised.
    vendor:
      beacon.manufacturer ?? resolveVendor(bssid, isLocallyAdministered(bssid), beacon.vendorOuis),
    model: beacon.model,
    locallyAdministered: isLocallyAdministered(bssid),
    countryCode: n.countryCode
  }
}

interface ActiveScan {
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
    scans: 0,
    elapsedSec: 0,
    message
  }
}

/**
 * Raise the Location Services dialog.
 *
 * It has to go through LaunchServices: a binary started as a child of another process is
 * attributed to that parent by TCC, so asking from there is a silent no-op — no dialog, no error.
 * Launched this way the helper is responsible for itself and macOS prompts properly. Fire and
 * forget; the next scan picks up the answer.
 */
function requestPermission(): void {
  const bundle = helperPath().replace(/\/Contents\/MacOS\/.*$/, '')
  void run('open', ['-a', bundle], { timeoutMs: 5000 })
}

async function scanOnce(device: string): Promise<HelperOutput | string> {
  const helper = helperPath()
  if (!existsSync(helper)) {
    return 'The Wi-Fi helper is missing — run scripts/build-wifi-helper.sh.'
  }
  const result = await run(helper, ['--interface', device], { timeoutMs: HELPER_TIMEOUT_MS })
  if (!result.stdout.trim()) {
    return result.stderr.trim() || 'The Wi-Fi helper produced no output.'
  }
  try {
    return JSON.parse(result.stdout) as HelperOutput
  } catch {
    return 'The Wi-Fi helper produced output that could not be read.'
  }
}

function ingest(s: ActiveScan, output: HelperOutput): void {
  const seen: WifiBss[] = []
  for (const raw of output.networks ?? []) {
    const bss = toBss(raw)
    if (bss) seen.push(bss)
  }
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
    void scanOnce(s.device).then((output) => {
      if (active !== s) return
      if (typeof output !== 'string' && output.status === 'ok') {
        ingest(s, output)
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

  if (process.platform !== 'darwin') {
    return fail(device, 'unsupported', 'Wi-Fi scanning is macOS-only in this version.')
  }

  const output = await scanOnce(device)
  // Someone pressed again while this scan was in the air; that call owns the state now.
  if (mine !== generation)
    return active
      ? snapshot(active, active.recording)
      : fail(device, 'error', 'Superseded by a newer scan.')
  if (typeof output === 'string') return fail(device, 'no-helper', output)
  if (output.status !== 'ok') {
    requestPermission()
    return fail(
      device,
      'needs-permission',
      output.message ??
        'macOS hides access point details until magiceth has Location access. Approve the prompt, then scan again.'
    )
  }

  // Keep the history across a one-off scan so repeated presses build a picture; a new recording
  // starts from nothing, because that is what pressing record means.
  const keep = mode === 'once' && previous ? previous : null
  const s: ActiveScan = {
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
  ingest(s, output)
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
