// Pure: the DHCP option 43 payload Ubiquiti devices read. Tested in test/option43.test.ts.
//
// Per Ubiquiti's Layer 3 adoption article: sub-option 1 is the controller's IPv4 address
// (`01 04 c0 a8 03 0a`), sub-option 2 is an inform URL in ASCII with its length in front
// (`02 1f http://192.168.3.10:8080/inform`). Both may be present. The device informs to
// `http://<ip>:8080/inform` for the first form, so the port is not negotiable.

export interface Option43Spec {
  ip?: string
  url?: string
}

export function buildOption43(spec: Option43Spec): Buffer {
  const parts: Buffer[] = []
  if (spec.ip) {
    const octets = spec.ip.split('.').map((o) => parseInt(o, 10))
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      throw new Error(`Not an IPv4 address: "${spec.ip}".`)
    }
    parts.push(Buffer.from([1, 4, ...octets]))
  }
  if (spec.url) {
    const text = Buffer.from(spec.url, 'ascii')
    if (text.length === 0 || text.length > 255)
      throw new Error('The inform URL must be 1–255 bytes.')
    parts.push(Buffer.from([2, text.length]), text)
  }
  if (parts.length === 0) throw new Error('Option 43 needs an address or a URL.')
  return Buffer.concat(parts)
}

/** `01:04:c0:a8:03:0a` — the form the host's DHCP spec takes. */
export function option43Hex(spec: Option43Spec): string {
  return [...buildOption43(spec)].map((b) => b.toString(16).padStart(2, '0')).join(':')
}
