import { describe, expect, it } from 'vitest'
import { bandOf, parseWifiHelper, widthOf } from '../src/main/platform/wifi-helper'
import { AP_5G_4X4 } from './fixtures/beacons'

/**
 * Real output of the macOS helper, captured 2026-10-09 on the development Mac and cut down to
 * three of its eleven access points: the 160 MHz 5 GHz radio, the 2.4 GHz one that reports no
 * noise figure, and a 6 GHz one. Nothing inside the entries was edited.
 */
const HELPER_OK =
  '{"auth":"authorizedAlways","interface":"en0","interfaces":["en0"],"status":"ok","networks":[{"band":2,"beaconInterval":100,"bssid":"84:78:48:1c:dd:37","channel":128,"countryCode":"SE","ibss":false,"ie":"000c7461726469735f6e6f6d617001088c129824b048606c070a534504240817640b1e002001002302180030140100000fac040100000fac040100000fac08cc000b05000001127a460573da00000c2d1aef0903ffffffff000000000000000001000000000000000000003d16800700000000000000000000000000000000000000007f0a04000f02000000400040bf0cf6f98b33aaff0000aaff0020c005017a72fcffc305033c3c3c3cc911000d8655ff8478481cdd39c526a7f84a14f40120ff27230d01181a40100c634088ff5b9d1c110a00aaffaaffaaffaaff7b1cc7711cc7711cc7711cc771ff0724f43f0026fcffff022703ff0e260703a4ff27a4ff4243ff6232ffff126c1700e01f1be01877803600444444444444ff066a0411000000dd178cfdf00101020100020101030301010004010109020f0fdd180050f2020101870003a4000027a4000042435e0062322f00dd168cfdf0040000494c510c05203000cb17000009110000dd078cfdf004010102dd0c00156d01553750726f584753dd3900156d000101000102a4a681068478481cdd36892434393135333139342d666436612d346438622d386265372d626635663138336433306161","noise":-91,"rssi":-59,"ssid":"tardis_nomap","width":4},{"band":1,"beaconInterval":100,"bssid":"8a:78:48:1c:dd:38","channel":1,"countryCode":"SE","ibss":false,"ie":"00097464635f6e6f6d6170010882848b960c1218240301010706534504010d14230206002a010232043048606c30140100000fac040100000fac040100000fac020c000b050b00471558460573da00000c2d1aad0903ffff0000000000000000000001000000000000000000003d16010005000000000000000000000000000000000000007f0a04000002000000400040c911000d8655ff8478481cdd39c526a7f84814ff1d230d01181a4010006040880f419d1c110a00fafffaff791cc7711cc771ff0724f43f0025fcffff022703ff0e260103a4ff27a4ff4243ff6232ffff0f6c9700e00101e01877001200222222ff066a0411000000dd178cfdf00101020100020101030301010004010109020300dd180050f2020101810003a4000027a4000042435e0062322f00dd168cfdf0040000494c510c05203000cb17000009110000dd078cfdf004010102dd3900156d000101000102a4a681068478481cdd36892434393135333139342d666436612d346438622d386265372d626635663138336433306161","noise":0,"rssi":-56,"ssid":"tdc_nomap","width":1},{"band":3,"beaconInterval":100,"bssid":"e6:38:83:e8:42:7f","channel":37,"countryCode":"SE","ibss":false,"ie":"000e7769666936652d636f6e74726f6c01088c129824b048606c070a534504c98300211000002001002302110030140100000fac040100000fac040100000fac08cc00472604002353021111000c7461726469735f6e6f6d61705501010b05020000127a460573d000000c7f0b04004f0200000040004009c3025814c3021814f40120ff27230d01081a40100c604888ff5b819c110800aaffaaffaaffaaff7b1cc7711cc7711cc7711cc771ff0c24f43f023efcff2503272f01ff022703ff0e260903a4ff27a4ff4243ff6232ffff033b7836dd1300156d00010100010256a68106e43883e8427cdd0700037f05010003dd178cfdf00101020100020101030301010004010109020f03dd180050f2020101890003a4000027a4000042435e0062322f00dd168cfdf0040000494c510302097201cb17000004110000dd078cfdf004010100","noise":0,"rssi":-62,"ssid":"wifi6e-control","width":4}]}'

