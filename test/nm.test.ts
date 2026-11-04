import { describe, it, expect } from 'vitest'
import { parseNmDevice, nmProfileScript, nmConnectionName } from '../src/main/platform/nm'
import type { Profile } from '../src/shared/types'

// `nmcli -t -f GENERAL.TYPE,GENERAL.STATE device show <dev>` — the documented terse format, one
// FIELD:value per line. Not yet captured on the field laptop; LINUX-TEST.md step 3 records it.
describe('parseNmDevice', () => {
  it('reads a connected Ethernet port as managed', () => {
    expect(parseNmDevice('GENERAL.TYPE:ethernet\nGENERAL.STATE:100 (connected)\n')).toEqual({
      type: 'ethernet',
      managed: true
    })
  })

  it('reads state 10 as unmanaged, whatever the name says', () => {
    expect(parseNmDevice('GENERAL.TYPE:ethernet\nGENERAL.STATE:10 (unmanaged)\n')).toEqual({
      type: 'ethernet',
      managed: false
    })
    expect(parseNmDevice('GENERAL.TYPE:ethernet\nGENERAL.STATE:10 (ohanterad)\n')?.managed).toBe(
      false
    )
  })

  it('keeps a managed port without a cable managed', () => {
    expect(parseNmDevice('GENERAL.TYPE:ethernet\nGENERAL.STATE:20 (unavailable)\n')).toEqual({
      type: 'ethernet',
      managed: true
    })
  })

  it('names the other device types', () => {
    expect(parseNmDevice('GENERAL.TYPE:wifi\nGENERAL.STATE:100 (connected)\n')?.type).toBe('wifi')
  })

  it('splits at the first colon, so a MAC in another field does not confuse it', () => {
    const full =
      'GENERAL.DEVICE:enp0s31f6\nGENERAL.TYPE:ethernet\nGENERAL.HWADDR:AA:BB:CC:DD:EE:FF\n' +
      'GENERAL.MTU:1500\nGENERAL.STATE:30 (disconnected)\nGENERAL.CONNECTION:\n'
    expect(parseNmDevice(full)).toEqual({ type: 'ethernet', managed: true })
  })

  it('is undefined for an error or nothing', () => {
    expect(parseNmDevice("Error: Device 'eth9' not found.\n")).toBeUndefined()
    expect(parseNmDevice('')).toBeUndefined()
    expect(parseNmDevice('GENERAL.TYPE:ethernet\n')).toBeUndefined()
  })
})

const staticProfile: Profile = {
  id: 'p1',
  name: 'Lab',
  mode: 'static',
  ip: '10.0.0.50',
  cidr: 24,
  gateway: '10.0.0.1',
  dns: ['1.1.1.1', '8.8.8.8']
}

describe('nmProfileScript', () => {
  it('replaces the port’s own connection and brings it up', () => {
    const s = nmProfileScript('eth1', staticProfile)
    expect(s).toBe(
      "nmcli connection delete id 'magiceth-eth1' >/dev/null 2>&1; " +
        "nmcli connection add save no type ethernet ifname 'eth1' con-name 'magiceth-eth1' " +
        'connection.autoconnect yes connection.autoconnect-priority 100 ' +
        "ipv4.method manual ipv4.addresses '10.0.0.50/24' ipv4.gateway '10.0.0.1' ipv4.dns '1.1.1.1 8.8.8.8' && " +
        "nmcli -w 20 connection up id 'magiceth-eth1'"
    )
  })

  it('leaves out a gateway and DNS the profile does not have', () => {
    const s = nmProfileScript('eth1', {
      id: 'p',
      name: 'n',
      mode: 'static',
      ip: '10.0.0.5',
      cidr: 16
    })
    expect(s).toContain("ipv4.addresses '10.0.0.5/16'")
    expect(s).not.toContain('ipv4.gateway')
    expect(s).not.toContain('ipv4.dns')
  })

  it('asks NetworkManager for DHCP rather than running a client', () => {
    const s = nmProfileScript('eth1', { id: 'p', name: 'n', mode: 'dhcp' })
    expect(s).toContain('ipv4.method auto')
    expect(s).not.toContain('ipv4.addresses')
    expect(s).not.toContain('dhclient')
  })

  it('sets the MAC the way rolling one does, before the connection', () => {
    const s = nmProfileScript('eth1', { ...staticProfile, macOverride: '02:11:22:33:44:55' })
    const mac = s.indexOf(
      "ip link set dev 'eth1' down && ip link set dev 'eth1' address '02:11:22:33:44:55' && ip link set dev 'eth1' up && "
    )
    expect(mac).toBeGreaterThan(0)
    expect(mac).toBeLessThan(s.indexOf('nmcli connection add'))
    expect(s).not.toContain('cloned-mac-address')
  })

  it('never persists: save no, and the name follows the port', () => {
    expect(nmConnectionName('enp0s31f6')).toBe('magiceth-enp0s31f6')
    expect(nmProfileScript('enp0s31f6', staticProfile)).toContain('connection add save no')
  })

  it('quotes a port name with a quote in it', () => {
    expect(nmProfileScript("e'1", staticProfile)).toContain("ifname 'e'\\''1'")
  })
})
