import { describe, expect, it } from 'vitest'
import {
  AGGREGATE_HEADER,
  aggregateCsv,
  csvEscape,
  isRecordingId,
  parseAggregateCsv,
  recordingId,
  sampleRows,
  splitCsvLine,
  startedAtFromId,
  summarize
} from '../src/main/capabilities/recordings-core'
import type { WifiBss, WifiTrack } from '../src/shared/types'

function range(min: number, max: number, avg: number, last: number) {
  return { min, max, avg, last }
}

function track(over: Partial<WifiTrack> & Pick<WifiTrack, 'bssid'>): WifiTrack {
  return {
    ssid: 'net',
    channel: 6,
    band: '2.4',
    sightings: 3,
    firstSeenSec: 0,
    lastSeenSec: 10,
    rssi: range(-80, -50, -64, -62),
    security: 'WPA2-Personal',
    locallyAdministered: false,
    ...over
  }
}

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

describe('CSV primitives', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvEscape('office-wifi')).toBe('office-wifi')
  })

  it('quotes and doubles up the characters that would break a row', () => {
    // A real café SSID will do all of this at once.
    expect(csvEscape('Bob\'s "Bar", Ltd')).toBe('"Bob\'s ""Bar"", Ltd"')
    expect(csvEscape('two\nlines')).toBe('"two\nlines"')
  })

  it('writes an absent value as an empty cell, never as 0 or undefined', () => {
    expect(csvEscape(undefined)).toBe('')
    expect(csvEscape(0)).toBe('0')
  })

  it('writes a flag as yes/no rather than true/false', () => {
    expect(csvEscape(true)).toBe('yes')
    expect(csvEscape(false)).toBe('no')
  })

  it('splits a row back, including embedded commas and quotes', () => {
    expect(splitCsvLine('a,"b,c","say ""hi""",,d')).toEqual(['a', 'b,c', 'say "hi"', '', 'd'])
  })

  it('returns the remainder rather than throwing on an unterminated quote', () => {
    expect(splitCsvLine('a,"unfinished')).toEqual(['a', 'unfinished'])
  })
})

describe('sampleRows', () => {
  it('writes one row per access point, newline terminated so it can be appended', () => {
    const text = sampleRows(4, '2026-09-29T21:45:07.000Z', [
      bss({ bssid: 'aa:bb', ssid: 'one', rssi: -41, streams: 2, clients: 3, utilizationPct: 12 }),
      bss({ bssid: 'cc:dd', ssid: 'two' })
    ])
    const lines = text.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(text.endsWith('\n')).toBe(true)
    expect(splitCsvLine(lines[0]).slice(0, 5)).toEqual([
      '4',
      '2026-09-29T21:45:07.000Z',
      'one',
      'aa:bb',
      '-41'
    ])
    // MIMO is written the way it is read, and the absent one stays blank.
    expect(splitCsvLine(lines[0])[10]).toBe('2x2')
    expect(splitCsvLine(lines[1])[10]).toBe('')
  })

  it('writes nothing at all for a snapshot that heard nothing', () => {
    expect(sampleRows(2, 'now', [])).toBe('')
  })
})

describe('aggregateCsv', () => {
  it('puts every access point of one network together, strongest first', () => {
    const csv = aggregateCsv([
      track({ bssid: 'b1', ssid: 'zeta', rssi: range(-70, -60, -65, -62) }),
      track({ bssid: 'a1', ssid: 'alpha', rssi: range(-80, -70, -75, -72) }),
      track({ bssid: 'a2', ssid: 'alpha', rssi: range(-50, -40, -45, -44) })
    ])
    const ssids = csv
      .split('\n')
      .slice(1)
      .filter(Boolean)
      .map((l) => splitCsvLine(l).slice(0, 2))
    expect(ssids).toEqual([
      ['alpha', 'a2'],
      ['alpha', 'a1'],
      ['zeta', 'b1']
    ])
  })

  it('sorts a hidden network last instead of first on its empty name', () => {
    const csv = aggregateCsv([
      track({ bssid: 'h1', ssid: '' }),
      track({ bssid: 'n1', ssid: 'named' })
    ])
    const order = csv
      .split('\n')
      .slice(1)
      .filter(Boolean)
      .map((l) => splitCsvLine(l)[1])
    expect(order).toEqual(['n1', 'h1'])
  })

  it('starts with the header', () => {
    expect(aggregateCsv([]).split('\n')[0]).toBe(AGGREGATE_HEADER)
  })
})

