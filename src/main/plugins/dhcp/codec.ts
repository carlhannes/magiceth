// Pure: DHCP packets (RFC 2131/2132) to and from bytes. Tested in test/dhcp-codec.test.ts.
//
// Only what a tiny single-subnet server needs: the fixed header, the magic cookie and the
// option list. Duplicate options are concatenated (RFC 3396); option overload (52) is not
// handled, because no DHCP client this is for has ever been seen using it.

import { intToIp, ipToInt } from '../../../shared/net'

export const BOOTREQUEST = 1
export const BOOTREPLY = 2

/** Option 53 values. */
export const DHCP = {
  DISCOVER: 1,
  OFFER: 2,
  REQUEST: 3,
  DECLINE: 4,
  ACK: 5,
  NAK: 6,
  RELEASE: 7,
  INFORM: 8
} as const

export const OPT = {
  PAD: 0,
  SUBNET_MASK: 1,
  ROUTER: 3,
  DNS: 6,
  HOSTNAME: 12,
  BROADCAST: 28,
  VENDOR_SPECIFIC: 43,
  REQUESTED_IP: 50,
  LEASE_TIME: 51,
  MESSAGE_TYPE: 53,
  SERVER_ID: 54,
  PARAM_LIST: 55,
  VENDOR_CLASS: 60,
  CLIENT_ID: 61,
  END: 255
} as const

/** The client asks for its reply to be broadcast. Echoed back; where the reply goes is decided elsewhere. */
export const BROADCAST_FLAG = 0x8000

const HEADER_LENGTH = 236
const COOKIE = Buffer.from([0x63, 0x82, 0x53, 0x63])
/** BOOTP clients expect at least this much; padding with zeros is harmless to everyone else. */
const MIN_PACKET = 300

export interface DhcpMessage {
  op: number
  htype: number
  hlen: number
  hops: number
  xid: number
  secs: number
  flags: number
  ciaddr: string
  yiaddr: string
  siaddr: string
  giaddr: string
  /** All 16 bytes, so a reply can echo them exactly. */
  chaddr: Buffer
  /** The hardware address as `aa:bb:cc:dd:ee:ff`, from the first `hlen` bytes of chaddr. */
  mac: string
  options: Map<number, Buffer>
}

export interface DhcpOption {
  code: number
  data: Buffer
}

export function ipToBytes(ip: string): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(ipToInt(ip))
  return b
}

export function bytesToIp(buf: Buffer, offset = 0): string {
  return intToIp(buf.readUInt32BE(offset))
}

/** `01:04:c0:a8:03:0a`, `0104c0a8030a` and `01 04 c0 a8 03 0a` all mean the same bytes. */
export function hexToBytes(hex: string): Buffer {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  if (clean.length % 2 !== 0) throw new Error(`Odd number of hex digits in "${hex}".`)
  return Buffer.from(clean, 'hex')
}

export function bytesToHex(buf: Buffer): string {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(':')
}

export function macText(buf: Buffer): string {
  return bytesToHex(buf)
}

/** Undefined when the bytes are not a DHCP packet: too short, or no magic cookie. */
export function parseDhcp(buf: Buffer): DhcpMessage | undefined {
  if (buf.length < HEADER_LENGTH + 4) return undefined
  if (!buf.subarray(HEADER_LENGTH, HEADER_LENGTH + 4).equals(COOKIE)) return undefined

  const hlen = Math.min(buf[2], 16)
  const chaddr = Buffer.from(buf.subarray(28, 44))
  const options = new Map<number, Buffer>()
  let i = HEADER_LENGTH + 4
  while (i < buf.length) {
    const code = buf[i]
    if (code === OPT.PAD) {
      i++
      continue
    }
    if (code === OPT.END) break
    if (i + 1 >= buf.length) break
    const len = buf[i + 1]
    const data = Buffer.from(buf.subarray(i + 2, Math.min(i + 2 + len, buf.length)))
    const previous = options.get(code)
    options.set(code, previous ? Buffer.concat([previous, data]) : data)
    i += 2 + len
  }

  return {
    op: buf[0],
    htype: buf[1],
    hlen,
    hops: buf[3],
    xid: buf.readUInt32BE(4),
    secs: buf.readUInt16BE(8),
    flags: buf.readUInt16BE(10),
    ciaddr: bytesToIp(buf, 12),
    yiaddr: bytesToIp(buf, 16),
    siaddr: bytesToIp(buf, 20),
    giaddr: bytesToIp(buf, 24),
    chaddr,
    mac: macText(chaddr.subarray(0, hlen || 6)),
    options
  }
}

