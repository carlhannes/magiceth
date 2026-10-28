import { describe, it, expect } from 'vitest'
import {
  bytesToHex,
  DHCP,
  hexToBytes,
  messageType,
  OPT,
  parseDhcp,
  serverId
} from '../src/main/plugins/dhcp/codec'
import {
  decide,
  DEFAULT_LEASE_SECONDS,
  inPool,
  POOL_END,
  POOL_START
} from '../src/main/plugins/dhcp/lease'
import type { Decision, LeaseConfig, LeaseTable } from '../src/main/plugins/dhcp/lease'
import { clientPacket, UBNT_MAC } from './fixtures/dhcp'
import { FLEX_MINI_DISCOVER, FLEX_MINI_MAC, MAC_HOST_DISCOVER } from './fixtures/flexmini-capture'
import type { ClientPacket } from './fixtures/dhcp'

const cfg: LeaseConfig = {
  serverIp: '10.254.254.1',
  cidr: 24,
  netmask: '255.255.255.0',
  broadcast: '10.254.254.255',
  poolStart: POOL_START,
  poolEnd: POOL_END,
  leaseSeconds: DEFAULT_LEASE_SECONDS,
  vendorClassPrefix: 'ubnt',
  extraOptions: [{ code: 43, data: hexToBytes('01:04:0a:fe:fe:01') }]
}

function send(p: ClientPacket, table: LeaseTable = {}, c: LeaseConfig = cfg): Decision {
  return decide(parseDhcp(clientPacket(p))!, table, c)
}

const OTHER_MAC = '78:45:58:00:00:02'

describe('decide: the happy path', () => {
  it('answers a UniFi DISCOVER with an OFFER from the pool, carrying option 43', () => {
    const d = send({
      type: DHCP.DISCOVER,
      mac: UBNT_MAC,
      vendorClass: 'ubnt',
      hostname: 'USW-Flex-Mini'
    })
    expect(d.reply).toBeDefined()
    expect(d.table).toEqual({ [UBNT_MAC]: '10.254.254.10' })
    expect(d.events).toEqual([
      { kind: 'discover', mac: UBNT_MAC, vendorClass: 'ubnt', hostname: 'USW-Flex-Mini' },
      { kind: 'offer', mac: UBNT_MAC, ip: '10.254.254.10' }
    ])
    const offer = parseDhcp(d.reply!)!
    expect(messageType(offer)).toBe(DHCP.OFFER)
    expect(offer.yiaddr).toBe('10.254.254.10')
    expect(serverId(offer)).toBe('10.254.254.1')
    expect(offer.options.get(OPT.LEASE_TIME)?.readUInt32BE(0)).toBe(120)
    expect(bytesToHex(offer.options.get(OPT.SUBNET_MASK)!)).toBe('ff:ff:ff:00')
    expect(bytesToHex(offer.options.get(OPT.ROUTER)!)).toBe('0a:fe:fe:01')
    expect(bytesToHex(offer.options.get(OPT.BROADCAST)!)).toBe('0a:fe:fe:ff')
    expect(bytesToHex(offer.options.get(OPT.VENDOR_SPECIFIC)!)).toBe('01:04:0a:fe:fe:01')
  })

  it('hands out DNS servers as option 6 only when the session shares the internet', () => {
    const shared = send(
      { type: DHCP.DISCOVER, mac: UBNT_MAC, vendorClass: 'ubnt' },
      {},
      { ...cfg, dnsServers: ['10.5.92.1', '1.1.1.1'] }
    )
    expect(bytesToHex(parseDhcp(shared.reply!)!.options.get(OPT.DNS)!)).toBe(
      '0a:05:5c:01:01:01:01:01'
    )
    const plain = send({ type: DHCP.DISCOVER, mac: UBNT_MAC, vendorClass: 'ubnt' })
    expect(parseDhcp(plain.reply!)!.options.has(OPT.DNS)).toBe(false)
  })

  it('gives the next address to the next device and the same one to a returning device', () => {
    const first = send({ type: DHCP.DISCOVER, mac: UBNT_MAC, vendorClass: 'ubnt' })
    const second = send({ type: DHCP.DISCOVER, mac: OTHER_MAC, vendorClass: 'ubnt' }, first.table)
    expect(second.table[OTHER_MAC]).toBe('10.254.254.11')
    const again = send({ type: DHCP.DISCOVER, mac: UBNT_MAC, vendorClass: 'ubnt' }, second.table)
    expect(parseDhcp(again.reply!)!.yiaddr).toBe('10.254.254.10')
  })

  it('ACKs a REQUEST for the offered address', () => {
    const table = { [UBNT_MAC]: '10.254.254.10' }
    const d = send(
      {
        type: DHCP.REQUEST,
        mac: UBNT_MAC,
        vendorClass: 'ubnt',
        requestedIp: '10.254.254.10',
        serverId: '10.254.254.1'
      },
      table
    )
    expect(messageType(parseDhcp(d.reply!)!)).toBe(DHCP.ACK)
    expect(d.events).toEqual([{ kind: 'ack', mac: UBNT_MAC, ip: '10.254.254.10' }])
  })

  it('ACKs a renewal, which names the address in ciaddr rather than option 50', () => {
    const d = send(
      { type: DHCP.REQUEST, mac: UBNT_MAC, vendorClass: 'ubnt', ciaddr: '10.254.254.10' },
      {
        [UBNT_MAC]: '10.254.254.10'
      }
    )
    const ack = parseDhcp(d.reply!)!
    expect(messageType(ack)).toBe(DHCP.ACK)
    expect(ack.ciaddr).toBe('10.254.254.10')
  })

  it('frees an address on RELEASE', () => {
    const d = send(
      { type: DHCP.RELEASE, mac: UBNT_MAC, vendorClass: 'ubnt' },
      { [UBNT_MAC]: '10.254.254.10' }
    )
    expect(d.reply).toBeUndefined()
    expect(d.table).toEqual({})
    expect(d.events).toEqual([{ kind: 'release', mac: UBNT_MAC, ip: '10.254.254.10' }])
  })
})

