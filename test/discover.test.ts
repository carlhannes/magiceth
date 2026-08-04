import { describe, it, expect } from 'vitest'
import {
  parseDiscovery,
  parseVlanFrames,
  surveyArgs,
  surveyScript
} from '../src/main/capabilities/discover'
import { shQuote, appleScriptEscape } from '../src/main/privilege'

// Hand-written from the documented tcpdump -v format. Kept because it is the shape a Cisco-style
// switch produces; LLDP_LIVE below is the one that came off real hardware.
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

// Real `tcpdump -nn -v -s0` output, captured 2026-08-04 on en7 (Realtek RTL8153) from an LLDP
// frame injected on en9 (ASIX AX88179A) across an unmanaged switch — see docs/VLAN-FINDINGS.md.
// It differs from the hand-written block above in two ways that matter to the regexes: every
// header carries the word "TLV", and the Port VLAN ID is nested two levels under an
// "Organization specific" TLV rather than printed inline as "PVID 100".
const LLDP_LIVE = `14:37:28.159907 LLDP, length 81
	Chassis ID TLV (1), length 7
	  Subtype MAC address (4): 6c:6e:07:01:ff:de
	Port ID TLV (2), length 20
	  Subtype Interface Name (5): GigabitEthernet0/24
	Time to Live TLV (3), length 2: TTL 120s
	System Name TLV (5), length 20: zyxel-unmanaged-test
	Management Address TLV (8), length 12
	  Management Address length 5, AFI IPv4 (1): 10.0.0.5
	  Interface Index Interface Numbering (2): 1
	Organization specific TLV (127), length 6: OUI Ethernet bridged (0x0080c2)
	  Port VLAN Id Subtype (1)
	    port vlan id (PVID): 100
	End TLV (0), length 0`

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

  it('parses tcpdump output captured off the wire, not just the documented format', () => {
    const [n] = parseDiscovery(LLDP_LIVE)
    expect(n.protocol).toBe('LLDP')
    expect(n.systemName).toBe('zyxel-unmanaged-test')
    expect(n.portId).toBe('GigabitEthernet0/24')
    expect(n.vlan).toBe(100)
    expect(n.mgmtAddress).toBe('10.0.0.5')
  })

  it('ignores an LLDP frame it could not read anything out of', () => {
    // The survey's broad filter also catches tagged LLDP whose TLVs tcpdump did not decode. Those
    // used to render as an empty "Protocol LLDP" row saying nothing at all.
    expect(parseDiscovery('14:37:28.159907 LLDP, length 81')).toEqual([])
  })

  it('handles what discover() actually passes in: tcpdump banner plus repeated frames', () => {
    // discover() concatenates stdout and stderr, so the banner is always the first thing the
    // parser sees, and a switch beacons every few seconds for as long as the capture runs.
    const asTheAppSeesIt = [
      'tcpdump: listening on en7, link-type EN10MB (Ethernet), snapshot length 524288 bytes',
      LLDP_LIVE,
      LLDP_LIVE
    ].join('\n')
    expect(parseDiscovery(asTheAppSeesIt)).toHaveLength(1)
  })
})

// Real `tcpdump -e` output from 2026-08-04: two tagged interfaces on one unmanaged switch, VLAN 100
// and VLAN 200, carrying SSDP, mDNS and ARP. This is what a trunk looks like to the survey.
const TAGGED = [
  '14:37:14.457804 00:e0:4c:be:53:2c > 01:00:5e:7f:ff:fa, ethertype 802.1Q (0x8100), length 171: vlan 200, p 0, ethertype IPv4 (0x0800), 10.99.100.2.55562 > 239.255.255.250.1900: UDP, length 125',
  '14:37:14.458039 6c:6e:07:01:ff:de > 01:00:5e:7f:ff:fa, ethertype 802.1Q (0x8100), length 171: vlan 100, p 0, ethertype IPv4 (0x0800), 10.99.100.1.58382 > 239.255.255.250.1900: UDP, length 125',
  '14:37:14.552631 00:e0:4c:be:53:2c > 01:00:5e:00:00:fb, ethertype 802.1Q (0x8100), length 91: vlan 200, p 0, ethertype IPv4 (0x0800), 10.99.100.2.5353 > 224.0.0.251.5353: 0 PTR (QM)? _spotify-connect._tcp.local. (45)',
  '14:37:15.452749 6c:6e:07:01:ff:de > ff:ff:ff:ff:ff:ff, ethertype 802.1Q (0x8100), length 90: vlan 100, p 0, ethertype IPv4 (0x0800), 10.99.100.1.57621 > 10.99.100.255.57621: UDP, length 44',
  '14:37:16.470376 6c:6e:07:01:ff:de > ff:ff:ff:ff:ff:ff, ethertype 802.1Q (0x8100), length 60: vlan 100, p 0, ethertype ARP (0x0806), Request who-has 10.99.100.2 tell 10.99.100.1, length 42'
].join('\n')

