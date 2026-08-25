// Pure adapter-list logic, shared by main (which sorts what it enumerates) and the renderer (which
// decides what to select). Lives in shared/ for the same reason validateProfileDraft does: the
// renderer must never import from main/, and both halves want the same rules.

import type { Adapter, AdapterKind } from './types'

// USB dongles are what the tool is for, so they come first however many built-in ports a machine
// has. Wired built-ins outrank Wi-Fi because a technician at a rack is far likelier to be testing
// one. Within a group, device name keeps the order stable between polls.
const KIND_ORDER: Record<AdapterKind, number> = { usb: 0, ethernet: 1, wifi: 2 }

/** Dongles first, then built-in wired, then Wi-Fi; stable by device name inside each group. */
export function sortAdapters(list: Adapter[]): Adapter[] {
  return [...list].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.device.localeCompare(b.device)
  )
}

/**
 * Which entry to select after the list changes. A dongle that was not there a moment ago wins:
 * the list is never empty now that built-ins are in it, so without this rule plugging a dongle
 * into a machine already showing Wi-Fi would change nothing on screen — and "plug it in and it
 * just shows up" is the whole interaction. Otherwise the current selection is kept.
 */
export function pickSelected(previous: Adapter[], next: Adapter[], currentDevice?: string): number {
  const before = new Set(previous.map((a) => a.device))
  const arrived = next.findIndex((a) => a.kind === 'usb' && !before.has(a.device))
  if (arrived >= 0) return arrived
  const kept = next.findIndex((a) => a.device === currentDevice)
  return kept >= 0 ? kept : 0
}
