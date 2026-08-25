import { spawn } from 'node:child_process'
import { run } from '../util/run-command'
import { getPlatform } from '../platform'
import type { SpeedPhase, SpeedTestResult } from '../../shared/types'

// How much the uplink behind the port actually delivers, which is a different question from the
// link speed the NIC negotiated. Runs only when asked (T), never automatically — it moves real
// traffic on someone else's network.
//
// curl does the transfer and Node counts the bytes: the body streams through the child's stdout
// (download) or stdin (upload), so there is no output format to parse and the count is exact.
// curl is also what makes the test measure *this* port — --interface binds the socket, which was
// verified by binding to lo0 and watching the connection fail.
//
// Two honesty notes about the figures:
//   * These are application-layer bytes, so TCP/IP/TLS framing is not counted and the result
//     understates line rate by a couple of percent. Understating is the safe direction.
//   * The upload counts bytes handed to curl, not bytes acknowledged on the wire; the pipe and
//     curl's own buffer hold a constant amount back. That offset cancels out of a trailing-window
//     rate, which is why the headline is a windowed peak and never total ÷ elapsed.

const ENDPOINT = 'https://speed.cloudflare.com'
/**
 * Per request. Measured against the live endpoint, 80 MB is served and 100 MB is refused; 50 MB
 * keeps headroom in case that limit ever tightens. The cost of a smaller chunk is a brief gap at
 * each request boundary — one was measured depressing a quarter-second window to 134 Mbit/s on a
 * link doing 550 — so the reported figure errs low, which is the safe direction for this tool.
 */
const CHUNK_BYTES = 50_000_000
/** Per direction, so a test costs at most this much of the network it is run on, twice. */
const PHASE_BYTES = 200_000_000
/** Per direction. Whichever cap is reached first ends the phase. */
const PHASE_SECONDS = 10

const SAMPLE_MS = 250
/** Throughput is always measured over a trailing second, never over the whole phase. */
const WINDOW_MS = 1000
/**
 * The first second of a phase is thrown away. Downloads spend it in TCP slow start and uploads
 * spend it filling the pipe, and neither of those is the speed of the link.
 */
const SKIP_MS = 1000

/** One reused buffer for the upload body. 'a' so no newline translation can alter the byte count. */
const UPLOAD_BUFFER = Buffer.alloc(256 * 1024, 0x61)

// --- The arithmetic (pure, unit-tested) ------------------------------------------------------

export interface Sample {
  at: number
  /** Cumulative bytes moved by this phase at that moment. */
  bytes: number
}

/**
 * Throughput over the trailing `windowMs`, in Mbit/s. A phase younger than the window is measured
 * over all of itself, so a figure exists from the first tick rather than only after a full second.
 */
export function rateMbps(samples: Sample[], windowMs = WINDOW_MS): number | undefined {
  if (samples.length < 2) return undefined
  const last = samples[samples.length - 1]
  // The last sample at or before the window opens — going back further than the window is fine,
  // going back less than it is not, so the rate is never computed over a sliver of time.
  let start = samples[0]
  for (const s of samples) {
    if (s.at <= last.at - windowMs) start = s
  }
  const ms = last.at - start.at
  if (ms <= 0) return undefined
  return ((last.bytes - start.bytes) * 8) / ms / 1000
}

/** Best trailing window of the phase, ignoring its first `skipMs`. Undefined until one exists. */
export function peakMbps(
  samples: Sample[],
  windowMs = WINDOW_MS,
  skipMs = SKIP_MS
): number | undefined {
  if (samples.length < 2) return undefined
  const from = samples[0].at + skipMs
  const usable = samples.filter((s) => s.at >= from)
  let best: number | undefined
  for (let i = 1; i < usable.length; i++) {
    const rate = rateMbps(usable.slice(0, i + 1), windowMs)
    if (rate != null && (best == null || rate > best)) best = rate
  }
  return best
}

// --- The commands (pure, unit-tested) --------------------------------------------------------

/** Flags shared by both directions. `%{stderr}` keeps curl's own report off the body stream. */
function commonArgs(bind: string): string[] {
  return [
    '-sS',
    '-f',
    '--interface',
    bind,
    '--connect-timeout',
    '5',
    // Backstop only — the sampler enforces the real cap. Mirrors the survey's hard cap.
    '--max-time',
    String(PHASE_SECONDS + 5),
    '-w',
    '%{stderr}%{http_code}\\n'
  ]
}

/**
 * The download: one curl with the URL repeated. curl reuses a single connection across them, so
 * the phase pays for TCP slow start exactly once — measured here, a fresh connection per chunk
 * reported 423 Mbit/s on a link that sustains 685. Bodies go to stdout, which is where the bytes
 * are counted, so no -o is wanted.
 */
