import type { NetInfo, Profile } from '../../shared/types'

// Pure profile operations (no electron/fs) — tested in test/profiles.test.ts.

// "DHCP" always exists as a default profile.
export const DEFAULT_PROFILES: Profile[] = [{ id: 'dhcp', name: 'DHCP', mode: 'dhcp' }]

function isValid(p: unknown): p is Profile {
  if (typeof p !== 'object' || p === null) return false
  const o = p as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    (o.mode === 'dhcp' || o.mode === 'static')
  )
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