const PERMISSION = 'ask the OS'

describe('parseWifiHelper', () => {
  it('turns the macOS helper output into sightings, with CoreWLAN enums decoded', () => {
    const out = parseWifiHelper(HELPER_OK, PERMISSION)
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.sightings).toHaveLength(3)
    const five = out.sightings.find((s) => s.bssid === '84:78:48:1c:dd:37')!
    expect(five.ssid).toBe('tardis_nomap')
    expect(five.rssi).toBe(-59)
    expect(five.noise).toBe(-91)
    expect(five.channel).toBe(128)
    expect(five.band).toBe('5')
    expect(five.widthMhz).toBe(160)
    expect(five.countryCode).toBe('SE')
    // The beacon's own operation elements agree with CoreWLAN about the width.
    expect(five.beacon.widthMhz).toBe(160)
    expect(five.beacon.streams).toBe(4)
    expect(five.beacon.clients).toBeDefined()
  })

  it('drops a zero noise figure, which CoreWLAN uses for "no reading"', () => {
    const out = parseWifiHelper(HELPER_OK, PERMISSION)
    if (out.status !== 'ok') throw new Error(out.message)
    const two = out.sightings.find((s) => s.bssid === '8a:78:48:1c:dd:38')!
    expect(two.noise).toBeUndefined()
    expect(two.band).toBe('2.4')
    expect(two.widthMhz).toBe(20)
    const six = out.sightings.find((s) => s.bssid === 'e6:38:83:e8:42:7f')!
    expect(six.band).toBe('6')
    expect(six.channel).toBe(37)
    expect(six.widthMhz).toBe(160)
  })

  it('places a Windows-style entry by its centre frequency and leaves width to the beacon', () => {
    const out = parseWifiHelper(
      JSON.stringify({
        status: 'ok',
        networks: [
          {
            bssid: '84:78:48:1C:DD:37',
            ssid: 'tardis_nomap',
            rssi: -59,
            freqMhz: 5640,
            ie: AP_5G_4X4
          }
        ]
      }),
      PERMISSION
    )
    if (out.status !== 'ok') throw new Error(out.message)
    const [s] = out.sightings
    expect(s.bssid).toBe('84:78:48:1c:dd:37')
    expect(s.channel).toBe(128)
    expect(s.band).toBe('5')
    expect(s.widthMhz).toBeUndefined()
    expect(s.beacon.widthMhz).toBe(160)
    expect(s.beacon.countryCode).toBe('SE')
  })

  it('maps a refusal to needs-permission with the OS wording, and every other status to error', () => {
    expect(parseWifiHelper('{"status":"needs-permission","networks":[]}', PERMISSION)).toEqual({
      status: 'needs-permission',
      message: PERMISSION
    })
    expect(
      parseWifiHelper('{"status":"no-interface","message":"No Wi-Fi.","networks":[]}', PERMISSION)
    ).toEqual({ status: 'error', message: 'No Wi-Fi.' })
    expect(parseWifiHelper('{"status":"error","networks":[]}', PERMISSION).status).toBe('error')
  })

  it('skips an entry without a BSSID or a signal rather than inventing one', () => {
    const out = parseWifiHelper(
      JSON.stringify({
        status: 'ok',
        networks: [
          { ssid: 'nameless', rssi: -50 },
          { bssid: 'aa:bb:cc:dd:ee:ff', ssid: 'x' }
        ]
      }),
      PERMISSION
    )
    expect(out).toEqual({ status: 'ok', sightings: [] })
  })

  it('reports unreadable output as an error instead of throwing', () => {
    expect(parseWifiHelper('not json', PERMISSION).status).toBe('error')
  })
})

describe('CoreWLAN enums', () => {
  it('decode the band and width values the helper passes through', () => {
    expect([bandOf(1), bandOf(2), bandOf(3), bandOf(9), bandOf(undefined)]).toEqual([
      '2.4',
      '5',
      '6',
      '?',
      '?'
    ])
    expect([widthOf(1), widthOf(2), widthOf(3), widthOf(4), widthOf(0)]).toEqual([
      20,
      40,
      80,
      160,
      undefined
    ])
  })
})
