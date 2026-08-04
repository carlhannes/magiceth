import { describe, it, expect } from 'vitest'
import { validateProfileDraft } from '../src/shared/profile'

describe('validateProfileDraft', () => {
  it('accepts a DHCP profile', () => {
    const r = validateProfileDraft({ name: 'Office', mode: 'dhcp' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.profile).toMatchObject({ name: 'Office', mode: 'dhcp' })
  })

  it('requires a name', () => {
    const r = validateProfileDraft({ name: '   ', mode: 'dhcp' })
    expect(r).toEqual({ ok: false, error: 'Name is required.' })
  })

  it('accepts a static profile and normalizes the fields', () => {
    const r = validateProfileDraft({
      name: 'Lab',
      mode: 'static',
      ip: '10.0.0.50',
      cidr: '24',
      gateway: '10.0.0.1',
      dns: '1.1.1.1, 8.8.8.8',
      macOverride: 'AA-BB-CC-DD-EE-FF'
    })
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.profile).toEqual({
        id: '',
        name: 'Lab',
        mode: 'static',
        ip: '10.0.0.50',
        cidr: 24,
        gateway: '10.0.0.1',
        dns: ['1.1.1.1', '8.8.8.8'],
        macOverride: 'aa:bb:cc:dd:ee:ff'
      })
  })

  it('accepts a netmask instead of a prefix', () => {
    const r = validateProfileDraft({
      name: 'X',
      mode: 'static',
      ip: '10.0.0.5',
      cidr: '255.255.255.0'
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.profile.cidr).toBe(24)
  })

  it('rejects an invalid IP', () => {
    const r = validateProfileDraft({ name: 'X', mode: 'static', ip: '10.0.0.999', cidr: '24' })
    expect(r).toEqual({ ok: false, error: 'Invalid IPv4 address.' })
  })

  it('rejects invalid DNS', () => {
    const r = validateProfileDraft({
      name: 'X',
      mode: 'static',
      ip: '10.0.0.5',
      cidr: '24',
      dns: '1.1.1.1, nope'
    })
    expect(r).toEqual({ ok: false, error: 'Invalid DNS address.' })
  })

  it('rejects an invalid MAC override', () => {
    const r = validateProfileDraft({ name: 'X', mode: 'dhcp', macOverride: 'xyz' })
    expect(r).toEqual({ ok: false, error: 'Invalid MAC override.' })
  })

  it('keeps the id when editing', () => {
    const r = validateProfileDraft({ id: 'p-abc', name: 'X', mode: 'dhcp' })
    expect(r.ok && r.profile.id).toBe('p-abc')
  })
})
