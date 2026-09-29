import { describe, expect, it } from 'vitest'
import {
  hexToBytes,
  htStreams,
  parseBssLoad,
  parseElements,
  parseRsn,
  readBeacon,
  vhtStreams
} from '../src/main/capabilities/ie80211'

// Fixtures are real beacons captured from the air on 2026-09-29 with the CoreWLAN helper, not
// hand-written bytes. A beacon nobody here designed is the only kind that catches the things
// nobody here would have thought to fake.

/** Real beacon captured 2026-09-29: 1c:0b:8b:f0:2d:39 (tardis_nomap), channel 48. */
const AP_6E_2X2 =
  '000c7461726469735f6e6f6d617001088c129824b048606c050401030000070a534504240817640b1e00200100230212' +
  '0030140100000fac040100000fac040100000fac08cc000b050200042778460573da00000c2d1aef0903ffff00000000' +
  '00000000000001000000000000000000003d16300704000000000000000000000000000000000000007f0a04000f0200' +
  '0000400040bf0cf6f98933faff0000faff0020c005012a32fcffc305032e2e2e2ef40120ff21230d01181a40100c6300' +
  '88ff49811c110800fafffafffafffaff791cc7711cc771ff0724f43f000dfcffff022703ff0e260903a4ff27a4ff4243' +
  'ff6232ffff126c1700e01f09001876800600222222222222ff066a0411000000dd178cfdf00101020100020101030301' +
  '010004010109020303dd180050f2020101890003a4000027a4000042435e0062322f00dd0a00156d0155374c697465dd' +
  '1300156d00010100010293a681061c0b8bf02d37'

/** Real beacon captured 2026-09-29: 84:78:48:1c:dd:37 (tardis_nomap), channel 128. */
const AP_5G_4X4 =
  '000c7461726469735f6e6f6d617001088c129824b048606c070a534504240817640b1e00200100230218003014010000' +
  '0fac040100000fac040100000fac08cc000b05000001127a460573da00000c2d1aef0903ffffffff0000000000000000' +
  '01000000000000000000003d16800700000000000000000000000000000000000000007f0a04000f02000000400040bf' +
  '0cf6f98b33aaff0000aaff0020c005017a72fcffc305033c3c3c3cc911000d8655ff8478481cdd39c526a7f84a14f401' +
  '20ff27230d01181a40100c634088ff5b9d1c110a00aaffaaffaaffaaff7b1cc7711cc7711cc7711cc771ff0724f43f00' +
  '26fcffff022703ff0e260103a4ff27a4ff4243ff6232ffff126c1700e01f1be01877803600444444444444ff066a0411' +
  '000000dd178cfdf00101020100020101030301010004010109020f0fdd180050f2020101810003a4000027a400004243' +
  '5e0062322f00dd168cfdf0040000494c510c05203000cb17000009110000dd078cfdf004010102dd0c00156d01553750' +
  '726f584753dd3900156d000101000102a4a681068478481cdd36892434393135333139342d666436612d346438622d38' +
  '6265372d626635663138336433306161'

/** Real beacon captured 2026-09-29: 8a:78:48:1c:dd:38 (tdc_nomap), channel 1. */
const AP_24_BUSY =
  '00097464635f6e6f6d6170010882848b960c1218240301010706534504010d14230206002a010232043048606c301401' +
  '00000fac040100000fac040100000fac020c000b050b004cb055460573da00000c2d1aad0903ffff0000000000000000' +
  '000001000000000000000000003d16010005000000000000000000000000000000000000007f0a040000020000004000' +
  '40c911000d8655ff8478481cdd39c526a7f84814ff1d230d01181a4010006040880f419d1c110a00fafffaff791cc771' +
  '1cc771ff0724f43f0025fcffff022703ff0e260703a4ff27a4ff4243ff6232ffff0f6c9700e00101e018770012002222' +
  '22ff066a0411000000dd178cfdf00101020100020101030301010004010109020300dd180050f2020101870003a40000' +
  '27a4000042435e0062322f00dd168cfdf0040000494c510c05203000cb17000009110000dd078cfdf004010102dd3900' +
  '156d000101000102a4a681068478481cdd36892434393135333139342d666436612d346438622d386265372d62663566' +
  '3138336433306161'
describe('hexToBytes', () => {
  it('reads a byte string', () => {
    expect([...hexToBytes('000b11ff')]).toEqual([0, 11, 17, 255])
  })

  it('ignores a trailing half byte rather than inventing one', () => {
    expect([...hexToBytes('00ff0')]).toEqual([0, 255])
  })

  it('stops at the first unreadable pair', () => {
    expect([...hexToBytes('00zz11')]).toEqual([0])
  })
})

