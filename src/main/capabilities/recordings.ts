// Electron/fs glue around the pure CSV in recordings-core.ts, on the same pattern as
// profiles.ts. Recordings go in ~/Documents/magiceth rather than userData, because the point of
// saving them is that you can find, open and send them — a path under Application Support is
// somewhere nobody looks.

import { app, shell } from 'electron'
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { RecordingSummary, SavedRecording, WifiBss, WifiTrack } from '../../shared/types'
import { channelSummary, groupBySsid, trackToBss } from './wifi-model'
import {
  aggregateCsv,
  isRecordingId,
  parseAggregateCsv,
  recordingId,
  SAMPLE_HEADER,
  sampleRows,
  summarize
} from './recordings-core'

/**
 * Below this, a recording is discarded on stop. A stray press of the record key should leave
 * nothing behind; three snapshots is six seconds, which is the shortest run that could say
 * anything about how a signal moved.
 */
const MIN_SNAPSHOTS = 3

const AGG_SUFFIX = '.agg.csv'

export interface RecordingPaths {
  id: string
  log: string
  aggregate: string
}

export function recordingsDir(): string {
  return join(app.getPath('documents'), 'magiceth')
}

/**
 * Only ever build a path from an id that matches our own filename pattern. The id arrives from the
 * renderer, and `isRecordingId` is what stops `../../something` from being turned into a path.
 */
function pathFor(id: string, suffix: string): string | undefined {
  return isRecordingId(id) ? join(recordingsDir(), `${id}${suffix}`) : undefined
}

/**
 * Create the time log and write its header. Returns undefined if the folder cannot be written —
 * macOS may refuse access to Documents — in which case the recording still runs in memory and
 * only the saving is lost.
 */
export function beginRecording(startedAt: Date): RecordingPaths | undefined {
  try {
    mkdirSync(recordingsDir(), { recursive: true })
    const id = recordingId(startedAt)
    const paths: RecordingPaths = {
      id,
      log: join(recordingsDir(), `${id}.csv`),
      aggregate: join(recordingsDir(), `${id}${AGG_SUFFIX}`)
    }
    writeFileSync(paths.log, `${SAMPLE_HEADER}\n`, 'utf8')
    return paths
  } catch {
    return undefined
  }
}

/** Append one snapshot. A write that fails must not take the scan down with it. */
export function appendSnapshot(
  paths: RecordingPaths,
  atSec: number,
  isoTime: string,
  bssids: WifiBss[]
): void {
  const rows = sampleRows(atSec, isoTime, bssids)
  if (rows === '') return
  try {
    appendFileSync(paths.log, rows, 'utf8')
  } catch {
    // Out of space or permission withdrawn mid-run. The live scan keeps working.
  }
}

/**
 * Write the aggregate, or remove both files when the run was too short to be worth keeping.
 * Returns the aggregate's path when one was written.
 *
 * Synchronous on purpose: this runs from `before-quit`, which does not await.
 */
export function finishRecording(
  paths: RecordingPaths,
  tracks: WifiTrack[],
  snapshots: number
): string | undefined {
  try {
    if (snapshots < MIN_SNAPSHOTS || tracks.length === 0) {
      rmSync(paths.log, { force: true })
      rmSync(paths.aggregate, { force: true })
      return undefined
    }
    writeFileSync(paths.aggregate, aggregateCsv(tracks), 'utf8')
    return paths.aggregate
  } catch {
    return undefined
  }
}

/** Newest first. A folder that does not exist yet is simply an empty list. */
export function listRecordings(): RecordingSummary[] {
  let names: string[]
  try {
    names = readdirSync(recordingsDir())
  } catch {
    return []
  }
  const out: RecordingSummary[] = []
  for (const name of names) {
    if (!name.endsWith(AGG_SUFFIX)) continue
    const id = name.slice(0, -AGG_SUFFIX.length)
    const path = pathFor(id, AGG_SUFFIX)
    if (!path) continue
    try {
      out.push(summarize(id, path, parseAggregateCsv(readFileSync(path, 'utf8'))))
    } catch {
      // A file being written right now, or one somebody edited into nonsense. Skip it.
    }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id))
}

export function readRecording(id: string): SavedRecording | null {
  const path = pathFor(id, AGG_SUFFIX)
  if (!path) return null
  try {
    const tracks = parseAggregateCsv(readFileSync(path, 'utf8'))
    return {
      summary: summarize(id, path, tracks),
      tracks,
      // Flattening each track to its last reading means a saved recording goes through exactly the
      // same grouping the live scan does, rather than a second implementation of it.
      networks: groupBySsid(tracks.map(trackToBss)),
      channels: channelSummary(tracks)
    }
  } catch {
    return null
  }
}

/** Open the platform file manager with the recording selected. */
export function revealRecording(id: string): void {
  const path = pathFor(id, AGG_SUFFIX)
  if (path) shell.showItemInFolder(path)
}
