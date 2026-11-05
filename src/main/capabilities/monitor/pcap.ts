// Pure: a pcap byte stream to records, fed in whatever pieces a growing file gives.
//
// The capture is a file that tcpdump appends to while the app reads what has arrived since last
// time, so a read can end in the middle of a record. The reader keeps that tail and finishes the
// record when the rest arrives; feeding a file in one piece or a byte at a time gives the same
// records (tested). Only classic pcap is spoken — tcpdump writes it, and a file in any other
// format is refused rather than guessed at.

export const LINKTYPE_IEEE802_11 = 105
export const LINKTYPE_IEEE802_11_RADIOTAP = 127

const GLOBAL_HEADER = 24
const RECORD_HEADER = 16
/** What a snaplen of zero ("whatever the writer felt like") is held to. */
const FALLBACK_SNAPLEN = 262_144

export interface PcapRecord {
  /** Capture time, milliseconds since the epoch. */
  atMs: number
  /** Length on the air; `data` is shorter when the capture truncated the frame. */
  origLen: number
  data: Buffer
}

export interface PcapReader {
  /** Bytes received but not yet part of a whole record. */
  pending: Buffer
  /** Known once the 24-byte file header has arrived. */
  format?: { littleEndian: boolean; nano: boolean; snaplen: number; linkType: number }
  /** Set once, and final: a reader that hit corrupt or unsupported input yields nothing more. */
  error?: string
}

export function createPcapReader(): PcapReader {
  return { pending: Buffer.alloc(0) }
}

/** The four magic bytes read little-endian, to the byte order and time unit they announce. */
function readMagic(magic: number): { littleEndian: boolean; nano: boolean } | undefined {
  switch (magic) {
    case 0xa1b2c3d4:
      return { littleEndian: true, nano: false }
    case 0xa1b23c4d:
      return { littleEndian: true, nano: true }
    case 0xd4c3b2a1:
      return { littleEndian: false, nano: false }
    case 0x4d3cb2a1:
      return { littleEndian: false, nano: true }
    default:
      return undefined
  }
}

function fail(reader: PcapReader, message: string): PcapRecord[] {
  reader.error = message
  reader.pending = Buffer.alloc(0)
  return []
}

/** Take the next chunk of the file and return every record it completed. Never throws. */
export function feedPcap(reader: PcapReader, chunk: Buffer): PcapRecord[] {
  if (reader.error) return []
  let buf = reader.pending.length > 0 ? Buffer.concat([reader.pending, chunk]) : chunk
  let at = 0

  if (!reader.format) {
    if (buf.length < GLOBAL_HEADER) {
      reader.pending = Buffer.from(buf)
      return []
    }
    const magic = readMagic(buf.readUInt32LE(0))
    if (!magic) {
      // 0a0d0d0a is a pcapng section header; anything else is simply not a capture.
      return fail(
        reader,
        buf.readUInt32LE(0) === 0x0a0d0d0a
          ? 'pcapng is not supported — tcpdump writes classic pcap'
          : 'not a pcap file'
      )
    }
    const u32 = (o: number): number =>
      magic.littleEndian ? buf.readUInt32LE(o) : buf.readUInt32BE(o)
    const linkType = u32(20)
    if (linkType !== LINKTYPE_IEEE802_11 && linkType !== LINKTYPE_IEEE802_11_RADIOTAP) {
      return fail(reader, `link type ${linkType} is not 802.11`)
    }
    reader.format = { ...magic, snaplen: u32(16) || FALLBACK_SNAPLEN, linkType }
    at = GLOBAL_HEADER
  }

  const { littleEndian, nano, snaplen } = reader.format
  const u32 = (o: number): number => (littleEndian ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  const records: PcapRecord[] = []

  while (buf.length - at >= RECORD_HEADER) {
    const inclLen = u32(at + 8)
    // A record longer than the snaplen the file promised means the stream has lost its place.
    // Reading on would turn every later byte into a bogus length, so stop for good.
    if (inclLen > snaplen) {
      // What came before it in this chunk was read in full and is kept.
      fail(reader, `record of ${inclLen} bytes exceeds the snaplen of ${snaplen}`)
      return records
    }
    if (buf.length - at - RECORD_HEADER < inclLen) break
    const seconds = u32(at)
    const fraction = u32(at + 4)
    records.push({
      atMs: seconds * 1000 + fraction / (nano ? 1_000_000 : 1000),
      origLen: u32(at + 12),
      data: buf.subarray(at + RECORD_HEADER, at + RECORD_HEADER + inclLen)
    })
    at += RECORD_HEADER + inclLen
  }

  // Copy the tail so the (possibly large) chunk it came from can be released.
  buf = buf.subarray(at)
  reader.pending = Buffer.from(buf)
  return records
}
