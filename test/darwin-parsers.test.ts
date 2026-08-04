import { describe, it, expect } from 'vitest'
import {
  parseHardwarePorts,
  parseIoregUsbMacs,
  joinDarwinAdapters
} from '../src/main/platform/darwin'

// Real output captured on macOS (Apple Silicon) with an ASIX AX88179A dongle plugged in.
const NETWORKSETUP = `
Hardware Port: Ethernet Adapter (en4)
Device: en4
Ethernet Address: 0e:30:9c:e7:25:0a

Hardware Port: AX88179A
Device: en9
Ethernet Address: 6c:6e:07:01:ff:de

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 84:2f:57:44:d6:4f

Hardware Port: Thunderbolt Bridge
Device: bridge0
Ethernet Address: 36:7b:bc:d7:59:c0
`

// Representative excerpt of `ioreg -r -c IOUSBHostDevice -l` (VIA hub without MAC + ASIX dongle).
const IOREG = `
+-o USB3.0 Hub@02200000  <class IOUSBHostDevice, id 0x100, registered, matched, active>
  |   "USB Vendor Name" = "VIA Labs, Inc."
  |   "USB Product Name" = "USB3.0 Hub"
  |   "idVendor" = 8457
  |   "idProduct" = 2071
  +-o AX88179A@02210000  <class IOUSBHostDevice, id 0x101, registered, matched, active>
    |   "USB Vendor Name" = "ASIX"
    |   "USB Product Name" = "AX88179A"
    |   "idVendor" = 2965
    |   "idProduct" = 6032
    +-o AppleUSBNCMData  <class AppleUSBNCMData, id 0x102, registered, matched, active>
      |   "idVendor" = 2965
      |   "idProduct" = 6032
      |   "IOMACAddress" = <6c6e0701ffde>
      +-o en9  <class IOEthernetInterface, id 0x103, registered, matched, active>
        |   "BSD Name" = "en9"
`

// Second capture, with an ASIX AX88179A on en9 and a Realtek RTL8153 on en7 cabled to each other.
const NETWORKSETUP_TWO_DONGLES = `
Hardware Port: AX88179A
Device: en9
Ethernet Address: 6c:6e:07:01:ff:de

Hardware Port: USB 10/100/1000 LAN
Device: en7
Ethernet Address: 00:e0:4c:be:53:2c

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 84:2f:57:44:d6:4f
`

// The Realtek reports IOMACAddress on both the data node and its ethernet-interface child, so the
// same dongle shows up twice; the ASIX reports it once. Trimmed to the lines the parser reads.
const IOREG_TWO_DONGLES = `
+-o AX88179A@02210000  <class IOUSBHostDevice, id 0x101, registered, matched, active>
  |   "USB Vendor Name" = "ASIX"
  |   "USB Product Name" = "AX88179A"
  |   "idVendor" = 2965
  |   "idProduct" = 6032
  +-o AppleUSBNCMData  <class AppleUSBNCMData, id 0x102, registered, matched, active>
    |   "idVendor" = 2965
    |   "idProduct" = 6032
    |   "IOMACAddress" = <6c6e0701ffde>
+-o USB 10/100/1000 LAN@02300000  <class IOUSBHostDevice, id 0x201, registered, matched, active>
  |   "USB Vendor Name" = "Realtek"
  |   "USB Product Name" = "USB 10/100/1000 LAN"
  |   "idVendor" = 3034
  |   "idProduct" = 33107
  +-o AppleUSBRTL8153  <class AppleUSBECMData, id 0x202, registered, matched, active>
    |   "idVendor" = 3034
    |   "idProduct" = 33107
    |   "IOMACAddress" = <00e04cbe532c>
    +-o en7  <class IOEthernetInterface, id 0x203, registered, matched, active>
      |   "IOMACAddress" = <00e04cbe532c>
      |   "BSD Name" = "en7"
`

describe('parseHardwarePorts', () => {
  it('parses port name, device and MAC', () => {
    const ports = parseHardwarePorts(NETWORKSETUP)
    const ax = ports.find((p) => p.device === 'en9')
    expect(ax).toEqual({ portName: 'AX88179A', device: 'en9', mac: '6c:6e:07:01:ff:de' })
    expect(ports.find((p) => p.device === 'en0')?.portName).toBe('Wi-Fi')
  })
})

describe('parseIoregUsbMacs', () => {
  it('emits only USB devices with MAC and correct VID/PID (hex)', () => {
    const entries = parseIoregUsbMacs(IOREG)
    expect(entries).toEqual([
      {
        mac: '6c:6e:07:01:ff:de',
        vendorId: '0b95',
        productId: '1790',
        vendorName: 'ASIX',
        productName: 'AX88179A'
      }
    ])
  })
})

describe('joinDarwinAdapters', () => {
  it('pairs USB device and hardware port via MAC', () => {
    const adapters = joinDarwinAdapters(parseHardwarePorts(NETWORKSETUP), parseIoregUsbMacs(IOREG))
    expect(adapters).toEqual([
      {
        device: 'en9',
        portName: 'AX88179A',
        mac: '6c:6e:07:01:ff:de',
        usb: {
          vendorId: '0b95',
          productId: '1790',
          vendorName: 'ASIX',
          productName: 'AX88179A'
        }
      }
    ])
  })

  it('returns no dongles when no USB MAC matches a port', () => {
    expect(joinDarwinAdapters(parseHardwarePorts(NETWORKSETUP), [])).toEqual([])
  })

  it('emits one adapter per MAC even when ioreg repeats it', () => {
    // Captured with two dongles attached: the Realtek publishes IOMACAddress on two nodes of the
    // tree, so the parser legitimately sees it twice and the join must not produce a phantom.
    const entries = parseIoregUsbMacs(IOREG_TWO_DONGLES)
    expect(entries).toHaveLength(3)
    expect(entries.filter((e) => e.mac === '00:e0:4c:be:53:2c')).toHaveLength(2)

    const adapters = joinDarwinAdapters(parseHardwarePorts(NETWORKSETUP_TWO_DONGLES), entries)
    expect(adapters.map((a) => a.device)).toEqual(['en9', 'en7'])
    expect(adapters[1].usb).toEqual({
      vendorId: '0bda',
      productId: '8153',
      vendorName: 'Realtek',
      productName: 'USB 10/100/1000 LAN'
    })
  })
})