describe('parseElements', () => {
  it('walks the TLV chain and tags the extension id', () => {
    // SSID "hi", then extension element 35 (HE capabilities) with one payload byte.
    const els = parseElements('00026869' + 'ff0223aa')
    expect(els.map((e) => ({ id: e.id, ext: e.ext, len: e.body.length }))).toEqual([
      { id: 0, ext: undefined, len: 2 },
      { id: 255, ext: 0x23, len: 2 }
    ])
  })

  it('stops when a declared length runs past the buffer instead of reading rubbish', () => {
    expect(parseElements('0002686900ff')).toHaveLength(1)
  })

  it('survives an empty string', () => {
    expect(parseElements('')).toEqual([])
  })
})

describe('parseBssLoad', () => {
  it('reads the station count and scales utilization to percent', () => {
    // 11 stations little-endian, 0x4d/255 = 30%.
    expect(parseBssLoad(hexToBytes('0b004d0000'))).toEqual({ clients: 11, utilizationPct: 30 })
  })

  it('returns nothing for a short element', () => {
    expect(parseBssLoad(hexToBytes('0b00'))).toBeUndefined()
  })
})

describe('spatial streams', () => {
  it('counts HT streams from the supported MCS set', () => {
    // 2 bytes cap info, 1 byte A-MPDU, then the MCS bitmap: two non-zero bytes = 2x2.
    expect(htStreams(hexToBytes('0000' + '00' + 'ffff0000' + '00'.repeat(12)))).toBe(2)
  })

  it('counts VHT streams from the Rx MCS map, where 3 means unsupported', () => {
    // 0xfffa => streams 0 and 1 supported, the rest 0b11.
    expect(vhtStreams(hexToBytes('00000000' + 'faff' + '000000000000'))).toBe(2)
  })

  it('returns nothing rather than zero when the element is truncated', () => {
    expect(htStreams(hexToBytes('0000'))).toBeUndefined()
    expect(vhtStreams(hexToBytes('0000'))).toBeUndefined()
  })
})

describe('parseRsn', () => {
  const rsn = (akms: string[]): Uint8Array =>
    hexToBytes(
      '0100' +
        '000fac04' +
        '0100' +
        '000fac04' +
        String(akms.length).padStart(2, '0') +
        '00' +
        akms.join('')
    )

  it('names a PSK-only network WPA2', () => {
    expect(parseRsn(rsn(['000fac02']))).toBe('WPA2-Personal')
  })

  it('names an SAE-only network WPA3', () => {
    expect(parseRsn(rsn(['000fac08']))).toBe('WPA3-Personal')
  })

  it('calls PSK and SAE together a transition network, which is why old clients still join', () => {
    expect(parseRsn(rsn(['000fac02', '000fac08']))).toBe('WPA2/WPA3-Personal')
  })

  it('recognises OWE', () => {
    expect(parseRsn(rsn(['000fac12']))).toBe('Enhanced Open (OWE)')
  })

  it('returns nothing for a truncated element', () => {
    expect(parseRsn(hexToBytes('0100'))).toBeUndefined()
  })
})

describe('readBeacon against real captures', () => {
  it('reads a Wi-Fi 7 access point with a busy 2.4 GHz channel', () => {
    const facts = readBeacon(AP_24_BUSY)
    expect(facts.ssid).toBe('tdc_nomap')
    expect(facts.clients).toBe(11)
    expect(facts.utilizationPct).toBe(30)
    expect(facts.phy).toBe('802.11be')
    expect(facts.streams).toBe(2)
    // Verified against the raw AKM suites: this one advertises PSK alone, so it is WPA2 even
    // though its neighbours on the same hardware are SAE.
    expect(facts.security).toBe('WPA2-Personal')
    // 00:15:6d is Ubiquiti — present even though the BSSID is a randomised one.
    expect(facts.vendorOuis).toContain('00156d')
  })

  it('reads a 4x4 radio on 5 GHz', () => {
    const facts = readBeacon(AP_5G_4X4)
    expect(facts.phy).toBe('802.11be')
    expect(facts.streams).toBe(4)
    expect(facts.clients).toBe(0)
    expect(facts.utilizationPct).toBe(0)
  })

  it('reads a 2x2 radio and its channel load', () => {
    const facts = readBeacon(AP_6E_2X2)
    expect(facts.streams).toBe(2)
    expect(facts.clients).toBe(2)
    expect(facts.utilizationPct).toBe(2)
    // The same physical access point as the WPA2 capture above, on a different SSID that does
    // advertise SAE — so the security readout follows the beacon, not the hardware.
    expect(facts.security).toBe('WPA3-Personal')
  })

  it('reports no model when the access point broadcasts no WPS element', () => {
    // None of the captured access points send one. An absent model must stay absent rather than
    // being guessed from the vendor.
    expect(readBeacon(AP_5G_4X4).model).toBeUndefined()
  })

  it('returns empty facts for an empty beacon instead of throwing', () => {
    expect(readBeacon('')).toEqual({ vendorOuis: [], phy: undefined, streams: undefined })
  })
})
