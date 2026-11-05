import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runElevatedPlan } from '../src/main/privilege'
import { leftoverFiles, startMonitor } from '../src/main/capabilities/monitor/session'
import type { MonitorOutcome, MonitorRun } from '../src/main/capabilities/monitor/session'
import type { MonitorSpec, PlatformOps, WifiSighting } from '../src/main/platform'
import { scratchFile } from '../src/main/util/scratch'
import { AP_24_BUSY } from './fixtures/beacons'
import { beaconBody, mgmtFrame, pcapFile, radiotap } from './fixtures/frames'

// The elevated call is replaced by one the test resolves when it likes; everything else — the
// scratch directory, the files, the decoding — is real.
vi.mock('../src/main/privilege', async (original) => ({
  ...(await original<typeof import('../src/main/privilege')>()),
  runElevatedPlan: vi.fn()
}))

const AP = '74:ac:b9:00:00:01'
const SUPPORT = {
  device: 'wlan0',
  channels: [{ freqMhz: 2412, disabled: false }],
  networkManager: false
}

function beaconRecord(signal: number): { atMs: number; data: Buffer } {
  const mac = mgmtFrame({ subtype: 8, bssid: AP, body: beaconBody(AP_24_BUSY) })
  return { atMs: 1_700_000_000_000, data: Buffer.concat([radiotap({ freq: 2412, signal }), mac]) }
}

interface Rig {
  run: MonitorRun
  spec: MonitorSpec
  windows: WifiSighting[][]
  ends: MonitorOutcome[]
  ticks: () => number
  /** Settle the elevated call the way the script ending would. */
  exit: (code: number, stderr?: string) => Promise<void>
}

let leftovers: string[] = []

