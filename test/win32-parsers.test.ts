import { describe, it, expect } from 'vitest'
import { parseGetNetAdapter, parseWinNetInfo, parseLinkSpeedMbps } from '../src/main/platform/win32'

// Documented Get-NetAdapter | ConvertTo-Json format (not live-verified — spike).
// A USB dongle, a built-in PCI card, built-in Wi-Fi, and two things that must not be listed:
// a Hyper-V virtual switch and a VPN adapter.
// Keys per the calculated properties in enumerateAdapters.
const JSON_ARRAY = JSON.stringify([
  {
    name: 'Ethernet 3',
    desc: 'Realtek USB GbE Family Controller',
    mac: '6C-6E-07-01-FF-DE',
    pnp: 'USB\\VID_0BDA&PID_8153\\00E04C680001',
    virtual: false,
    hardware: true,
    media: '802.3',
    ndis: 14
  },
  {
    name: 'Ethernet',
    desc: 'Intel(R) Ethernet Connection',
    mac: '00-11-22-33-44-55',
    pnp: 'PCI\\VEN_8086&DEV_15F3\\3&11583659&0&FE',
    virtual: false,
    hardware: true,
    media: '802.3',
    ndis: 14
  },
  {
    name: 'Wi-Fi',
    desc: 'Intel(R) Wi-Fi 6 AX201 160MHz',
    mac: '00-11-22-33-44-77',
    pnp: 'PCI\\VEN_8086&DEV_A0F0\\3&11583659&0&A3',
    virtual: false,
    hardware: true,
    media: 'Native 802.11',
    ndis: 9
  },
  {
    name: 'vEthernet (Default Switch)',
    desc: 'Hyper-V Virtual Ethernet Adapter',
    mac: '00-15-5D-00-00-01',
    pnp: 'VMBUS\\{ABCD}',
    virtual: true,
    hardware: false
  },
  {
    name: 'VPN',
    desc: 'TAP-Windows Adapter V9',
    mac: '00-FF-11-22-33-44',
    pnp: 'ROOT\\NET\\0000',
    virtual: false,
    hardware: false
  }
])

// PowerShell returns a single object (not an array) when only one adapter exists. This one also
// carries none of the new properties, standing in for a Windows build that does not report them.
const JSON_SINGLE = JSON.stringify({
  name: 'Ethernet 3',
  desc: 'ASIX AX88179 USB 3.0 to Gigabit Ethernet',
  mac: '6C-6E-07-01-FF-DE',
  pnp: 'USB\\VID_0B95&PID_1790\\000001'
})

describe('parseGetNetAdapter', () => {
  it('keeps the real ports and drops the virtual ones', () => {
    const adapters = parseGetNetAdapter(JSON_ARRAY)
    expect(adapters.map((a) => [a.device, a.kind])).toEqual([
      ['Ethernet 3', 'usb'],
      ['Ethernet', 'ethernet'],
      ['Wi-Fi', 'wifi']
    ])
  })

  it('parses VID:PID from PnpDeviceID for the USB dongle only', () => {
    const adapters = parseGetNetAdapter(JSON_ARRAY)
    expect(adapters[0].usb).toEqual({
      vendorId: '0bda',
      productId: '8153',
      productName: 'Realtek USB GbE Family Controller'
    })
    expect(adapters[1].usb).toBeUndefined()
    expect(adapters[2].usb).toBeUndefined()
  })

  it('reads Wi-Fi from either the media string or the NDIS medium', () => {
    const byMedium = parseGetNetAdapter(
      JSON.stringify({ name: 'WLAN', pnp: 'PCI\\X', mac: '00-11-22-33-44-77', ndis: 9 })
    )
    expect(byMedium[0].kind).toBe('wifi')
    const byMedia = parseGetNetAdapter(
      JSON.stringify({ name: 'WLAN', pnp: 'PCI\\X', mac: '00-11-22-33-44-77', media: '802.11' })
    )
    expect(byMedia[0].kind).toBe('wifi')
  })

  it('handles a single object (not an array), and keeps it when the new properties are absent', () => {
    // A property we cannot see must leave the adapter in. Hiding every port would be a far worse
    // failure than showing one too many on the platform we cannot test against.
    const adapters = parseGetNetAdapter(JSON_SINGLE)
    expect(adapters).toHaveLength(1)
    expect(adapters[0].kind).toBe('usb')
    expect(adapters[0].usb).toEqual({
      vendorId: '0b95',
      productId: '1790',
      productName: 'ASIX AX88179 USB 3.0 to Gigabit Ethernet'
    })
  })
})

describe('parseLinkSpeedMbps', () => {
  it('parses Gbps/Mbps', () => {
    expect(parseLinkSpeedMbps('1 Gbps')).toBe(1000)
    expect(parseLinkSpeedMbps('100 Mbps')).toBe(100)
    expect(parseLinkSpeedMbps('2.5 Gbps')).toBe(2500)
    expect(parseLinkSpeedMbps(undefined)).toBeUndefined()
  })
})

describe('parseWinNetInfo', () => {
  it('parses the combined JSON object', () => {
    const json = JSON.stringify({
      mac: '6C-6E-07-01-FF-DE',
      status: 'Up',
      linkSpeed: '1 Gbps',
      ip: '192.168.70.196',
      prefix: 23,
      origin: 'Dhcp',
      gateway: '192.168.70.1',
      dns: ['192.168.70.1', '8.8.8.8']
    })
    const net = parseWinNetInfo(json, 'Ethernet 3')
    expect(net).toMatchObject({
      device: 'Ethernet 3',
      linkUp: true,
      mac: '6c:6e:07:01:ff:de',
      ipv4: '192.168.70.196',
      netmask: '255.255.254.0',
      cidr: 23,
      gateway: '192.168.70.1',
      dnsServers: ['192.168.70.1', '8.8.8.8'],
      linkSpeedMbps: 1000
    })
    expect(net.dhcp.enabled).toBe(true)
  })
})
