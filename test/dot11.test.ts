import { describe, expect, it } from 'vitest'
import { readBeacon } from '../src/main/capabilities/ie80211'
import { decodeFrame } from '../src/main/capabilities/monitor/dot11'
import type { PcapRecord } from '../src/main/capabilities/monitor/pcap'
import { FLAG_BAD_FCS, FLAG_FCS_AT_END } from '../src/main/capabilities/monitor/radiotap'
import { AP_24_BUSY, AP_5G_4X4, AP_6E_2X2 } from './fixtures/beacons'
import { ackFrame, beaconBody, dataFrame, hexBuffer, mgmtFrame, radiotap } from './fixtures/frames'

const AP = '1c:0b:8b:f0:2d:39'
const CLIENT = '3c:22:fb:12:34:56'
const RADIO = { flags: 0, freq: 5240, signal: -52 } as const

/** A record of one frame behind a radiotap header, as tcpdump on a monitor interface writes it. */
function record(mac: Buffer, rt = radiotap(RADIO), origLen?: number): PcapRecord {
  const data = Buffer.concat([rt, mac])
  return { atMs: 0, origLen: origLen ?? data.length, data }
}

const beacon = (elements: string, extra: Partial<Parameters<typeof mgmtFrame>[0]> = {}) =>
  mgmtFrame({ subtype: 8, bssid: AP, body: beaconBody(elements), ...extra })

describe('decodeFrame: beacons', () => {
  it.each([
    ['2.4 GHz, busy', AP_24_BUSY],
    ['5 GHz, 4x4', AP_5G_4X4],
    ['5 GHz, 2x2', AP_6E_2X2]
  ])('reads the same facts as the OS path does from the real beacon (%s)', (_name, elements) => {
    const frame = decodeFrame(record(beacon(elements)), 127)
    expect(frame?.body).toEqual({ kind: 'beacon', bssid: AP, facts: readBeacon(elements) })
    expect(frame).toMatchObject({ freqMhz: 5240, rssi: -52, retry: false })
  })

  it('reads a probe response the same way', () => {
    const frame = decodeFrame(
      record(mgmtFrame({ subtype: 5, bssid: AP, da: CLIENT, body: beaconBody(AP_24_BUSY) })),
      127
    )
    expect(frame?.body.kind).toBe('probe-response')
    expect((frame?.body as { facts: { ssid?: string } }).facts.ssid).toBe('tdc_nomap')
  })

  it('finds the elements four bytes later when the header carries HT Control', () => {
    const frame = decodeFrame(record(beacon(AP_6E_2X2, { htControl: true })), 127)
    expect(frame?.body).toMatchObject({ kind: 'beacon', facts: readBeacon(AP_6E_2X2) })
  })

  it('takes the privacy bit from the capability field: no RSN but the bit set is WEP', () => {
    const wep = mgmtFrame({
      subtype: 8,
      bssid: AP,
      body: beaconBody('00026869', { privacy: true })
    })
    const open = mgmtFrame({ subtype: 8, bssid: AP, body: beaconBody('00026869') })
    expect(
      (decodeFrame(record(wep), 127)?.body as { facts: { security?: string } }).facts.security
    ).toBe('WEP')
    expect(
      (decodeFrame(record(open), 127)?.body as { facts: { security?: string } }).facts.security
    ).toBeUndefined()
  })

  it('has no SSID for a hidden network, and still names its channel', () => {
    // A zero-length SSID element: readBeacon leaves the name unset, the sighting turns that into ''.
    const frame = decodeFrame(record(beacon('0000' + '030101')), 127)
    const facts = (frame?.body as { facts: { ssid?: string; primaryChannel?: number } }).facts
    expect(facts.ssid).toBeUndefined()
    expect(facts.primaryChannel).toBe(1)
  })

  it('keeps what a capture cut at the snaplen still holds', () => {
    // Cut in the middle of the third element: the SSID before it survives.
    const full = beacon(AP_6E_2X2)
    const cut = full.subarray(0, 24 + 12 + 40)
    const rt = radiotap(RADIO)
    const frame = decodeFrame(record(cut, rt, rt.length + full.length), 127)
    expect((frame?.body as { facts: { ssid?: string } }).facts.ssid).toBe('tardis_nomap')
  })
})

