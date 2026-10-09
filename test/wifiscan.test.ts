import { describe, expect, it } from 'vitest'
import { isLocallyAdministered, toBss } from '../src/main/capabilities/wifiscan'
import type { WifiSighting } from '../src/main/platform'

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
