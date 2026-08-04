import { normalizeMac } from '../../shared/mac'
import { isValidIpv4 } from '../../shared/net'
import type { NetInfo, Profile } from '../../shared/types'

// Pure profile operations (no electron/fs) — tested in test/profiles.test.ts.

// "DHCP" always exists as a default profile.
export const DEFAULT_PROFILES: Profile[] = [{ id: 'dhcp', name: 'DHCP', mode: 'dhcp' }]

/** An optional IPv4 field: absent is fine, present must be a valid address. */
function ipOk(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && isValidIpv4(value))
}

function macOk(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'string') return false
  try {
    normalizeMac(value)
    return true
  } catch {
    return false
  }
}

/**
 * Validate a stored profile. Optional fields are checked for *format when present*, never for
 * presence — so nothing this app writes can be rejected. Profiles that fail are dropped by
 * parseProfiles, which is the boundary that keeps a hand-edited profiles.json out of the elevated
 * command line built in platform/<os>.ts: macOS and Linux sh-quote these values, Windows netsh
 * takes them bare.
 */
function isValid(p: unknown): p is Profile {
  if (typeof p !== 'object' || p === null) return false
  const o = p as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return false
  if (o.mode !== 'dhcp' && o.mode !== 'static') return false
  if (!ipOk(o.ip) || !ipOk(o.gateway)) return false
  if (o.cidr !== undefined) {
    if (typeof o.cidr !== 'number' || !Number.isInteger(o.cidr) || o.cidr < 1 || o.cidr > 32) {
      return false
    }
  }
  if (o.dns !== undefined) {
    if (!Array.isArray(o.dns) || !o.dns.every((d) => typeof d === 'string' && isValidIpv4(d))) {
      return false
    }
  }
  return macOk(o.macOverride)
}

/** Parse and validate profiles from stored JSON. Ensure the DHCP default always exists. */
export function parseProfiles(json: string): Profile[] {
  let list: Profile[] = []
  try {
    const parsed: unknown = JSON.parse(json)
    if (Array.isArray(parsed)) list = parsed.filter(isValid)
  } catch {
    list = []
  }
  return ensureDefaults(list)
}

export function serializeProfiles(list: Profile[]): string {
  return JSON.stringify(list, null, 2)
}

/** Make sure default profiles exist (without duplicating). */
export function ensureDefaults(list: Profile[]): Profile[] {
  const result = [...list]
  for (const def of DEFAULT_PROFILES) {
    if (!result.some((p) => p.id === def.id)) result.unshift(def)
  }
  return result
}

/** Add or replace a profile (by id). */
export function upsertProfile(list: Profile[], profile: Profile): Profile[] {
  const idx = list.findIndex((p) => p.id === profile.id)
  if (idx >= 0) {
    const copy = [...list]
    copy[idx] = profile
    return copy
  }
  return [...list, profile]
}

/** Remove a profile (default profiles cannot be removed). */
export function removeProfile(list: Profile[], id: string): Profile[] {
  if (DEFAULT_PROFILES.some((d) => d.id === id)) return list
  return list.filter((p) => p.id !== id)
}

/** Build a static profile (bookmark) from the current netinfo. */
export function profileFromNetInfo(id: string, name: string, net: NetInfo): Profile {
  return {
    id,
    name,
    mode: 'static',
    ip: net.ipv4,
    cidr: net.cidr,
    gateway: net.gateway,
    dns: net.dnsServers.length > 0 ? [...net.dnsServers] : undefined
  }
}
