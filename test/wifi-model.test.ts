import { describe, expect, it } from 'vitest'
import {
  MAX_TRACKS,
  accumulate,
  channelBuckets,
  channelCentreMhz,
  channelFromMhz,
  channelSummary,
  distinctRadios,
  groupBySsid,
  isLocallyAdministered,
  occupiedSpan,
  octetDistance,
  toBss,
  trackToBss
} from '../src/main/capabilities/wifi-model'
import type { WifiSighting } from '../src/main/platform'
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

describe('track attributes', () => {
  it('carries the descriptive fields from the newest sighting, so a track describes itself', () => {
    const tracks = accumulate([
      { atSec: 0, bssids: [bss({ bssid: 'aa', phy: '802.11ac', streams: 2 })] },
      {
        atSec: 4,
        bssids: [
          bss({
            bssid: 'aa',
            phy: '802.11be',
            streams: 4,
            widthMhz: 160,
            vendor: 'Ubiquiti',
            security: 'WPA3-Personal',
            countryCode: 'SE'
          })
        ]
      }
    ])
    expect(tracks[0]).toMatchObject({
      phy: '802.11be',
      streams: 4,
      widthMhz: 160,
      vendor: 'Ubiquiti',
      security: 'WPA3-Personal',
      countryCode: 'SE'
    })
  })

  it('keeps a name once learned when a later beacon comes back hidden', () => {
    const tracks = accumulate([
      { atSec: 0, bssids: [bss({ bssid: 'aa', ssid: 'office' })] },
      { atSec: 4, bssids: [bss({ bssid: 'aa', ssid: '' })] }
    ])
    expect(tracks[0].ssid).toBe('office')
  })
})

describe('channelSummary', () => {
  it('counts the access points sharing a channel and keeps the nearest and the busiest', () => {
    const tracks = accumulate([
      {
        atSec: 0,
        bssids: [
          bss({ bssid: 'a', channel: 6, rssi: -70, utilizationPct: 10 }),
          bss({ bssid: 'b', channel: 6, rssi: -40, utilizationPct: 55 }),
          bss({ bssid: 'c', channel: 1, rssi: -60 })
        ]
      }
    ])
    expect(channelSummary(tracks)).toEqual([
      {
        channel: 1,
        band: '2.4',
        accessPoints: 1,
        bestRssi: -60,
        maxUtilizationPct: undefined,
        clients: undefined,
        clientsFromAps: 0,
        overlappingAps: 1
      },
      {
        channel: 6,
        band: '2.4',
        accessPoints: 2,
        bestRssi: -40,
        maxUtilizationPct: 55,
        clients: undefined,
        clientsFromAps: 0,
        overlappingAps: 2
      }
    ])
  })

  it('does not let an access point that never advertised a load read as 0%', () => {
    const tracks = accumulate([
      {
        atSec: 0,
        bssids: [
          bss({ bssid: 'a', channel: 11, utilizationPct: 40 }),
          bss({ bssid: 'b', channel: 11 })
        ]
      }
    ])
    expect(channelSummary(tracks)[0].maxUtilizationPct).toBe(40)
  })

  it('orders by band then channel, the way a spectrum is read', () => {
    const tracks = accumulate([
      {
        atSec: 0,
        bssids: [
          bss({ bssid: 'a', channel: 36, band: '5' }),
          bss({ bssid: 'b', channel: 11, band: '2.4' }),
          bss({ bssid: 'c', channel: 37, band: '6' }),
          bss({ bssid: 'd', channel: 1, band: '2.4' })
        ]
      }
    ])
    expect(channelSummary(tracks).map((c) => `${c.band}/${c.channel}`)).toEqual([
      '2.4/1',
      '2.4/11',
      '5/36',
      '6/37'
    ])
  })

  it('returns nothing for no tracks', () => {
    expect(channelSummary([])).toEqual([])
  })
})

describe('trackToBss', () => {
  it('flattens a track to its latest reading so saved recordings reuse the live grouping', () => {
    const [t] = accumulate([
      { atSec: 0, bssids: [bss({ bssid: 'aa', ssid: 'office', rssi: -80, clients: 1 })] },
      { atSec: 4, bssids: [bss({ bssid: 'aa', ssid: 'office', rssi: -50, clients: 9 })] }
    ])
    expect(trackToBss(t)).toMatchObject({ bssid: 'aa', ssid: 'office', rssi: -50, clients: 9 })
  })

  it('leaves a never-advertised value absent', () => {
    const [t] = accumulate([{ atSec: 0, bssids: [bss({ bssid: 'aa' })] }])
    expect(trackToBss(t).clients).toBeUndefined()
  })
})

