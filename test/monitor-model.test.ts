import { describe, expect, it } from 'vitest'
import { readBeacon } from '../src/main/capabilities/ie80211'
import { decodeFrame } from '../src/main/capabilities/monitor/dot11'
import {
  MAX_APS,
  apAir,
  channelAir,
  closeWindow,
  createMonitorState,
  foldFrame,
  foldHop,
  monitorCounts
} from '../src/main/capabilities/monitor/model'
import type { MonitorState } from '../src/main/capabilities/monitor/model'
import { createPcapReader, feedPcap } from '../src/main/capabilities/monitor/pcap'
import { FALLBACK_CHANNELS, planHops } from '../src/main/capabilities/monitor/plan'
import { AP_24_BUSY, AP_5G_4X4, AP_6E_2X2 } from './fixtures/beacons'
import {
  beaconBody,
  dataFrame,
  mgmtFrame,
  pcapFile,
  radiotap,
  type PcapRecordSpec
} from './fixtures/frames'

const A = '74:ac:b9:00:00:01' // 2.4 GHz, channel 1
const B = '1c:0b:8b:f0:2d:39' // 5 GHz, channel 48
const CLIENT = '3c:22:fb:12:34:56'

function rec(freq: number, signal: number, mac: Buffer): PcapRecordSpec {
  return { atMs: 0, data: Buffer.concat([radiotap({ flags: 0, freq, signal }), mac]) }
}
const beacon = (bssid: string, elements: string, freq: number, signal: number): PcapRecordSpec =>
  rec(freq, signal, mgmtFrame({ subtype: 8, bssid, body: beaconBody(elements) }))

/** Records through the same chain a live capture takes: pcap, decode, fold. */
function fold(records: PcapRecordSpec[], state = createMonitorState()): MonitorState {
  const reader = createPcapReader()
  for (const r of feedPcap(reader, pcapFile(records))) {
    const frame = decodeFrame(r, reader.format?.linkType ?? 127)
    if (frame) foldFrame(state, frame)
  }
  return state
}

describe('access points', () => {
  it('turns a sweep of beacons into the sightings a scan would give, on the AP own channel', () => {
    const state = fold([
      beacon(A, AP_24_BUSY, 2412, -70),
      beacon(A, AP_24_BUSY, 2412, -60),
      // Heard while the radio sat on 5240, though the AP says it is on 128: its own word wins.
      beacon(B, AP_5G_4X4, 5240, -80)
    ])
    const sightings = closeWindow(state)
    expect(sightings).toHaveLength(2)
    const a = sightings.find((s) => s.bssid === A)
    expect(a).toMatchObject({ ssid: 'tdc_nomap', rssi: -65, channel: 1, band: '2.4' })
    expect(a?.beacon).toEqual(readBeacon(AP_24_BUSY))
    expect(sightings.find((s) => s.bssid === B)).toMatchObject({ channel: 128, band: '5' })
    // The next sweep starts empty.
    expect(closeWindow(state)).toEqual([])
  })

  it('gives a sighting no signal when the capture had none, so it makes none', () => {
    const noSignal = mgmtFrame({ subtype: 8, bssid: A, body: beaconBody(AP_24_BUSY) })
    const state = createMonitorState()
    foldFrame(state, decodeFrame({ atMs: 0, origLen: noSignal.length, data: noSignal }, 105)!)
    expect(closeWindow(state)).toEqual([])
  })

  it('learns a hidden network name from a probe response and keeps it past a nameless beacon', () => {
    const hidden = '0000' + '030101'
    const named = '0004' + '68696464' + '030101' // "hidd"
    const state = fold([
      beacon(A, hidden, 2412, -60),
      rec(2412, -62, mgmtFrame({ subtype: 5, bssid: A, body: beaconBody(named) })),
      beacon(A, hidden, 2412, -61)
    ])
    expect(closeWindow(state)[0].ssid).toBe('hidd')
  })

  it('lets a probe response fill gaps in a beacon without overriding it', () => {
    const state = fold([
      beacon(A, '0003' + '616161' + '030101', 2412, -60),
      rec(2412, -60, mgmtFrame({ subtype: 5, bssid: A, body: beaconBody('0003' + '626262') }))
    ])
    expect(closeWindow(state)[0].ssid).toBe('aaa')
  })

  it('stops adding access points at the cap rather than growing without limit', () => {
    const state = createMonitorState()
    for (let i = 0; i < MAX_APS + 20; i++) {
      const bssid = `02:00:00:00:${(i >> 8).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}`
      fold([beacon(bssid, AP_24_BUSY, 2412, -70)], state)
    }
    expect(state.window.size).toBe(MAX_APS)
    expect(state.aps.size).toBe(MAX_APS)
  })
})

