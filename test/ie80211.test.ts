import { describe, expect, it } from 'vitest'
import {
  hexToBytes,
  htStreams,
  parseBssLoad,
  parseCountry,
  parseElements,
  parseHeOperation,
  parseHtOperation,
  parseRsn,
  parseVhtOperation,
  phyLabel,
  readBeacon,
  securityLabel,
  vhtStreams,
  vhtWidth
} from '../src/main/capabilities/ie80211'
import { AP_24_BUSY, AP_5G_4X4, AP_6E_2X2 } from './fixtures/beacons'

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

describe('channel width from the operation elements', () => {
  it('reads 20 and 40 MHz off the HT Operation secondary channel offset', () => {
    expect(parseHtOperation(hexToBytes('0600'))).toEqual({ primary: 6, widthMhz: 20 })
    expect(parseHtOperation(hexToBytes('0605'))).toEqual({ primary: 6, widthMhz: 40 })
    expect(parseHtOperation(hexToBytes('0607'))).toEqual({ primary: 6, widthMhz: 40 })
    expect(parseHtOperation(hexToBytes('06'))).toBeUndefined()
  })

  it('tells 80 from 160 by the distance between the centre segments, not the width field', () => {
    expect(vhtWidth(1, 42, 0)).toBe(80)
    expect(vhtWidth(1, 42, 50)).toBe(160)
    expect(vhtWidth(1, 106, 90)).toBe(160)
    // The deprecated encodings older gear still sends.
    expect(vhtWidth(2, 50, 0)).toBe(160)
    expect(vhtWidth(3, 42, 106)).toBe(160)
    // Width 0 means the HT Operation element decides.
    expect(vhtWidth(0, 0, 0)).toBeUndefined()
    expect(parseVhtOperation(hexToBytes('012a32'))).toEqual({ widthMhz: 160 })
    expect(parseVhtOperation(hexToBytes('01'))).toBeUndefined()
  })

  it('reads the 6 GHz width out of HE Operation only when the parameters say it is there', () => {
    // Documented layout (802.11ax 9.4.2.249), not a capture: ext id, params with bit 17 set,
    // colour, MCS set, then the 6 GHz info: primary 37, control width 3 (160), segments 47/55.
    expect(
      parseHeOperation(
        hexToBytes('24' + '000002' + '0d' + 'fcff' + '25' + '03' + '2f' + '37' + '00')
      )
    ).toEqual({
      widthMhz: 160
    })
    expect(
      parseHeOperation(
        hexToBytes('24' + '000002' + '0d' + 'fcff' + '25' + '02' + '2f' + '00' + '00')
      )
    ).toEqual({
      widthMhz: 80
    })
    // Bit 17 clear: nothing to read, and that is not an error.
    expect(parseHeOperation(hexToBytes('24' + 'f43f00' + '0d' + 'fcff'))).toEqual({})
    // Declared but truncated.
    expect(parseHeOperation(hexToBytes('24' + '000002' + '0d' + 'fcff' + '25'))).toBeUndefined()
  })
})

describe('labels shared by every source', () => {
  it('names the suites the way parseRsn always has', () => {
    const none = { sae: false, psk: false, enterprise: false, owe: false }
    expect(securityLabel({ ...none, psk: true })).toBe('WPA2-Personal')
    expect(securityLabel({ ...none, sae: true })).toBe('WPA3-Personal')
    expect(securityLabel({ ...none, sae: true, psk: true })).toBe('WPA2/WPA3-Personal')
    expect(securityLabel({ ...none, enterprise: true })).toBe('WPA2/WPA3-Enterprise')
    expect(securityLabel({ ...none, owe: true })).toBe('Enhanced Open (OWE)')
  })

  it('names the newest PHY present', () => {
    expect(phyLabel({ ht: true, vht: true, he: true, eht: true })).toBe('802.11be')
    expect(phyLabel({ ht: true, vht: true, he: true, eht: false })).toBe('802.11ax')
    expect(phyLabel({ ht: true, vht: false, he: false, eht: false })).toBe('802.11n')
    expect(phyLabel({ ht: false, vht: false, he: false, eht: false })).toBeUndefined()
  })

  it('reads a country and rejects a byte pair that is not one', () => {
    expect(parseCountry(hexToBytes('534504'))).toBe('SE')
    expect(parseCountry(hexToBytes('0000'))).toBeUndefined()
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
    expect(facts.widthMhz).toBe(20)
    expect(facts.countryCode).toBe('SE')
  })

  it('reads a 4x4 radio on 5 GHz', () => {
    const facts = readBeacon(AP_5G_4X4)
    expect(facts.phy).toBe('802.11be')
    expect(facts.streams).toBe(4)
    expect(facts.clients).toBe(0)
    expect(facts.utilizationPct).toBe(0)
    // VHT Operation says width 1 with segments 122 and 114: the newer 160 MHz encoding, which is
    // also what CoreWLAN reported for this access point.
    expect(facts.widthMhz).toBe(160)
  })

  it('reads a 2x2 radio and its channel load', () => {
    const facts = readBeacon(AP_6E_2X2)
    expect(facts.streams).toBe(2)
    expect(facts.clients).toBe(2)
    expect(facts.utilizationPct).toBe(2)
    // The same physical access point as the WPA2 capture above, on a different SSID that does
    // advertise SAE — so the security readout follows the beacon, not the hardware.
    expect(facts.security).toBe('WPA3-Personal')
    // Segments 42 and 50, eight apart: 160 MHz, matching CoreWLAN.
    expect(facts.widthMhz).toBe(160)
  })

  it('calls an access point with only the old WPA element WPA, and one with neither open', () => {
    // Documented layout: SSID, then a vendor element 00:50:f2 type 01 (WPA) with no RSN.
    expect(readBeacon('00026869' + 'dd0a0050f20101000050f202').security).toBe('WPA')
    expect(readBeacon('00026869').security).toBeUndefined()
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
