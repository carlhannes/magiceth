import { describe, expect, it } from 'vitest'
import { MAX_TRACKS, accumulate, groupBySsid } from '../src/main/capabilities/wifi-model'
import type { WifiBss } from '../src/shared/types'

function bss(over: Partial<WifiBss> & Pick<WifiBss, 'bssid'>): WifiBss {
  return {
    ssid: 'net',
    rssi: -60,
    channel: 6,
    band: '2.4',
    security: 'WPA2-Personal',
    locallyAdministered: false,
    ...over
  }
}

describe('groupBySsid', () => {
  it('gathers every access point under one network, strongest first', () => {
    const grouped = groupBySsid([
      bss({ bssid: 'a', ssid: 'office', rssi: -70, band: '2.4' }),
      bss({ bssid: 'b', ssid: 'office', rssi: -45, band: '5' }),
      bss({ bssid: 'c', ssid: 'guest', rssi: -55 })
    ])
    expect(grouped.map((n) => [n.ssid, n.bestRssi, n.bssids.length])).toEqual([
      ['office', -45, 2],
      ['guest', -55, 1]
    ])
    // The strongest access point leads its own network too.
    expect(grouped[0].bssids[0].bssid).toBe('b')
    expect(grouped[0].bands).toEqual(['2.4', '5'])
  })

  it('keeps hidden networks apart instead of merging them into one nameless blob', () => {
    const grouped = groupBySsid([bss({ bssid: 'a', ssid: '' }), bss({ bssid: 'b', ssid: '' })])
    expect(grouped).toHaveLength(2)
  })
})

describe('accumulate', () => {
  it('folds repeated sightings into min/max/avg while keeping the latest value', () => {
    const tracks = accumulate([
      { atSec: 0, bssids: [bss({ bssid: 'aa', rssi: -50, clients: 2, utilizationPct: 10 })] },
      { atSec: 5, bssids: [bss({ bssid: 'aa', rssi: -80, clients: 6, utilizationPct: 30 })] },
      { atSec: 9, bssids: [bss({ bssid: 'aa', rssi: -62, clients: 4, utilizationPct: 20 })] }
    ])
    expect(tracks).toHaveLength(1)
    expect(tracks[0].sightings).toBe(3)
    expect(tracks[0].firstSeenSec).toBe(0)
    expect(tracks[0].lastSeenSec).toBe(9)
    expect(tracks[0].rssi).toEqual({ min: -80, max: -50, avg: -64, last: -62 })
    expect(tracks[0].clients).toEqual({ min: 2, max: 6, avg: 4, last: 4 })
    expect(tracks[0].utilizationPct).toEqual({ min: 10, max: 30, avg: 20, last: 20 })
  })

  it('keeps an access point that stopped being heard — walking out of range is the finding', () => {
    const tracks = accumulate([
      { atSec: 0, bssids: [bss({ bssid: 'aa' }), bss({ bssid: 'bb' })] },
      { atSec: 30, bssids: [bss({ bssid: 'aa' })] }
    ])
    expect(tracks.map((t) => t.bssid).sort()).toEqual(['aa', 'bb'])
    expect(tracks.find((t) => t.bssid === 'bb')?.lastSeenSec).toBe(0)
  })

  it('starts an accumulator only when the value is actually advertised', () => {
    // The first scan carries no BSS Load; the second does. Client stats must describe the
    // readings that existed, not treat a missing element as a zero.
    const tracks = accumulate([
      { atSec: 0, bssids: [bss({ bssid: 'aa' })] },
      { atSec: 4, bssids: [bss({ bssid: 'aa', clients: 8 })] }
    ])
    expect(tracks[0].clients).toEqual({ min: 8, max: 8, avg: 8, last: 8 })
  })

  it('takes the newest channel and band, because an access point can move', () => {
    const tracks = accumulate([
      { atSec: 0, bssids: [bss({ bssid: 'aa', channel: 1, band: '2.4' })] },
      { atSec: 4, bssids: [bss({ bssid: 'aa', channel: 44, band: '5' })] }
    ])
    expect([tracks[0].channel, tracks[0].band]).toEqual([44, '5'])
  })

  it('sorts by the signal last heard, so the nearest access point is on top', () => {
    const tracks = accumulate([
      {
        atSec: 0,
        bssids: [bss({ bssid: 'far', rssi: -85 }), bss({ bssid: 'near', rssi: -40 })]
      }
    ])
    expect(tracks.map((t) => t.bssid)).toEqual(['near', 'far'])
  })

  it('caps the tracked access points so a long walk cannot grow without bound', () => {
    const many = Array.from({ length: MAX_TRACKS + 50 }, (_, i) => bss({ bssid: `ap-${i}` }))
    expect(accumulate([{ atSec: 0, bssids: many }])).toHaveLength(MAX_TRACKS)
  })

  it('returns nothing for no scans', () => {
    expect(accumulate([])).toEqual([])
  })
})
