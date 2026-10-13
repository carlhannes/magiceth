import { describe, it, expect } from 'vitest'
import { buildOption43, option43Hex } from '../src/plugins/unifi-adopt/option43'

// The two examples in Ubiquiti's "Remote Adoption (Layer 3)" article.
describe('buildOption43', () => {
  it('encodes the controller address as sub-option 1', () => {
    expect(option43Hex({ ip: '192.168.3.10' })).toBe('01:04:c0:a8:03:0a')
  })

  it('encodes an inform URL as sub-option 2 with its length', () => {
    const url = 'http://192.168.3.10:8080/inform'
    const bytes = buildOption43({ url })
    expect(bytes[0]).toBe(2)
    expect(bytes[1]).toBe(0x1f)
    expect(bytes.subarray(2).toString('ascii')).toBe(url)
  })

  it('can carry both, address first', () => {
    const bytes = buildOption43({ ip: '10.254.254.1', url: 'http://10.254.254.1:8080/inform' })
    expect(bytes.subarray(0, 6)).toEqual(Buffer.from([1, 4, 10, 254, 254, 1]))
    expect(bytes[6]).toBe(2)
  })

  it('refuses nonsense', () => {
    expect(() => buildOption43({})).toThrow(/needs an address or a URL/)
    expect(() => buildOption43({ ip: '300.1.1.1' })).toThrow(/Not an IPv4/)
    expect(() => buildOption43({ url: 'x'.repeat(256) })).toThrow(/1–255/)
  })
})