describe('parseVlanFrames', () => {
  it('enumerates VLANs off real tagged traffic, with counts and observed hosts', () => {
    // Addresses are in the order they were first seen: .1 from the SSDP frame, .255 from the
    // subnet-broadcast frame, then .2 from the ARP request.
    expect(parseVlanFrames(TAGGED)).toEqual([
      { id: 100, frames: 3, addresses: ['10.99.100.1', '10.99.100.255', '10.99.100.2'] },
      { id: 200, frames: 2, addresses: ['10.99.100.2'] }
    ])
  })

  it('drops multicast destinations, which describe no host on the VLAN', () => {
    // Every line above carries 239.255.255.250 or 224.0.0.251 as its destination.
    const addresses = parseVlanFrames(TAGGED).flatMap((v) => v.addresses)
    expect(addresses.some((a) => a.startsWith('239.') || a.startsWith('224.'))).toBe(false)
  })

  it('reports nothing for untagged traffic — that is what says "access port"', () => {
    const untagged =
      '14:37:16.470376 6c:6e:07:01:ff:de > ff:ff:ff:ff:ff:ff, ethertype ARP (0x0806), Request who-has 10.0.0.2 tell 10.0.0.1, length 42'
    expect(parseVlanFrames(untagged)).toEqual([])
    expect(parseVlanFrames('')).toEqual([])
  })

  it('caps the address list so a busy VLAN cannot grow without bound', () => {
    const many = Array.from(
      { length: 12 },
      (_unused, i) =>
        `10:00:0${i}.0 a > b, ethertype 802.1Q (0x8100), length 60: vlan 7, p 0, ethertype ARP (0x0806), Request who-has 10.0.0.${i + 20} tell 10.0.0.1, length 42`
    ).join('\n')
    const [seen] = parseVlanFrames(many)
    expect(seen.frames).toBe(12)
    expect(seen.addresses).toHaveLength(4)
  })
})

describe('surveyScript', () => {
  const script = surveyScript('en7', '/tmp/out.txt', '/tmp/out.stop')

  // The bug this whole rewrite exists for: SIGTERM does not stop tcpdump while its BPF read is
  // blocked, so `wait` hangs and the captured output is never handed back. See docs/VLAN-FINDINGS.md.
  it('stops tcpdump with SIGKILL, never a bare kill', () => {
    expect(script).toContain('kill -9 $p')
    expect(script).not.toMatch(/(^|[^-9] )kill \$p/)
  })

  it('waits on the stop file and gives up on its own so no root capture can be orphaned', () => {
    expect(script).toContain("while [ ! -f '/tmp/out.stop' ]")
    expect(script).toMatch(/\$n -lt \d+/)
    expect(script).toContain("rm -f '/tmp/out.stop'")
  })

  // Every argument is quoted, not just the interpolated one — uniform is harder to get wrong than
  // remembering which of them came from outside.
  it('quotes the device and appends to the output file', () => {
    expect(script).toContain("'-i' 'en7'")
    expect(script).toContain(">> '/tmp/out.txt'")
    expect(surveyScript("a'b", '/tmp/o', '/tmp/s')).toContain("'a'\\''b'")
  })

  // -e guarantees tcpdump prints the 802.1Q header; without it we would be relying on the payload
  // decode, which no capture we have taken actually demonstrates.
  it('captures broadcast/multicast with the link-layer header shown', () => {
    expect(surveyArgs('en7')).toEqual([
      '-l',
      '-e',
      '-nn',
      '-v',
      '-s0',
      '-i',
      'en7',
      'ether broadcast or ether multicast'
    ])
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
