import { describe, it, expect } from 'vitest'
import type { NetworkInterfaceInfo } from 'node:os'
import { CANDIDATE_NETWORKS, pickSubnet } from '../src/main/plugins/dhcp/subnet'

function v4(address: string, netmask: string): NetworkInterfaceInfo {
  return { address, netmask, family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: null }
}

function v6(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: null,
    scopeid: 0
  }
}

describe('pickSubnet', () => {
  it('takes the first candidate on a machine with nothing in the way', () => {
    const s = pickSubnet({
      en0: [v4('192.168.1.23', '255.255.255.0'), v6('fe80::1')],
      lo0: [v4('127.0.0.1', '255.0.0.0')]
    })
    expect(s).toEqual({
      serverIp: '10.254.254.1',
      cidr: 24,
      netmask: '255.255.255.0',
      network: '10.254.254.0',
      broadcast: '10.254.254.255'
    })
  })

  it('steps past a candidate the machine is already on', () => {
    const s = pickSubnet({ en0: [v4('10.254.254.7', '255.255.255.0')] })
    expect(s?.serverIp).toBe('172.31.254.1')
  })

  // The office VPN hands out a /8; the whole of 10.x is spoken for.
  it('treats a wider prefix containing the candidate as a clash', () => {
    const s = pickSubnet({ utun3: [v4('10.8.0.2', '255.0.0.0')] })
    expect(s?.serverIp).toBe('172.31.254.1')
  })

  it('gives up when every candidate is taken', () => {
    const taken = CANDIDATE_NETWORKS.map((n, i) => [
      `if${i}`,
      [v4(n.replace(/0$/, '5'), '255.255.255.0')]
    ])
    expect(pickSubnet(Object.fromEntries(taken))).toBeUndefined()
  })

  it('copes with an interface that reports no addresses', () => {
    expect(pickSubnet({ en7: undefined, en8: [] })?.serverIp).toBe('10.254.254.1')
  })
})
