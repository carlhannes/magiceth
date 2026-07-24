// Pure MAC helpers. Used for display (M1) and MAC rolling (M4). Tested in test/mac.test.ts.

/** Normalize a MAC address from any common format to "aa:bb:cc:dd:ee:ff". */
export function normalizeMac(input: string): string {
  const hex = input.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  if (hex.length !== 12) throw new Error(`Invalid MAC address: ${input}`)
  return (hex.match(/.{2}/g) as string[]).join(':')
}

/**
 * Generate a random valid locally-administered unicast MAC.
 * First octet: clear bit 0 (unicast) and set bit 1 (locally administered).
 * `rand` is injected for testability.
 */
export function randomLocallyAdministeredMac(rand: () => number = Math.random): string {
  const bytes = Array.from({ length: 6 }, () => Math.floor(rand() * 256))
  bytes[0] = (bytes[0] & 0xfe) | 0x02
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':')
}

/** True if the MAC is locally administered (bit 1 set in the first octet). */
export function isLocallyAdministered(mac: string): boolean {
  const first = parseInt(normalizeMac(mac).slice(0, 2), 16)
  return (first & 0x02) === 0x02
}
