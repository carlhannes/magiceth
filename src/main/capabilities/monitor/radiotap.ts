// Pure: the radiotap header that precedes every frame a monitor interface hands over. It carries
// what the radio knew about the reception — the frequency, the signal, whether a check sequence
// follows the frame — and its length, which is where the 802.11 frame begins.
//
// Only the first six fields are read (TSFT, flags, rate, channel, FHSS, signal). They are the ones
// this app uses, they always come first and always in the default namespace, and walking them
// needs nothing beyond their sizes and alignments. Later fields, and the second namespace that
// iwlwifi adds with one signal per antenna chain, are skipped over by the header's own length:
// the first signal is the combined one. Reading further (HE rates, for airtime) would mean
// walking the extended presence words and their namespaces properly — see docs/BACKLOG.md.

/** The frame ends in a four-byte check sequence. */
export const FLAG_FCS_AT_END = 0x10
/** The check sequence did not match: the frame is damaged. */
export const FLAG_BAD_FCS = 0x40

export interface Radiotap {
  /** Bytes to skip to reach the 802.11 frame. */
  length: number
  flags: number
  freqMhz?: number
  /** Signal in dBm; absent when the driver reports none or nonsense. */
  rssi?: number
}

// Presence bit → [alignment, size], for the six fields read. Alignment counts from the start of
// the radiotap header, not from the frame.
const FIELDS: [number, number][] = [
  [8, 8], // 0 TSFT
  [1, 1], // 1 flags
  [1, 1], // 2 rate
  [2, 4], // 3 channel: frequency, flags
  [2, 2], // 4 FHSS: hop set and pattern, aligned as a pair (the kernel's radiotap.c)
  [1, 1] // 5 antenna signal, dBm
]
const EXT_BIT = 0x80000000

export function parseRadiotap(buf: Buffer): Radiotap | undefined {
  if (buf.length < 8 || buf[0] !== 0) return undefined
  const length = buf.readUInt16LE(2)
  if (length < 8 || length > buf.length) return undefined

  const present = buf.readUInt32LE(4)
  // Extra presence words follow while bit 31 is set; the field data starts after the last one.
  let at = 8
  for (let word = present; word & EXT_BIT;) {
    if (at + 4 > length) return undefined
    word = buf.readUInt32LE(at)
    at += 4
  }

  const out: Radiotap = { length, flags: 0 }
  for (let bit = 0; bit < FIELDS.length; bit++) {
    if (!(present & (1 << bit))) continue
    const [align, size] = FIELDS[bit]
    at = Math.ceil(at / align) * align
    if (at + size > length) return undefined
    if (bit === 1) out.flags = buf[at]
    else if (bit === 3) out.freqMhz = buf.readUInt16LE(at)
    else if (bit === 5) {
      const dbm = buf.readInt8(at)
      // 0 and above are what drivers write for "unknown"; no receiver hears +0 dBm from a neighbour.
      if (dbm < 0) out.rssi = dbm
    }
    at += size
  }
  return out
}
