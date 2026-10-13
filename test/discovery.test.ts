import { describe, it, expect } from 'vitest'
import { parseDiscovery, PROBE_V1 } from '../src/plugins/unifi-adopt/discovery'

// Built from the field table in nmap's ubiquiti-discovery.nse. DOCUMENTED FORMAT — the Flex
// Mini's own broadcast, captured per CONFIGURE-TEST.md, belongs here as a hex constant.
function tlv(type: number, value: Buffer | string): Buffer {
  const v = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  const len = Buffer.alloc(2)
  len.writeUInt16BE(v.length)
  return Buffer.concat([Buffer.from([type]), len, v])
}

function packet(version: number, command: number, body: Buffer): Buffer {
  const len = Buffer.alloc(2)
  len.writeUInt16BE(body.length)
  return Buffer.concat([Buffer.from([version, command]), len, body])
}

const MAC = Buffer.from([0x78, 0x45, 0x58, 0xa1, 0xb2, 0xc3])
const IP = Buffer.from([10, 254, 254, 10])

describe('parseDiscovery', () => {
  it('reads a v1 reply', () => {
    const d = parseDiscovery(
      packet(
        1,
        0,
        Buffer.concat([
          tlv(0x02, Buffer.concat([MAC, IP])),
          tlv(0x03, 'USMINI.rtl838x.v2.0.0.1234'),
          tlv(0x0a, Buffer.from([0, 0, 0x0e, 0x10])),
          tlv(0x0b, 'UBNT'),
          tlv(0x0c, 'USMINI'),
          tlv(0x14, 'USW-Flex-Mini'),
          tlv(0x16, '2.0.0'),
          tlv(0x17, Buffer.from([0, 0, 0, 1])),
          tlv(0x18, Buffer.from([0, 0, 0, 0]))
        ])
      )
    )
    expect(d).toEqual({
      mac: '78:45:58:a1:b2:c3',
      ip: '10.254.254.10',
      firmware: 'USMINI.rtl838x.v2.0.0.1234',
      uptimeSec: 3600,
      hostname: 'UBNT',
      product: 'USMINI',
      model: 'USW-Flex-Mini',
      version: '2.0.0',
      isDefault: true,
      unknown: { '0x18': '00000000' }
    })
  })

  it('reads a v2 announcement with the one-byte default flag', () => {
    const d = parseDiscovery(
      packet(
        2,
        6,
        Buffer.concat([tlv(0x01, MAC), tlv(0x15, 'USW-Flex-Mini'), tlv(0x17, Buffer.from([0]))])
      )
    )
    expect(d?.mac).toBe('78:45:58:a1:b2:c3')
    expect(d?.model).toBe('USW-Flex-Mini')
    expect(d?.isDefault).toBe(false)
  })

  it('is undefined for other versions and for runts', () => {
    expect(parseDiscovery(packet(3, 0, tlv(0x0b, 'x')))).toBeUndefined()
    expect(parseDiscovery(Buffer.from([1, 0]))).toBeUndefined()
  })

  it('stops at a truncated TLV rather than reading past the end', () => {
    const p = packet(
      1,
      0,
      Buffer.concat([tlv(0x0b, 'UBNT'), Buffer.from([0x03, 0x00, 0x40, 0x41])])
    )
    expect(parseDiscovery(p)?.hostname).toBe('UBNT')
  })

  it('is the probe nmap sends', () => {
    expect(PROBE_V1).toEqual(Buffer.from([1, 0, 0, 0]))
  })
})
