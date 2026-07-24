import { describe, it, expect } from 'vitest'
import { macSetMacScript, macProfileScript, parseNetworkServiceName } from '../src/main/platform/darwin'
import { linuxSetMacScript, linuxProfileScript } from '../src/main/platform/linux'
import { winSetMacScript, winProfileScript } from '../src/main/platform/win32'
import type { Profile } from '../src/shared/types'

const staticProfile: Profile = {
  id: 's',
  name: 'Lab',
  mode: 'static',
  ip: '10.0.0.50',
  cidr: 24,
  gateway: '10.0.0.1',
  dns: ['1.1.1.1', '8.8.8.8']
}
const dhcpProfile: Profile = { id: 'dhcp', name: 'DHCP', mode: 'dhcp' }

const SERVICE_ORDER = `An asterisk (*) denotes that a network service is disabled.
(1) Wi-Fi
(Hardware Port: Wi-Fi, Device: en0)

(3) AX88179A
(Hardware Port: AX88179A, Device: en9)`

describe('macOS reconfig scripts', () => {
  it('parses service name for device', () => {
    expect(parseNetworkServiceName(SERVICE_ORDER, 'en9')).toBe('AX88179A')
    expect(parseNetworkServiceName(SERVICE_ORDER, 'en0')).toBe('Wi-Fi')
    expect(parseNetworkServiceName(SERVICE_ORDER, 'en5')).toBeUndefined()
  })

  it('builds MAC script', () => {
    expect(macSetMacScript('en9', '02:11:22:33:44:55')).toBe("ifconfig 'en9' ether '02:11:22:33:44:55'")
  })

  it('builds static profile script with netmask and DNS', () => {
    const s = macProfileScript('en9', 'AX88179A', staticProfile)
    expect(s).toContain("networksetup -setmanual 'AX88179A' '10.0.0.50' '255.255.255.0' '10.0.0.1'")
    expect(s).toContain("networksetup -setdnsservers 'AX88179A' '1.1.1.1' '8.8.8.8'")
  })

  it('builds DHCP profile script', () => {
    expect(macProfileScript('en9', 'AX88179A', dhcpProfile)).toBe("networksetup -setdhcp 'AX88179A'")
  })
})

describe('Linux reconfig scripts', () => {
  it('builds MAC script (down/set/up)', () => {
    expect(linuxSetMacScript('eth1', '02:11:22:33:44:55')).toBe(
      "ip link set dev 'eth1' down && ip link set dev 'eth1' address '02:11:22:33:44:55' && ip link set dev 'eth1' up"
    )
  })

  it('builds static profile script', () => {
    const s = linuxProfileScript('eth1', staticProfile)
    expect(s).toContain("ip addr flush dev 'eth1'")
    expect(s).toContain("ip addr add '10.0.0.50/24' dev 'eth1'")
    expect(s).toContain("ip route replace default via '10.0.0.1' dev 'eth1'")
  })
})

describe('Windows reconfig scripts', () => {
  it('builds MAC script (advanced property, MAC without colons in uppercase)', () => {
    const s = winSetMacScript('Ethernet 3', '02:11:22:33:44:55')
    expect(s).toContain('-RegistryValue "021122334455"')
    expect(s).toContain('Restart-NetAdapter -Name "Ethernet 3"')
  })

  it('builds static profile script (netsh)', () => {
    const s = winProfileScript('Ethernet 3', staticProfile)
    expect(s).toContain('netsh interface ip set address name="Ethernet 3" static 10.0.0.50 255.255.255.0 10.0.0.1')
    expect(s).toContain('netsh interface ip set dns name="Ethernet 3" static 1.1.1.1')
  })
})
