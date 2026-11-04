import { describe, expect, it } from 'vitest'
import {
  FLAG_BAD_FCS,
  FLAG_FCS_AT_END,
  parseRadiotap
} from '../src/main/capabilities/monitor/radiotap'
import { radiotap } from './fixtures/frames'

describe('parseRadiotap', () => {
  it('reads frequency, signal and flags', () => {
    const rt = parseRadiotap(
      radiotap({ flags: FLAG_FCS_AT_END, rate: 12, freq: 5180, signal: -57 })
    )
    expect(rt).toEqual({ length: 15, flags: FLAG_FCS_AT_END, freqMhz: 5180, rssi: -57 })
  })

  it('aligns the channel field to two bytes, counting from the header start', () => {
    // flags sit at offset 8, so the channel field is padded to 10: a parser that forgets the
    // padding reads 5180 from the wrong bytes.
    const buf = radiotap({ flags: 0, freq: 2437, signal: -40 })
    expect(buf.length).toBe(8 + 1 + 1 + 4 + 1)
    expect(parseRadiotap(buf)?.freqMhz).toBe(2437)
  })

  it('aligns the timestamp to eight bytes', () => {
    const rt = parseRadiotap(radiotap({ tsft: 123456789, flags: 0x10, freq: 2412, signal: -70 }))
    // 8 header + 8 timestamp + 1 flags + 1 pad + 4 channel + 1 signal
    expect(rt).toEqual({ length: 23, flags: 0x10, freqMhz: 2412, rssi: -70 })
  })

  it('skips an extended presence word and takes the first signal as the combined one', () => {
    const buf = radiotap({
      tsft: 1,
      flags: 0,
      freq: 5500,
      signal: -48,
      perChain: { signal: -61, antenna: 1 }
    })
    // The second namespace carries a per-chain signal; it must not replace the combined one.
    expect(parseRadiotap(buf)).toMatchObject({ freqMhz: 5500, rssi: -48, length: buf.length })
  })

  it('leaves a signal of zero or more unknown', () => {
    expect(parseRadiotap(radiotap({ freq: 2412, signal: 0 }))?.rssi).toBeUndefined()
  })

  it('reports the damaged-frame flag', () => {
    expect(parseRadiotap(radiotap({ flags: FLAG_BAD_FCS }))?.flags).toBe(FLAG_BAD_FCS)
  })

  it('returns undefined for anything that is not a whole radiotap header', () => {
    const ok = radiotap({ flags: 0, freq: 2412, signal: -50 })
    expect(parseRadiotap(Buffer.alloc(0))).toBeUndefined()
    expect(parseRadiotap(ok.subarray(0, 7))).toBeUndefined()
    expect(parseRadiotap(ok.subarray(0, ok.length - 1))).toBeUndefined() // length runs past the buffer
    const wrongVersion = Buffer.from(ok)
    wrongVersion[0] = 1
    expect(parseRadiotap(wrongVersion)).toBeUndefined()
    const tooShort = Buffer.from(ok)
    tooShort.writeUInt16LE(4, 2)
    expect(parseRadiotap(tooShort)).toBeUndefined()
  })

  it('returns undefined when a field the presence word promises does not fit', () => {
    const lying = Buffer.from(radiotap({ flags: 0 }))
    lying.writeUInt32LE(1 << 3, 4) // says "channel" but only one byte of data follows
    expect(parseRadiotap(lying)).toBeUndefined()
  })
})
