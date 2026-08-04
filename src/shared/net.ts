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
    .reduce(
      (bits, octet) => bits + ((parseInt(octet, 10) & 0xff).toString(2).match(/1/g)?.length ?? 0),
      0
    )
}

/** True if the string is a valid IPv4 address (four octets 0–255). */
export function isValidIpv4(value: string): boolean {
  const parts = value.trim().split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/**
 * True for a link-local / APIPA address (169.254.0.0/16, RFC 3927). Every OS self-assigns one of
 * these when no DHCP server answers, so it means "this port gave me nothing" rather than a
 * working address — worth saying out loud instead of showing it like any other IP.
 */
export function isLinkLocalIpv4(value: string): boolean {
  return isValidIpv4(value) && value.trim().startsWith('169.254.')
}
