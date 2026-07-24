import { describe, it, expect } from 'vitest'
import { parseDiscovery } from '../src/main/capabilities/discover'
import { shQuote, appleScriptEscape } from '../src/main/privilege'

// Documented tcpdump -v format (not live-verified — validated against a real switch).
const LLDP = `11:22:33.444444 LLDP, length 234
	Chassis ID (1), length 7
	  Subtype MAC address (4): 00:1b:0d:aa:bb:cc
	Port ID (2), length 15
	  Subtype Interface Name (5): GigabitEthernet0/24
	Time to Live (3), length 2: TTL 120s
	System Name (5), length 9: switch-01
	Management Address (8), length 12
	  Management Address length 5, AFI IPv4 (1): 10.0.0.5
	Port VLAN ID (127), length 6: PVID 100`

const CDP = `11:22:34.555555 CDPv2, ttl: 180s, checksum: 692 (unverified), length 337
	Device-ID (0x01), length 8: 'switch01'
	Platform (0x06), length 15: 'cisco WS-C2960'
	Address (0x02), length 13:
	  IPv4 (1) 10.0.0.5
	Port-ID (0x03), length 23: 'GigabitEthernet0/24'
	Native VLAN ID (0x0a), length 2: 100`

describe('parseDiscovery', () => {
  it('parses LLDP: switch name, port, VLAN (PVID, not TLV type) and mgmt IP', () => {
    const [n] = parseDiscovery(LLDP)
    expect(n.protocol).toBe('LLDP')
    expect(n.systemName).toBe('switch-01')
    expect(n.portId).toBe('GigabitEthernet0/24')
    expect(n.vlan).toBe(100)
    expect(n.mgmtAddress).toBe('10.0.0.5')
  })

  it('parses CDP: device-id, port, native VLAN (not 0x0a) and address', () => {
    const [n] = parseDiscovery(CDP)
    expect(n.protocol).toBe('CDP')
    expect(n.systemName).toBe('switch01')
    expect(n.portId).toBe('GigabitEthernet0/24')
    expect(n.vlan).toBe(100)
    expect(n.mgmtAddress).toBe('10.0.0.5')
  })

  it('deduplicates and ignores irrelevant packets', () => {
    const combined = `${LLDP}\n${LLDP}\n11:22:35.1 ARP, Request who-has 10.0.0.1`
    expect(parseDiscovery(combined)).toHaveLength(1)
  })

  it('returns an empty list when no LLDP/CDP is present', () => {
    expect(parseDiscovery('11:22:35.1 ARP, Request who-has 10.0.0.1')).toEqual([])
  })
})

describe('shQuote / appleScriptEscape', () => {
  it('sh-quotes safely', () => {
    expect(shQuote('en9')).toBe("'en9'")
    expect(shQuote("a'b")).toBe("'a'\\''b'")
  })

  it('escapes AppleScript strings', () => {
    expect(appleScriptEscape('say "hi"\\n')).toBe('say \\"hi\\"\\\\n')
  })
})
