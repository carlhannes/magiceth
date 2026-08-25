import { getPlatform } from '../platform'
import chipsetsRaw from '../../../resources/chipsets.json'
import { sortAdapters } from '../../shared/adapter'
import type { Adapter, ChipsetInfo } from '../../shared/types'

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
