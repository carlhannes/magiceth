import { describe, it, expect } from 'vitest'
import { parsePing } from '../src/main/capabilities/probe'

const MAC_OK = `--- 1.1.1.1 ping statistics ---
5 packets transmitted, 5 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 14.985/15.388/15.966/0.324 ms`

const MAC_FAIL = `--- 10.0.0.9 ping statistics ---
5 packets transmitted, 0 packets received, 100.0% packet loss`

const LINUX_OK = `5 packets transmitted, 4 received, 20% packet loss, time 1001ms
rtt min/avg/max/mdev = 0.512/0.612/0.712/0.100 ms`

const WIN_OK = `Ping statistics for 1.1.1.1:
    Packets: Sent = 5, Received = 5, Lost = 0 (0% loss),
Approximate round trip times in milli-seconds:
    Minimum = 11ms, Maximum = 12ms, Average = 11ms`

describe('parsePing', () => {
  it('macOS: successful ping gives ok, 0 loss, average RTT and jitter', () => {
    const p = parsePing(MAC_OK, '1.1.1.1', '1.1.1.1')
    expect(p.ok).toBe(true)
    expect(p.lossPct).toBe(0)
    expect(p.avgMs).toBeCloseTo(15.388)
    expect(p.jitterMs).toBeCloseTo(0.324)
  })

  it('macOS: 100% loss gives ok=false', () => {
    const p = parsePing(MAC_FAIL, '10.0.0.9', 'Gateway')
    expect(p.ok).toBe(false)
    expect(p.lossPct).toBe(100)
    expect(p.avgMs).toBeUndefined()
    expect(p.jitterMs).toBeUndefined()
  })

  it('Linux: parses the rtt format, mdev as jitter, and partial loss', () => {
    const p = parsePing(LINUX_OK, '1.1.1.1', '1.1.1.1')
    // Partial loss is still a reachable target — the UI colours it amber rather than red.
    expect(p.ok).toBe(true)
    expect(p.lossPct).toBe(20)
    expect(p.avgMs).toBeCloseTo(0.612)
    expect(p.jitterMs).toBeCloseTo(0.1)
  })

  it('Windows: parses "(0% loss)" and "Average = Nms", and reports no jitter', () => {
    const p = parsePing(WIN_OK, '1.1.1.1', '1.1.1.1')
    expect(p.ok).toBe(true)
    expect(p.lossPct).toBe(0)
    expect(p.avgMs).toBe(11)
    // Windows ping prints minimum/maximum/average and no deviation, so there is nothing to show.
    expect(p.jitterMs).toBeUndefined()
  })

  it('a clean run reports 0 rather than nothing, so the UI can say "0% loss"', () => {
    // The renderer used to hide 0% loss because the value was falsy; the distinction between
    // "measured, clean" and "never measured" has to survive parsing.
    expect(parsePing(MAC_OK, '1.1.1.1', '1.1.1.1').lossPct).toBe(0)
    expect(parsePing('nothing useful here', '1.1.1.1', '1.1.1.1').lossPct).toBeUndefined()
  })
})
