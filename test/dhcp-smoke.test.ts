// Loopback smoke test of the socket half of the DHCP server. Not part of `npm test`: it binds
// port 67 and 68 on the machine running it, so it only runs when asked for —
//
//   DHCP_SMOKE=1 npx vitest run test/dhcp-smoke.test.ts
//
// Everything about *what* is answered is covered by dhcp-lease.test.ts; this proves that a
// DISCOVER arriving on the wildcard socket produces an OFFER sent to port 68 at the link's reply
// address, and that a client without the vendor class gets silence. macOS does not deliver a
// broadcast on loopback, so 127.0.0.1 stands in for the dongle's broadcast address here; the
// broadcast itself is a hardware check (CONFIGURE-TEST.md §3).

import dgram from 'node:dgram'
import { describe, it, expect } from 'vitest'
import { DHCP, messageType, OPT, parseDhcp } from '../src/main/plugins/dhcp/codec'
import { startDhcpServer } from '../src/main/plugins/dhcp/server'
import type { DhcpEvent } from '../src/shared/plugin'
import { clientPacket } from './fixtures/dhcp'

const cfg = {
  serverIp: '127.0.0.1',
  cidr: 8,
  netmask: '255.0.0.0',
  broadcast: '127.0.0.1',
  poolStart: 10,
  poolEnd: 49,
  leaseSeconds: 120,
  vendorClassPrefix: 'ubnt',
  extraOptions: [{ code: 43, data: Buffer.from([1, 4, 127, 0, 0, 1]) }]
}

describe.skipIf(!process.env.DHCP_SMOKE)('DHCP server on loopback', () => {
  it('offers to a ubnt client and ignores the rest', async () => {
    const events: DhcpEvent[] = []
    const server = await startDhcpServer(cfg, (e) => events.push(e))
    const client = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const replies: Buffer[] = []
    client.on('message', (buf) => replies.push(buf))
    await new Promise<void>((resolve) => client.bind(68, '0.0.0.0', resolve))
    client.setBroadcast(true)
    try {
      client.send(
        clientPacket({ type: DHCP.DISCOVER, mac: '78:45:58:00:00:01', vendorClass: 'ubnt' }),
        67,
        '127.0.0.1'
      )
      await new Promise((r) => setTimeout(r, 400))
      client.send(clientPacket({ type: DHCP.DISCOVER, mac: '78:45:58:00:00:02' }), 67, '127.0.0.1')
      await new Promise((r) => setTimeout(r, 400))

      expect(replies).toHaveLength(1)
      const offer = parseDhcp(replies[0])!
      expect(messageType(offer)).toBe(DHCP.OFFER)
      expect(offer.yiaddr).toBe('127.0.0.10')
      expect([...offer.options.get(OPT.VENDOR_SPECIFIC)!]).toEqual([1, 4, 127, 0, 0, 1])
      expect(events.map((e) => e.kind)).toEqual(['discover', 'offer', 'ignored'])
    } finally {
      client.close()
      server.close()
    }
  })
})
