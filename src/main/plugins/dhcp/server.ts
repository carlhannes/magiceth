// The socket half of the DHCP server. Unprivileged on every OS the app runs on: macOS and
// Windows let any process bind port 67, and on Linux the address-hold script lowers
// `ip_unprivileged_port_start` for the session. Everything about *what* to answer is in lease.ts.

import dgram from 'node:dgram'
import type { DhcpEvent } from '../../../shared/plugin'
import { parseDhcp } from './codec'
import { decide } from './lease'
import type { LeaseConfig, LeaseTable } from './lease'

const CLIENT_PORT = 68
const SERVER_PORT = 67

export interface DhcpServerHandle {
  close(): void
}

function describeBindError(err: NodeJS.ErrnoException): string {
  if (err.code === 'EADDRINUSE') {
    return 'Port 67 is already taken on this computer — another DHCP server (dnsmasq for libvirt or Docker, Internet Sharing) has to be stopped first.'
  }
  if (err.code === 'EACCES') {
    return 'This computer refused to open port 67 without administrator rights.'
  }
  return `Could not open port 67: ${err.message}`
}

/**
 * Bind port 67 on every interface — a broadcast is only delivered to a socket bound to the
 * wildcard address — and answer on the link's own broadcast. No `reuseAddr`: a second DHCP server
 * on the machine must fail loudly here rather than silently share the port.
 */
export function startDhcpServer(
  cfg: LeaseConfig,
  onEvent: (event: DhcpEvent) => void
): Promise<DhcpServerHandle> {
  const socket = dgram.createSocket({ type: 'udp4' })
  let table: LeaseTable = {}
  // A laptop's own DHCP client, or a neighbour's, asks every few seconds; once is enough to say so.
  const ignoredSeen = new Set<string>()

  socket.on('message', (buf) => {
    const msg = parseDhcp(buf)
    if (!msg) return
    const decision = decide(msg, table, cfg)
    table = decision.table
    for (const event of decision.events) {
      if (event.kind === 'ignored') {
        const key = `${event.mac}|${event.reason}`
        if (ignoredSeen.has(key)) continue
        ignoredSeen.add(key)
      }
      onEvent(event)
    }
    if (decision.reply) {
      socket.send(decision.reply, CLIENT_PORT, cfg.broadcast, (err) => {
        if (err) onEvent({ kind: 'error', message: `Could not send a reply: ${err.message}` })
      })
    }
  })

  return new Promise((resolve, reject) => {
    socket.once('error', (err: NodeJS.ErrnoException) => {
      try {
        socket.close()
      } catch {
        // Already closed.
      }
      reject(new Error(describeBindError(err)))
    })
    socket.bind(SERVER_PORT, '0.0.0.0', () => {
      socket.setBroadcast(true)
      socket.removeAllListeners('error')
      socket.on('error', (err) => onEvent({ kind: 'error', message: err.message }))
      resolve({
        close: () => {
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
