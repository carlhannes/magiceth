// Frames and capture files for the monitor-mode parsers, put together from the real beacon
// elements in beacons.ts. No capture exists yet that covers a particular case (a retried data
// frame, a deauthentication, a header with an extended presence word), so these are built to the
// layouts in the 802.11 and radiotap specifications — the same arrangement as dhcp.ts, which
// builds the DHCP messages no capture covers. The layouts were cross-checked once, by hand, against
// an independent decoder: `tcpdump -r` on a file written from these printed the same frequency,
// signal, rate, retry flag, BSSID, SSID and channel (2026-11-05). A real capture from a Mac, and
// then from the AX201, replaces them where it can.

export const BROADCAST = 'ff:ff:ff:ff:ff:ff'

function mac(text: string): number[] {
  return text.split(':').map((h) => Number.parseInt(h, 16))
}

export function hexBuffer(hex: string): Buffer {
  return Buffer.from(hex, 'hex')
}

export interface RadiotapSpec {
  tsft?: number
  flags?: number
  rate?: number
  freq?: number
  chanFlags?: number
  signal?: number
  /** Add what iwlwifi adds: an extended presence word and a second namespace with a per-chain signal. */
  perChain?: { signal: number; antenna: number }
}

/** Radiotap header: fields in presence-bit order, each aligned to its own size from the header start. */
export function radiotap(spec: RadiotapSpec): Buffer {
  type Field = { bit: number; align: number; size: number; write: (b: Buffer, at: number) => void }
  const fields: Field[] = []
  if (spec.tsft !== undefined) {
    const v = BigInt(spec.tsft)
    fields.push({ bit: 0, align: 8, size: 8, write: (b, at) => b.writeBigUInt64LE(v, at) })
  }
  if (spec.flags !== undefined) {
    const v = spec.flags
    fields.push({ bit: 1, align: 1, size: 1, write: (b, at) => b.writeUInt8(v, at) })
  }
  if (spec.rate !== undefined) {
    const v = spec.rate
    fields.push({ bit: 2, align: 1, size: 1, write: (b, at) => b.writeUInt8(v, at) })
  }
  if (spec.freq !== undefined) {
    const freq = spec.freq
    const flags = spec.chanFlags ?? 0x0080
    fields.push({
      bit: 3,
      align: 2,
      size: 4,
      write: (b, at) => {
        b.writeUInt16LE(freq, at)
        b.writeUInt16LE(flags, at + 2)
      }
    })
  }
  if (spec.signal !== undefined) {
    const v = spec.signal
    fields.push({ bit: 5, align: 1, size: 1, write: (b, at) => b.writeInt8(v, at) })
  }
  if (spec.perChain) {
    fields.push({ bit: 14, align: 2, size: 2, write: (b, at) => b.writeUInt16LE(0, at) })
  }

  const extended = spec.perChain !== undefined
  let present = fields.reduce((p, f) => p | (1 << f.bit), 0)
  if (extended) present |= (1 << 29) | 0x80000000 // next word restarts the default namespace
  let at = extended ? 12 : 8
  const placed = fields.map((f) => {
    at = Math.ceil(at / f.align) * f.align
    const start = at
    at += f.size
    return { f, start }
  })
  const chain = spec.perChain ? [spec.perChain.signal, spec.perChain.antenna] : []
  const length = at + chain.length
  const out = Buffer.alloc(length)
  out.writeUInt8(0, 0)
  out.writeUInt16LE(length, 2)
  out.writeUInt32LE(present >>> 0, 4)
  if (extended) out.writeUInt32LE((1 << 5) | (1 << 11), 8)
  for (const { f, start } of placed) f.write(out, start)
  if (spec.perChain) {
    out.writeInt8(chain[0], at)
    out.writeUInt8(chain[1], at + 1)
  }
  return out
}

export interface MgmtSpec {
  subtype: number
  bssid: string
  /** Receiver address; broadcast for beacons. */
  da?: string
  /** Transmitter address; the BSSID unless a client is the sender. */
  sa?: string
  retry?: boolean
  /** The order bit: the header grows a four-byte HT Control field. */
  htControl?: boolean
  body?: Buffer
}

