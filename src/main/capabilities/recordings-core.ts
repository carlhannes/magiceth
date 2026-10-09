// Pure CSV for Wi-Fi recordings: writing them, and reading them back.
//
// Mirrors profiles-core.ts — every function here is pure and exported, and all the fs/electron
// glue lives next door in recordings.ts. The CSV is the only artifact: it is both the thing you
// open in a spreadsheet and the thing the app reads to list past recordings, so there is no second
// format to drift out of sync with it.

import type { RecordingSummary, WifiBss, WifiTrack } from '../../shared/types'
import type { WifiBand } from '../../shared/types'

// --- CSV primitives (RFC 4180) ---
//
// SSIDs are attacker-adjacent free text off the air: they legitimately contain commas, quotes,
// semicolons and emoji. Everything written goes through csvEscape, and everything read comes back
// through splitCsvLine, or a café called `Bob's "Bar", Ltd` silently corrupts every later column.

export function csvEscape(value: string | number | boolean | undefined | null): string {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value)
  if (!/[",\r\n]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

/** Split one CSV record. Unterminated quotes yield the rest of the line rather than throwing. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      out.push(field)
      field = ''
    } else field += c
  }
  out.push(field)
  return out
}

function row(values: (string | number | boolean | undefined)[]): string {
  return values.map(csvEscape).join(',')
}

/** An unknown band is an empty cell, the same as every other unknown. */
function bandOut(band: WifiBand): string {
  return band === '?' ? '' : band
}

function bandIn(text: string): WifiBand {
  return text === '2.4' || text === '5' || text === '6' ? text : '?'
}

/** `2x2`, or empty when the beacon did not say. Round-trips back to a stream count. */
function mimoOut(streams?: number): string {
  return streams ? `${streams}x${streams}` : ''
}

function mimoIn(text: string): number | undefined {
  const m = /^(\d+)x\1$/.exec(text.trim())
  return m ? Number(m[1]) : undefined
}

function numIn(text: string): number | undefined {
  if (text.trim() === '') return undefined
  const n = Number(text)
  return Number.isFinite(n) ? n : undefined
}

function textIn(text: string): string | undefined {
  return text === '' ? undefined : text
}

// --- The time log: one row per access point per snapshot ---

export const SAMPLE_HEADER =
  'time_s,iso_time,ssid,bssid,rssi_dbm,noise_dbm,channel,band_ghz,width_mhz,phy,mimo,' +
  'security,clients,utilization_pct,vendor,model,locally_administered,country'

/**
 * One snapshot as CSV rows, newline-terminated so it can simply be appended. Returns an empty
 * string when nothing was heard, so a blank moment adds nothing to the file.
 */
export function sampleRows(atSec: number, isoTime: string, bssids: WifiBss[]): string {
  if (bssids.length === 0) return ''
  return (
    bssids
      .map((b) =>
        row([
          atSec,
          isoTime,
          b.ssid,
          b.bssid,
          b.rssi,
          b.noise,
          b.channel,
          bandOut(b.band),
          b.widthMhz,
          b.phy,
          mimoOut(b.streams),
          b.security,
          b.clients,
          b.utilizationPct,
          b.vendor,
          b.model,
          b.locallyAdministered,
          b.countryCode
        ])
      )
      .join('\n') + '\n'
  )
}

// --- The aggregate: one row per access point, grouped by network ---

export const AGGREGATE_HEADER =
  'ssid,bssid,vendor,model,security,phy,mimo,channel,band_ghz,width_mhz,' +
  'rssi_min,rssi_max,rssi_avg,rssi_last,clients_min,clients_max,clients_avg,clients_last,' +
  'util_min,util_max,util_avg,util_last,sightings,first_seen_s,last_seen_s,' +
  'locally_administered,country'

/**
 * Sort key that puts every access point of one network together, strongest first within it.
 * Hidden networks have no name to group on, so they go last rather than sorting to the top on an
 * empty string.
 */
function groupKey(t: WifiTrack): string {
  return t.ssid === '' ? '￿' : t.ssid.toLowerCase()
}

export function sortForAggregate(tracks: WifiTrack[]): WifiTrack[] {
  return [...tracks].sort(
    (a, b) =>
      groupKey(a).localeCompare(groupKey(b)) ||
      b.rssi.max - a.rssi.max ||
      a.bssid.localeCompare(b.bssid)
  )
}

export function aggregateCsv(tracks: WifiTrack[]): string {
  const body = sortForAggregate(tracks).map((t) =>
    row([
      t.ssid,
      t.bssid,
      t.vendor,
      t.model,
      t.security,
      t.phy,
      mimoOut(t.streams),
      t.channel,
      bandOut(t.band),
      t.widthMhz,
      t.rssi.min,
      t.rssi.max,
      t.rssi.avg,
      t.rssi.last,
      t.clients?.min,
      t.clients?.max,
      t.clients?.avg,
      t.clients?.last,
      t.utilizationPct?.min,
      t.utilizationPct?.max,
      t.utilizationPct?.avg,
      t.utilizationPct?.last,
      t.sightings,
      t.firstSeenSec,
      t.lastSeenSec,
      t.locallyAdministered,
      t.countryCode
    ])
  )
  return [AGGREGATE_HEADER, ...body].join('\n') + '\n'
}

function rangeIn(min: string, max: string, avg: string, last: string) {
  const lo = numIn(min)
  const hi = numIn(max)
  const mean = numIn(avg)
  const latest = numIn(last)
  if (lo === undefined || hi === undefined || mean === undefined || latest === undefined) {
    return undefined
  }
  return { min: lo, max: hi, avg: mean, last: latest }
}

/**
 * Read an aggregate back into tracks.
 *
 * Unreadable lines are skipped rather than thrown on: a recording killed mid-write leaves a
 * truncated last line, and one bad row must not make the whole list unopenable.
 */
export function parseAggregateCsv(text: string): WifiTrack[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0 || !lines[0].startsWith('ssid,')) return []
  const out: WifiTrack[] = []
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line)
    if (f.length < 27) continue
    const rssi = rangeIn(f[10], f[11], f[12], f[13])
    if (!f[1] || !rssi) continue
    out.push({
      ssid: f[0],
      bssid: f[1],
      vendor: textIn(f[2]),
      model: textIn(f[3]),
      security: f[4] || 'Open',
      phy: textIn(f[5]),
      streams: mimoIn(f[6]),
      channel: numIn(f[7]) ?? 0,
      band: bandIn(f[8]),
      widthMhz: numIn(f[9]),
      rssi,
      clients: rangeIn(f[14], f[15], f[16], f[17]),
      utilizationPct: rangeIn(f[18], f[19], f[20], f[21]),
      sightings: numIn(f[22]) ?? 0,
      firstSeenSec: numIn(f[23]) ?? 0,
      lastSeenSec: numIn(f[24]) ?? 0,
      locallyAdministered: f[25] === 'yes',
      countryCode: textIn(f[26])
    })
  }
  return out
}