export function downloadArgs(bind: string): string[] {
  const url = `${ENDPOINT}/__down?bytes=${CHUNK_BYTES}`
  const count = Math.ceil(PHASE_BYTES / CHUNK_BYTES) + 1
  return [...commonArgs(bind), ...new Array<string>(count).fill(url)]
}

/**
 * The upload: a chunked POST fed from stdin, so it streams for as long as we keep writing instead
 * of needing a body of known size up front. No --compressed and no Content-Encoding in either
 * direction — a compressed transfer would measure the compressor rather than the link.
 */
export function uploadArgs(bind: string): string[] {
  return [
    ...commonArgs(bind),
    '-X',
    'POST',
    '-H',
    'Content-Type: application/octet-stream',
    '-T',
    '-',
    `${ENDPOINT}/__up`
  ]
}

/**
 * The HTTP status of curl's last transfer. The download puts several URLs on one command line and
 * so prints one line per transfer; the last is the one that ended the phase.
 */
export function lastHttpCode(stderr: string): number | undefined {
  const codes = stderr.match(/^\s*(\d{3})\s*$/gm)
  if (!codes) return undefined
  return Number(codes[codes.length - 1].trim())
}

/** Say why a direction moved nothing, preferring the most specific explanation available. */
export function failureText(code: number | null, stderr: string): string {
  const http = lastHttpCode(stderr)
  if (http != null && http >= 400) {
    return `The server answered HTTP ${http} — a captive portal or proxy may be in the way.`
  }
  const curlMsg = stderr.match(/curl: \(\d+\)\s*(.+)/)
  if (curlMsg) return curlMsg[1].trim()
  return `No data moved (curl exited ${code ?? 'without a code'}).`
}

// --- The test --------------------------------------------------------------------------------

interface PhaseRun {
  phase: SpeedPhase
  samples: Sample[]
  startedAt: number
  /** Live counter, folded into `phase` on each sample. */
  bytes: number
}

interface ActiveTest {
  device: string
  startedAt: number
  phases: SpeedPhase[]
  current?: PhaseRun
  child?: ReturnType<typeof spawn>
  timer: NodeJS.Timeout
  onUpdate: (result: SpeedTestResult) => void
}

let active: ActiveTest | null = null

/** Fold the live byte counter into the phase the renderer sees. */
function sample(s: ActiveTest): void {
  const run = s.current
  if (!run) return
  const now = Date.now()
  run.samples.push({ at: now, bytes: run.bytes })
  run.phase.bytes = run.bytes
  run.phase.seconds = Math.round((now - run.startedAt) / 100) / 10
  run.phase.nowMbps = rateMbps(run.samples)
  // Left undefined until a window past the ramp exists; the UI falls back to the live figure.
  run.phase.peakMbps = peakMbps(run.samples)
}

function snapshot(s: ActiveTest, running: boolean): SpeedTestResult {
  const phases = s.phases.map((p) => ({ ...p }))
  const movedNothing = phases.length > 0 && phases.every((p) => p.bytes === 0)
  // A failure has to come with an explanation. Stopping a test in its first moments also leaves
  // every phase at zero bytes, and calling that "the speed test failed" would be a lie about
  // something the user did on purpose — it reports "nothing moved" per direction instead.
  const message = phases.find((p) => p.message)?.message
  const failed = !running && movedNothing && message != null
  return {
    status: failed ? 'error' : 'ok',
    running,
    device: s.device,
    phases,
    elapsedSec: Math.round((Date.now() - s.startedAt) / 1000),
    message: failed ? message : undefined
  }
}

/** Feed the upload body, respecting backpressure and stopping at the byte cap. */
function pump(child: ReturnType<typeof spawn>, run: PhaseRun): void {
  const stdin = child.stdin
  if (!stdin) return
  let writable = true
  // EPIPE once the child is killed; nothing to do but stop feeding it.
  stdin.on('error', () => {
    writable = false
  })
  const write = (): void => {
    // A write to a pipe whose child has just been killed normally emits 'error' rather than
    // throwing — but this also runs from a 'drain' listener, where a throw would reach nobody and
    // take the main process with it. Cheap insurance for a stream we are deliberately racing.
    try {
      while (writable && stdin.writable && run.bytes < PHASE_BYTES) {
        run.bytes += UPLOAD_BUFFER.length
        if (!stdin.write(UPLOAD_BUFFER)) {
          stdin.once('drain', write)
          return
        }
      }
      // Cap reached: end the body so curl completes the request instead of dying mid-upload.
      if (writable && stdin.writable) stdin.end()
    } catch {
      writable = false
    }
  }
  write()
}

