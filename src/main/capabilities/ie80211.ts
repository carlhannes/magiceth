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
const ID_COUNTRY = 7
const ID_BSS_LOAD = 11
const ID_HT_CAPABILITIES = 45
const ID_RSN = 48
const ID_HT_OPERATION = 61
const ID_VHT_CAPABILITIES = 191
const ID_VHT_OPERATION = 192
const ID_VENDOR = 221
const ID_EXTENSION = 255
const EXT_HE_CAPABILITIES = 35
const EXT_HE_OPERATION = 36
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

/** Which families of key management a network offers, however the OS reported them. */
export interface AkmFlags {
  sae: boolean
  psk: boolean
  enterprise: boolean
  owe: boolean
}

/**
 * Name a security suite the way a technician would. A network offering both PSK and SAE is a
 * WPA2/WPA3 transition network, which is worth saying out loud because it explains why an old
 * client still associates.
 *
 * One function for every source: the byte decoder below and the Linux `iw` text parser both end
 * up here, so the two can never disagree on what to call the same network.
 */
export function securityLabel(f: AkmFlags): string {
  if (f.owe) return 'Enhanced Open (OWE)'
  if (f.sae && f.psk) return 'WPA2/WPA3-Personal'
  if (f.sae) return 'WPA3-Personal'
  if (f.enterprise) return 'WPA2/WPA3-Enterprise'
  if (f.psk) return 'WPA2-Personal'
  return 'WPA2'
}

/** The PHY generation is the newest capability element present, whatever else the AP claims. */
export function phyLabel(f: {
  ht: boolean
  vht: boolean
  he: boolean
  eht: boolean
}): string | undefined {
  if (f.eht) return '802.11be'
  if (f.he) return '802.11ax'
  if (f.vht) return '802.11ac'
  if (f.ht) return '802.11n'
  return undefined
}

/** Read the AKM selectors out of an RSN element and name the result. */
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

  return securityLabel({
    sae: types.includes(AKM_SAE) || types.includes(AKM_FT_SAE),
    psk: types.includes(AKM_PSK) || types.includes(AKM_FT_PSK) || types.includes(AKM_PSK_SHA256),
    enterprise: types.some((t) => AKM_ENTERPRISE.has(t)),
    owe: types.includes(AKM_OWE)
  })
}

/**
 * Channel width from the HT Operation element: a secondary channel on either side means the BSS
 * is 40 MHz wide. Anything wider is described by the VHT or HE Operation element instead.
 */
export function parseHtOperation(
  body: Uint8Array
): { primary: number; widthMhz: 20 | 40 } | undefined {
  if (body.length < 2) return undefined
  const secondary = body[1] & 0x03
  return { primary: body[0], widthMhz: secondary === 1 || secondary === 3 ? 40 : 20 }
}

/**
 * Width from the VHT Operation fields. The newer encoding reuses width 1 for 80, 160 and 80+80
 * and tells them apart by the two centre-frequency segments: eight channels apart is one 160 MHz
 * block, sixteen is 80+80. The old values 2 and 3 are still broadcast by older gear.
 *
 * Shared with the Linux `iw` parser, which prints the same three numbers but labels width 1 as
 * "(80 MHz)" whatever the segments say — so the label is ignored and the numbers are decoded here.
 * 80+80 counts as 160 because it occupies the same amount of spectrum and is practically unseen.
 */
export function vhtWidth(width: number, ccfs0: number, ccfs1: number): number | undefined {
  if (width === 2 || width === 3) return 160
  if (width !== 1) return undefined
  return ccfs1 !== 0 && Math.abs(ccfs1 - ccfs0) >= 8 ? 160 : 80
}

export function parseVhtOperation(body: Uint8Array): { widthMhz?: number } | undefined {
  if (body.length < 3) return undefined
  return { widthMhz: vhtWidth(body[0], body[1], body[2]) }
}

