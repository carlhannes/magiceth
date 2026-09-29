import { describe, expect, it } from 'vitest'
import {
  UNINFORMATIVE_OUIS,
  lookupOui,
  normalizeMac,
  resolveVendor
} from '../src/main/capabilities/oui'

// Everything here is asserted against the real committed registry, not a stub. If a lookup
// changes because IEEE reassigned a block, that is worth finding out about.

describe('normalizeMac', () => {
  it('accepts the separators a MAC address actually arrives with', () => {
    expect(normalizeMac('84:78:48:1C:DD:37')).toBe('8478481cdd37')
    expect(normalizeMac('84-78-48-1c-dd-37')).toBe('8478481cdd37')
    expect(normalizeMac('847848')).toBe('847848')
  })
})

describe('lookupOui', () => {
  it('names the maker from a real BSSID seen on the air', () => {
    expect(lookupOui('84:78:48:1c:dd:37')).toBe('Ubiquiti Inc')
    expect(lookupOui('20:97:27:87:fa:b5')).toBe('TELTONIKA NETWORKS UAB')
  })

  it('prefers the finer registry, which is the whole reason MA-M and MA-S are fetched', () => {
    // 00:1b:c5 as a /24 belongs to IEEE itself and says nothing; the /36 below it is the answer.
    expect(lookupOui('001bc5')).toBe('IEEE Registration Authority')
    expect(lookupOui('00:1b:c5:00:0a:bc')).toBe('Converging Systems Inc.')
    expect(lookupOui('00:1b:c5:00:1a:bc')).toBe('OpenRB.com, Direct SIA')
    expect(lookupOui('10:06:48:0a:bc:de')).toBe('FLEXTRONICS TECHNOLOGIES (INDIA) PVT LTD')
  })

  it('returns nothing for an unassigned block or a fragment', () => {
    expect(lookupOui('020000')).toBeUndefined()
    expect(lookupOui('84')).toBeUndefined()
    expect(lookupOui('')).toBeUndefined()
  })
})

describe('resolveVendor', () => {
  it('reads a globally administered BSSID straight off the address', () => {
    expect(resolveVendor('84:78:48:1c:dd:37', false, [])).toBe('Ubiquiti Inc')
  })

  it('falls back to the beacon vendor elements when the BSSID is randomised', () => {
    // A real capture: 8a:78:48:… is locally administered, but the beacon carries Ubiquiti's
    // own vendor element, so the maker is still knowable.
    expect(resolveVendor('8a:78:48:1c:dd:38', true, ['8cfdf0', '0050f2', '00156d'])).toBe(
      'Ubiquiti Inc'
    )
  })

  it('ignores the elements that ride in nearly every beacon', () => {
    // Reading WPS/WMM as the maker would report most of the world's Wi-Fi as Microsoft.
    expect(lookupOui('0050f2')).toBe('MICROSOFT CORP.')
    expect(resolveVendor('8a:78:48:1c:dd:38', true, ['0050f2', '000fac', '506f9a'])).toBeUndefined()
  })

  it('ignores silicon vendors, which answer a different question than "who made it"', () => {
    expect(lookupOui('8cfdf0')).toBe('Qualcomm Inc.')
    expect(UNINFORMATIVE_OUIS.has('8cfdf0')).toBe(true)
    expect(resolveVendor('8a:00:00:00:00:01', true, ['8cfdf0'])).toBeUndefined()
  })

  it('says nothing rather than guessing when a randomised BSSID carries no usable element', () => {
    expect(resolveVendor('06:31:92:8d:ea:31', true, [])).toBeUndefined()
  })
})
