import { run } from '../util/run-command'
import { runElevatedShell, shQuote } from '../privilege'
import type { DiscoveryResult, Neighbor } from '../../shared/types'

// Passive discovery of switch/VLAN via LLDP (ethertype 0x88cc) and CDP (multicast
// 01:00:0c:cc:cc:cc). Requires tcpdump + capture privileges. Optional feature — degrades
// gracefully when tcpdump is missing or nothing is heard.

const FILTER = 'ether proto 0x88cc or ether dst 01:00:0c:cc:cc:cc'

/** Parse tcpdump -v output for LLDP/CDP. Best-effort text extraction. */
export function parseDiscovery(output: string): Neighbor[] {
  const blocks = output.split(/\n(?=\d{2}:\d{2}:\d{2}\.\d+ )/)
  const neighbors: Neighbor[] = []

  for (const block of blocks) {
    const isLldp = /\bLLDP\b/.test(block)
    const isCdp = /\bCDPv?\d?\b/.test(block)
    if (!isLldp && !isCdp) continue

    const n: Neighbor = { protocol: isLldp ? 'LLDP' : 'CDP' }
    if (isLldp) {
      const sys = block.match(/System Name[^:]*:\s*(.+)/i)
      if (sys) n.systemName = sys[1].trim()
      const port = block.match(/Port ID[\s\S]*?Subtype[^:]*:\s*(.+)/i)
      if (port) n.portId = port[1].trim()
      // Read the VLAN value after the colon (avoid capturing the TLV type number, e.g. "(127)").
      const vlan =
        block.match(/Port VLAN ID[^:]*:\s*(?:PVID\s*)?(\d+)/i) ?? block.match(/PVID\D*(\d+)/i)
      if (vlan) n.vlan = parseInt(vlan[1], 10)
      const mgmt = block.match(/Management Address[\s\S]*?((?:\d{1,3}\.){3}\d{1,3})/i)
      if (mgmt) n.mgmtAddress = mgmt[1]
    } else {
      const dev = block.match(/Device-ID[^:]*:\s*'?([^'\n]+?)'?\s*$/im)
      if (dev) n.systemName = dev[1].trim()
      const port = block.match(/Port-ID[^:]*:\s*'?([^'\n]+?)'?\s*$/im)
      if (port) n.portId = port[1].trim()
      const vlan = block.match(/Native VLAN[^:]*:\s*(\d+)/i)
      if (vlan) n.vlan = parseInt(vlan[1], 10)
      const addr = block.match(/Address[\s\S]*?((?:\d{1,3}\.){3}\d{1,3})/i)
      if (addr) n.mgmtAddress = addr[1]
    }
    neighbors.push(n)
  }

  // Deduplicate identical neighbors (the same switch sends repeatedly).
  const seen = new Set<string>()
  return neighbors.filter((n) => {
    const key = `${n.protocol}|${n.systemName ?? ''}|${n.portId ?? ''}|${n.vlan ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function toolAvailable(): Promise<boolean> {
  const r = await run('tcpdump', ['--version'], { timeoutMs: 3000 })
  return /tcpdump|libpcap/i.test(`${r.stdout}${r.stderr}`)
}

/** Listen for LLDP/CDP on an interface for durationSec seconds. */
export async function discover(device: string, durationSec = 35): Promise<DiscoveryResult> {
  if (process.platform === 'win32') {
    return {
      status: 'no-tool',
      neighbors: [],
      message: 'VLAN/LLDP requires tshark + Npcap on Windows (not supported in this version).'
    }
  }
  if (!(await toolAvailable())) {
    return {
      status: 'no-tool',
      neighbors: [],
      message: 'tcpdump is missing — install it for VLAN/switch info.'
    }
  }

  // Try directly first (works if the app has capture privileges, e.g. ChmodBPF).
  const directArgs = ['-l', '-i', device, '-nn', '-v', '-s', '0', FILTER]
  const direct = await run('tcpdump', directArgs, { timeoutMs: durationSec * 1000 + 3000 })
  const denied = /permission denied|you don't have permission|bpf/i.test(direct.stderr)
  let text = `${direct.stdout}\n${direct.stderr}`

  if (denied) {
    // Elevate with a self-killing wrapper so tcpdump exits after durationSec (no orphan processes).
    const cmd =
      `tcpdump -l -i ${shQuote(device)} -nn -v -s0 ${shQuote(FILTER)} 2>&1 & ` +
      `p=$!; sleep ${durationSec}; kill $p 2>/dev/null; wait $p 2>/dev/null; true`
    try {
      const elev = await runElevatedShell(cmd, durationSec * 1000 + 10000)
      if (/not authorized|user canceled|-128/i.test(elev.stderr)) {
        return {
          status: 'needs-privilege',
          neighbors: [],
          message: 'Capture was cancelled — requires admin privileges.'
        }
      }
      text = `${elev.stdout}\n${elev.stderr}`
    } catch {
      return {
        status: 'needs-privilege',
        neighbors: [],
        message: 'Capture requires admin privileges (or install ChmodBPF).'
      }
    }
  }

  const neighbors = parseDiscovery(text)
  if (neighbors.length === 0) {
    return {
      status: 'none-seen',
      neighbors: [],
      message: `No LLDP/CDP heard in ${durationSec} s — the switch may not send it on the access port.`
    }
  }
  return { status: 'ok', neighbors }
}
