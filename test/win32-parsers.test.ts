import { describe, it, expect } from 'vitest'
import { parseGetNetAdapter, parseWinNetInfo, parseLinkSpeedMbps } from '../src/main/platform/win32'

// Documented Get-NetAdapter | ConvertTo-Json format (not live-verified — spike).
// A USB dongle (RTL8153) and a built-in PCI card.
// Keys per the calculated properties in enumerateAdapters (name/desc/mac/pnp).
const JSON_ARRAY = JSON.stringify([
  {
    name: 'Ethernet 3',
    desc: 'Realtek USB GbE Family Controller',
    mac: '6C-6E-07-01-FF-DE',
    pnp: 'USB\\VID_0BDA&PID_8153\\00E04C680001'
  },
  {
    name: 'Ethernet',
    desc: 'Intel(R) Ethernet Connection',
    mac: '00-11-22-33-44-55',
    pnp: 'PCI\\VEN_8086&DEV_15F3\\3&11583659&0&FE'
  }
])

// PowerShell returns a single object (not an array) when only one adapter exists.
const JSON_SINGLE = JSON.stringify({
  name: 'Ethernet 3',
  desc: 'ASIX AX88179 USB 3.0 to Gigabit Ethernet',
  mac: '6C-6E-07-01-FF-DE',
  pnp: 'USB\\VID_0B95&PID_1790\\000001'
})

describe('parseGetNetAdapter', () => {
  it('picks out USB dongles and parses VID:PID from PnpDeviceID', () => {
    const adapters = parseGetNetAdapter(JSON_ARRAY)
    expect(adapters).toEqual([
      {
        device: 'Ethernet 3',
        portName: 'Realtek USB GbE Family Controller',
        mac: '6c:6e:07:01:ff:de',
        usb: {
          vendorId: '0bda',
          productId: '8153',
          productName: 'Realtek USB GbE Family Controller'
        }
      }
    ])
  })

  it('handles a single object (not an array)', () => {
    const adapters = parseGetNetAdapter(JSON_SINGLE)
    expect(adapters).toHaveLength(1)
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
