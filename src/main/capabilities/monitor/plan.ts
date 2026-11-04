// Pure: which channels a listening session visits, and for how long each.
//
// One 20 MHz dwell per channel, not one per 80 MHz block: a receiver set to an 80 MHz channel
// only detects frames that start on its primary 20 MHz, so an access point on one of the block's
// other 20 MHz channels would never be heard. Beacons and the frames that start and end an
// association go out on the primary channel in 20 MHz anyway, so this misses nothing that is
// read — wide data frames are seen by pinning the radio to one access point's channel.

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
