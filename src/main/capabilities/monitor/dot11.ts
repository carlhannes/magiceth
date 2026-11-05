// Pure: one captured frame to the few facts this app keeps about it.
//
// What is read, and what is deliberately not: the radiotap header, the 802.11 frame control, and —
// for beacons, probe responses and the frames that end an association — the BSSID and the
// elements an access point advertises about itself. A data frame is reduced to "a data frame,
// retried or not, on this BSSID": the BSSID is the access point's own address and is read from the
// one field the DS bits name, so the client's address and the payload are never looked at, and
// nothing downstream can hold, show or save who was talking to whom. Per-device views, if they
// are ever built, extend this file and say so in docs/SECURITY.md.
//
// A frame the parser cannot place comes back `undefined`; input off the air is never trusted to
// be well-formed, and never makes this throw.

import { readBeacon, withPrivacyBit } from '../ie80211'
import type { BeaconFacts } from '../ie80211'
import { LINKTYPE_IEEE802_11, LINKTYPE_IEEE802_11_RADIOTAP } from './pcap'
import type { PcapRecord } from './pcap'
import { FLAG_BAD_FCS, FLAG_FCS_AT_END, parseRadiotap } from './radiotap'

const TYPE_MGMT = 0
const TYPE_DATA = 2

const SUBTYPE_PROBE_RESPONSE = 5
const SUBTYPE_BEACON = 8
const SUBTYPE_DISASSOC = 10
const SUBTYPE_DEAUTH = 12

/** Frame control (2) + duration (2) + three addresses (18) + sequence control (2). */
const MGMT_HEADER = 24
/** Beacons and probe responses: timestamp (8), beacon interval (2), capability (2), then elements. */
const BEACON_FIXED = 12
const CAPABILITY_PRIVACY = 0x0010
const FC_ORDER = 0x80
const FC_RETRY = 0x08
const FCS_LENGTH = 4

export type FrameBody =
  | {
      kind: 'beacon' | 'probe-response'
      bssid: string
      facts: BeaconFacts
      /** The capture cut the frame short, so its last elements are missing from `facts`. */
      truncated: boolean
    }
  | { kind: 'deauth' | 'disassoc'; bssid: string }
  /** `bssid` is absent for a four-address (WDS) frame, where the access point is not named. */
  | { kind: 'data'; bssid?: string }
  | { kind: 'other' }

export interface DecodedFrame {
  /** What the radio was tuned to; absent when the capture has no radiotap header. */
  freqMhz?: number
  rssi?: number
  retry: boolean
  /** Length on the air, in bytes. */
  bytes: number
  body: FrameBody
}

function macAt(buf: Buffer, at: number): string {
  let out = ''
  for (let i = 0; i < 6; i++) out += (i ? ':' : '') + buf[at + i].toString(16).padStart(2, '0')
  return out
}

const FC_TO_DS = 0x01
const FC_FROM_DS = 0x02
/** Where the three-address data header ends: the third address stops at byte 22. */
const DATA_ADDRESSES = 22

/**
 * The access point's address in a data frame: address 1 going to it, address 2 coming from it,
 * address 3 when neither (a peer-to-peer or ad-hoc frame). The other two fields hold the station
 * and are never read.
 */
function dataBssid(mac: Buffer, flags: number): string | undefined {
  if (mac.length < DATA_ADDRESSES) return undefined
  const toDs = (flags & FC_TO_DS) !== 0
  const fromDs = (flags & FC_FROM_DS) !== 0
  if (toDs && fromDs) return undefined
  return macAt(mac, toDs ? 4 : fromDs ? 10 : 16)
}

/** The 802.11 frame itself, with the check sequence cut off when there is one to cut. */
function decodeMac(
  mac: Buffer,
  meta: { freqMhz?: number; rssi?: number; bytes: number },
  truncated: boolean
): DecodedFrame | undefined {
  if (mac.length < 2 || (mac[0] & 0x03) !== 0) return undefined // not protocol version 0
  const type = (mac[0] >> 2) & 0x03
  const subtype = mac[0] >> 4
  const flags = mac[1]
  const out = (body: FrameBody): DecodedFrame => ({
    ...meta,
    retry: (flags & FC_RETRY) !== 0,
    body
  })

  if (type === TYPE_DATA) return out({ kind: 'data', bssid: dataBssid(mac, flags) })
  if (type !== TYPE_MGMT) return out({ kind: 'other' })

  // The order bit on a management frame adds a four-byte HT Control field to the header.
  const header = MGMT_HEADER + (flags & FC_ORDER ? 4 : 0)
  if (mac.length < header) return out({ kind: 'other' })
  const bssid = macAt(mac, 16)

  if (subtype === SUBTYPE_DEAUTH) return out({ kind: 'deauth', bssid })
  if (subtype === SUBTYPE_DISASSOC) return out({ kind: 'disassoc', bssid })
  if (subtype !== SUBTYPE_BEACON && subtype !== SUBTYPE_PROBE_RESPONSE)
    return out({ kind: 'other' })
  if (mac.length < header + BEACON_FIXED) return out({ kind: 'other' })

  const privacy = (mac.readUInt16LE(header + 10) & CAPABILITY_PRIVACY) !== 0
  // A capture cut at the snaplen ends mid-element; readBeacon keeps everything before the cut. The
  // Privacy bit means WEP only when no RSN element follows, and a cut frame cannot say that.
  const read = readBeacon(mac.subarray(header + BEACON_FIXED))
  const facts = truncated ? read : withPrivacyBit(read, privacy)
  const kind = subtype === SUBTYPE_BEACON ? 'beacon' : 'probe-response'
  return out({ kind, bssid, facts, truncated })
}

/**
 * One record to one frame. Frames the radio marked as damaged are dropped: a flipped bit in an
 * SSID or a channel number would otherwise become an access point that does not exist.
 */
export function decodeFrame(record: PcapRecord, linkType: number): DecodedFrame | undefined {
  const truncated = record.data.length < record.origLen
  if (linkType === LINKTYPE_IEEE802_11) {
    return decodeMac(record.data, { bytes: record.origLen }, truncated)
  }
  if (linkType !== LINKTYPE_IEEE802_11_RADIOTAP) return undefined

  const rt = parseRadiotap(record.data)
  if (!rt || rt.flags & FLAG_BAD_FCS) return undefined
  let mac = record.data.subarray(rt.length)
  // When the capture was cut short the last four bytes are frame, not check sequence.
  if (rt.flags & FLAG_FCS_AT_END && !truncated && mac.length >= FCS_LENGTH) {
    mac = mac.subarray(0, mac.length - FCS_LENGTH)
  }
  const meta = { freqMhz: rt.freqMhz, rssi: rt.rssi, bytes: record.origLen - rt.length }
  return decodeMac(mac, meta, truncated)
}