/**
 * The 6 GHz band has no HT or VHT Operation elements; its width is carried in the HE Operation
 * element's optional 6 GHz Operation Information, which only exists when bit 17 of the parameters
 * says so. The body still starts with the extension id, as parseElements leaves it.
 */
export function parseHeOperation(body: Uint8Array): { widthMhz?: number } | undefined {
  // ext id (1) + parameters (3) + BSS colour (1) + basic MCS/NSS set (2)
  if (body.length < 7) return undefined
  const params = body[1] | (body[2] << 8) | (body[3] << 16)
  let at = 7
  if (params & (1 << 14)) at += 3 // VHT Operation Information present
  if (params & (1 << 15)) at += 1 // Max Co-Hosted BSSID Indicator present
  if (!(params & (1 << 17))) return {}
  if (at + 5 > body.length) return undefined
  const width = body[at + 1] & 0x03
  return { widthMhz: width === 0 ? 20 : width === 1 ? 40 : width === 2 ? 80 : 160 }
}

/** The two-letter country in a Country element; the third byte is the environment, not a letter. */
export function parseCountry(body: Uint8Array): string | undefined {
  if (body.length < 2) return undefined
  const code = String.fromCharCode(body[0], body[1])
  return /^[A-Z]{2}$/.test(code) ? code : undefined
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
  /** From the operation elements — the only source of width an OS that reports none has. */
  widthMhz?: number
  clients?: number
  utilizationPct?: number
  security?: string
  manufacturer?: string
  model?: string
  countryCode?: string
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
  let hasWpa = false
  let rsn: string | undefined
  let htWidth: number | undefined
  let vhtOpWidth: number | undefined
  let heWidth: number | undefined

  for (const el of parseElements(hex)) {
    switch (el.id) {
      case ID_SSID:
        if (el.body.length > 0) {
          facts.ssid = new TextDecoder().decode(el.body).replace(/\0+$/, '')
        }
        break
      case ID_COUNTRY:
        facts.countryCode = parseCountry(el.body)
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
        rsn = parseRsn(el.body)
        break
      case ID_HT_OPERATION:
        htWidth = parseHtOperation(el.body)?.widthMhz
        break
      case ID_VHT_OPERATION:
        vhtOpWidth = parseVhtOperation(el.body)?.widthMhz
        break
      case ID_EXTENSION:
        if (el.ext === EXT_HE_CAPABILITIES) hasHe = true
        if (el.ext === EXT_EHT_CAPABILITIES) hasEht = true
        if (el.ext === EXT_HE_OPERATION) heWidth = parseHeOperation(el.body)?.widthMhz
        break
      case ID_VENDOR: {
        if (el.body.length < 4) break
        const oui = [...el.body.subarray(0, 3)].map((x) => x.toString(16).padStart(2, '0')).join('')
        if (!facts.vendorOuis.includes(oui)) facts.vendorOuis.push(oui)
        // 00:50:F2 type 04 is WPS; type 01 is the original WPA element, pre-RSN.
        if (oui === '0050f2' && el.body[3] === 0x04) {
          const wps = parseWps(el.body)
          if (wps.manufacturer) facts.manufacturer = wps.manufacturer
          if (wps.model) facts.model = wps.model
        }
        if (oui === '0050f2' && el.body[3] === 0x01) hasWpa = true
        break
      }
      default:
        break
    }
  }

  facts.phy = phyLabel({ ht: hasHt, vht: hasVht, he: hasHe, eht: hasEht })
  // Prefer the VHT count: it describes the 5/6 GHz radio, where HT is often reported for the
  // 2.4 GHz chain of the same AP.
  facts.streams = vht ?? ht
  // RSN is authoritative; an AP still sending only the old WPA element is WPA1, and one sending
  // neither is open (or WEP, which the elements alone cannot tell apart from open).
  facts.security = rsn ?? (hasWpa ? 'WPA' : undefined)
  // Widest claim wins: 6 GHz has only the HE element, 5 GHz gets VHT over HT, 2.4 GHz has HT alone.
  facts.widthMhz = heWidth ?? vhtOpWidth ?? htWidth
  return facts
}