// The socket hears every interface of a laptop that is usually also on an office LAN. Everything
// in this block is a packet that LAN could produce, and the right answer to all of it is silence.
describe('decide: what must never be answered', () => {
  it('ignores a client without the vendor class, once', () => {
    const d = send({ type: DHCP.DISCOVER, mac: OTHER_MAC })
    expect(d.reply).toBeUndefined()
    expect(d.events).toEqual([{ kind: 'ignored', mac: OTHER_MAC, reason: 'no vendor class' }])
    const laptop = send({ type: DHCP.DISCOVER, mac: OTHER_MAC, vendorClass: 'MSFT 5.0' })
    expect(laptop.events[0]).toEqual({
      kind: 'ignored',
      mac: OTHER_MAC,
      reason: 'vendor class "MSFT 5.0"'
    })
  })

  it('answers everyone when no vendor class is required', () => {
    const d = send(
      { type: DHCP.DISCOVER, mac: OTHER_MAC },
      {},
      { ...cfg, vendorClassPrefix: undefined }
    )
    expect(d.reply).toBeDefined()
  })

  it('ignores anything relayed', () => {
    const d = send({
      type: DHCP.DISCOVER,
      mac: UBNT_MAC,
      vendorClass: 'ubnt',
      giaddr: '192.168.1.1'
    })
    expect(d.reply).toBeUndefined()
    expect(d.events[0]).toMatchObject({ kind: 'ignored', reason: 'relayed through a gateway' })
  })

  // A production access point rebinding its office lease: vendor class ubnt, ciaddr on another
  // subnet, broadcast so it reaches us. An ACK here would hand it our option 43.
  it('says nothing to a UniFi device renewing an address that is not in the pool', () => {
    const d = send({
      type: DHCP.REQUEST,
      mac: UBNT_MAC,
      vendorClass: 'ubnt',
      ciaddr: '192.168.1.50'
    })
    expect(d.reply).toBeUndefined()
    expect(d.events).toEqual([])
  })

  it('says nothing to a REQUEST meant for another server', () => {
    const d = send(
      {
        type: DHCP.REQUEST,
        mac: UBNT_MAC,
        vendorClass: 'ubnt',
        requestedIp: '10.254.254.10',
        serverId: '192.168.1.1'
      },
      { [UBNT_MAC]: '10.254.254.10' }
    )
    expect(d.reply).toBeUndefined()
    expect(d.events).toEqual([])
  })

  it('says nothing when the requested address belongs to someone else', () => {
    const d = send(
      { type: DHCP.REQUEST, mac: OTHER_MAC, vendorClass: 'ubnt', requestedIp: '10.254.254.10' },
      { [UBNT_MAC]: '10.254.254.10' }
    )
    expect(d.reply).toBeUndefined()
  })

  it('never sends a NAK, whatever arrives', () => {
    const packets: ClientPacket[] = [
      { type: DHCP.REQUEST, mac: UBNT_MAC, vendorClass: 'ubnt', requestedIp: '192.168.1.50' },
      { type: DHCP.REQUEST, mac: UBNT_MAC, vendorClass: 'ubnt', requestedIp: '10.254.254.200' },
      { type: DHCP.INFORM, mac: UBNT_MAC, vendorClass: 'ubnt', ciaddr: '10.254.254.10' },
      { type: DHCP.DECLINE, mac: UBNT_MAC, vendorClass: 'ubnt' },
      { type: 99, mac: UBNT_MAC, vendorClass: 'ubnt' }
    ]
    for (const p of packets) {
      const d = send(p, { [UBNT_MAC]: '10.254.254.10' })
      if (d.reply) expect(messageType(parseDhcp(d.reply)!)).not.toBe(DHCP.NAK)
    }
  })

  it('ignores a reply pretending to be a request', () => {
    const packet = clientPacket({ type: DHCP.DISCOVER, mac: UBNT_MAC, vendorClass: 'ubnt' })
    packet[0] = 2
    const d = decide(parseDhcp(packet)!, {}, cfg)
    expect(d.reply).toBeUndefined()
    expect(d.events).toEqual([])
  })
})