function start(): Rig {
  const specs: MonitorSpec[] = []
  const platform = {
    buildMonitorPlan: (spec: MonitorSpec) => {
      specs.push(spec)
      return { interpreter: 'sh' as const, script: 'true' }
    }
  } as unknown as PlatformOps
  let settle: (r: { code: number | null; stdout: string; stderr: string }) => void = () => {}
  vi.mocked(runElevatedPlan).mockReturnValue(
    new Promise((resolve) => {
      settle = resolve as typeof settle
    })
  )
  const windows: WifiSighting[][] = []
  const ends: MonitorOutcome[] = []
  let ticks = 0
  const run = startMonitor(platform, 'wlan0', SUPPORT, {
    onWindow: (w) => windows.push(w.sightings),
    onTick: () => ticks++,
    onEnd: (o) => ends.push(o)
  })
  const spec = specs[0]
  leftovers.push(spec.pcapFile, spec.hopsFile, spec.logFile, spec.stopFile, spec.pinFile)
  return {
    run,
    spec,
    windows,
    ends,
    ticks: () => ticks,
    exit: async (code, stderr = '') => {
      settle({ code, stdout: '', stderr })
      await vi.advanceTimersByTimeAsync(0)
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-05T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  for (const f of leftovers) rmSync(f, { force: true })
  leftovers = []
  delete process.env.MAGICETH_MONITOR_REPLAY
})

describe('startMonitor', () => {
  it('hands the script a plan for the channels the card offered, with files it can create', () => {
    const { run, spec } = start()
    expect(spec).toMatchObject({ device: 'wlan0', freqs: [2412], dwellMs: 400 })
    expect(spec.pcapFile).toMatch(/monitor-.*\.pcap$/)
    expect(dirname(spec.pcapFile)).toBe(dirname(scratchFile('x')))
    run.stop()
  })

  it('reads the capture and the journal as they grow, and reports a sweep when the next begins', async () => {
    const { run, spec, windows } = start()
    writeFileSync(spec.hopsFile, 'ok 1 2412\n')
    writeFileSync(spec.pcapFile, pcapFile([beaconRecord(-60), beaconRecord(-70)]))
    await vi.advanceTimersByTimeAsync(1000)
    expect(windows).toEqual([]) // the first sweep is still under way
    expect(run.status()).toMatchObject({ running: true, frames: 2, passes: 0 })

    appendFileSync(spec.hopsFile, 'ok 2 2412\n')
    await vi.advanceTimersByTimeAsync(1000)
    expect(windows).toHaveLength(1)
    expect(windows[0][0]).toMatchObject({ bssid: AP, ssid: 'tdc_nomap', rssi: -65, channel: 1 })
    expect(run.status()).toMatchObject({ passes: 1, channelsVisited: 1 })
    run.stop()
  })

  it('copes with the journal arriving in pieces that split a line', async () => {
    const { run, spec } = start()
    writeFileSync(spec.hopsFile, 'ok 1 24')
    await vi.advanceTimersByTimeAsync(1000)
    expect(run.status().channelsVisited).toBe(0)
    appendFileSync(spec.hopsFile, '12\n')
    await vi.advanceTimersByTimeAsync(1000)
    expect(run.status().channelsVisited).toBe(1)
    run.stop()
  })

  it('ticks once a second while running, and not after it is stopped', async () => {
    const { run, ticks } = start()
    await vi.advanceTimersByTimeAsync(3000)
    expect(ticks()).toBe(3)
    run.stop()
    await vi.advanceTimersByTimeAsync(3000)
    expect(ticks()).toBe(3)
  })

  it('stops by creating the stop file, deletes the capture at once and the rest when the script has gone', async () => {
    const { run, spec, exit, ends } = start()
    writeFileSync(spec.pcapFile, pcapFile([beaconRecord(-60)]))
    writeFileSync(spec.hopsFile, 'ok 1 2412\n')
    await vi.advanceTimersByTimeAsync(1000)

    run.stop()
    run.stop() // twice is fine
    expect(existsSync(spec.stopFile)).toBe(true)
    expect(existsSync(spec.pcapFile)).toBe(false)
    expect(existsSync(spec.hopsFile)).toBe(true) // the script is still putting things back
    expect(run.status().running).toBe(false)

    await exit(0)
    expect(existsSync(spec.hopsFile)).toBe(false)
    expect(existsSync(spec.stopFile)).toBe(false)
    expect(ends).toEqual([]) // a stop that was asked for is not an ending to report
  })

  it('says the script is not done until it has exited, which is after the Wi-Fi is back', async () => {
    const { run, exit } = start()
    expect(run.scriptDone).toBe(false)
    run.stop()
    expect(run.scriptDone).toBe(false) // stopped, but the script is still restoring
    await exit(0)
    expect(run.scriptDone).toBe(true)
  })

  it('stops counting elapsed time when it stops', async () => {
    const { run, spec } = start()
    writeFileSync(spec.pcapFile, pcapFile([beaconRecord(-60)]))
    await vi.advanceTimersByTimeAsync(5000)
    run.stop()
    const at = run.status().elapsedSec
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run.status().elapsedSec).toBe(at)
  })

  it('keeps the last partial sweep when it is stopped', async () => {
    const { run, spec, windows } = start()
    writeFileSync(spec.hopsFile, 'ok 1 2412\n')
    writeFileSync(spec.pcapFile, pcapFile([beaconRecord(-60)]))
    await vi.advanceTimersByTimeAsync(1000)
    expect(windows).toEqual([])
    run.stop()
    expect(windows).toHaveLength(1)
  })

  it.each([
    [126, '', /cancelled/, 'needs-privilege'],
    [1, 'RTNETLINK answers: Operation not supported\n', /Operation not supported/, 'error'],
    [0, '', /limit/, 'ok'],
    [2, '', /exit 2/, 'error'],
    [1, 'iw: command failed: Device or resource busy (-16)\n', /busy/, 'error']
  ] as const)(
    'reports a script that ends by itself with %i',
    async (code, log, message, status) => {
      const { spec, exit, ends } = start()
      if (log) writeFileSync(spec.logFile, log)
      await exit(code)
      expect(ends).toHaveLength(1)
      expect(ends[0].status).toBe(status)
      expect(ends[0].message).toMatch(message)
      expect(existsSync(spec.logFile)).toBe(false)
    }
  )

  it('pins a channel with its width, and lets go again', () => {
    const { run, spec } = start()
    run.pin({ freqMhz: 5180, widthMhz: 80, centreMhz: 5210 })
    expect(readFileSync(spec.pinFile, 'utf8')).toBe('5180 80 5210\n')
    expect(run.status().pinned).toEqual({ channel: 36, band: '5' })
    run.pin({ freqMhz: 2412 })
    expect(readFileSync(spec.pinFile, 'utf8')).toBe('2412 20 2412\n')
    run.pin(null)
    expect(existsSync(spec.pinFile)).toBe(false)
    expect(run.status().pinned).toBeUndefined()
    run.stop()
  })

  it('removes what a crashed session left behind before it starts, and leaves a live one alone', () => {
    // No process has a pid this high on Linux or macOS; the parent of this test is alive and not us.
    const crashed = scratchFile('monitor-999999999-1.pcap')
    const live = scratchFile(`monitor-${process.ppid}-1.pcap`)
    mkdirSync(dirname(crashed), { recursive: true })
    writeFileSync(crashed, 'other people frames')
    writeFileSync(live, 'another instance is still listening')
    leftovers.push(crashed, live)
    const { run } = start()
    expect(existsSync(crashed)).toBe(false)
    expect(existsSync(live)).toBe(true)
    run.stop()
  })

  it('says so when the platform has no way to listen', async () => {
    const ends: MonitorOutcome[] = []
    startMonitor({} as PlatformOps, 'wlan0', SUPPORT, {
      onWindow: () => {},
      onTick: () => {},
      onEnd: (o) => ends.push(o)
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(ends[0]).toMatchObject({ status: 'error' })
  })
})

describe('replay', () => {
  it('plays a capture back at its own pace instead of elevating, and leaves the file alone', async () => {
    const file = scratchFile('monitor-replay-test.pcap')
    leftovers.push(file)
    const records = [0, 500, 9000].map((ms) => ({
      ...beaconRecord(-60),
      atMs: 1_700_000_000_000 + ms
    }))
    writeFileSync(file, pcapFile(records))
    process.env.MAGICETH_MONITOR_REPLAY = file
    vi.mocked(runElevatedPlan).mockClear()

    const windows: WifiSighting[][] = []
    const ends: MonitorOutcome[] = []
    const run = startMonitor({} as PlatformOps, 'wlan0', SUPPORT, {
      onWindow: (w) => windows.push(w.sightings),
      onTick: () => {},
      onEnd: (o) => ends.push(o)
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(run.status().frames).toBe(2)
    await vi.advanceTimersByTimeAsync(9000)
    expect(run.status().frames).toBe(3)
    expect(windows.length).toBeGreaterThan(0)
    expect(ends[0].message).toMatch(/replayed capture/)
    expect(runElevatedPlan).not.toHaveBeenCalled()
    expect(existsSync(file)).toBe(true)
  })
})

describe('leftoverFiles', () => {
  it('names only the files of sessions whose app has gone', () => {
    const alive = (pid: number): boolean => pid === 4242
    const names = [
      'monitor-4242-1730800000000.pcap',
      'monitor-4242-1730800000000.stop',
      'monitor-17-1730800000000.pcap',
      'monitor-17-1730800000000.hops',
      'monitor-replay-test.pcap',
      'survey-17-1.pcap',
      'monitor-17'
    ]
    expect(leftoverFiles(names, alive)).toEqual([
      'monitor-17-1730800000000.pcap',
      'monitor-17-1730800000000.hops'
    ])
  })
})