export function messageType(m: DhcpMessage): number | undefined {
  const v = m.options.get(OPT.MESSAGE_TYPE)
  return v && v.length >= 1 ? v[0] : undefined
}

export function requestedIp(m: DhcpMessage): string | undefined {
  const v = m.options.get(OPT.REQUESTED_IP)
  return v && v.length === 4 ? bytesToIp(v) : undefined
}

export function serverId(m: DhcpMessage): string | undefined {
  const v = m.options.get(OPT.SERVER_ID)
  return v && v.length === 4 ? bytesToIp(v) : undefined
}

/** Option 60, as text. Ubiquiti devices send `ubnt`; most laptops send nothing. */
export function vendorClass(m: DhcpMessage): string | undefined {
  const v = m.options.get(OPT.VENDOR_CLASS)
  return v && v.length > 0 ? v.toString('latin1') : undefined
}

export function hostname(m: DhcpMessage): string | undefined {
  const v = m.options.get(OPT.HOSTNAME)
  const text = v?.toString('utf8').replace(/\0+$/, '').trim()
  return text || undefined
}

export function clientId(m: DhcpMessage): string | undefined {
  const v = m.options.get(OPT.CLIENT_ID)
  return v && v.length > 0 ? bytesToHex(v) : undefined
}

export function paramList(m: DhcpMessage): number[] {
  const v = m.options.get(OPT.PARAM_LIST)
  return v ? [...v] : []
}

export interface DhcpReplySpec {
  xid: number
  flags: number
  htype: number
  hlen: number
  chaddr: Buffer
  /** Echoed for a renewing client; zero otherwise. */
  ciaddr?: string
  yiaddr: string
  options: DhcpOption[]
}

/** A BOOTREPLY with the given options, padded to the BOOTP minimum. */
export function buildReply(spec: DhcpReplySpec): Buffer {
  const head = Buffer.alloc(HEADER_LENGTH)
  head[0] = BOOTREPLY
  head[1] = spec.htype
  head[2] = spec.hlen
  head[3] = 0
  head.writeUInt32BE(spec.xid, 4)
  head.writeUInt16BE(0, 8)
  head.writeUInt16BE(spec.flags, 10)
  ipToBytes(spec.ciaddr ?? '0.0.0.0').copy(head, 12)
  ipToBytes(spec.yiaddr).copy(head, 16)
  // siaddr and giaddr stay zero: there is no next server and no relay.
  const chaddr = Buffer.alloc(16)
  spec.chaddr.copy(chaddr, 0, 0, Math.min(16, spec.chaddr.length))
  chaddr.copy(head, 28)

  const parts: Buffer[] = [head, COOKIE]
  for (const o of spec.options) {
    if (o.data.length > 255) throw new Error(`Option ${o.code} is longer than 255 bytes.`)
    parts.push(Buffer.from([o.code, o.data.length]), o.data)
  }
  parts.push(Buffer.from([OPT.END]))
  const packet = Buffer.concat(parts)
  if (packet.length >= MIN_PACKET) return packet
  return Buffer.concat([packet, Buffer.alloc(MIN_PACKET - packet.length)])
}

export function u32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(value >>> 0)
  return b
}
