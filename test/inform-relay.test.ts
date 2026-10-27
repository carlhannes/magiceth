import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { describe, it, expect } from 'vitest'
import { parseInformHeader, startInformRelay } from '../src/plugins/unifi-adopt/inform-relay'

// Header per the reverse-engineered inform protocol: TNBU, version, MAC, flags, IV, data
// version, payload length. DOCUMENTED FORMAT — a real inform captured from the Flex Mini through
// the relay belongs here (CONFIGURE-TEST.md).
function header(opts: { mac?: number[]; flags?: number; length?: number } = {}): Buffer {
  const b = Buffer.alloc(40)
  b.write('TNBU', 0, 'latin1')
  b.writeUInt32BE(0, 4)
  Buffer.from(opts.mac ?? [0x78, 0x45, 0x58, 0xa1, 0xb2, 0xc3]).copy(b, 8)
  b.writeUInt16BE(opts.flags ?? 0x0003, 14)
  b.writeUInt32BE(1, 32)
  b.writeUInt32BE(opts.length ?? 1234, 36)
  return b
}

describe('parseInformHeader', () => {
  it('reads the device MAC and the flags', () => {
    const h = parseInformHeader(Buffer.concat([header(), Buffer.alloc(16)]))
    expect(h).toEqual({
      version: 0,
      mac: '78:45:58:a1:b2:c3',
      flags: 3,
      encrypted: true,
      compressed: true,
      gcm: false,
      payloadLength: 1234
    })
  })

  it('tells AES-GCM from AES-CBC', () => {
    expect(parseInformHeader(header({ flags: 0x09 }))?.gcm).toBe(true)
  })

  it('is undefined for anything else', () => {
    expect(parseInformHeader(Buffer.from('hello'))).toBeUndefined()
    const wrong = header()
    wrong.write('UBNT', 0, 'latin1')
    expect(parseInformHeader(wrong)).toBeUndefined()
  })
})

// What the device receives, byte for byte: a raw HTTP/1.1 POST over a socket, the way the
// switch sends it, against a relay in front of a stand-in controller.
describe('startInformRelay', () => {
  function listen(server: net.Server): Promise<number> {
    return new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
    )
  }

  /** The relay binds a fixed port by default; the test gives it one nothing else holds. */
  async function freePort(): Promise<number> {
    const probe = net.createServer()
    const port = await listen(probe)
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    return port
  }

  /** Sends one inform the way the switch does, and keeps the connection open until the answer is in. */
  function postRaw(port: number, body: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(
          `POST /inform HTTP/1.1\r\nHost: 10.254.254.1:8080\r\nContent-Type: application/x-binary\r\nContent-Length: ${body.length}\r\n\r\n`
        )
        sock.write(body)
      })
      const done = (): void => {
        sock.destroy()
        resolve(Buffer.concat(chunks).toString('latin1'))
      }
      sock.on('data', (c: Buffer) => {
        chunks.push(c)
        const raw = Buffer.concat(chunks)
        const split = raw.indexOf('\r\n\r\n')
        if (split < 0) return
        const length = /\r\ncontent-length: (\d+)\r\n/i.exec(raw.toString('latin1', 0, split))
        // Without a length the reply would be chunked; let the assertions say so.
        if (!length || raw.length - split - 4 >= Number(length[1])) done()
      })
      sock.on('error', reject)
      setTimeout(done, 2000).unref()
    })
  }

  it('hands the controller answer back whole, with its length, never chunked', async () => {
    // The Flex family's HTTP client cannot read chunked encoding: given a chunked 200 the switch
    // stayed factory default (USW-Flex-2.5G-8-PoE, 2026-10-27). The controller itself answers
    // with a Content-Length, and so must the relay.
    const answer = Buffer.concat([header(), Buffer.from('mgmt_cfg')])
    const controller = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'application/x-binary',
          'content-length': answer.length
        })
        res.end(answer)
      })
    })
    const controllerPort = await listen(controller)
    const exchanges: { status?: number; mac?: string }[] = []
    const relay = await startInformRelay(
      `http://127.0.0.1:${controllerPort}/inform`,
      (x) => exchanges.push(x),
      await freePort()
    )
    try {
      const raw = await postRaw(relay.port, Buffer.concat([header(), Buffer.alloc(16)]))
      const [head, body] = raw.split('\r\n\r\n')
      expect(head).toMatch(/^HTTP\/1\.1 200 OK\r\n/)
      expect(head).toMatch(new RegExp(`\r\ncontent-length: ${answer.length}\r\n`, 'i'))
      expect(head).not.toMatch(/transfer-encoding/i)
      expect(Buffer.from(body, 'latin1')).toEqual(answer)
      expect(exchanges).toEqual([
        { mac: '78:45:58:a1:b2:c3', bytes: 56, status: 200, ms: expect.any(Number) }
      ])
    } finally {
      relay.close()
      controller.close()
    }
  })
})
