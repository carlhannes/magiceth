import { describe, it, expect } from 'vitest'
import { macAddressHoldScript } from '../src/main/platform/darwin'
import { linuxAddressHoldScript } from '../src/main/platform/linux'
import { HOLD_FIREWALL_RULES, winAddressHoldScript } from '../src/main/platform/win32'

const link = { ip: '10.254.254.1', cidr: 24 }

describe('macAddressHoldScript', () => {
  const s = macAddressHoldScript('en7', link, '/tmp/hold.stop', 900)

  it('adds an alias and removes the same one', () => {
    expect(
      s.startsWith("ifconfig 'en7' inet '10.254.254.1' netmask '255.255.255.0' alias && ")
    ).toBe(true)
    expect(s).toContain("ifconfig 'en7' inet '10.254.254.1' -alias")
  })

  // configd reconfigures the port when the link comes up, which is exactly when the device gets
  // plugged in; a one-second re-assert costs nothing when the alias is already there.
  it('re-asserts the alias inside the wait loop', () => {
    expect(s).toContain(
      "do ifconfig 'en7' inet '10.254.254.1' netmask '255.255.255.0' alias 2>/dev/null; sleep 1"
    )
  })

  it('waits on the stop file and gives up on its own', () => {
    expect(s).toContain("while [ ! -f '/tmp/hold.stop' ] && [ $n -lt 900 ]")
    expect(s.endsWith("rm -f '/tmp/hold.stop'; true")).toBe(true)
  })

  it('never sets a router, so the default route cannot move', () => {
    expect(s).not.toMatch(/networksetup|route/)
  })

  it('quotes the device', () => {
    expect(macAddressHoldScript("a'b", link, '/tmp/s', 10)).toContain("'a'\\''b'")
  })
})

// The commands here are the ones run by hand on 2026-10-27, when a Flex switch on the dongle
// adopted itself straight against a controller on the internet through the laptop.
describe('macAddressHoldScript sharing the internet', () => {
  const s = macAddressHoldScript('en7', { ...link, upstream: 'en0' }, '/tmp/hold.stop', 900)
  const plain = macAddressHoldScript('en7', link, '/tmp/hold.stop', 900)

  it('still starts with the alias and ends by removing it', () => {
    expect(
      s.startsWith("ifconfig 'en7' inet '10.254.254.1' netmask '255.255.255.0' alias && ")
    ).toBe(true)
    expect(
      s.endsWith("ifconfig 'en7' inet '10.254.254.1' -alias; rm -f '/tmp/hold.stop'; true")
    ).toBe(true)
  })

  it('turns forwarding on, remembering what it was, and puts it back after the loop', () => {
    expect(s).toContain('fwd=$(sysctl -n net.inet.ip.forwarding 2>/dev/null)')
    expect(s).toContain('sysctl -q -w net.inet.ip.forwarding=1')
    expect(s).toContain('sysctl -q -w net.inet.ip.forwarding="${fwd:-0}"')
    expect(s.indexOf('forwarding=1')).toBeLessThan(s.indexOf('while ['))
    expect(s.indexOf('while [')).toBeLessThan(s.indexOf('${fwd:-0}'))
  })

  it("NATs the link's network through the upstream, in its own anchor, from stdin", () => {
    expect(s).toContain("'nat on en0 inet from 10.254.254.0/24 to any -> (en0)'")
    expect(s).toContain("'pass in quick on en7 inet from 10.254.254.0/24 to any keep state'")
    expect(s).toContain("'pass out quick on en0 inet from 10.254.254.0/24 to any keep state'")
    expect(s).toContain("printf '%s\\n' 'nat on en0")
    expect(s).toContain('| pfctl -q -a com.apple/magiceth -f -;')
  })

  it('enables pf by reference and releases that reference, never disabling pf', () => {
    expect(s).toContain("tok=$(pfctl -E 2>&1 | sed -n 's/.*Token : //p')")
    expect(s).toContain(
      'pfctl -q -a com.apple/magiceth -F all; [ -n "$tok" ] && pfctl -q -X "$tok";'
    )
    expect(s).not.toContain('pfctl -d')
    expect(s.indexOf('while [')).toBeLessThan(s.indexOf('-F all'))
    expect(s.indexOf('-F all')).toBeLessThan(s.indexOf('pfctl -q -X'))
    expect(s.indexOf('pfctl -q -X')).toBeLessThan(s.indexOf('${fwd:-0}'))
    expect(s.indexOf('${fwd:-0}')).toBeLessThan(s.indexOf('-alias'))
  })

  it('leaves the routing table alone; NAT is the way out', () => {
    expect(s).not.toMatch(/networksetup|route/)
  })

  it('is the plain script when nothing is shared', () => {
    expect(plain).not.toContain('pfctl')
    expect(plain).not.toContain('forwarding')
  })
})

