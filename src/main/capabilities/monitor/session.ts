// One listening session: start the elevated script, follow the two files it writes, and turn what
// arrives into sightings and counters. The shape is survey.ts's — a capture written by root to a
// file the app tails, stopped by creating a file, so a stop needs no second password prompt — and
// like it this module never touches Electron, so it can be tested in node.
//
// What it keeps on disk is the capture, the hop journal and the log, in the user's own scratch
// directory, and all three are deleted when the session ends; the capture first, at the moment of
// the stop. A capture holds whatever its radio heard, other people's frames included, so nothing
// is left behind to be found later: a leftover from a crash is removed by the next session.

import fs from 'node:fs'
import path from 'node:path'
import { elevationRefused, runElevatedPlan } from '../../privilege'
import { MONITOR_MAX_BYTES, MONITOR_MAX_SECONDS } from '../../platform/iw'
import type { MonitorSpec, MonitorSupport, PlatformOps, WifiSighting } from '../../platform'
import { scratchFile } from '../../util/scratch'
import { channelFromMhz } from '../wifi-model'
import type { MonitorStatus } from '../../../shared/types'
import { decodeFrame } from './dot11'
import { closeWindow, createMonitorState, foldFrame, foldHop, monitorCounts } from './model'
import type { MonitorState } from './model'
import { createPcapReader, feedPcap } from './pcap'
import type { PcapRecord } from './pcap'
import { DWELL_MS, FALLBACK_CHANNELS, planHops } from './plan'

const TICK_MS = 1000
/** A tick reads at most this much of the capture, so one long stall cannot freeze the window. */
const MAX_READ = 16 * 1024 * 1024
/**
 * Extra time on top of the session's own cap before the elevated call is given up on. It has to
 * cover however long the admin prompt sits unanswered, because the call's clock starts at the
 * prompt and the script's own cap only starts after it; the script's cap is the real backstop.
 */
const SLACK_MS = 10 * 60_000
/** A replayed capture has no hop journal, so it is given one: a new sweep this often. */
const REPLAY_SWEEP_MS = 8000

export interface MonitorCallbacks {
  /** A sweep of the channels completed; these are the access points it heard, as a scan would give. */
  onWindow(sightings: WifiSighting[]): void
  /** Once a second while running: the counters moved. */
  onTick(): void
  /** The session ended without being asked to. Not called after stop(). */
  onEnd(outcome: MonitorOutcome): void
}

export interface MonitorOutcome {
  status: 'ok' | 'needs-privilege' | 'error'
  message: string
}

export interface MonitorRun {
  readonly state: MonitorState
  status(): MonitorStatus
  /** Hold the radio on one channel; the width and centre default to a plain 20 MHz channel. */
  pin(target: { freqMhz: number; widthMhz?: number; centreMhz?: number } | null): void
  /** Synchronous, safe to call twice and from `before-quit`. */
  stop(): void
  /**
   * False until the elevated script has exited — which, after a stop, is when it has finished
   * putting the Wi-Fi back. A new session must wait for it: two scripts at once would undo each other.
   */
  readonly scriptDone: boolean
}

/**
 * A development aid: a capture file played back in place of the elevated script, at the pace it
 * was recorded, with a made-up hop journal. It exists so the screens can be driven on a computer
 * that cannot listen; the rates it produces are not measurements.
 */
export function replayFile(): string | undefined {
  return process.env.MAGICETH_MONITOR_REPLAY || undefined
}

/** Capture files a crashed session left behind; the next session's first act is to remove them. */
function removeLeftovers(keep?: string): void {
  const dir = path.dirname(scratchFile('monitor'))
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name)
      if (name.startsWith('monitor-') && file !== keep) fs.rmSync(file, { force: true })
    }
  } catch {
    // Nothing to remove, or no right to remove it.
  }
}

/** The bytes a file has gained since `offset`, and where to read from next. */
function readNew(file: string, offset: number): { data: Buffer; next: number } | undefined {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    if (size <= offset) return undefined
    const data = Buffer.alloc(Math.min(size - offset, MAX_READ))
    fs.readSync(fd, data, 0, data.length, offset)
    return { data, next: offset + data.length }
  } catch {
    return undefined // not created yet
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function lastLine(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).pop()
  } catch {
    return undefined
  }
}