/** Run one direction to completion. Resolves when curl exits, however it exits. */
function runPhase(s: ActiveTest, kind: SpeedPhase['kind'], bind: string): Promise<void> {
  return new Promise((resolve) => {
    const run: PhaseRun = {
      phase: { kind, bytes: 0, seconds: 0, done: false },
      samples: [{ at: Date.now(), bytes: 0 }],
      startedAt: Date.now(),
      bytes: 0
    }
    s.phases.push(run.phase)
    s.current = run

    const download = kind === 'download'
    const child = spawn('curl', download ? downloadArgs(bind) : uploadArgs(bind), {
      // The download's bytes arrive on stdout; the upload's response body is of no interest.
      stdio: download ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'],
      windowsHide: true
    })
    s.child = child

    let stderr = ''
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString()
    })
    if (download) {
      child.stdout?.on('data', (c: Buffer) => {
        run.bytes += c.length
        // Cap the volume where the bytes are counted, not on the next tick: at 570 Mbit/s a
        // 250 ms sampling gap was measured to be another 9.5 MB of someone else's bandwidth.
        // The upload's pump stops itself at the same cap, so both directions bound it the same way.
        if (run.bytes >= PHASE_BYTES) child.kill('SIGKILL')
      })
    } else {
      pump(child, run)
    }

    child.on('error', (err) => {
      run.phase.message = `curl could not be started: ${err.message}`
    })
    child.on('close', (code) => {
      sample(s)
      run.phase.done = true
      if (run.bytes === 0 && !run.phase.message) run.phase.message = failureText(code, stderr)
      s.current = undefined
      s.child = undefined
      resolve()
    })
  })
}

async function runPhases(s: ActiveTest, bind: string): Promise<void> {
  await runPhase(s, 'download', bind)
  if (active === s) await runPhase(s, 'upload', bind)
  if (active !== s) return
  active = null
  clearInterval(s.timer)
  s.onUpdate(snapshot(s, false))
}

async function toolAvailable(): Promise<boolean> {
  const r = await run('curl', ['--version'], { timeoutMs: 3000 })
  return /curl\s+\d/i.test(`${r.stdout}${r.stderr}`)
}

function fail(device: string, status: SpeedTestResult['status'], message: string): SpeedTestResult {
  return { status, running: false, device, phases: [], elapsedSec: 0, message }
}

/**
 * Start a speed test on a device. Resolves as soon as the first transfer is launched; results
 * arrive through onUpdate until both directions finish or stopSpeedTest() is called. Only one
 * test runs at a time.
 */
export async function startSpeedTest(
  device: string,
  onUpdate: (result: SpeedTestResult) => void
): Promise<SpeedTestResult> {
  stopSpeedTest()

  if (!(await toolAvailable())) {
    return fail(device, 'no-tool', 'curl is missing — install it to run a speed test.')
  }
  // Read the address here rather than trusting the caller for it: on Windows it is the only thing
  // curl can bind to, and testing the wrong interface would be worse than not testing at all.
  const net = await getPlatform().readNetInfo(device)
  const bind = getPlatform().speedTestBind(device, net.ipv4)
  if (!bind) {
    return fail(device, 'no-address', 'The port has no IPv4 address to send from.')
  }

  // Everything from here to the launch stays synchronous. An await in between lets a second start
  // take over `active`, and this call would then leave a curl that nothing tracks and nothing
  // stops — the same race that was found in startSurvey during review.
  const s: ActiveTest = {
    device,
    startedAt: Date.now(),
    phases: [],
    timer: setInterval(() => {
      if (active !== s) return
      sample(s)
      const run = s.current
      // The time cap lives here; the byte cap is enforced by whichever side counts the bytes.
      // Killing the child is all it does — `close` finishes the phase up.
      if (run && Date.now() - run.startedAt >= PHASE_SECONDS * 1000) s.child?.kill('SIGKILL')
      onUpdate(snapshot(s, true))
    }, SAMPLE_MS),
    onUpdate
  }
  active = s
  void runPhases(s, bind)

  return snapshot(s, true)
}

/** Stop the running test and return what it measured. Safe to call when none is running. */
export function stopSpeedTest(): SpeedTestResult | null {
  const s = active
  if (!s) return null
  active = null
  clearInterval(s.timer)
  sample(s)
  if (s.current) s.current.phase.done = true
  s.child?.kill('SIGKILL')
  return snapshot(s, false)
}
