// Pure net helpers (shared by several platforms — DRY). Tested in test/net.test.ts.

/** Prefix length (23) -> dotted netmask ("255.255.254.0"). */
export function cidrToDotted(prefix: number): string {
  const mask = prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return [(mask >>> 24) & 0xff, (mask >>> 16) & 0xff, (mask >>> 8) & 0xff, mask & 0xff].join('.')
}

/** Dotted netmask ("255.255.254.0") -> prefix length (23). */
export function dottedToCidr(mask: string): number {
  return mask
    .split('.')
    .reduce((bits, octet) => bits + ((parseInt(octet, 10) & 0xff).toString(2).match(/1/g)?.length ?? 0), 0)
}

/** True if the string is a valid IPv4 address (four octets 0–255). */
export function isValidIpv4(value: string): boolean {
  const parts = value.trim().split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}
