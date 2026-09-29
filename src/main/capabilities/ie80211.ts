// 802.11 information elements: the TLV chain carried in every beacon.
//
// This is where the interesting half of a Wi-Fi scan lives. CoreWLAN hands back the raw bytes and
// decodes almost nothing, so channel utilization, client count, spatial streams, the real PHY
// generation and the security suite all have to be read out of here.
//
// Everything is pure and takes bytes in, typed values out — no radio needed to test it. Every
// length is checked before it is indexed: this is input off the air, from equipment nobody here
// controls, and a malformed element must produce "unknown" rather than a crash.

/** One element. `ext` is the extension id for id 255, where the real type lives in the first body byte. */
export interface InfoElement {
  id: number
  ext?: number
  body: Uint8Array
}

// Element ids worth naming.
const ID_SSID = 0
const ID_BSS_LOAD = 11
const ID_HT_CAPABILITIES = 45
const ID_RSN = 48
const ID_VHT_CAPABILITIES = 191
const ID_VENDOR = 221
const ID_EXTENSION = 255
const EXT_HE_CAPABILITIES = 35
const EXT_EHT_CAPABILITIES = 108

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : hex.slice(0, -1)
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) return out.slice(0, i)
    out[i] = byte
  }
  return out
}

/**
 * Walk the TLV chain. Stops at the first element whose declared length runs past the buffer, which
 * is the only sane response to a truncated capture — the remainder cannot be located.
 */
export function parseElements(hex: string): InfoElement[] {
  const b = hexToBytes(hex)
  const out: InfoElement[] = []
  let i = 0
  while (i + 2 <= b.length) {
    const id = b[i]
    const len = b[i + 1]
    const start = i + 2
    if (start + len > b.length) break
    const body = b.subarray(start, start + len)
    out.push(id === ID_EXTENSION && len >= 1 ? { id, ext: body[0], body } : { id, body })
    i = start + len
  }
  return out
}

/**
 * The BSS Load (QBSS) element: how busy the AP says its channel is, and how many stations it is
 * serving. This is where a scanner's "Channel Utilization" and "Clients" columns come from — the
 * AP advertises both, so neither needs monitor mode.
 */
export function parseBssLoad(
  body: Uint8Array
): { clients: number; utilizationPct: number } | undefined {
  if (body.length < 5) return undefined
  return {
    clients: body[0] | (body[1] << 8),
    // One byte scaled 0–255, which is the wire format. Percent is what a human reads.
    utilizationPct: Math.round((body[2] / 255) * 100)
  }
}

/**
 * Spatial streams from the HT Supported MCS Set: one byte per stream, non-zero when that stream
 * carries rates. Four bytes in means a 4x4 radio.
 */
export function htStreams(body: Uint8Array): number | undefined {
  if (body.length < 19) return undefined
  let streams = 0
  for (let i = 0; i < 4; i++) if (body[3 + i] !== 0) streams++
  return streams || undefined
}

/**
 * Spatial streams from the VHT Rx MCS Map: two bits per stream, where the value 3 means the stream
 * is not supported.
 */
export function vhtStreams(body: Uint8Array): number | undefined {
  if (body.length < 12) return undefined
  const map = body[4] | (body[5] << 8)
  let streams = 0
  for (let i = 0; i < 8; i++) if (((map >> (2 * i)) & 3) !== 3) streams++
  return streams || undefined
}

// AKM suite selectors under the 00-0F-AC OUI. The AKM list is what actually distinguishes WPA2
// from WPA3 — the cipher suites do not.
const AKM_PSK = 2
const AKM_FT_PSK = 4
const AKM_PSK_SHA256 = 6
const AKM_SAE = 8
const AKM_FT_SAE = 9
const AKM_OWE = 18
const AKM_ENTERPRISE = new Set([1, 3, 5, 11, 12, 13])

/**
 * Read the AKM selectors out of an RSN element and name the result the way a technician would.
 * A network offering both PSK and SAE is a WPA2/WPA3 transition network, which is worth saying
 * out loud because it explains why an old client still associates.
 */
