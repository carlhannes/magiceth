import { describe, it, expect } from 'vitest'
import { parseIfconfig, parseIpconfigSummary } from '../src/main/platform/darwin'

// Real output captured on macOS with ASIX AX88179A on a live network.
const IFCONFIG = `en9: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	options=404<VLAN_MTU,CHANNEL_IO>
	ether 6c:6e:07:01:ff:de
	inet6 fe80::49f:4e94:6001:b45b%en9 prefixlen 64 secured scopeid 0x1b
	inet 192.168.70.196 netmask 0xfffffe00 broadcast 192.168.71.255
	media: autoselect (1000baseT <full-duplex>)
	status: active`

const SUMMARY = `<dictionary> {
  IPv4 : <array> {
    0 : <dictionary> {
      Addresses : <array> { 0 : 192.168.70.196 }
      ConfigMethod : DHCP
      DHCP : <dictionary> {
        LeaseExpirationTime : 08/06/2026 11:07:58
        LeaseStartTime : 07/23/2026 11:07:58
        Packet : op = BOOTREPLY
server_identifier (ip): 192.168.70.1
subnet_mask (ip): 255.255.254.0
domain_name (string): localdomain
domain_name_server (ip_mult): {192.168.70.1}
router (ip_mult): {192.168.70.1}
        State : BOUND
      }
      Router : 192.168.70.1
      RouterARPVerified : TRUE
    }
  }
}`

describe('parseIfconfig', () => {
  it('parses MAC, IP, netmask (hex->cidr), media and status', () => {
    const i = parseIfconfig(IFCONFIG)
    expect(i.mac).toBe('6c:6e:07:01:ff:de')
    expect(i.ipv4).toBe('192.168.70.196')
    expect(i.netmask).toBe('255.255.254.0')
    expect(i.cidr).toBe(23)
    expect(i.linkUp).toBe(true)
    expect(i.linkSpeedMbps).toBe(1000)
    expect(i.duplex).toBe('full')
  })

  it('marks link down when status is not active', () => {
    const i = parseIfconfig('en9: flags=8863\n\tether 6c:6e:07:01:ff:de\n\tstatus: inactive')
    expect(i.linkUp).toBe(false)
  })
})

describe('parseIpconfigSummary', () => {
  it('parses DHCP, gateway, server, DNS, domain and lease', () => {
    const s = parseIpconfigSummary(SUMMARY)
    expect(s.dhcp).toBe(true)
    expect(s.gateway).toBe('192.168.70.1')
    expect(s.dhcpServer).toBe('192.168.70.1')
    expect(s.dnsServers).toEqual(['192.168.70.1'])
    expect(s.domain).toBe('localdomain')
    expect(s.state).toBe('BOUND')
    expect(s.leaseExpiration).toBe('08/06/2026 11:07:58')
  })
})
