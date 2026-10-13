// Ubiquiti's discovery protocol on UDP 10001, the way nmap's ubiquiti-discovery.nse reads it
// (checked 2026-10-13): a four-byte header — version, command, big-endian length — then TLVs of
// one type byte, a big-endian two-byte length and the value. Unadopted devices announce themselves
// with the same packet unasked, and anyone can ask with the v1 probe. parseDiscovery is pure and
// tested in test/discovery.test.ts.

import dgram from 'node:dgram'

export const DISCOVERY_PORT = 10001
export const PROBE_V1 = Buffer.from([0x01, 0x00, 0x00, 0x00])
const PROBE_INTERVAL_MS = 5000

export interface DiscoveredDevice {
  mac?: string
  ip?: string
  firmware?: string
  hostname?: string
  product?: string
  model?: string
  version?: string
  uptimeSec?: number
  /** From TLV 0x17: 1 means factory default, which for a UniFi device means unadopted. */
  isDefault?: boolean
  /** Types the parser does not know, as hex, so a capture can be read back later. */
  unknown: Record<string, string>
}

function macOf(buf: Buffer): string {
  return [...buf.subarray(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join(':')
}

function text(buf: Buffer): string {
  return buf.toString('utf8').replace(/\0+$/, '').trim()
}

export function parseDiscovery(buf: Buffer): DiscoveredDevice | undefined {
  if (buf.length < 4) return undefined
  const version = buf[0]
  if (version !== 1 && version !== 2) return undefined
  const declared = buf.readUInt16BE(2)
  const end = Math.min(buf.length, 4 + declared || buf.length)
  const device: DiscoveredDevice = { unknown: {} }
  let i = 4
  while (i + 3 <= end) {
    const type = buf[i]
    const len = buf.readUInt16BE(i + 1)
    const value = buf.subarray(i + 3, Math.min(i + 3 + len, end))
    i += 3 + len
    switch (type) {
      case 0x01:
        if (value.length >= 6) device.mac = macOf(value)
        break
      case 0x02:
        if (value.length >= 10) {
          device.mac = device.mac ?? macOf(value)
          device.ip = [...value.subarray(6, 10)].join('.')
        }
        break
      case 0x03:
        device.firmware = text(value)
        break
      case 0x0a:
        if (value.length >= 4) device.uptimeSec = value.readUInt32BE(0)
        break
      case 0x0b:
        device.hostname = text(value)
        break
      case 0x0c:
        device.product = text(value)
        break
      case 0x14:
      case 0x15:
        device.model = text(value)
        break
      case 0x16:
        device.version = text(value)
        break
      case 0x17:
        if (value.length === 4) device.isDefault = value.readUInt32BE(0) !== 0
        else if (value.length >= 1) device.isDefault = value[0] !== 0
        break
      default:
        device.unknown[`0x${type.toString(16).padStart(2, '0')}`] = value.toString('hex')
    }
  }
  return device
}

export interface DiscoveryHandle {
  /** Start probing this broadcast address every few seconds (once the link's address exists). */
  setProbeTarget(broadcast: string): void
  close(): void
}

export function startDiscovery(
  onDevice: (device: DiscoveredDevice, from: string) => void
): Promise<DiscoveryHandle> {
  const socket = dgram.createSocket({ type: 'udp4' })
  let probe: NodeJS.Timeout | undefined
  let target: string | undefined

  socket.on('message', (buf, rinfo) => {
    if (buf.equals(PROBE_V1)) return
    const device = parseDiscovery(buf)
    if (device) onDevice(device, rinfo.address)
  })

  const sendProbe = (): void => {
    if (!target) return
    socket.send(PROBE_V1, DISCOVERY_PORT, target, () => undefined)
  }

  return new Promise((resolve, reject) => {
    socket.once('error', (err: NodeJS.ErrnoException) => {
      try {
        socket.close()
      } catch {
        // Already closed.
      }
      reject(
        new Error(
          err.code === 'EADDRINUSE'
            ? `Port ${DISCOVERY_PORT} is in use — a UniFi controller or discovery tool on this computer holds it.`
            : `Could not open port ${DISCOVERY_PORT}: ${err.message}`
        )
      )
    })
    socket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
      socket.setBroadcast(true)
      socket.removeAllListeners('error')
      socket.on('error', () => undefined)
      resolve({
        setProbeTarget(broadcast) {
          target = broadcast
          sendProbe()
          if (!probe) probe = setInterval(sendProbe, PROBE_INTERVAL_MS)
        },
        close() {
          if (probe) clearInterval(probe)
          probe = undefined
          try {
            socket.close()
          } catch {
            // Already closed.
          }
        }
      })
    })
  })
}
