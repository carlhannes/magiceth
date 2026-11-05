import { describe, expect, it } from 'vitest'
import { createPcapReader, feedPcap } from '../src/main/capabilities/monitor/pcap'
import type { PcapRecord } from '../src/main/capabilities/monitor/pcap'
import { pcapFile } from './fixtures/frames'

const FRAMES = [
  { atMs: 1_700_000_000_250, data: Buffer.from('first frame bytes') },
  { atMs: 1_700_000_001_500, data: Buffer.from('second'), origLen: 90 },
  { atMs: 1_700_000_002_000, data: Buffer.alloc(0) }
]

const plain = (records: PcapRecord[]): unknown =>
  records.map((r) => ({ atMs: r.atMs, origLen: r.origLen, data: [...r.data] }))

describe('feedPcap', () => {
  it.each([
    { littleEndian: true, nano: false },
    { littleEndian: true, nano: true },
    { littleEndian: false, nano: false },
    { littleEndian: false, nano: true }
  ])('reads a whole file: $littleEndian-endian, nanoseconds $nano', (variant) => {
    const reader = createPcapReader()
    const records = feedPcap(reader, pcapFile(FRAMES, variant))
    expect(reader.error).toBeUndefined()
    expect(reader.format?.linkType).toBe(127)
    expect(records).toHaveLength(3)
    expect(records[0].atMs).toBeCloseTo(1_700_000_000_250, 3)
    expect(records[1].origLen).toBe(90)
    expect(records[1].data.toString()).toBe('second')
    expect(records[2].data).toHaveLength(0)
  })

  it.each([1, 7, 1000])('gives the same records fed %i bytes at a time', (size) => {
    const file = pcapFile(FRAMES)
    const once = feedPcap(createPcapReader(), file)
    const reader = createPcapReader()
    const pieces: PcapRecord[] = []
    for (let at = 0; at < file.length; at += size) {
      pieces.push(...feedPcap(reader, file.subarray(at, at + size)))
    }
    expect(plain(pieces)).toEqual(plain(once))
    expect(reader.error).toBeUndefined()
  })

  it('waits for the rest of a header and of a record rather than failing', () => {
    const reader = createPcapReader()
    const file = pcapFile(FRAMES)
    expect(feedPcap(reader, file.subarray(0, 10))).toEqual([])
    expect(reader.error).toBeUndefined()
    // Into the middle of the first record's data: nothing yet.
    expect(feedPcap(reader, file.subarray(10, 24 + 16 + 5))).toEqual([])
    expect(feedPcap(reader, file.subarray(24 + 16 + 5)).length).toBe(3)
  })

  it('refuses pcapng by name', () => {
    const reader = createPcapReader()
    const section = Buffer.concat([Buffer.from('0a0d0d0a', 'hex'), Buffer.alloc(40)])
    expect(feedPcap(reader, section)).toEqual([])
    expect(reader.error).toMatch(/pcapng/)
  })

  it('refuses a file that is not a capture', () => {
    const reader = createPcapReader()
    expect(feedPcap(reader, Buffer.alloc(64, 0x41))).toEqual([])
    expect(reader.error).toMatch(/not a pcap/)
  })

  it('refuses a capture of anything but 802.11', () => {
    const reader = createPcapReader()
    expect(feedPcap(reader, pcapFile([], { linkType: 1 }))).toEqual([])
    expect(reader.error).toMatch(/link type 1/)
  })

  it('accepts plain 802.11 without radiotap', () => {
    const reader = createPcapReader()
    feedPcap(reader, pcapFile(FRAMES, { linkType: 105 }))
    expect(reader.format?.linkType).toBe(105)
  })

  it('stops for good at a record longer than the snaplen, keeping what came before it', () => {
    const good = pcapFile([FRAMES[0]], { snaplen: 64 })
    const bad = Buffer.alloc(16)
    bad.writeUInt32LE(5000, 8) // inclLen far past the snaplen
    const reader = createPcapReader()
    const records = feedPcap(reader, Buffer.concat([good, bad, Buffer.alloc(5000)]))
    expect(records.map((r) => r.data.toString())).toEqual(['first frame bytes'])
    expect(reader.error).toMatch(/snaplen/)
    expect(feedPcap(reader, good)).toEqual([])
  })
})
