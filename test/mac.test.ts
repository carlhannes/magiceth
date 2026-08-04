import { describe, it, expect } from 'vitest'
import {
  normalizeMac,
  randomLocallyAdministeredMac,
  isLocallyAdministered
} from '../src/shared/mac'

describe('normalizeMac', () => {
  it('normalizes common formats', () => {
    expect(normalizeMac('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff')
    expect(normalizeMac('aabb.ccdd.eeff')).toBe('aa:bb:cc:dd:ee:ff')
    expect(normalizeMac('aa:bb:cc:dd:ee:ff')).toBe('aa:bb:cc:dd:ee:ff')
  })

  it('throws on invalid input', () => {
    expect(() => normalizeMac('xyz')).toThrow()
    expect(() => normalizeMac('aa:bb:cc')).toThrow()
  })
})

describe('randomLocallyAdministeredMac', () => {
  it('always sets the locally-administered unicast bits', () => {
    for (let i = 0; i < 200; i++) {
      const mac = randomLocallyAdministeredMac()
      expect(isLocallyAdministered(mac)).toBe(true)
      const first = parseInt(mac.slice(0, 2), 16)
      expect(first & 0x01).toBe(0) // unicast (not multicast)
    }
  })

  it('is deterministic with injected rng', () => {
    expect(randomLocallyAdministeredMac(() => 0)).toBe('02:00:00:00:00:00')
    expect(randomLocallyAdministeredMac(() => 0.9999999)).toBe('fe:ff:ff:ff:ff:ff')
  })
})
