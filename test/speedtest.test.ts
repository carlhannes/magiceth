import { describe, it, expect } from 'vitest'
import {
  downloadArgs,
  failureText,
  lastHttpCode,
  peakMbps,
  rateMbps,
  uploadArgs
} from '../src/main/capabilities/speedtest'
import type { Sample } from '../src/main/capabilities/speedtest'
import { darwin } from '../src/main/platform/darwin'
import { linux } from '../src/main/platform/linux'
import { win32 } from '../src/main/platform/win32'

/** Samples 250 ms apart, each carrying `mbps` for that quarter-second. Cumulative, as the real ones are. */
function samplesAt(mbps: number[]): Sample[] {
  const out: Sample[] = [{ at: 0, bytes: 0 }]
  let bytes = 0
  mbps.forEach((rate, i) => {
    bytes += (rate * 1e6 * 0.25) / 8
    out.push({ at: (i + 1) * 250, bytes })
  })
  return out
}

describe('rateMbps', () => {
  it('measures the trailing second, so an early ramp stops counting once it is past', () => {
    // 1 Mbit/s for a second, then 100 Mbit/s for a second. The trailing window sees only the fast part.
    const s = samplesAt([1, 1, 1, 1, 100, 100, 100, 100])
    expect(rateMbps(s)).toBeCloseTo(100, 1)
  })

  it('measures a phase younger than the window over all of itself', () => {
    // Two ticks in: half a second of data, and a figure is wanted now rather than at t=1s.
    const s = samplesAt([40, 40])
    expect(rateMbps(s)).toBeCloseTo(40, 1)
  })

  it('needs two samples, and never divides by a zero-length window', () => {
    expect(rateMbps([{ at: 0, bytes: 0 }])).toBeUndefined()
    expect(rateMbps([])).toBeUndefined()
    expect(
      rateMbps([
        { at: 5, bytes: 0 },
        { at: 5, bytes: 1000 }
      ])
    ).toBeUndefined()
  })
})

describe('peakMbps', () => {
  it('ignores the first second, where slow start and buffer fill live', () => {
    // A fake 900 Mbit/s spike in the opening quarter-second — an upload pipe swallowing its buffer —
    // must not become the headline for a link that then settles at 50.
    const s = samplesAt([900, 5, 5, 5, 50, 50, 50, 50, 50, 50, 50, 50])
    const peak = peakMbps(s)
    expect(peak).toBeDefined()
    expect(peak as number).toBeLessThan(60)
    expect(peak as number).toBeGreaterThan(45)
  })

  it('reports the best sustained second, not the last one', () => {
    const s = samplesAt([10, 10, 10, 10, 80, 80, 80, 80, 20, 20, 20, 20])
    expect(peakMbps(s)).toBeCloseTo(80, 0)
  })

  it('is undefined for a phase shorter than the skip window', () => {
    // The UI falls back to the live figure here rather than inventing a peak.
    expect(peakMbps(samplesAt([50, 50]))).toBeUndefined()
    expect(peakMbps([])).toBeUndefined()
  })
})

describe('downloadArgs', () => {
  const args = downloadArgs('en9')

  it('binds to the interface it was given', () => {
    expect(args).toContain('--interface')
    expect(args[args.indexOf('--interface') + 1]).toBe('en9')
  })

  it('repeats the URL enough to outlast the byte cap on one connection', () => {
    // curl reuses the connection across URLs, so the phase pays for TCP slow start once. There
    // must be more bytes on offer than the cap allows, or a fast link would run dry early.
    const urls = args.filter((a) => a.startsWith('https://'))
    const chunk = Number(urls[0].match(/bytes=(\d+)/)?.[1])
    expect(urls.length).toBeGreaterThan(1)
    expect(urls.length * chunk).toBeGreaterThan(200_000_000)
    expect(new Set(urls).size).toBe(1)
  })

  it('asks the endpoint for a size it will actually serve', () => {
    // Measured against the live endpoint: 80 MB answers 200, 100 MB answers 403.
    const chunk = Number(args.find((a) => a.startsWith('https://'))?.match(/bytes=(\d+)/)?.[1])
    expect(chunk).toBeLessThan(100_000_000)
  })

  it('writes no body to a file, since the bytes are counted off stdout', () => {
    expect(args).not.toContain('-o')
  })

  it('leaves the transfer uncompressed, so it measures the link and not a compressor', () => {
    expect(args).not.toContain('--compressed')
  })
})

describe('uploadArgs', () => {
  const args = uploadArgs('192.168.1.50')

  it('streams the body from stdin as a POST', () => {
    expect(args).toContain('-T')
    expect(args[args.indexOf('-T') + 1]).toBe('-')
    expect(args).toContain('-X')
    expect(args[args.indexOf('-X') + 1]).toBe('POST')
  })

  it('binds to whatever it was given, address or interface alike', () => {
    expect(args[args.indexOf('--interface') + 1]).toBe('192.168.1.50')
  })

  it('has a single upload URL', () => {
    expect(args.filter((a) => a.startsWith('https://'))).toHaveLength(1)
  })
})

describe('lastHttpCode', () => {
  it('takes the last of the per-transfer lines the download prints', () => {
    expect(lastHttpCode('200\n200\n200\n403\n')).toBe(403)
  })

  it('ignores curl error prose, which is not a status line', () => {
    expect(lastHttpCode('curl: (7) Failed to connect to host port 443\n')).toBeUndefined()
    expect(lastHttpCode('')).toBeUndefined()
  })
})

describe('failureText', () => {
  it('names an HTTP error, since that smells like a captive portal', () => {
    expect(failureText(22, '511\n')).toMatch(/HTTP 511/)
  })

  it('passes the message from curl through when there is no response at all', () => {
    expect(failureText(7, 'curl: (7) Failed to connect to speed.cloudflare.com port 443')).toBe(
      'Failed to connect to speed.cloudflare.com port 443'
    )
  })

  it('falls back to the exit code when curl said nothing useful', () => {
    expect(failureText(null, '')).toMatch(/without a code/)
  })
})

describe('speedTestBind', () => {
  it('binds by interface name where the OS can', () => {
    expect(darwin.speedTestBind('en9', '192.168.1.50')).toBe('en9')
    expect(linux.speedTestBind('eth0', '192.168.1.50')).toBe('eth0')
  })

  it('binds by source address on Windows, which has no bind-by-interface', () => {
    // curl would try to resolve "Ethernet 2" as a host name, so the adapter name is unusable.
    expect(win32.speedTestBind('Ethernet 2', '192.168.1.50')).toBe('192.168.1.50')
  })

  it('gives nothing to bind to when the port has no address, on any platform', () => {
    expect(win32.speedTestBind('Ethernet 2', undefined)).toBeUndefined()
    expect(darwin.speedTestBind('', undefined)).toBeUndefined()
  })
})