describe('parseAggregateCsv', () => {
  it('round-trips a track, including an SSID full of CSV hazards', () => {
    const original = track({
      bssid: '84:78:48:1c:dd:37',
      ssid: 'Bob\'s "Bar", Ltd ☕',
      vendor: 'Ubiquiti',
      phy: '802.11be',
      streams: 4,
      widthMhz: 160,
      channel: 128,
      band: '5',
      security: 'WPA3-Personal',
      clients: range(0, 6, 2.5, 1),
      utilizationPct: range(0, 30, 12.5, 8),
      locallyAdministered: true,
      countryCode: 'SE'
    })
    expect(parseAggregateCsv(aggregateCsv([original]))).toEqual([original])
  })

  it('keeps an absent measurement absent rather than turning it into zero', () => {
    const [back] = parseAggregateCsv(aggregateCsv([track({ bssid: 'aa' })]))
    expect(back.clients).toBeUndefined()
    expect(back.utilizationPct).toBeUndefined()
    expect(back.vendor).toBeUndefined()
  })

  it('skips a truncated final line instead of throwing, so a killed run still opens', () => {
    const good = aggregateCsv([track({ bssid: 'aa' }), track({ bssid: 'bb' })])
    const truncated = good.trimEnd().split('\n').slice(0, -1).join('\n') + '\nzz,incompl'
    expect(parseAggregateCsv(truncated).map((t) => t.bssid)).toEqual(['aa'])
  })

  it('returns nothing for an empty file or something that is not ours', () => {
    expect(parseAggregateCsv('')).toEqual([])
    expect(parseAggregateCsv('name,age\nbob,7\n')).toEqual([])
  })
})

describe('recording ids', () => {
  it('names a recording after its local start time', () => {
    expect(recordingId(new Date(2026, 8, 29, 21, 45, 3))).toBe('wifi-2026-09-29_214503')
  })

  it('reads the start time back for display', () => {
    expect(startedAtFromId('wifi-2026-09-29_214503')).toBe('2026-09-29 21:45:03')
    expect(startedAtFromId('something-else')).toBeUndefined()
  })

  it('rejects anything that is not one of our filenames', () => {
    // The id arrives from the renderer, so this is what keeps a path inside the folder.
    expect(isRecordingId('wifi-2026-09-29_214503')).toBe(true)
    expect(isRecordingId('../../../etc/passwd')).toBe(false)
    expect(isRecordingId('wifi-2026-09-29_214503/../../x')).toBe(false)
    expect(isRecordingId('')).toBe(false)
  })
})

describe('summarize', () => {
  it('derives duration, access points and networks from the rows alone', () => {
    const s = summarize('wifi-2026-09-29_214503', '/tmp/x.agg.csv', [
      track({ bssid: 'a1', ssid: 'alpha', lastSeenSec: 40 }),
      track({ bssid: 'a2', ssid: 'alpha', lastSeenSec: 95 }),
      track({ bssid: 'b1', ssid: 'beta', lastSeenSec: 12 })
    ])
    expect(s).toEqual({
      id: 'wifi-2026-09-29_214503',
      startedAt: '2026-09-29 21:45:03',
      durationSec: 95,
      accessPoints: 3,
      networks: 2,
      path: '/tmp/x.agg.csv'
    })
  })

  it('counts each hidden access point as its own network, as the live grouping does', () => {
    const s = summarize('wifi-2026-09-29_214503', '/x', [
      track({ bssid: 'h1', ssid: '' }),
      track({ bssid: 'h2', ssid: '' })
    ])
    expect(s.networks).toBe(2)
  })
})