describe('linuxAddressHoldScript', () => {
  const s = linuxAddressHoldScript('eth1', link, '/tmp/hold.stop', 900)

  it('lowers the privileged-port threshold to 67 for the session and puts it back', () => {
    expect(s).toContain('old=$(sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null)')
    expect(s).toContain('sysctl -q -w net.ipv4.ip_unprivileged_port_start=67')
    expect(s).toContain('sysctl -q -w net.ipv4.ip_unprivileged_port_start="${old:-1024}"')
    // The restore must come after the loop, not before.
    expect(s.indexOf('=67')).toBeLessThan(s.indexOf('${old:-1024}'))
  })

  it('adds the address, re-asserts it in the loop, and deletes it', () => {
    expect(s).toContain("do ip addr add '10.254.254.1/24' dev 'eth1' 2>/dev/null; sleep 1")
    expect(s).toContain("ip addr del '10.254.254.1/24' dev 'eth1'")
    expect(s).not.toContain('ip route')
  })

  it('waits on the stop file with a cap', () => {
    expect(s).toContain("while [ ! -f '/tmp/hold.stop' ] && [ $n -lt 900 ]")
    expect(s.endsWith("rm -f '/tmp/hold.stop'; true")).toBe(true)
  })
})

describe('winAddressHoldScript', () => {
  const exe = 'C:\\Program Files\\magiceth\\magiceth.exe'
  const s = winAddressHoldScript('Ethernet 2', link, 'C:\\Temp\\hold.stop', 900, exe)

  it('adds the address with netsh and deletes it afterwards', () => {
    expect(s).toContain(
      'netsh interface ipv4 add address name="Ethernet 2" 10.254.254.1 255.255.255.0'
    )
    expect(s).toContain('netsh interface ipv4 delete address name="Ethernet 2" 10.254.254.1')
  })

  it('opens the two listeners for this executable only, and closes them again', () => {
    expect(HOLD_FIREWALL_RULES.map((r) => `${r.protocol} ${r.port}`)).toEqual([
      'UDP 67',
      'UDP 10001'
    ])
    for (const r of HOLD_FIREWALL_RULES) {
      expect(s).toContain(
        `New-NetFirewallRule -DisplayName "${r.name}" -Direction Inbound -Action Allow -Protocol ${r.protocol} -LocalPort ${r.port} -Program "${exe}" -Profile Any`
      )
    }
    expect(s).toContain('Remove-NetFirewallRule -DisplayName "magiceth DHCP","magiceth discovery"')
    expect(s.indexOf('New-NetFirewallRule')).toBeLessThan(s.indexOf('Remove-NetFirewallRule'))
  })

  it('waits on the stop file with a cap and removes it', () => {
    expect(s).toContain('while (-not (Test-Path "C:\\Temp\\hold.stop") -and $n -lt 900)')
    expect(s).toContain('Remove-Item "C:\\Temp\\hold.stop" -Force')
  })

  it('never stops on an error', () => {
    expect(s.startsWith("$ErrorActionPreference='SilentlyContinue'")).toBe(true)
  })

  it('escapes the adapter name for a PowerShell string', () => {
    expect(winAddressHoldScript('$(whoami)', link, 'C:\\s', 1, exe)).toContain('name="`$(whoami)"')
  })
})
