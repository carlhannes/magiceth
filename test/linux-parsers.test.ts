import { describe, it, expect } from 'vitest'
import {
  parseUdevProperties,
  udevToRawAdapter,
  parseIpAddr,
  parseIpRoute,
  parseDnsServers
} from '../src/main/platform/linux'

// Documented udev format for an RTL8153 dongle (not live-verified — spike).
const UDEV_USB = `DEVPATH=/devices/pci0000:00/0000:00:14.0/usb2/2-1/2-1:1.0/net/eth1
ID_BUS=usb
ID_VENDOR_ID=0bda
ID_MODEL_ID=8153
ID_VENDOR_FROM_DATABASE=Realtek Semiconductor Corp.
ID_MODEL_FROM_DATABASE=RTL8153 Gigabit Ethernet Adapter
ID_NET_NAME_MAC=enx0bda8153aabb
INTERFACE=eth1`

const UDEV_BUILTIN = `DEVPATH=/devices/pci0000:00/0000:00:1f.6/net/eth0
ID_BUS=pci
ID_VENDOR_ID=8086
ID_MODEL_ID=15f3
INTERFACE=eth0`

describe('parseUdevProperties', () => {
  it('parses KEY=VALUE lines', () => {
    const props = parseUdevProperties(UDEV_USB)
    expect(props.ID_BUS).toBe('usb')
    expect(props.ID_VENDOR_ID).toBe('0bda')
    expect(props.ID_MODEL_ID).toBe('8153')
  })
})

describe('udevToRawAdapter', () => {
  it('builds a RawAdapter for USB interfaces', () => {
    const adapter = udevToRawAdapter('eth1', '00:11:22:33:44:55', parseUdevProperties(UDEV_USB))
    expect(adapter).toEqual({
      device: 'eth1',
      portName: 'RTL8153 Gigabit Ethernet Adapter',
      mac: '00:11:22:33:44:55',
      kind: 'usb',
      usb: {
        vendorId: '0bda',
        productId: '8153',
        vendorName: 'Realtek Semiconductor Corp.',
        productName: 'RTL8153 Gigabit Ethernet Adapter'
      }
    })
  })

  it('treats a non-USB interface as built-in ethernet rather than discarding it', () => {
    const adapter = udevToRawAdapter('eth0', '00:11:22:33:44:66', parseUdevProperties(UDEV_BUILTIN))
    expect(adapter.kind).toBe('ethernet')
    expect(adapter.usb).toBeUndefined()
  })

  it('still describes a port when udev told us nothing', () => {
    // udevadm missing or failing must not make a real port disappear; it only costs the USB
    // identification, and sysfs has already said whether the interface is wireless.
    const adapter = udevToRawAdapter('eth0', '00:11:22:33:44:66', {})
    expect(adapter.device).toBe('eth0')
    expect(adapter.portName).toBe('eth0')
    expect(adapter.kind).toBe('ethernet')
    expect(udevToRawAdapter('wlan0', '00:11:22:33:44:77', {}, true).kind).toBe('wifi')
  })

  it('reads Wi-Fi from the sysfs wireless directory or from DEVTYPE', () => {
    const bySysfs = udevToRawAdapter(
      'wlan0',
      '00:11:22:33:44:77',
      parseUdevProperties(UDEV_BUILTIN),
      true
    )
    expect(bySysfs.kind).toBe('wifi')
    const byDevtype = udevToRawAdapter(
      'wlan0',
      '00:11:22:33:44:77',
      parseUdevProperties(`${UDEV_BUILTIN}\nDEVTYPE=wlan`)
    )
    expect(byDevtype.kind).toBe('wifi')
  })
})

// A DHCP lease: iproute2 marks the address "dynamic" because it has a finite lifetime.
const IP_ADDR = JSON.stringify([
  {
    ifname: 'eth1',
    operstate: 'UP',
    address: '6c:6e:07:01:ff:de',
    addr_info: [
      {
        family: 'inet',
        local: '192.168.70.196',
        prefixlen: 23,
        dynamic: true,
        valid_life_time: 85994
      },
      { family: 'inet6', local: 'fe80::1', prefixlen: 64 }
    ]
  }
])

// A statically configured address: no lifetime, so no "dynamic" key at all.
const IP_ADDR_STATIC = JSON.stringify([
  {
    ifname: 'eth1',
    operstate: 'UP',
    address: '6c:6e:07:01:ff:de',
    addr_info: [{ family: 'inet', local: '10.0.0.50', prefixlen: 24 }]
  }
])

const IP_ROUTE = JSON.stringify([
  { dst: 'default', gateway: '192.168.70.1', dev: 'eth1', protocol: 'dhcp' },
  { dst: 'default', gateway: '10.0.0.1', dev: 'wlan0' }
])

describe('parseIpAddr', () => {
  it('parses MAC, link status, IPv4 and prefix', () => {
    expect(parseIpAddr(IP_ADDR, 'eth1')).toEqual({
      mac: '6c:6e:07:01:ff:de',
      linkUp: true,
      ipv4: '192.168.70.196',
      cidr: 23,
      dhcp: true
    })
  })

  it('reports a static address as not DHCP', () => {
    const info = parseIpAddr(IP_ADDR_STATIC, 'eth1')
    expect(info.ipv4).toBe('10.0.0.50')
    expect(info.dhcp).toBe(false)
  })
})

describe('parseIpRoute', () => {
  it('picks the default gateway for the correct device', () => {
    expect(parseIpRoute(IP_ROUTE, 'eth1')).toBe('192.168.70.1')
  })
})

describe('parseDnsServers', () => {
  it('keeps only valid IPv4 addresses', () => {
    // resolvectl happily lists IPv6 servers alongside IPv4 ones.
    expect(parseDnsServers('Link 3 (eth1): 192.168.70.1 fe80::1 1.1.1.1')).toEqual([
      '192.168.70.1',
      '1.1.1.1'
    ])
    expect(parseDnsServers('nameserver 1.2.3\nnameserver 999.1.1.1\nnameserver 8.8.8.8')).toEqual([
      '8.8.8.8'
    ])
  })

  it('parses resolvectl and resolv.conf formats', () => {
    expect(parseDnsServers('Link 3 (eth1): 192.168.70.1 1.1.1.1')).toEqual([
      '192.168.70.1',
      '1.1.1.1'
    ])
    expect(parseDnsServers('nameserver 192.168.70.1\nnameserver 8.8.8.8')).toEqual([
      '192.168.70.1',
      '8.8.8.8'
    ])
  })
})
