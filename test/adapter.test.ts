import { describe, it, expect } from 'vitest'
import { sortAdapters, pickSelected } from '../src/shared/adapter'
import type { Adapter, AdapterKind } from '../src/shared/types'

function adapter(device: string, kind: AdapterKind): Adapter {
  return { device, portName: device, mac: '00:11:22:33:44:55', kind, known: kind === 'usb' }
}

describe('sortAdapters', () => {
  it('puts dongles first, then wired built-ins, then Wi-Fi', () => {
    const sorted = sortAdapters([
      adapter('en0', 'wifi'),
      adapter('en1', 'ethernet'),
      adapter('en9', 'usb')
    ])
    expect(sorted.map((a) => a.device)).toEqual(['en9', 'en1', 'en0'])
  })

  it('keeps a stable order inside a group, so the list does not shuffle between polls', () => {
    const sorted = sortAdapters([adapter('en9', 'usb'), adapter('en7', 'usb')])
    expect(sorted.map((a) => a.device)).toEqual(['en7', 'en9'])
  })

  it('leaves the input untouched', () => {
    const input = [adapter('en0', 'wifi'), adapter('en9', 'usb')]
    sortAdapters(input)
    expect(input.map((a) => a.device)).toEqual(['en0', 'en9'])
  })
})

describe('pickSelected', () => {
  const wifi = adapter('en0', 'wifi')
  const dongle = adapter('en9', 'usb')

  it('jumps to a dongle that has just been plugged in', () => {
    // The list is never empty now that built-ins are in it, so without this the screen would not
    // move when you plug something in — which is the whole interaction the tool is built around.
    expect(pickSelected([wifi], [dongle, wifi], 'en0')).toBe(0)
  })

  it('keeps the current selection when nothing arrived', () => {
    expect(pickSelected([dongle, wifi], [dongle, wifi], 'en0')).toBe(1)
  })

  it('does not jump for a built-in that appears', () => {
    // A Thunderbolt dock coming up should not steal focus from the port being worked on.
    const eth = adapter('en5', 'ethernet')
    expect(pickSelected([wifi], [eth, wifi], 'en0')).toBe(1)
  })

  it('falls back to the first entry when the selected device is gone', () => {
    expect(pickSelected([dongle, wifi], [wifi], 'en9')).toBe(0)
  })

  it('does not re-select a dongle that was already there', () => {
    expect(pickSelected([dongle, wifi], [dongle, wifi], 'en0')).toBe(1)
  })

  it('handles a first run with no previous list', () => {
    expect(pickSelected([], [dongle, wifi], undefined)).toBe(0)
  })
})