describe('air and association churn', () => {
  /** Two passes over three channels; 2.4 GHz is busy, 5240 is quiet, 5500 cannot be tuned. */
  function session(): MonitorState {
    const state = createMonitorState()
    for (const line of [
      'ok 1 2412',
      'ok 1 5240',
      'fail 1 5500',
      'ok 2 2412',
      'ok 2 5240',
      'fail 2 5500'
    ]) {
      foldHop(state, line)
    }
    const data = (retry: boolean) =>
      rec(2412, -50, dataFrame({ qos: true, toDs: true, retry, a1: A, a2: CLIENT, a3: A }))
    const deauth = rec(
      2412,
      -50,
      mgmtFrame({ subtype: 12, bssid: A, da: A, sa: CLIENT, body: Buffer.from([7, 0]) })
    )
    fold(
      [
        ...Array.from({ length: 14 }, () => data(false)),
        ...Array.from({ length: 4 }, () => data(true)),
        deauth,
        deauth,
        // The other AP sends one frame on the quiet channel.
        beacon(B, AP_6E_2X2, 5240, -75)
      ],
      state
    )
    return state
  }

  it('counts frames and retries per channel against the dwells spent there', () => {
    const air = channelAir(session())
    // 20 frames on 2412 (14 + 4 data + 2 deauth), 2 dwells of 400 ms: 20 / 0.8 s.
    expect(air.find((c) => c.channel === 1)).toEqual({
      channel: 1,
      band: '2.4',
      visited: 2,
      framesPerSec: 25,
      retryPct: 20
    })
  })

  it('reports a channel that was visited and silent differently from one that could not be tuned', () => {
    const air = channelAir(session())
    const quiet = air.find((c) => c.band === '5' && c.channel === 48)
    const failed = air.find((c) => c.band === '5' && c.channel === 100)
    // One beacon over two dwells on channel 48: quiet, but it was listened to.
    expect(quiet).toMatchObject({ visited: 2, framesPerSec: 1.3, retryPct: 0 })
    expect(failed).toMatchObject({ visited: 0, framesPerSec: 0 })
  })

  it('leaves out a channel that has frames but no journal line yet', () => {
    const state = fold([beacon(A, AP_24_BUSY, 2412, -60)])
    expect(channelAir(state)).toEqual([])
  })

  it('counts deauthentications and the frames that named each access point', () => {
    const air = apAir(session())
    expect(air.get(A)).toEqual({ deauths: 2, framesPerSec: 25, retryPct: 20 })
    expect(air.get(B)?.deauths).toBe(0)
  })

  it('has no rate for an access point on a channel the journal has not covered', () => {
    const state = fold([beacon(A, AP_24_BUSY, 2412, -60)])
    expect(apAir(state).get(A)?.framesPerSec).toBeUndefined()
  })

  it('keeps no address of any station in its state', () => {
    const state = session()
    // Maps do not serialise by default; spell them out so nothing hides behind that.
    const text = JSON.stringify(state, (_k, v) => (v instanceof Map ? [...v] : v))
    expect(text).not.toContain(CLIENT)
    expect(text).not.toContain('3c:22')
    expect(text).toContain(A)
  })
})

describe('the hop journal', () => {
  it('reports a new sweep only when the pass number rises', () => {
    const state = createMonitorState()
    expect(foldHop(state, 'ok 1 2412')).toBe(true) // the first sweep begins
    expect(foldHop(state, 'ok 1 2417')).toBe(false)
    expect(foldHop(state, 'fail 1 5500')).toBe(false)
    expect(foldHop(state, 'ok 2 2412')).toBe(true)
  })

  it('ignores a line that is not a journal line', () => {
    const state = createMonitorState()
    for (const line of ['', 'ok', 'ok 1', 'ok x 2412', 'bogus 1 2412', 'ok 1 2412 extra']) {
      expect(foldHop(state, line)).toBe(false)
    }
    expect(state.channels.size).toBe(0)
  })

  it('summarises the session for the status line', () => {
    const state = createMonitorState()
    for (const line of ['ok 1 2412', 'fail 1 5500', 'ok 2 2412', 'fail 2 5500', 'ok 3 2412']) {
      foldHop(state, line)
    }
    // Pass 3 is under way, so two sweeps are complete.
    expect(monitorCounts(state)).toMatchObject({ passes: 2, channelsVisited: 1, channelsFailed: 1 })
  })
})

describe('planHops', () => {
  it('visits each enabled channel once, lowest first', () => {
    expect(
      planHops([
        { freqMhz: 5180, disabled: false },
        { freqMhz: 2412, disabled: false },
        { freqMhz: 5200, disabled: true },
        { freqMhz: 2412, disabled: false }
      ])
    ).toEqual([2412, 5180])
  })

  it('has a fallback that every entry of is a real channel', () => {
    expect(planHops(FALLBACK_CHANNELS)).toHaveLength(FALLBACK_CHANNELS.length)
    expect(planHops(FALLBACK_CHANNELS)[0]).toBe(2412)
  })
})
