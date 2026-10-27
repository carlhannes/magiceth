import { describe, it, expect } from 'vitest'
import { parseInformHeader } from '../src/plugins/unifi-adopt/inform-relay'

// Header per the reverse-engineered inform protocol: TNBU, version, MAC, flags, IV, data
// version, payload length. DOCUMENTED FORMAT — a real inform captured from the Flex Mini through
// the relay belongs here (CONFIGURE-TEST.md).
function header(opts: { mac?: number[]; flags?: number; length?: number } = {}): Buffer {
  const b = Buffer.alloc(40)
  b.write('TNBU', 0, 'latin1')
  b.writeUInt32BE(0, 4)
  Buffer.from(opts.mac ?? [0x78, 0x45, 0x58, 0xa1, 0xb2, 0xc3]).copy(b, 8)
  b.writeUInt16BE(opts.flags ?? 0x0003, 14)
  b.writeUInt32BE(1, 32)
  b.writeUInt32BE(opts.length ?? 1234, 36)
  return b
}

describe('parseInformHeader', () => {
  it('reads the device MAC and the flags', () => {
    const h = parseInformHeader(Buffer.concat([header(), Buffer.alloc(16)]))
    expect(h).toEqual({
      version: 0,
      mac: '78:45:58:a1:b2:c3',
      flags: 3,
      encrypted: true,
      compressed: true,
      gcm: false,
      payloadLength: 1234
    })
  })

  it('tells AES-GCM from AES-CBC', () => {
    expect(parseInformHeader(header({ flags: 0x09 }))?.gcm).toBe(true)
  })

  it('is undefined for anything else', () => {
    expect(parseInformHeader(Buffer.from('hello'))).toBeUndefined()
    const wrong = header()
    wrong.write('UBNT', 0, 'latin1')
    expect(parseInformHeader(wrong)).toBeUndefined()
  })
})