/** One scan's worth of access points, as tracks. */
function scan(bssids: WifiBss[]) {
  return accumulate([{ atSec: 0, bssids }])
}

describe('octetDistance', () => {
  it('counts the octets that differ', () => {
    expect(octetDistance('3c:51:0e:f7:4a:eb', '3c:51:0e:f7:4a:ec')).toBe(1)
    expect(octetDistance('ec:75:0c:10:73:aa', 'ee:75:0c:20:73:aa')).toBe(2)
    expect(octetDistance('3c:51:0e:f7:4a:eb', 'c4:71:fe:5c:7f:17')).toBe(6)
  })

  it('treats anything that is not a six-octet address as unrelated', () => {
    expect(octetDistance('nonsense', '3c:51:0e:f7:4a:eb')).toBe(6)
  })
})

// The station count in a BSS Load element belongs to the radio, so every SSID on that radio repeats
// it. All of these are real BSSIDs captured in an office on 2026-09-30.
describe('distinctRadios', () => {
  it('folds five SSIDs of one Cisco radio into one', () => {
    const tracks = scan(
      ['eb', 'ec', 'ed', 'ee', 'ef'].map((tail) =>
        bss({ bssid: `3c:51:0e:f7:4a:${tail}`, channel: 140, band: '5', clients: 6 })
      )
    )
    expect(distinctRadios(tracks)).toHaveLength(1)
  })

  it('folds a pair whose addresses are registered to different vendors', () => {
    // ec:75:0c… is TP-Link and ee:75:0c… is MediaTek, yet both report 24 — one access point.
    // No address-pattern rule would catch this; the matching station count is what does.
    const tracks = scan([
      bss({ bssid: 'ec:75:0c:10:73:aa', channel: 2, clients: 24 }),
      bss({ bssid: 'ee:75:0c:20:73:aa', channel: 2, clients: 24 })
    ])
    expect(distinctRadios(tracks)).toHaveLength(1)
  })

  it('keeps unrelated access points apart even when they report the same count', () => {
    const tracks = scan([
      bss({ bssid: '3c:51:0e:f7:4a:e0', clients: 1 }),
      bss({ bssid: 'c4:71:fe:5c:7f:17', clients: 1 })
    ])
    expect(distinctRadios(tracks)).toHaveLength(2)
  })

  it('keeps access points apart when neither advertises a count, since nothing can be compared', () => {
    const tracks = scan([bss({ bssid: '3c:51:0e:f7:4a:e0' }), bss({ bssid: '3c:51:0e:f7:4a:e1' })])
    expect(distinctRadios(tracks)).toHaveLength(2)
  })
})

describe('channelSummary clients', () => {
  it('reports six clients on the Cisco radio, not thirty', () => {
    const tracks = scan(
      ['eb', 'ec', 'ed', 'ee', 'ef'].map((tail) =>
        bss({ bssid: `3c:51:0e:f7:4a:${tail}`, channel: 140, band: '5', clients: 6 })
      )
    )
    const [ch] = channelSummary(tracks)
    expect(ch.clients).toBe(6)
    expect(ch.accessPoints).toBe(5)
    expect(ch.clientsFromAps).toBe(5)
  })

  it('adds up genuinely separate access points', () => {
    const tracks = scan([
      bss({ bssid: '3c:51:0e:f7:4a:e0', channel: 1, clients: 4 }),
      bss({ bssid: 'c4:71:fe:5c:7f:17', channel: 1, clients: 7 })
    ])
    expect(channelSummary(tracks)[0].clients).toBe(11)
  })

  it('leaves the total undefined when nothing advertised one, rather than calling it zero', () => {
    const [ch] = channelSummary(scan([bss({ bssid: 'aa:bb:cc:dd:ee:ff', channel: 1 })]))
    expect(ch.clients).toBeUndefined()
    expect(ch.clientsFromAps).toBe(0)
  })

  it('counts only the access points that actually advertised', () => {
    const [ch] = channelSummary(
      scan([
        bss({ bssid: '3c:51:0e:f7:4a:e0', channel: 1, clients: 4 }),
        bss({ bssid: 'c4:71:fe:5c:7f:17', channel: 1 })
      ])
    )
    expect(ch.clients).toBe(4)
    expect(ch.clientsFromAps).toBe(1)
    expect(ch.accessPoints).toBe(2)
  })
})