describe('decide: the pool', () => {
  it('knows its own bounds', () => {
    expect(inPool(cfg, '10.254.254.10')).toBe(true)
    expect(inPool(cfg, '10.254.254.49')).toBe(true)
    expect(inPool(cfg, '10.254.254.9')).toBe(false)
    expect(inPool(cfg, '10.254.254.50')).toBe(false)
    expect(inPool(cfg, '10.254.253.10')).toBe(false)
  })

  it('reports exhaustion rather than inventing an address', () => {
    let table: LeaseTable = {}
    for (let i = 0; i <= POOL_END - POOL_START; i++) {
      const mac = `02:00:00:00:00:${i.toString(16).padStart(2, '0')}`
      table = send({ type: DHCP.DISCOVER, mac, vendorClass: 'ubnt' }, table).table
    }
    expect(Object.keys(table)).toHaveLength(POOL_END - POOL_START + 1)
    const d = send({ type: DHCP.DISCOVER, mac: UBNT_MAC, vendorClass: 'ubnt' }, table)
    expect(d.reply).toBeUndefined()
    expect(d.events[1]).toEqual({ kind: 'error', message: 'The address pool is full.' })
  })
})

describe('decide: against the real packets from the dongle link (captured 2026-10-26)', () => {
  it("offers the Flex Mini's DISCOVER an address with option 43", () => {
    const d = decide(parseDhcp(Buffer.from(FLEX_MINI_DISCOVER, 'hex'))!, {}, cfg)
    expect(d.reply).toBeDefined()
    expect(d.table).toEqual({ [FLEX_MINI_MAC]: '10.254.254.10' })
    const offer = parseDhcp(d.reply!)!
    expect(messageType(offer)).toBe(DHCP.OFFER)
    expect(offer.xid).toBe(0xc36d91aa)
    expect(bytesToHex(offer.options.get(OPT.VENDOR_SPECIFIC)!)).toBe('01:04:0a:fe:fe:01')
  })

  it("gives the Mac's own DHCP client on the same link silence", () => {
    const d = decide(parseDhcp(Buffer.from(MAC_HOST_DISCOVER, 'hex'))!, {}, cfg)
    expect(d.reply).toBeUndefined()
    expect(d.events).toEqual([
      { kind: 'ignored', mac: '6c:6e:07:01:ff:de', reason: 'no vendor class' }
    ])
  })
})