export function mgmtFrame(spec: MgmtSpec): Buffer {
  const fc1 = (spec.retry ? 0x08 : 0) | (spec.htControl ? 0x80 : 0)
  const header = Buffer.from([
    spec.subtype << 4,
    fc1,
    0,
    0,
    ...mac(spec.da ?? BROADCAST),
    ...mac(spec.sa ?? spec.bssid),
    ...mac(spec.bssid),
    0,
    0
  ])
  const parts: Buffer[] = [header]
  if (spec.htControl) parts.push(Buffer.alloc(4))
  if (spec.body) parts.push(spec.body)
  return Buffer.concat(parts)
}

/** A beacon or probe response body: timestamp, interval, capability, then the elements. */
export function beaconBody(elementsHex: string, opts: { privacy?: boolean } = {}): Buffer {
  const fixed = Buffer.alloc(12)
  fixed.writeUInt16LE(100, 8)
  fixed.writeUInt16LE(0x0001 | (opts.privacy ? 0x0010 : 0), 10)
  return Buffer.concat([fixed, hexBuffer(elementsHex)])
}

export interface DataSpec {
  /** QoS data (subtype 8) rather than plain data. */
  qos?: boolean
  toDs?: boolean
  fromDs?: boolean
  retry?: boolean
  a1: string
  a2: string
  a3: string
  payload?: Buffer
}

export function dataFrame(spec: DataSpec): Buffer {
  const fc1 = (spec.toDs ? 0x01 : 0) | (spec.fromDs ? 0x02 : 0) | (spec.retry ? 0x08 : 0)
  const header = [
    ((spec.qos ? 8 : 0) << 4) | (2 << 2),
    fc1,
    0,
    0,
    ...mac(spec.a1),
    ...mac(spec.a2),
    ...mac(spec.a3),
    0,
    0
  ]
  if (spec.qos) header.push(0, 0)
  return Buffer.concat([Buffer.from(header), spec.payload ?? Buffer.alloc(40, 0xab)])
}

/** A control frame: an ACK is frame control, duration and one address. */
export function ackFrame(receiver: string): Buffer {
  return Buffer.from([0xd4, 0, 0, 0, ...mac(receiver)])
}

export interface PcapRecordSpec {
  atMs: number
  data: Buffer
  /** Defaults to the data length; larger means the capture truncated the frame. */
  origLen?: number
}

export interface PcapSpec {
  linkType?: number
  littleEndian?: boolean
  nano?: boolean
  snaplen?: number
}

export function pcapFile(records: PcapRecordSpec[], spec: PcapSpec = {}): Buffer {
  const le = spec.littleEndian ?? true
  const nano = spec.nano ?? false
  const w32 = (b: Buffer, v: number, at: number): void =>
    le ? void b.writeUInt32LE(v >>> 0, at) : void b.writeUInt32BE(v >>> 0, at)
  const w16 = (b: Buffer, v: number, at: number): void =>
    le ? void b.writeUInt16LE(v, at) : void b.writeUInt16BE(v, at)
  const header = Buffer.alloc(24)
  w32(header, nano ? 0xa1b23c4d : 0xa1b2c3d4, 0)
  w16(header, 2, 4)
  w16(header, 4, 6)
  w32(header, spec.snaplen ?? 1024, 16)
  w32(header, spec.linkType ?? 127, 20)
  const parts: Buffer[] = [header]
  for (const r of records) {
    const head = Buffer.alloc(16)
    const seconds = Math.floor(r.atMs / 1000)
    const frac = Math.round((r.atMs - seconds * 1000) * (nano ? 1_000_000 : 1000))
    w32(head, seconds, 0)
    w32(head, frac, 4)
    w32(head, r.data.length, 8)
    w32(head, r.origLen ?? r.data.length, 12)
    parts.push(head, r.data)
  }
  return Buffer.concat(parts)
}
