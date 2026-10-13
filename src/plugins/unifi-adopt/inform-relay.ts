// The inform relay: the device POSTs to http://<this laptop>:8080/inform, because that is the
// URL it builds from option 43, and each POST is forwarded as-is to the controller the user saved.
// The body is Ubiquiti's binary inform packet, encrypted end to end; only its header is read, for
// the device MAC in the log. parseInformHeader is pure and tested in test/inform-relay.test.ts.

import http from 'node:http'
import https from 'node:https'

/** Fixed by the device: option 43 sub-option 1 carries an address, and the device appends this. */
export const INFORM_PORT = 8080
const UPSTREAM_TIMEOUT_MS = 20_000
/** Informs are a few kilobytes; a megabyte is already absurd. */
const MAX_BODY = 4 * 1024 * 1024

export interface InformHeader {
  version: number
  mac: string
  flags: number
  encrypted: boolean
  compressed: boolean
  gcm: boolean
  payloadLength: number
}

/** `TNBU`, version, MAC, flags, IV, data version, payload length — 40 bytes before the payload. */
export function parseInformHeader(buf: Buffer): InformHeader | undefined {
  if (buf.length < 40 || buf.toString('latin1', 0, 4) !== 'TNBU') return undefined
  const flags = buf.readUInt16BE(14)
  return {
    version: buf.readUInt32BE(4),
    mac: [...buf.subarray(8, 14)].map((b) => b.toString(16).padStart(2, '0')).join(':'),
    flags,
    encrypted: (flags & 0x01) !== 0,
    compressed: (flags & 0x02) !== 0,
    gcm: (flags & 0x08) !== 0,
    payloadLength: buf.readUInt32BE(36)
  }
}

export interface InformExchange {
  mac?: string
  bytes: number
  status?: number
  ms: number
  error?: string
}

export interface RelayHandle {
  port: number
  close(): void
}

function collect(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('inform body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function startInformRelay(
  targetUrl: string,
  onExchange: (exchange: InformExchange) => void
): Promise<RelayHandle> {
  const target = new URL(targetUrl)
  const client = target.protocol === 'https:' ? https : http

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !(req.url ?? '').startsWith('/inform')) {
      res.statusCode = 404
      res.end()
      return
    }
    const startedAt = Date.now()
    void collect(req)
      .then((body) => {
        const mac = parseInformHeader(body)?.mac
        const upstream = client.request(
          target,
          {
            method: 'POST',
            headers: {
              'content-type': req.headers['content-type'] ?? 'application/x-binary',
              'content-length': body.length,
              'user-agent': req.headers['user-agent'] ?? 'magiceth inform relay'
            },
            timeout: UPSTREAM_TIMEOUT_MS
          },
          (reply) => {
            res.statusCode = reply.statusCode ?? 502
            const type = reply.headers['content-type']
            if (type) res.setHeader('content-type', type)
            reply.pipe(res)
            reply.on('end', () =>
              onExchange({
                mac,
                bytes: body.length,
                status: reply.statusCode,
                ms: Date.now() - startedAt
              })
            )
          }
        )
        upstream.on('timeout', () =>
          upstream.destroy(new Error('the controller did not answer in time'))
        )
        upstream.on('error', (err) => {
          if (!res.headersSent) res.statusCode = 502
          res.end()
          onExchange({ mac, bytes: body.length, ms: Date.now() - startedAt, error: err.message })
        })
        upstream.end(body)
      })
      .catch((err: Error) => {
        res.statusCode = 400
        res.end()
        onExchange({ bytes: 0, ms: Date.now() - startedAt, error: err.message })
      })
  })

  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === 'EADDRINUSE'
            ? `Port ${INFORM_PORT} is in use on this computer. A device builds its inform URL from option 43 as http://<address>:${INFORM_PORT}/inform, so whatever holds the port (a development server?) has to be stopped first.`
            : `Could not open port ${INFORM_PORT}: ${err.message}`
        )
      )
    })
    server.listen(INFORM_PORT, '0.0.0.0', () => {
      server.removeAllListeners('error')
      server.on('error', () => undefined)
      resolve({ port: INFORM_PORT, close: () => server.close() })
    })
  })
}