describe('decodeFrame: the check sequence', () => {
  // Four bytes that would read as an SSID element ("AB") if they were taken for elements.
  const fcs = hexBuffer('00024142')
  const ssid = (frame: ReturnType<typeof decodeFrame>): string | undefined =>
    (frame?.body as { facts: { ssid?: string } }).facts.ssid

  it('cuts it off when the radio says it is there', () => {
    const rt = radiotap({ ...RADIO, flags: FLAG_FCS_AT_END })
    const frame = decodeFrame(record(Buffer.concat([beacon(AP_6E_2X2), fcs]), rt), 127)
    expect(ssid(frame)).toBe('tardis_nomap')
  })

  it('does not cut when the radio does not say so', () => {
    const frame = decodeFrame(record(Buffer.concat([beacon(AP_6E_2X2), fcs])), 127)
    expect(ssid(frame)).toBe('AB')
  })

  it('does not cut four bytes off a capture that was itself cut short', () => {
    const rt = radiotap({ ...RADIO, flags: FLAG_FCS_AT_END })
    const data = Buffer.concat([beacon(AP_6E_2X2), fcs])
    const frame = decodeFrame(record(data, rt, rt.length + data.length + 300), 127)
    expect(ssid(frame)).toBe('AB')
  })

  it('drops a frame the radio marked as damaged', () => {
    const rt = radiotap({ ...RADIO, flags: FLAG_BAD_FCS })
    expect(decodeFrame(record(beacon(AP_6E_2X2), rt), 127)).toBeUndefined()
  })
})

describe('decodeFrame: the frames that end an association', () => {
  it.each([
    [12, 'deauth'],
    [10, 'disassoc']
  ] as const)('names the BSSID, not the sender, of subtype %i', (subtype, kind) => {
    // From the client to the AP: the BSSID field (address 3) is the AP either way.
    const frame = decodeFrame(
      record(mgmtFrame({ subtype, bssid: AP, da: AP, sa: CLIENT, body: Buffer.from([7, 0]) })),
      127
    )
    expect(frame?.body).toEqual({ kind, bssid: AP })
  })
})

describe('decodeFrame: frames whose parties are not kept', () => {
  it('reduces a data frame to its retry flag, with no address anywhere in the result', () => {
    const data = dataFrame({ qos: true, toDs: true, retry: true, a1: AP, a2: CLIENT, a3: AP })
    const frame = decodeFrame(record(data), 127)
    expect(frame).toMatchObject({ body: { kind: 'data' }, retry: true, freqMhz: 5240 })
    const text = JSON.stringify(frame)
    expect(text).not.toContain(CLIENT)
    expect(text).not.toContain('3c:22')
    expect(text).not.toContain(CLIENT.replaceAll(':', ''))
  })

  it('does not look at a four-address data frame any differently', () => {
    const data = dataFrame({ toDs: true, fromDs: true, a1: AP, a2: CLIENT, a3: AP })
    expect(decodeFrame(record(data), 127)?.body).toEqual({ kind: 'data' })
  })

  it('counts a probe request and an ACK as other, and keeps no address from them', () => {
    const probe = mgmtFrame({
      subtype: 4,
      bssid: 'ff:ff:ff:ff:ff:ff',
      sa: CLIENT,
      body: hexBuffer('0004636166e9')
    })
    const probed = decodeFrame(record(probe), 127)
    expect(probed?.body).toEqual({ kind: 'other' })
    expect(JSON.stringify(probed)).not.toContain('caf')
    expect(decodeFrame(record(ackFrame(CLIENT)), 127)?.body).toEqual({ kind: 'other' })
  })

  it('reports retry from the frame control of a management frame too', () => {
    expect(decodeFrame(record(beacon(AP_6E_2X2, { retry: true })), 127)?.retry).toBe(true)
  })
})

describe('decodeFrame: input it cannot place', () => {
  it('gives undefined for a frame of another protocol version, an empty frame, or a bad link type', () => {
    const odd = Buffer.from(beacon(AP_6E_2X2))
    odd[0] |= 0x01
    expect(decodeFrame(record(odd), 127)).toBeUndefined()
    expect(decodeFrame(record(Buffer.alloc(0)), 127)).toBeUndefined()
    expect(decodeFrame(record(beacon(AP_6E_2X2)), 1)).toBeUndefined()
  })

  it('treats a management frame shorter than its header as other', () => {
    const short = beacon(AP_6E_2X2).subarray(0, 20)
    expect(decodeFrame(record(short), 127)?.body).toEqual({ kind: 'other' })
  })

  it('reads a capture without radiotap, with no frequency or signal to report', () => {
    const mac = beacon(AP_6E_2X2)
    const frame = decodeFrame({ atMs: 0, origLen: mac.length, data: mac }, 105)
    expect(frame?.freqMhz).toBeUndefined()
    expect(frame?.rssi).toBeUndefined()
    expect(frame?.body.kind).toBe('beacon')
  })
})
