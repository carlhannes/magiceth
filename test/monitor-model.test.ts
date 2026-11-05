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
  listAfterSweep,
  monitorCounts
} from '../src/main/capabilities/monitor/model'
import type { MonitorState } from '../src/main/capabilities/monitor/model'
import { createPcapReader, feedPcap } from '../src/main/capabilities/monitor/pcap'
import { FALLBACK_CHANNELS, pinTarget, planHops } from '../src/main/capabilities/monitor/plan'
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
/** An RSN element: CCMP, PSK. */
const RSN = '30140100000fac040100000fac040100000fac020000'

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
    const { sightings } = closeWindow(state)
    expect(sightings).toHaveLength(2)
    const a = sightings.find((s) => s.bssid === A)
    expect(a).toMatchObject({ ssid: 'tdc_nomap', rssi: -65, channel: 1, band: '2.4' })
    expect(a?.beacon).toEqual(readBeacon(AP_24_BUSY))
    expect(sightings.find((s) => s.bssid === B)).toMatchObject({ channel: 128, band: '5' })
    // The next sweep starts empty.
    expect(closeWindow(state).sightings).toEqual([])
  })

  it('gives a sighting no signal when the capture had none, so it makes none', () => {
    const noSignal = mgmtFrame({ subtype: 8, bssid: A, body: beaconBody(AP_24_BUSY) })
    const state = createMonitorState()
    foldFrame(state, decodeFrame({ atMs: 0, origLen: noSignal.length, data: noSignal }, 105)!)
    expect(closeWindow(state).sightings).toEqual([])
  })

  it('learns a hidden network name from a probe response and keeps it past a nameless beacon', () => {
    const hidden = '0000' + '030101'
    const named = '0004' + '68696464' + '030101' // "hidd"
    const state = fold([
      beacon(A, hidden, 2412, -60),
      rec(2412, -62, mgmtFrame({ subtype: 5, bssid: A, body: beaconBody(named) })),
      beacon(A, hidden, 2412, -61)
    ])
    expect(closeWindow(state).sightings[0].ssid).toBe('hidd')
  })

  it('lets a probe response fill gaps in a beacon without overriding it', () => {
    const state = fold([
      beacon(A, '0003' + '616161' + '030101', 2412, -60),
      rec(2412, -60, mgmtFrame({ subtype: 5, bssid: A, body: beaconBody('0003' + '626262') }))
    ])
    expect(closeWindow(state).sightings[0].ssid).toBe('aaa')
  })

  it('names a hidden network from a probe response heard after its beacon', () => {
    // The usual order: the beacon, its SSID four NUL bytes, then the answer to someone's probe.
    const hidden = beaconBody('000400000000' + '030101' + RSN, { privacy: true })
    const named = beaconBody('0003666f6f' + '030101' + RSN, { privacy: true }) // "foo"
    const state = fold([
      rec(2412, -60, mgmtFrame({ subtype: 8, bssid: A, body: hidden })),
      rec(2412, -60, mgmtFrame({ subtype: 5, bssid: A, body: named }))
    ])
    const [sighting] = closeWindow(state).sightings
    expect(sighting.ssid).toBe('foo')
    expect(sighting.beacon.security).toBe('WPA2-Personal')
  })

  it('keeps the vendors a probe response named when a beacon names none', () => {
    const wps = 'dd050050f20410' // Microsoft OUI, WPS
    const state = fold([
      rec(
        2412,
        -60,
        mgmtFrame({ subtype: 5, bssid: A, body: beaconBody('0003616161' + '030101' + wps) })
      ),
      beacon(A, '0003616161' + '030101', 2412, -60)
    ])
    expect(closeWindow(state).sightings[0].beacon.vendorOuis).toEqual(['0050f2'])
  })

  it('takes the signal from the access point own channel, not the copies leaking next to it', () => {
    const own = '0003616161' + '030106' // channel 6
    const state = fold([
      beacon(A, own, 2437, -50),
      beacon(A, own, 2427, -72), // heard from channel 4
      beacon(A, own, 2447, -74) // and from 8
    ])
    expect(closeWindow(state).sightings[0].rssi).toBe(-50)
    // Heard only from a neighbour, the neighbour's reading is all there is.
    const leakedOnly = fold([beacon(A, own, 2427, -72), beacon(A, own, 2447, -74)])
    expect(closeWindow(leakedOnly).sightings[0].rssi).toBe(-73)
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

describe('beacons the capture cut short', () => {
  /** AP_5G_4X4 as a frame, and the same frame with its last 166 bytes cut — where its EHT elements are. */
  function cutFrames(): { full: PcapRecordSpec; cut: PcapRecordSpec } {
    const mac = (subtype: number): Buffer =>
      mgmtFrame({ subtype, bssid: B, body: beaconBody(AP_5G_4X4, { privacy: true }) })
    const full = {
      atMs: 0,
      data: Buffer.concat([radiotap({ flags: 0, freq: 5640, signal: -60 }), mac(5)])
    }
    const whole = Buffer.concat([radiotap({ flags: 0, freq: 5640, signal: -60 }), mac(8)])
    const cut = { atMs: 0, data: whole.subarray(0, whole.length - 166), origLen: whole.length }
    return { full, cut }
  }

  it('lets a complete frame outrank a cut one, whichever came first', () => {
    const { full, cut } = cutFrames()
    // The precondition: the cut beacon alone reads a generation lower.
    expect(closeWindow(fold([cut])).sightings[0].beacon.phy).toBe('802.11ax')
    for (const order of [
      [full, cut],
      [cut, full]
    ]) {
      const facts = closeWindow(fold(order)).sightings[0].beacon
      expect(facts.phy).toBe('802.11be')
      expect(facts.vendorOuis).toEqual(readBeacon(AP_5G_4X4).vendorOuis)
    }
  })

  it('never calls a cut beacon WEP: its RSN element may be what was cut', () => {
    const mac = mgmtFrame({
      subtype: 8,
      bssid: A,
      body: beaconBody('0003616161' + '030101' + RSN, { privacy: true })
    })
    const whole = Buffer.concat([radiotap({ flags: 0, freq: 2412, signal: -60 }), mac])
    const cut = whole.subarray(0, whole.length - 20)
    const frame = decodeFrame({ atMs: 0, data: cut, origLen: whole.length }, 127)
    expect(frame?.body).toMatchObject({ kind: 'beacon', truncated: true })
    expect(frame?.body.kind === 'beacon' && frame.body.facts.security).toBeUndefined()
    // Complete, the same bit with no RSN element is WEP.
    const wep = mgmtFrame({
      subtype: 8,
      bssid: A,
      body: beaconBody('0003616161', { privacy: true })
    })
    const whole2 = Buffer.concat([radiotap({ flags: 0, freq: 2412, signal: -60 }), wep])
    const frame2 = decodeFrame({ atMs: 0, data: whole2, origLen: whole2.length }, 127)
    expect(frame2?.body.kind === 'beacon' && frame2.body.facts.security).toBe('WEP')
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
        // Its beacon names channel 1, which is what lets its frames be counted.
        beacon(A, AP_24_BUSY, 2412, -50),
        ...Array.from({ length: 13 }, () => data(false)),
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
    // 20 frames on 2412 (a beacon, 13 + 4 data, 2 deauths), 2 dwells of 400 ms: 20 / 0.8 s.
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

  it('counts an access point only on its own channel, though it is heard on the ones next to it', () => {
    const state = createMonitorState()
    for (const f of [2412, 2417, 2422]) foldHop(state, `ok 1 ${f}`)
    // Four beacons a dwell (one per 100 ms), heard on channel 1 and leaking onto 2 and 3.
    fold(
      [2412, 2417, 2422].flatMap((f) =>
        Array.from({ length: 4 }, () => beacon(A, AP_24_BUSY, f, -50))
      ),
      state
    )
    expect(apAir(state).get(A)?.framesPerSec).toBe(10)
    // The channels themselves did hear all of it: that is what the receiver had to contend with.
    expect(channelAir(state).map((c) => c.framesPerSec)).toEqual([10, 10, 10])
  })

  it('counts nothing for an access point until a beacon has said where it lives', () => {
    const state = createMonitorState()
    foldHop(state, 'ok 1 2412')
    const data = rec(2412, -50, dataFrame({ toDs: true, a1: A, a2: CLIENT, a3: A }))
    fold([data, data], state)
    expect(apAir(state).get(A)?.framesPerSec).toBeUndefined()
    fold([beacon(A, AP_24_BUSY, 2412, -50), data], state)
    // The beacon and the data frame after it: two frames in one 400 ms dwell.
    expect(apAir(state).get(A)?.framesPerSec).toBe(5)
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
  it('closes a sweep only when the pass number rises', () => {
    const state = createMonitorState()
    expect(foldHop(state, 'ok 1 2412')).toBeUndefined() // the first sweep begins; nothing to close
    expect(foldHop(state, 'ok 1 2417')).toBeUndefined()
    expect(foldHop(state, 'fail 1 5500')).toBeUndefined()
    expect(foldHop(state, 'ok 2 2412')).toEqual({ sightings: [], held: false })
  })

  it('calls a sweep held when it sat on one channel, from the journal alone', () => {
    const state = createMonitorState()
    for (const line of ['ok 1 2412', 'ok 1 2437']) foldHop(state, line)
    expect(foldHop(state, 'ok 2 5180')?.held).toBe(false) // closes the full sweep
    for (let i = 0; i < 4; i++) foldHop(state, 'ok 2 5180')
    // The pin may be gone by now; the sweep it shaped is still the one that closes.
    expect(foldHop(state, 'ok 3 2412')?.held).toBe(true)
    // A plan of one channel visits it once a sweep, which is not a hold.
    const one = createMonitorState()
    foldHop(one, 'ok 1 2412')
    expect(foldHop(one, 'ok 2 2412')?.held).toBe(false)
  })

  it('ignores a line that is not a journal line', () => {
    const state = createMonitorState()
    for (const line of ['', 'ok', 'ok 1', 'ok x 2412', 'bogus 1 2412', 'ok 1 2412 extra']) {
      expect(foldHop(state, line)).toBeUndefined()
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

describe('pinTarget', () => {
  it.each([
    // channel, band, width → freq, width, centre
    [36, '5', 80, 5180, 80, 5210], // 36–48 centred on 42
    [48, '5', 80, 5240, 80, 5210],
    [40, '5', 40, 5200, 40, 5190], // 36+40
    [44, '5', 40, 5220, 40, 5230], // 44+48
    [128, '5', 160, 5640, 160, 5570], // 100–128 centred on 114
    [100, '5', 160, 5500, 160, 5570],
    [149, '5', 80, 5745, 80, 5775], // 149–161 centred on 155
    [157, '5', 80, 5785, 80, 5775],
    [52, '5', 80, 5260, 80, 5290], // 52–64 centred on 58
    [36, '5', 20, 5180, 20, 5180],
    [36, '5', undefined, 5180, 20, 5180],
    [6, '2.4', 40, 2437, 20, 2437],
    [14, '2.4', 20, 2484, 20, 2484]
  ] as const)('holds channel %i (%s, %s MHz)', (channel, band, width, freq, w, centre) => {
    expect(pinTarget(channel, band, width)).toEqual({
      freqMhz: freq,
      widthMhz: w,
      centreMhz: centre
    })
  })

  it('has nothing for a band or channel it cannot tune to', () => {
    expect(pinTarget(1, '6', 80)).toBeUndefined()
    expect(pinTarget(0, '2.4', 20)).toBeUndefined()
    expect(pinTarget(20, '5', 20)).toBeUndefined()
  })
})

describe('listAfterSweep', () => {
  const ap = (bssid: string, rssi = -60) => ({ bssid, rssi })

  it('shows this sweep and what the last one heard that this one missed, newest values first', () => {
    const shown = listAfterSweep(
      [ap('a'), ap('b'), ap('c')],
      [ap('a', -70), ap('b')],
      [ap('a', -50)],
      false
    )
    expect(shown).toEqual([ap('a', -50), ap('b')])
  })

  it('keeps the whole list while the radio is held on one channel', () => {
    const shown = listAfterSweep([ap('a'), ap('b'), ap('c')], [ap('a')], [ap('a', -40)], true)
    expect(shown).toEqual([ap('a', -40), ap('b'), ap('c')])
  })
})
