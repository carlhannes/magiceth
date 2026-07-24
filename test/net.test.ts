import { describe, it, expect } from 'vitest'
import { cidrToDotted, dottedToCidr, isValidIpv4 } from '../src/shared/net'

describe('cidrToDotted', () => {
  it('converts prefix to dotted netmask', () => {
    expect(cidrToDotted(23)).toBe('255.255.254.0')
    expect(cidrToDotted(24)).toBe('255.255.255.0')
    expect(cidrToDotted(8)).toBe('255.0.0.0')
    expect(cidrToDotted(0)).toBe('0.0.0.0')
    expect(cidrToDotted(32)).toBe('255.255.255.255')
  })
})

describe('dottedToCidr', () => {
  it('converts dotted netmask to prefix', () => {
    expect(dottedToCidr('255.255.254.0')).toBe(23)
    expect(dottedToCidr('255.255.255.0')).toBe(24)
    expect(dottedToCidr('255.0.0.0')).toBe(8)
  })
})

describe('isValidIpv4', () => {
  it('accepts valid addresses', () => {
    expect(isValidIpv4('192.168.70.1')).toBe(true)
    expect(isValidIpv4('0.0.0.0')).toBe(true)
    expect(isValidIpv4('255.255.255.255')).toBe(true)
  })

  it('rejects invalid addresses', () => {
    expect(isValidIpv4('256.0.0.1')).toBe(false)
    expect(isValidIpv4('192.168.1')).toBe(false)
    expect(isValidIpv4('1.2.3.4.5')).toBe(false)
    expect(isValidIpv4('abc')).toBe(false)
    expect(isValidIpv4('')).toBe(false)
  })
})
