import { getPlatform } from '../platform'
import chipsetsRaw from '../../../resources/chipsets.json'
import type { Adapter, AdapterKind, ChipsetInfo } from '../../shared/types'

interface ChipsetDb {
  vendors: Record<string, string>
  chipsets: Record<string, ChipsetInfo>
}

// chipsets.json is the single source of truth for identification. Bundled in at build time.
const db = chipsetsRaw as unknown as ChipsetDb

/** Look up a chipset in the database; falls back to a known vendor if the exact chipset is missing. */
export function resolveChipset(
  vendorId?: string,
  productId?: string
): {
  chipset?: ChipsetInfo
  known: boolean
} {
  if (!vendorId || !productId) return { known: false }
  const exact = db.chipsets[`${vendorId}:${productId}`]
  if (exact) return { chipset: exact, known: true }
  const vendor = db.vendors[vendorId]
  if (vendor) {
    return {
      chipset: {
        vendor,
        chipset: 'Unknown chipset',
        maxSpeedMbps: 0,
        vlan: false,
        notes: 'Known vendor but unknown chipset — probably works anyway via the OS driver.'
      },
      known: false
    }
  }
  return { known: false }
}

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

/** List the ports worth diagnosing, dongles first, with chipset info resolved for the USB ones. */
export async function listAdapters(): Promise<Adapter[]> {
  const raw = await getPlatform().enumerateAdapters()
  return sortAdapters(
    raw.map((r) => {
      const { chipset, known } = resolveChipset(r.usb?.vendorId, r.usb?.productId)
      return {
        device: r.device,
        portName: r.portName,
        mac: r.mac,
        kind: r.kind,
        usb: r.usb,
        chipset,
        known
      }
    })
  )
}