// --- Filenames ---
//
// The filename carries the start time, which is why the aggregate needs no metadata rows: the
// file stays clean for a spreadsheet and there is still only one place the truth lives.

const ID_PATTERN = /^wifi-(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})$/

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Local time, because a technician reads the folder in the timezone they were standing in. */
export function recordingId(startedAt: Date): string {
  return (
    `wifi-${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}` +
    `_${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}`
  )
}

export function isRecordingId(id: string): boolean {
  return ID_PATTERN.test(id)
}

/** `2026-09-29 21:45:03` for display, or undefined when the name is not one of ours. */
export function startedAtFromId(id: string): string | undefined {
  const m = ID_PATTERN.exec(id)
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : undefined
}

/**
 * Describe a recording from its tracks alone. Duration, access points and networks are all
 * derivable, so listing recordings needs no sidecar file.
 */
export function summarize(id: string, path: string, tracks: WifiTrack[]): RecordingSummary {
  const networks = new Set(tracks.map((t) => (t.ssid === '' ? `\u0000${t.bssid}` : t.ssid)))
  return {
    id,
    startedAt: startedAtFromId(id) ?? id,
    durationSec: tracks.reduce((max, t) => Math.max(max, t.lastSeenSec), 0),
    accessPoints: tracks.length,
    networks: networks.size,
    path
  }
}