describe('spectrum overlap', () => {
  it('knows where each band sits', () => {
    expect(channelCentreMhz(1, '2.4')).toBe(2412)
    expect(channelCentreMhz(14, '2.4')).toBe(2484) // the one that breaks the arithmetic
    expect(channelCentreMhz(36, '5')).toBe(5180)
    expect(channelCentreMhz(37, '6')).toBe(6135)
    expect(channelCentreMhz(1, '?')).toBeUndefined()
  })

  it('widens the span with the channel width', () => {
    const [narrow] = scan([bss({ bssid: 'a', channel: 1, widthMhz: 20 })])
    const [wide] = scan([bss({ bssid: 'a', channel: 1, widthMhz: 40 })])
    expect(occupiedSpan(narrow)).toEqual({ loMhz: 2402, hiMhz: 2422 })
    expect(occupiedSpan(wide)).toEqual({ loMhz: 2392, hiMhz: 2432 })
  })

  it('leaves 1, 6 and 11 clear of each other, which is why they are the plan', () => {
    const tracks = scan([
      bss({ bssid: 'a', channel: 1 }),
      bss({ bssid: 'b', channel: 6 }),
      bss({ bssid: 'c', channel: 11 })
    ])
    expect(channelSummary(tracks).map((c) => c.overlappingAps)).toEqual([1, 1, 1])
  })

  it('counts neighbours that do bleed across', () => {
    // Channel 3 covers 2412–2432 and channel 1 covers 2402–2422, so each sees the other.
    const tracks = scan([bss({ bssid: 'a', channel: 1 }), bss({ bssid: 'b', channel: 3 })])
    expect(channelSummary(tracks).map((c) => c.overlappingAps)).toEqual([2, 2])
  })

  it('counts a wide access point against a channel a narrow one would not reach', () => {
    const narrow = scan([bss({ bssid: 'a', channel: 1 }), bss({ bssid: 'b', channel: 6 })])
    const wide = scan([
      bss({ bssid: 'a', channel: 1, widthMhz: 40 }),
      bss({ bssid: 'b', channel: 6 })
    ])
    // At 20 MHz channel 1 stops at 2422 and channel 6 starts at 2427; at 40 MHz it reaches 2432.
    expect(channelSummary(narrow)[1].overlappingAps).toBe(1)
    expect(channelSummary(wide)[1].overlappingAps).toBe(2)
  })
})

describe('channelBuckets', () => {
  it('rolls channels up into the blocks they are planned in', () => {
    const tracks = scan([
      bss({ bssid: 'a1', channel: 1, clients: 2 }),
      bss({ bssid: 'a2', channel: 6 }),
      bss({ bssid: 'a3', channel: 11 }),
      bss({ bssid: 'a4', channel: 36, band: '5' }),
      bss({ bssid: 'a5', channel: 140, band: '5' })
    ])
    expect(channelBuckets(tracks).map((b) => [b.band, b.label, b.accessPoints])).toEqual([
      ['2.4', 'ch 1–5', 1],
      ['2.4', 'ch 6–10', 1],
      ['2.4', 'ch 11–14', 1],
      ['5', 'UNII-1', 1],
      ['5', 'UNII-2C', 1]
    ])
    expect(channelBuckets(tracks)[0].clients).toBe(2)
  })

  it('de-duplicates radios inside a block, not just inside a channel', () => {
    // The same radio on two channels of one block must still only be counted once.
    const tracks = scan([
      bss({ bssid: '3c:51:0e:f7:4a:eb', channel: 1, clients: 6 }),
      bss({ bssid: '3c:51:0e:f7:4a:ec', channel: 1, clients: 6 })
    ])
    expect(channelBuckets(tracks)[0].clients).toBe(6)
  })

  it('leaves out blocks with nothing in them', () => {
    expect(channelBuckets(scan([bss({ bssid: 'a', channel: 1 })]))).toHaveLength(1)
    expect(channelBuckets([])).toEqual([])
  })

  it('lists which channels of the block are actually in use', () => {
    const tracks = scan([
      bss({ bssid: 'a', channel: 1 }),
      bss({ bssid: 'b', channel: 5 }),
      bss({ bssid: 'c', channel: 1 })
    ])
    expect(channelBuckets(tracks)[0].channels).toEqual([1, 5])
  })
})

