// DHCP client packets built by hand from RFC 2131/2132.
//
// DOCUMENTED FORMAT, NOT A CAPTURE. The Flex Mini's real DISCOVER — its vendor class, whether it
// sets the broadcast flag, what it asks for in option 55 — is the first thing CONFIGURE-TEST.md
// has you record; paste those bytes here as a constant and point the tests at them (AGENTS.md).

export interface ClientPacket {
  type: number
  mac: string
  xid?: number
  flags?: number
  ciaddr?: string
  giaddr?: string
  vendorClass?: string
  hostname?: string
  requestedIp?: string
  serverId?: string
  paramList?: number[]
}

function ip(text: string): number[] {
  return text.split('.').map((o) => parseInt(o, 10))
}

function mac(text: string): number[] {
  return text.split(':').map((o) => parseInt(o, 16))
}

/** A BOOTREQUEST with the magic cookie and the given options, as a client would send it. */
export function clientPacket(p: ClientPacket): Buffer {
  const head = Buffer.alloc(236)
  head[0] = 1 // BOOTREQUEST
  head[1] = 1 // Ethernet
  head[2] = 6
  head.writeUInt32BE(p.xid ?? 0x3903f326, 4)
  head.writeUInt16BE(p.flags ?? 0, 10)
  Buffer.from(ip(p.ciaddr ?? '0.0.0.0')).copy(head, 12)
  Buffer.from(ip(p.giaddr ?? '0.0.0.0')).copy(head, 24)
  Buffer.from(mac(p.mac)).copy(head, 28)

  const options: number[] = [0x63, 0x82, 0x53, 0x63, 53, 1, p.type]
  if (p.requestedIp) options.push(50, 4, ...ip(p.requestedIp))
  if (p.serverId) options.push(54, 4, ...ip(p.serverId))
  if (p.vendorClass) options.push(60, p.vendorClass.length, ...Buffer.from(p.vendorClass, 'latin1'))
  if (p.hostname) options.push(12, p.hostname.length, ...Buffer.from(p.hostname, 'utf8'))
  if (p.paramList) options.push(55, p.paramList.length, ...p.paramList)
  options.push(255)
  return Buffer.concat([head, Buffer.from(options)])
}

export const UBNT_MAC = '78:45:58:a1:b2:c3'
