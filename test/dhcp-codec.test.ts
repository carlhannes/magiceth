import { describe, it, expect } from 'vitest'
import {
  BOOTREPLY,
  buildReply,
  bytesToHex,
  clientId,
  DHCP,
  hexToBytes,
  hostname,
  ipToBytes,
  messageType,
  OPT,
  paramList,
  parseDhcp,
  requestedIp,
  serverId,
  u32,
  vendorClass
} from '../src/main/plugins/dhcp/codec'
import { clientPacket, UBNT_MAC } from './fixtures/dhcp'
import { FLEX_MINI_DISCOVER, FLEX_MINI_MAC, MAC_HOST_DISCOVER } from './fixtures/flexmini-capture'

describe('parseDhcp', () => {
  it('reads the header and the options of a DISCOVER', () => {
    const m = parseDhcp(
      clientPacket({
        type: DHCP.DISCOVER,
        mac: UBNT_MAC,
        xid: 0x12345678,
        flags: 0x8000,
        vendorClass: 'ubnt',
        hostname: 'USW-Flex-Mini',
        paramList: [1, 3, 43]
      })
    )
    expect(m).toBeDefined()
    expect(m?.op).toBe(1)
    expect(m?.xid).toBe(0x12345678)
    expect(m?.flags).toBe(0x8000)
    expect(m?.mac).toBe(UBNT_MAC)
    expect(m?.ciaddr).toBe('0.0.0.0')
    expect(m?.giaddr).toBe('0.0.0.0')
    expect(messageType(m!)).toBe(DHCP.DISCOVER)
    expect(vendorClass(m!)).toBe('ubnt')
    expect(hostname(m!)).toBe('USW-Flex-Mini')
    expect(paramList(m!)).toEqual([1, 3, 43])
    expect(requestedIp(m!)).toBeUndefined()
    expect(serverId(m!)).toBeUndefined()
    expect(clientId(m!)).toBeUndefined()
  })

  it('reads requested address and server id from a REQUEST', () => {
    const m = parseDhcp(
      clientPacket({
        type: DHCP.REQUEST,
        mac: UBNT_MAC,
        requestedIp: '10.254.254.10',
        serverId: '10.254.254.1',
        ciaddr: '10.254.254.10'
      })
    )
    expect(requestedIp(m!)).toBe('10.254.254.10')
    expect(serverId(m!)).toBe('10.254.254.1')
    expect(m?.ciaddr).toBe('10.254.254.10')
  })

  it('is undefined for anything that is not DHCP', () => {
    expect(parseDhcp(Buffer.alloc(10))).toBeUndefined()
    const noCookie = clientPacket({ type: DHCP.DISCOVER, mac: UBNT_MAC })
    noCookie[236] = 0
    expect(parseDhcp(noCookie)).toBeUndefined()
  })

  // RFC 3396: an option split over several instances is one option.
  it('concatenates a repeated option', () => {
    const base = clientPacket({ type: DHCP.DISCOVER, mac: UBNT_MAC })
    const withoutEnd = base.subarray(0, base.length - 1)
    const packet = Buffer.concat([
      withoutEnd,
      Buffer.from([60, 2, 0x75, 0x62, 60, 2, 0x6e, 0x74, 255])
    ])
    expect(vendorClass(parseDhcp(packet)!)).toBe('ubnt')
  })

  it('survives a truncated option list', () => {
    const base = clientPacket({ type: DHCP.DISCOVER, mac: UBNT_MAC, vendorClass: 'ubnt' })
    const cut = base.subarray(0, base.length - 3)
    const m = parseDhcp(cut)
    expect(m).toBeDefined()
    expect(messageType(m!)).toBe(DHCP.DISCOVER)
  })
})