function removeAll(files: string[]): void {
  for (const f of files) fs.rmSync(f, { force: true })
}

/**
 * Start a session. Returns at once; the admin prompt happens inside the elevated call, which only
 * returns when the session is over. `support` comes from PlatformOps.monitorSupport.
 */
export function startMonitor(
  p: PlatformOps,
  device: string,
  support: MonitorSupport,
  cb: MonitorCallbacks
): MonitorRun {
  const replay = replayFile()
  removeLeftovers(replay)
  const stamp = `${process.pid}-${Date.now()}`
  const files = {
    pcapFile: replay ?? scratchFile(`monitor-${stamp}.pcap`),
    hopsFile: scratchFile(`monitor-${stamp}.hops`),
    logFile: scratchFile(`monitor-${stamp}.log`),
    stopFile: scratchFile(`monitor-${stamp}.stop`),
    pinFile: scratchFile(`monitor-${stamp}.pin`)
  }
  const mine = [files.hopsFile, files.logFile, files.stopFile, files.pinFile]
  const state = createMonitorState()
  const reader = createPcapReader()

  const hopsToFold: string[] = []
  let replayRecords: PcapRecord[] | undefined
  let replayNext = 0
  let replayLink = 0
  const replayVisited = new Set<number>()
  let replayPass = 0
  let pcapOffset = 0
  let hopsOffset = 0
  let hopsTail = ''
  let startedAt = Date.now()
  let pinned: number | undefined
  let ended = false
  let endedAt: number | undefined
  let scriptDone = false
  let message: string | undefined

  const freqs = planHops(support.channels.length > 0 ? support.channels : FALLBACK_CHANNELS)

  /** Replay: release the records whose time has come, and write the journal a script would have. */
  function replayStep(file: string): void {
    if (!replayRecords) {
      const r = createPcapReader()
      try {
        replayRecords = feedPcap(r, fs.readFileSync(file))
      } catch (err) {
        replayRecords = []
        message = `Cannot read ${file}: ${String(err)}`
      }
      if (r.error) message = `Cannot read the capture: ${r.error}.`
      replayLink = r.format?.linkType ?? 0
      pcapOffset = 1 // "capture bytes have arrived": starts the elapsed clock in status()
    }
    const elapsed = Date.now() - startedAt
    const first = replayRecords[0]?.atMs ?? 0
    const due: PcapRecord[] = []
    while (replayNext < replayRecords.length && replayRecords[replayNext].atMs - first <= elapsed) {
      due.push(replayRecords[replayNext++])
    }
    const pass = 1 + Math.floor(elapsed / REPLAY_SWEEP_MS)
    if (pass !== replayPass) {
      replayPass = pass
      replayVisited.clear()
    }
    const frames = due.map((record) => decodeFrame(record, replayLink))
    for (const frame of frames) {
      if (frame?.freqMhz !== undefined && !replayVisited.has(frame.freqMhz)) {
        replayVisited.add(frame.freqMhz)
        hopsToFold.push(`ok ${pass} ${frame.freqMhz}`)
      }
    }
    if (hopsToFold.length === 0 && state.pass !== pass) hopsToFold.push(`ok ${pass} 0`)
    // Journal first, as with a live capture; then the frames those dwells heard.
    for (const line of hopsToFold.splice(0)) {
      if (foldHop(state, line)) {
        const heard = closeWindow(state)
        if (heard.length > 0) cb.onWindow(heard)
      }
    }
    for (const frame of frames) if (frame) foldFrame(state, frame)
    if (replayNext >= replayRecords.length) {
      finish({ status: 'ok', message: 'The replayed capture has ended.' })
    }
  }

  /** Take in whatever the script has appended since the last call. */
  function drain(): void {
    if (replay) return replayStep(replay)
    // The journal first: a dwell's line is written before any frame of it, so frames read after
    // it always belong to dwells the journal already knows about.
    const hops = readNew(files.hopsFile, hopsOffset)
    if (hops) {
      hopsOffset = hops.next
      const lines = (hopsTail + hops.data.toString('utf8')).split('\n')
      hopsTail = lines.pop() ?? ''
      hopsToFold.push(...lines)
    }
    const cap = readNew(files.pcapFile, pcapOffset)
    if (cap) {
      // tcpdump writes its file header the moment it starts, so these are the first bytes of the
      // session proper. Everything before was the wait at the admin prompt.
      if (pcapOffset === 0) startedAt = Date.now()
      pcapOffset = cap.next
      for (const record of feedPcap(reader, cap.data)) {
        const frame = decodeFrame(record, reader.format?.linkType ?? 0)
        if (frame) foldFrame(state, frame)
      }
      if (reader.error && !message) message = `Cannot read the capture: ${reader.error}.`
    }
    for (const line of hopsToFold.splice(0)) {
      if (foldHop(state, line)) {
        const heard = closeWindow(state)
        if (heard.length > 0) cb.onWindow(heard)
      }
    }
  }

  const status = (): MonitorStatus => ({
    running: !ended,
    device,
    monitorInterface: 'magicmon0',
    ...monitorCounts(state),
    pcapBytes: pcapOffset,
    dwellMs: DWELL_MS,
    pinnedChannel: pinned === undefined ? undefined : channelFromMhz(pinned)?.channel,
    elapsedSec: pcapOffset === 0 ? 0 : Math.round(((endedAt ?? Date.now()) - startedAt) / 1000),
    message
  })

  const timer = setInterval(() => {
    if (ended) return
    drain()
    cb.onTick()
  }, TICK_MS)

  function finish(outcome?: MonitorOutcome): void {
    if (ended) return
    ended = true
    endedAt = Date.now()
    clearInterval(timer)
    drain()
    const heard = closeWindow(state)
    if (heard.length > 0) cb.onWindow(heard)
    // The capture holds other people's frames; it goes the moment it has been read.
    if (!replay) removeAll([files.pcapFile])
    if (outcome) cb.onEnd(outcome)
  }

  if (!replay) {
    const spec: MonitorSpec = {
      device: support.device,
      support,
      freqs,
      dwellMs: DWELL_MS,
      maxSeconds: MONITOR_MAX_SECONDS,
      maxBytes: MONITOR_MAX_BYTES,
      ...files
    }
    const plan = p.buildMonitorPlan?.(spec)
    if (!plan) {
      scriptDone = true
      // After the caller has the run in hand, not before.
      queueMicrotask(() =>
        finish({ status: 'error', message: 'This computer cannot listen to the air.' })
      )
    } else {
      // Fire and forget: this returns when the session is over, and the prompt is inside it.
      runElevatedPlan(plan, (MONITOR_MAX_SECONDS + 30) * 1000 + SLACK_MS)
        .then((r) => {
          scriptDone = true
          const wasStopped = ended
          const log = lastLine(files.logFile)
          if (!wasStopped) {
            if (elevationRefused(r)) {
              finish({
                status: 'needs-privilege',
                message: 'Listening was cancelled — it needs admin rights.'
              })
            } else if (r.code === 0) {
              finish({
                status: 'ok',
                message: `Listening reached its limit (${MONITOR_MAX_SECONDS / 60} minutes or ${MONITOR_MAX_BYTES / 1024 / 1024} MB) and stopped.`
              })
            } else {
              finish({
                status: 'error',
                message: `Listening ended${log ? `: ${log}` : r.code === null ? ' without an exit code' : ` (exit ${r.code})`}. Wi-Fi was put back.`
              })
            }
          }
          removeAll(mine)
        })
        .catch((err) => {
          scriptDone = true
          finish({ status: 'error', message: `Could not start listening: ${String(err)}` })
          removeAll(mine)
        })
    }
  }

  // A replayed capture has no script to wait for.
  if (replay) scriptDone = true

  return {
    state,
    status,
    get scriptDone() {
      return scriptDone
    },
    pin(target) {
      if (ended || replay) return
      try {
        if (target === null) {
          pinned = undefined
          fs.rmSync(files.pinFile, { force: true })
          return
        }
        const width = target.widthMhz ?? 20
        const centre = target.centreMhz ?? target.freqMhz
        // A trailing newline: the script's `read` reports end-of-file, and fails, without one.
        fs.writeFileSync(files.pinFile, `${target.freqMhz} ${width} ${centre}\n`)
        pinned = target.freqMhz
      } catch {
        // The session carries on sweeping; the pin is a convenience.
      }
    },
    stop() {
      if (ended) return
      if (!replay) {
        try {
          fs.writeFileSync(files.stopFile, '')
        } catch {
          // The script's own time cap is the backstop.
        }
      }
      finish()
    }
  }
}
