import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PROFILES,
  ensureDefaults,
  parseProfiles,
  profileFromNetInfo,
  removeProfile,
  upsertProfile
} from '../src/main/capabilities/profiles-core'
import type { NetInfo, Profile } from '../src/shared/types'

const net: NetInfo = {
  device: 'en9',
  linkUp: true,
  mac: '6c:6e:07:01:ff:de',
  ipv4: '192.168.70.196',
  netmask: '255.255.254.0',
  cidr: 23,
  gateway: '192.168.70.1',
  dnsServers: ['192.168.70.1'],
  dhcp: { enabled: true }
}

describe('parseProfiles', () => {
  it('always adds the DHCP default and filters out invalid ones', () => {
    const list = parseProfiles(
      JSON.stringify([{ id: 'x', name: 'X', mode: 'static' }, { junk: true }])
    )
    expect(list.some((p) => p.id === 'dhcp')).toBe(true)
    expect(list.some((p) => p.id === 'x')).toBe(true)
    expect(list).toHaveLength(2)
  })

  it('returns defaults on broken JSON', () => {
    expect(parseProfiles('not json')).toEqual(DEFAULT_PROFILES)
  })

  // These values reach an elevated command line (netsh on Windows takes them unquoted), so a
  // hand-edited profiles.json must not survive the load.
  it('keeps a fully populated, well-formed profile', () => {
    const good = {
      id: 'lab',
      name: 'Lab',
      mode: 'static',
      ip: '10.0.0.50',
      cidr: 24,
      gateway: '10.0.0.1',
      dns: ['1.1.1.1', '8.8.8.8'],
      macOverride: '02:11:22:33:44:55'
    }
    expect(parseProfiles(JSON.stringify([good])).some((p) => p.id === 'lab')).toBe(true)
  })

  it('drops profiles whose optional fields are malformed', () => {
    const base = { id: 'x', name: 'X', mode: 'static' }
    const bad = [
      { ...base, ip: '10.0.0.50; calc' },
      { ...base, gateway: '999.1.1.1' },
      { ...base, cidr: 33 },
      { ...base, cidr: '24' },
      { ...base, dns: ['1.1.1.1', 'evil'] },
      { ...base, dns: '1.1.1.1' },
      { ...base, macOverride: 'not-a-mac' }
    ]
    for (const profile of bad) {
      expect(parseProfiles(JSON.stringify([profile]))).toEqual(DEFAULT_PROFILES)
    }
  })
})

describe('upsert/remove', () => {
  it('adds and replaces by id', () => {
    const a: Profile = { id: 'a', name: 'A', mode: 'dhcp' }
    let list = upsertProfile([], a)
    expect(list).toHaveLength(1)
    list = upsertProfile(list, { id: 'a', name: 'A2', mode: 'dhcp' })
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('A2')
  })

  it('deletes user profiles but not the default DHCP', () => {
    const list: Profile[] = [
      { id: 'dhcp', name: 'DHCP', mode: 'dhcp' },
      { id: 'a', name: 'A', mode: 'dhcp' }
    ]
    expect(removeProfile(list, 'a')).toHaveLength(1)
    expect(removeProfile(list, 'dhcp')).toHaveLength(2)
  })
})

describe('ensureDefaults', () => {
  it('does not duplicate the DHCP default', () => {
    expect(ensureDefaults(DEFAULT_PROFILES)).toHaveLength(1)
  })
})

describe('profileFromNetInfo', () => {
  it('builds a static profile from net info', () => {
    expect(profileFromNetInfo('p1', 'Bookmark', net)).toEqual({
      id: 'p1',
      name: 'Bookmark',
      mode: 'static',
      ip: '192.168.70.196',
      cidr: 23,
      gateway: '192.168.70.1',
      dns: ['192.168.70.1']
    })
  })
})