describe('buildReply', () => {
  const request = parseDhcp(
    clientPacket({ type: DHCP.DISCOVER, mac: UBNT_MAC, xid: 42, flags: 0x8000 })
  )!

  it('round-trips through parseDhcp with the client identity echoed', () => {
    const reply = buildReply({
      xid: request.xid,
      flags: request.flags,
      htype: request.htype,
      hlen: request.hlen,
      chaddr: request.chaddr,
      yiaddr: '10.254.254.10',
      options: [
        { code: OPT.MESSAGE_TYPE, data: Buffer.from([DHCP.OFFER]) },
        { code: OPT.SERVER_ID, data: ipToBytes('10.254.254.1') },
        { code: OPT.LEASE_TIME, data: u32(120) },
        { code: OPT.VENDOR_SPECIFIC, data: hexToBytes('01:04:0a:fe:fe:01') }
      ]
    })
    // BOOTP minimum, so the oldest client in the world still accepts it.
    expect(reply.length).toBeGreaterThanOrEqual(300)
    const m = parseDhcp(reply)!
    expect(m.op).toBe(BOOTREPLY)
    expect(m.xid).toBe(42)
    expect(m.flags).toBe(0x8000)
    expect(m.mac).toBe(UBNT_MAC)
    expect(m.yiaddr).toBe('10.254.254.10')
    expect(m.siaddr).toBe('0.0.0.0')
    expect(messageType(m)).toBe(DHCP.OFFER)
    expect(serverId(m)).toBe('10.254.254.1')
    expect(m.options.get(OPT.LEASE_TIME)?.readUInt32BE(0)).toBe(120)
    expect(bytesToHex(m.options.get(OPT.VENDOR_SPECIFIC)!)).toBe('01:04:0a:fe:fe:01')
  })

  it('refuses an option longer than a byte can describe', () => {
    expect(() =>
      buildReply({
        xid: 1,
        flags: 0,
        htype: 1,
        hlen: 6,
        chaddr: request.chaddr,
        yiaddr: '10.254.254.10',
        options: [{ code: 43, data: Buffer.alloc(256) }]
      })
    ).toThrow(/longer than 255/)
  })
})

describe('hexToBytes', () => {
  it('accepts colons, spaces and bare hex', () => {
    expect(hexToBytes('01:04:c0:a8:03:0a')).toEqual(Buffer.from([1, 4, 192, 168, 3, 10]))
    expect(hexToBytes('0104c0a8030a')).toEqual(Buffer.from([1, 4, 192, 168, 3, 10]))
    expect(hexToBytes('01 04 C0 A8 03 0A')).toEqual(Buffer.from([1, 4, 192, 168, 3, 10]))
  })

  it('refuses an odd number of digits', () => {
    expect(() => hexToBytes('abc')).toThrow(/odd/i)
  })
})

describe("the Flex Mini's real DISCOVER (captured 2026-10-26)", () => {
  const m = parseDhcp(Buffer.from(FLEX_MINI_DISCOVER, 'hex'))!

  it('parses as a broadcast-flag-clear DISCOVER from the switch', () => {
    expect(m.op).toBe(1)
    expect(m.mac).toBe(FLEX_MINI_MAC)
    expect(m.xid).toBe(0xc36d91aa)
    expect(m.flags).toBe(0)
    expect(m.giaddr).toBe('0.0.0.0')
    expect(messageType(m)).toBe(DHCP.DISCOVER)
  })

  it('carries the ubnt vendor class, its hostname and option 43 in the parameter list', () => {
    expect(vendorClass(m)).toBe('ubnt')
    expect(hostname(m)).toBe('USW-Flex-Mini')
    expect(paramList(m)).toEqual([1, 3, 28, 6, 12, 15, 43])
    expect(clientId(m)).toBeUndefined()
    expect(requestedIp(m)).toBeUndefined()
  })

  it("and the Mac's own DISCOVER on the same link has a client id but no vendor class", () => {
    const host = parseDhcp(Buffer.from(MAC_HOST_DISCOVER, 'hex'))!
    expect(messageType(host)).toBe(DHCP.DISCOVER)
    expect(vendorClass(host)).toBeUndefined()
    expect(clientId(host)).toBe('01:6c:6e:07:01:ff:de')
    expect(hostname(host)).toBe('hannes-mbpm4')
  })
})
