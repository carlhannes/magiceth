import { describe, it, expect } from 'vitest'
import {
  parseHardwarePorts,
  parseIoregUsbMacs,
  joinDarwinAdapters,
  parseNetworkServiceDevices,
  builtinDarwinAdapters
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
        kind: 'usb',
        usb: {
          vendorId: '0b95',
          productId: '1790',
          vendorName: 'ASIX',
          productName: 'AX88179A'
        }
      }
    ])
  })

  it('returns no adapters when no USB MAC matches a port', () => {
    expect(joinDarwinAdapters(parseHardwarePorts(NETWORKSETUP), [])).toEqual([])
  })

  it('emits one adapter per MAC even when ioreg repeats it', () => {
    // Captured with two adapters attached: the Realtek publishes IOMACAddress on two nodes of the
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

// Real output captured on this development Mac, with no dongle attached. Both commands, verbatim:
// the hardware list still offers plenty that is not a usable port, and the service list is what
// separates them.
const HARDWARE_PORTS_LAPTOP = `
Hardware Port: Ethernet Adapter (en4)
Device: en4
Ethernet Address: 0e:30:9c:e7:25:0a

Hardware Port: Ethernet Adapter (en5)
Device: en5
Ethernet Address: 0e:30:9c:e7:25:0b

Hardware Port: Ethernet Adapter (en6)
Device: en6
Ethernet Address: 0e:30:9c:e7:25:0c

Hardware Port: Thunderbolt Bridge
Device: bridge0
Ethernet Address: 36:7b:bc:d7:59:c0

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 84:2f:57:44:d6:4f

Hardware Port: Thunderbolt 1
Device: en1
Ethernet Address: 36:7b:bc:d7:59:c0

Hardware Port: Thunderbolt 2
Device: en2
Ethernet Address: 36:7b:bc:d7:59:c4

Hardware Port: Thunderbolt 3
Device: en3
Ethernet Address: 36:7b:bc:d7:59:c8

VLAN Configurations
===================
`

// The matching service order. Note en7/en8/en9/en10: SystemConfiguration keeps services long after
// the hardware is unplugged, so this list alone would invent ports that are not there.
const SERVICE_ORDER_LAPTOP = `An asterisk (*) denotes that a network service is disabled.
(1) Wi-Fi
(Hardware Port: Wi-Fi, Device: en0)

(2) USB 10/100/1000 LAN
(Hardware Port: USB 10/100/1000 LAN, Device: en7)

(3) AX88179A
(Hardware Port: AX88179A, Device: en9)

(4) Thunderbolt Ethernet Slot 2
(Hardware Port: Thunderbolt Ethernet Slot 2, Device: en8)

(5) Thunderbolt Bridge
(Hardware Port: Thunderbolt Bridge, Device: bridge0)

(6) iPhone USB
(Hardware Port: iPhone USB, Device: en10)

(7) UniFi Teleport
(Hardware Port: com.ubnt.wifiman, Device: )

(8) wg-h.home.0xp.se-mbpm4
(Hardware Port: com.wireguard.macos, Device: )
`

describe('parseNetworkServiceDevices', () => {
  it('collects the devices macOS has made into network services', () => {
    const devices = parseNetworkServiceDevices(SERVICE_ORDER_LAPTOP)
    expect([...devices].sort()).toEqual(['bridge0', 'en0', 'en10', 'en7', 'en8', 'en9'])
  })

  it('skips services with no device, which is what a VPN looks like here', () => {
    const devices = parseNetworkServiceDevices(SERVICE_ORDER_LAPTOP)
    expect(devices.has('')).toBe(false)
    expect(devices.size).toBe(6)
  })
})

describe('builtinDarwinAdapters', () => {
  const ports = parseHardwarePorts(HARDWARE_PORTS_LAPTOP)
  const services = parseNetworkServiceDevices(SERVICE_ORDER_LAPTOP)

  it('finds exactly the one real built-in port on this machine', () => {
    // en1-en3 are Thunderbolt ports and en4-en6 are the T2 plumbing: macOS lists all six as
    // hardware and none of them as a service, which is the whole reason the service list is read.
    const adapters = builtinDarwinAdapters(ports, services, new Set())
    expect(adapters).toEqual([
      { device: 'en0', portName: 'Wi-Fi', mac: '84:2f:57:44:d6:4f', kind: 'wifi' }
    ])
  })

  it('invents nothing for services whose hardware is gone', () => {
    // en7/en8/en9/en10 all have services but are not plugged in, so they are not in the hardware
    // list and must not appear.
    const devices = builtinDarwinAdapters(ports, services, new Set()).map((a) => a.device)
    expect(devices).not.toContain('en7')
    expect(devices).not.toContain('en9')
  })

  it('leaves the Thunderbolt bridge out even though it is both hardware and a service', () => {
    expect(services.has('bridge0')).toBe(true)
    expect(builtinDarwinAdapters(ports, services, new Set()).map((a) => a.device)).not.toContain(
      'bridge0'
    )
  })

  it('does not list a port the USB pass already claimed', () => {
    expect(builtinDarwinAdapters(ports, services, new Set(['en0']))).toEqual([])
  })

  it('lists a dongle once, from the USB pass, never twice', () => {
    // Both passes see the same hardware list. The dongles have services too, so without the
    // exclusion they would appear a second time — and the second copy would have no chipset.
    const hw = parseHardwarePorts(NETWORKSETUP_TWO_DONGLES)
    const dongles = joinDarwinAdapters(hw, parseIoregUsbMacs(IOREG_TWO_DONGLES))
    const svc = parseNetworkServiceDevices(SERVICE_ORDER_LAPTOP)
    const all = [
      ...dongles,
      ...builtinDarwinAdapters(hw, svc, new Set(dongles.map((d) => d.device)))
    ]

    expect(all.map((a) => [a.device, a.kind])).toEqual([
      ['en9', 'usb'],
      ['en7', 'usb'],
      ['en0', 'wifi']
    ])
    expect(new Set(all.map((a) => a.device)).size).toBe(all.length)
  })

  it('still shows a dongle the USB pass missed, as a plain port rather than not at all', () => {
    // If ioreg ever fails to pair one, the built-in pass picks it up: no chipset, but the port is
    // there and can be diagnosed. Losing identification beats losing the port.
    const hw = parseHardwarePorts(NETWORKSETUP_TWO_DONGLES)
    const svc = parseNetworkServiceDevices(SERVICE_ORDER_LAPTOP)
    const fallback = builtinDarwinAdapters(hw, svc, new Set())
    expect(fallback.map((a) => a.device)).toEqual(['en9', 'en7', 'en0'])
    expect(fallback[0].kind).toBe('ethernet')
  })

  it('calls a wired built-in ethernet, not wifi', () => {
    // A Mac mini / iMac names its built-in port exactly "Ethernet".
    const desktop = parseHardwarePorts(`
Hardware Port: Ethernet
Device: en0
Ethernet Address: 84:2f:57:44:d6:4f
`)
    const adapters = builtinDarwinAdapters(desktop, new Set(['en0']), new Set())
    expect(adapters).toEqual([
      { device: 'en0', portName: 'Ethernet', mac: '84:2f:57:44:d6:4f', kind: 'ethernet' }
    ])
  })
})
