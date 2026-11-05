import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MonitorCallbacks } from '../src/main/capabilities/monitor/session'
import type { WifiSighting } from '../src/main/platform'

// wifiscan.ts is the state machine between scanning, recording and listening. Its own imports
// stop it being loaded in a test — recordings.ts needs Electron — so the three neighbours it talks
// to are replaced: the recording files, the platform, and the listening session, which the test
// drives by hand. Everything in wifiscan.ts itself is the real code.

const ctl = vi.hoisted(() => ({
  runs: [] as {
    cb: MonitorCallbacks
    running: boolean
    scriptDone: boolean
    pinned?: number
    stops: number
  }[],
  throwNext: false,
  scans: 0
}))

// Fails the suite if anything still reaches Electron, which CI does not have.
vi.mock('electron', () => {
  throw new Error('electron was imported — replace the module that imports it')
})

vi.mock('../src/main/capabilities/recordings', () => ({
  appendSnapshot: vi.fn(),
  beginRecording: vi.fn(() => ({ aggregate: '/tmp/r.agg.csv', log: '/tmp/r.csv' })),
  finishRecording: vi.fn(() => true)
}))

vi.mock('../src/main/platform', () => ({
  getPlatform: () => ({
    scanWifi: async () => {
      ctl.scans++
      return { status: 'ok', sightings: [] }
    },
    requestWifiAccess: () => {},
    endWifiSession: () => {},
    monitorSupport: async (device: string) => ({ device, channels: [], networkManager: false })
  })
}))

vi.mock('../src/main/capabilities/monitor/session', async () => {
  const { createMonitorState } = await import('../src/main/capabilities/monitor/model')
  return {
    replayFile: () => undefined,
    startMonitor: (_p: unknown, device: string, _s: unknown, cb: MonitorCallbacks) => {
      if (ctl.throwNext) {
        ctl.throwNext = false
        throw new Error('Scratch directory /tmp/magiceth-1000 is writable by others')
      }
      const run = {
        cb,
        running: true,
        scriptDone: false,
        pinned: undefined as number | undefined,
        stops: 0
      }
      ctl.runs.push(run)
      return {
        state: createMonitorState(),
        status: () => ({
          running: run.running,
          frames: 0,
          pcapBytes: 0,
          channelsVisited: 0,
          channelsFailed: 0,
          pinnedChannel: run.pinned,
          device
        }),
        pin: () => {},
        stop: () => {
          run.stops++
          run.running = false
        },
        get scriptDone() {
          return run.scriptDone
        }
      }
    }
  }
})

type Wifiscan = typeof import('../src/main/capabilities/wifiscan')
let w: Wifiscan
const updates: unknown[] = []
const onUpdate = (r: unknown): void => {
  updates.push(r)
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  ctl.runs = []
  ctl.throwNext = false
  ctl.scans = 0
  updates.length = 0
  w = await import('../src/main/capabilities/wifiscan')
})

afterEach(() => {
  w.stopMonitor()
  w.stopWifiScan()
  vi.useRealTimers()
})

const sighting = (bssid: string, ssid: string): WifiSighting => ({
  bssid,
  ssid,
  rssi: -60,
  channel: 1,
  band: '2.4',
  beacon: { vendorOuis: [] }
})

describe('wifiscan while listening', () => {
  it('leaves a running recording scanning when the session cannot even start', async () => {
    await w.startWifiScan('wlan0', 'record', onUpdate)
    ctl.throwNext = true
    const r = await w.startMonitor('wlan0', onUpdate)
    expect(r.status).toBe('error')
    expect(r.message).toMatch(/writable by others/)
    const before = ctl.scans
    await vi.advanceTimersByTimeAsync(3000)
    expect(ctl.scans).toBeGreaterThan(before)
  })

  it('refuses a new session while the last one is still putting the Wi-Fi back, even after a scan', async () => {
    expect((await w.startMonitor('wlan0', onUpdate)).status).toBe('ok')
    w.stopMonitor()
    // A scan in between replaces the run the session belonged to.
    expect((await w.startWifiScan('wlan0', 'once', onUpdate)).status).toBe('ok')
    const refused = await w.startMonitor('wlan0', onUpdate)
    expect(refused.status).toBe('error')
    expect(refused.message).toMatch(/still being put back/)
    ctl.runs[0].scriptDone = true
    expect((await w.startMonitor('wlan0', onUpdate)).status).toBe('ok')
    expect(ctl.runs).toHaveLength(2)
  })

  it('does not start a second scan loop when stopped after the session ended by itself', async () => {
    await w.startWifiScan('wlan0', 'record', onUpdate)
    await w.startMonitor('wlan0', onUpdate)
    const run = ctl.runs[0]
    // The session ends on its own (a cap, say): scanning takes over for the recording.
    run.running = false
    run.cb.onEnd({ status: 'ok', message: 'Listening reached its limit.' })
    await vi.advanceTimersByTimeAsync(7500)
    const oneLoop = ctl.scans
    w.stopMonitor() // a stop that crossed the ending, or before-quit
    expect(run.stops).toBe(0)
    const from = ctl.scans
    await vi.advanceTimersByTimeAsync(7500)
    // The same pace as before the stop, not twice it.
    expect(ctl.scans - from).toBeLessThanOrEqual(oneLoop + 1)
  })

  it('keeps the whole list while the radio is held, and lets it shrink again once it is not', async () => {
    await w.startMonitor('wlan0', onUpdate)
    const run = ctl.runs[0]
    const names = (): string[] =>
      ((updates.at(-1) as { networks: { ssid: string }[] }).networks ?? [])
        .map((n) => n.ssid)
        .sort()
    run.cb.onWindow([sighting('02:00:00:00:00:01', 'a'), sighting('02:00:00:00:00:02', 'b')])
    run.pinned = 1
    run.cb.onWindow([sighting('02:00:00:00:00:01', 'a')])
    run.cb.onWindow([sighting('02:00:00:00:00:01', 'a')])
    expect(names()).toEqual(['a', 'b'])
    run.pinned = undefined
    run.cb.onWindow([sighting('02:00:00:00:00:01', 'a')])
    run.cb.onWindow([sighting('02:00:00:00:00:01', 'a')])
    expect(names()).toEqual(['a'])
  })
})
