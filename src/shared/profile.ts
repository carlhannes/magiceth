import { normalizeMac } from './mac'
import { dottedToCidr, isValidIpv4 } from './net'
import type { Profile } from './types'

// Pure, shared profile validation. Lives in shared/ so that both the renderer (instant feedback
// in the form) and main can use it without crossing the main/renderer boundary. Tested in
// test/profile.test.ts.

// Raw string fields from the form (the renderer reads the DOM and passes them here).
export interface ProfileDraftInput {
  id?: string
  name: string
  mode: 'dhcp' | 'static'
  ip?: string
  cidr?: string // "24" or a netmask "255.255.255.0"
  gateway?: string
  dns?: string // comma-separated
  macOverride?: string
}

export type DraftResult = { ok: true; profile: Profile } | { ok: false; error: string }

/** Validate and normalize a form draft into a Profile. */
export function validateProfileDraft(input: ProfileDraftInput): DraftResult {
  const name = (input.name ?? '').trim()
  if (!name) return { ok: false, error: 'Name is required.' }

  let macOverride: string | undefined
  const macRaw = (input.macOverride ?? '').trim()
  if (macRaw) {
    try {
      macOverride = normalizeMac(macRaw)
    } catch {
      return { ok: false, error: 'Invalid MAC override.' }
    }
  }

  const base = { id: input.id || '', name }

  if (input.mode === 'dhcp') {
    return { ok: true, profile: { ...base, mode: 'dhcp', macOverride } }
  }

  // Static
  const ip = (input.ip ?? '').trim()
  if (!isValidIpv4(ip)) return { ok: false, error: 'Invalid IPv4 address.' }

  const cidrRaw = (input.cidr ?? '').trim()
  if (!cidrRaw) return { ok: false, error: 'Netmask or prefix is required.' }
  let cidr: number
  if (cidrRaw.includes('.')) {
    if (!isValidIpv4(cidrRaw)) return { ok: false, error: 'Invalid netmask.' }
    cidr = dottedToCidr(cidrRaw)
  } else {
    cidr = parseInt(cidrRaw, 10)
  }
  if (!Number.isInteger(cidr) || cidr < 1 || cidr > 32) {
    return { ok: false, error: 'Prefix must be 1–32 (or a valid netmask).' }
  }

  const gatewayRaw = (input.gateway ?? '').trim()
  if (gatewayRaw && !isValidIpv4(gatewayRaw)) return { ok: false, error: 'Invalid gateway.' }

  const dns = (input.dns ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (dns.some((d) => !isValidIpv4(d))) return { ok: false, error: 'Invalid DNS address.' }

  return {
    ok: true,
    profile: {
      ...base,
      mode: 'static',
      ip,
      cidr,
      gateway: gatewayRaw || undefined,
      dns: dns.length > 0 ? dns : undefined,
      macOverride
    }
  }
}
