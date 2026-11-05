// Pure: which channels a listening session visits, and for how long each.
//
// One 20 MHz dwell per channel, not one per 80 MHz block: a receiver set to an 80 MHz channel
// only detects frames that start on its primary 20 MHz, so an access point on one of the block's
// other 20 MHz channels would never be heard. Beacons and the frames that start and end an
// association go out on the primary channel in 20 MHz anyway, so this misses nothing that is
// read — wide data frames are seen by pinning the radio to one access point's channel.

import { channelCentreMhz } from '../wifi-model'
import type { WifiBand } from '../../../shared/types'

/** One channel as the card reports it (`iw list`), with the flags that decide whether to visit. */
export interface PhyChannel {
  freqMhz: number
  /** Regulatory-disabled: the card will not tune to it. */
  disabled: boolean
}

/** Long enough for at least three beacon intervals (about 102 ms each). */
export const DWELL_MS = 400

/**
 * What to visit when `iw list` could not be read: the 2.4 GHz channels every regulatory domain
 * allows some of, then the 5 GHz channels of Europe and North America. A channel the card refuses
 * shows up as failed in the session's journal and is skipped, so a list that is too long costs a
 * few milliseconds, one that is too short costs coverage.
 */
export const FALLBACK_CHANNELS: PhyChannel[] = [
  ...[2412, 2417, 2422, 2427, 2432, 2437, 2442, 2447, 2452, 2457, 2462, 2467, 2472],
  ...[5180, 5200, 5220, 5240, 5260, 5280, 5300, 5320],
  ...[5500, 5520, 5540, 5560, 5580, 5600, 5620, 5640, 5660, 5680, 5700, 5720],
  ...[5745, 5765, 5785, 5805, 5825]
].map((freqMhz) => ({ freqMhz, disabled: false }))

/** The frequencies to visit, in order: enabled channels only, lowest first, each once. */
export function planHops(channels: PhyChannel[]): number[] {
  const freqs = new Set<number>()
  for (const c of channels) if (!c.disabled) freqs.add(c.freqMhz)
  return [...freqs].sort((a, b) => a - b)
}

/**
 * Where to hold the radio to see one access point properly: its primary channel, its width, and
 * the centre of the block it spreads over — the three numbers `iw set freq` wants. The centre is
 * the middle of the aligned block of 20 MHz channels the primary sits in (36–48 is the 80 MHz
 * block centred on 42, 100–128 the 160 MHz block centred on 114). 2.4 GHz is held at 20 MHz,
 * where "40 MHz" would also need to say which side of the primary the second half lies.
 */
export function pinTarget(
  channel: number,
  band: WifiBand,
  widthMhz: number | undefined
): { freqMhz: number; widthMhz: number; centreMhz: number } | undefined {
  const freqMhz = channelCentreMhz(channel, band)
  if (freqMhz === undefined) return undefined
  if (band === '2.4')
    return channel <= 14 ? { freqMhz, widthMhz: 20, centreMhz: freqMhz } : undefined
  if (band !== '5' || channel < 36 || channel > 177) return undefined
  const width = widthMhz === 40 || widthMhz === 80 || widthMhz === 160 ? widthMhz : 20
  if (width === 20) return { freqMhz, widthMhz: 20, centreMhz: freqMhz }
  // The aligned blocks run from channel 36, from 100 and from 149; each starts a new alignment.
  const base = channel >= 149 ? 149 : channel >= 100 ? 100 : 36
  const channelsIn = width / 20
  const first = base + Math.floor((channel - base) / 4 / channelsIn) * channelsIn * 4
  const centreChannel = first + (channelsIn - 1) * 2
  // Channel numbers are 5 MHz apart, so the centre is that many steps from the primary.
  return { freqMhz, widthMhz: width, centreMhz: freqMhz + 5 * (centreChannel - channel) }
}