describe('channelFromMhz', () => {
  it('reads the channel and band off a centre frequency', () => {
    expect(channelFromMhz(2412)).toEqual({ channel: 1, band: '2.4' })
    expect(channelFromMhz(2484)).toEqual({ channel: 14, band: '2.4' })
    expect(channelFromMhz(5180)).toEqual({ channel: 36, band: '5' })
    expect(channelFromMhz(5825)).toEqual({ channel: 165, band: '5' })
    expect(channelFromMhz(5935)).toEqual({ channel: 2, band: '6' })
    expect(channelFromMhz(5955)).toEqual({ channel: 1, band: '6' })
    expect(channelFromMhz(7115)).toEqual({ channel: 233, band: '6' })
  })

  it('refuses frequencies off the grid rather than inventing a channel', () => {
    expect(channelFromMhz(2413)).toBeUndefined()
    expect(channelFromMhz(0)).toBeUndefined()
    expect(channelFromMhz(5180.5)).toBeUndefined()
    expect(channelFromMhz(3000)).toBeUndefined()
  })

  it('round-trips with channelCentreMhz on the channels anyone deploys', () => {
    const cases: [number, '2.4' | '5' | '6'][] = [
      [1, '2.4'],
      [6, '2.4'],
      [11, '2.4'],
      [36, '5'],
      [100, '5'],
      [149, '5'],
      [1, '6'],
      [37, '6'],
      [233, '6']
    ]
    for (const [channel, band] of cases) {
      expect(channelFromMhz(channelCentreMhz(channel, band)!)).toEqual({ channel, band })
    }
  })
})

// --- From a sighting to an access point: the one place a vendor is looked up ---

function sighting(over: Partial<WifiSighting> = {}): WifiSighting {
  return {
    bssid: '84:78:48:1c:dd:37',
    ssid: 'office',
    rssi: -60,
    channel: 36,
    band: '5',
    beacon: { vendorOuis: [] },
    ...over
  }
}

describe('toBss', () => {
  it("prefers the OS's width and country, falling back to the beacon's", () => {
    const beacon = { vendorOuis: [], widthMhz: 160, countryCode: 'SE' }
    expect(toBss(sighting({ widthMhz: 80, countryCode: 'DE', beacon }))).toMatchObject({
      widthMhz: 80,
      countryCode: 'DE'
    })
    expect(toBss(sighting({ beacon }))).toMatchObject({ widthMhz: 160, countryCode: 'SE' })
  })

  it("takes the beacon's SSID when the OS copy is empty, and calls no security Open", () => {
    const bss = toBss(sighting({ ssid: '', beacon: { vendorOuis: [], ssid: 'from-beacon' } }))
    expect(bss.ssid).toBe('from-beacon')
    expect(bss.security).toBe('Open')
  })

  it('looks the vendor up from a global address and says so when it cannot', () => {
    expect(toBss(sighting()).vendor).toBeDefined()
    const randomised = toBss(sighting({ bssid: '8a:78:48:1c:dd:38' }))
    expect(randomised.locallyAdministered).toBe(true)
    expect(randomised.vendor).toBeUndefined()
    // A vendor element in the beacon still names the maker behind a randomised address.
    expect(
      toBss(sighting({ bssid: '8a:78:48:1c:dd:38', beacon: { vendorOuis: ['00156d'] } })).vendor
    ).toMatch(/ubiquiti/i)
  })

  it('lets a WPS manufacturer beat the lookup', () => {
    expect(
      toBss(sighting({ beacon: { vendorOuis: [], manufacturer: 'TP-Link', model: 'Archer C7' } }))
    ).toMatchObject({ vendor: 'TP-Link', model: 'Archer C7' })
  })
})

describe('isLocallyAdministered', () => {
  it('reads the second-lowest bit of the first octet', () => {
    expect(isLocallyAdministered('02:00:00:00:00:00')).toBe(true)
    expect(isLocallyAdministered('8a:00:00:00:00:00')).toBe(true)
    expect(isLocallyAdministered('84:00:00:00:00:00')).toBe(false)
    expect(isLocallyAdministered('zz')).toBe(false)
  })
})
