import { describe, it, expect } from 'vitest'
import { parsePing } from '../src/main/capabilities/probe'

const MAC_OK = `--- 1.1.1.1 ping statistics ---
2 packets transmitted, 2 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 11.933/11.936/11.940/0.004 ms`

const MAC_FAIL = `--- 10.0.0.9 ping statistics ---
2 packets transmitted, 0 packets received, 100.0% packet loss`

const LINUX_OK = `2 packets transmitted, 2 received, 0% packet loss, time 1001ms
rtt min/avg/max/mdev = 0.512/0.612/0.712/0.100 ms`

const WIN_OK = `Ping statistics for 1.1.1.1:
    Packets: Sent = 2, Received = 2, Lost = 0 (0% loss),
Approximate round trip times in milli-seconds:
    Minimum = 11ms, Maximum = 12ms, Average = 11ms`

describe('parsePing', () => {
  it('macOS: successful ping gives ok, 0 loss and average RTT', () => {
    const p = parsePing(MAC_OK, '1.1.1.1', '1.1.1.1')
    expect(p.ok).toBe(true)
    expect(p.lossPct).toBe(0)
    expect(p.avgMs).toBeCloseTo(11.936)
  })

  it('macOS: 100% loss gives ok=false', () => {
    const p = parsePing(MAC_FAIL, '10.0.0.9', 'Gateway')
    expect(p.ok).toBe(false)
    expect(p.lossPct).toBe(100)
    expect(p.avgMs).toBeUndefined()
  })

  it('Linux: parses the rtt format and loss', () => {
    const p = parsePing(LINUX_OK, '1.1.1.1', '1.1.1.1')
    expect(p.ok).toBe(true)
    expect(p.lossPct).toBe(0)
    expect(p.avgMs).toBeCloseTo(0.612)
  })

  it('Windows: parses "(0% loss)" and "Average = Nms"', () => {
    const p = parsePing(WIN_OK, '1.1.1.1', '1.1.1.1')
    expect(p.ok).toBe(true)
    expect(p.lossPct).toBe(0)
    expect(p.avgMs).toBe(11)
  })
})