export function parseRsn(body: Uint8Array): string | undefined {
  // version(2) groupCipher(4) pairwiseCount(2) … then the AKM count and list.
  if (body.length < 8) return undefined
  const pairwiseCount = body[6] | (body[7] << 8)
  const akmCountAt = 8 + pairwiseCount * 4
  if (akmCountAt + 2 > body.length) return undefined
  const akmCount = body[akmCountAt] | (body[akmCountAt + 1] << 8)
  const types: number[] = []
  for (let i = 0; i < akmCount; i++) {
    const at = akmCountAt + 2 + i * 4
    if (at + 4 > body.length) break
    types.push(body[at + 3])
  }
  if (types.length === 0) return undefined

  const sae = types.includes(AKM_SAE) || types.includes(AKM_FT_SAE)
  const psk =
    types.includes(AKM_PSK) || types.includes(AKM_FT_PSK) || types.includes(AKM_PSK_SHA256)
  const enterprise = types.some((t) => AKM_ENTERPRISE.has(t))
  if (types.includes(AKM_OWE)) return 'Enhanced Open (OWE)'
  if (sae && psk) return 'WPA2/WPA3-Personal'
  if (sae) return 'WPA3-Personal'
  if (enterprise) return 'WPA2/WPA3-Enterprise'
  if (psk) return 'WPA2-Personal'
  return 'WPA2'
}

/**
 * WPS carries the only self-declared model name an AP ever broadcasts. Plenty of gear does not
 * send it at all — Ubiquiti does not — so an absent model is normal and must never be guessed.
 */
export function parseWps(body: Uint8Array): { manufacturer?: string; model?: string } {
  const out: { manufacturer?: string; model?: string } = {}
  let i = 4 // past the 00:50:F2:04 OUI + type
  while (i + 4 <= body.length) {
    const type = (body[i] << 8) | body[i + 1]
    const len = (body[i + 2] << 8) | body[i + 3]
    if (i + 4 + len > body.length) break
    const text = new TextDecoder().decode(body.subarray(i + 4, i + 4 + len)).replace(/\0+$/, '')
    if (type === 0x1021 && text) out.manufacturer = text
    if (type === 0x1023 && text) out.model = text
    i += 4 + len
  }
  return out
}

export interface BeaconFacts {
  ssid?: string
  phy?: string
  streams?: number
  clients?: number
  utilizationPct?: number
  security?: string
  manufacturer?: string
  model?: string
  /** Vendor OUIs seen in element 221, lowercase hex without separators, e.g. `00156d` for Ubiquiti. */
  vendorOuis: string[]
}

/**
 * Everything worth knowing from one beacon, in one pass.
 *
 * The PHY generation is decided by which capability element is present rather than by any field
 * claiming a mode: an AP that carries EHT capabilities is Wi-Fi 7 whatever else it says.
 */
export function readBeacon(hex: string): BeaconFacts {
  const facts: BeaconFacts = { vendorOuis: [] }
  let ht: number | undefined
  let vht: number | undefined
  let hasHt = false
  let hasVht = false
  let hasHe = false
  let hasEht = false

  for (const el of parseElements(hex)) {
    switch (el.id) {
      case ID_SSID:
        if (el.body.length > 0) {
          facts.ssid = new TextDecoder().decode(el.body).replace(/\0+$/, '')
        }
        break
      case ID_BSS_LOAD: {
        const load = parseBssLoad(el.body)
        if (load) {
          facts.clients = load.clients
          facts.utilizationPct = load.utilizationPct
        }
        break
      }
      case ID_HT_CAPABILITIES:
        hasHt = true
        ht = htStreams(el.body)
        break
      case ID_VHT_CAPABILITIES:
        hasVht = true
        vht = vhtStreams(el.body)
        break
      case ID_RSN:
        facts.security = parseRsn(el.body)
        break
      case ID_EXTENSION:
        if (el.ext === EXT_HE_CAPABILITIES) hasHe = true
        if (el.ext === EXT_EHT_CAPABILITIES) hasEht = true
        break
      case ID_VENDOR: {
        if (el.body.length < 4) break
        const oui = [...el.body.subarray(0, 3)].map((x) => x.toString(16).padStart(2, '0')).join('')
        if (!facts.vendorOuis.includes(oui)) facts.vendorOuis.push(oui)
        // 00:50:F2 type 04 is WPS.
        if (oui === '0050f2' && el.body[3] === 0x04) {
          const wps = parseWps(el.body)
          if (wps.manufacturer) facts.manufacturer = wps.manufacturer
          if (wps.model) facts.model = wps.model
        }
        break
      }
      default:
        break
    }
  }

  facts.phy = hasEht
    ? '802.11be'
    : hasHe
      ? '802.11ax'
      : hasVht
        ? '802.11ac'
        : hasHt
          ? '802.11n'
          : undefined
  // Prefer the VHT count: it describes the 5/6 GHz radio, where HT is often reported for the
  // 2.4 GHz chain of the same AP.
  facts.streams = vht ?? ht
  return facts
}
