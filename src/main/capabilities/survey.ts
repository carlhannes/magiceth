import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from '../util/run-command'
import { runElevatedShell, shQuote } from '../privilege'
import { isValidIpv4 } from '../../shared/net'
import type { SurveyResult, Neighbor, VlanSighting } from '../../shared/types'

// Passive survey of what a port carries. Runs until stopped, pushing results as they accumulate.
//
// The headline signal is 802.1Q tags: a trunk floods tagged broadcast/multicast for every VLAN it
// carries (host ARP/mDNS, and on Cisco a PVST+ BPDU per VLAN every 2 s), so the VLAN IDs can be
// read straight off the wire without the switch advertising anything. LLDP (ethertype 0x88cc) and
// CDP (01:00:0c:cc:cc:cc) are a bonus on top, for switches that do advertise.
//
// One filter covers all of it: LLDP, CDP, STP and ARP are all broadcast or multicast, as is every
// flooded tagged frame. It also excludes unicast, which is the bulk of the traffic on a live
// uplink and tells us nothing here.
const FILTER = 'ether broadcast or ether multicast'

// Hard cap so a lost sentinel file can never leave a root tcpdump running forever.
const MAX_SECONDS = 600
const POLL_MS = 1000
// Enough to recognise the addressing on a VLAN; we are summarising, not inventorying.
const MAX_ADDRESSES = 4

/** Real capture-permission failures. Narrow enough that a success message cannot trip it. */
const DENIED = /permission denied|you don't have permission|\/dev\/bpf/i

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
    // Nothing identified means nothing worth showing. The survey's broad filter also catches
    // tagged LLDP frames whose TLVs tcpdump did not decode, and those would otherwise render as
    // an empty "Protocol LLDP" row.
    if (n.systemName || n.portId || n.vlan != null || n.mgmtAddress) neighbors.push(n)
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

// --- VLAN tallying -------------------------------------------------------------------------

type VlanTally = Map<number, { frames: number; addresses: Set<string> }>

/** Source-ish IPv4 addresses on a packet line, minus the ones that describe no host. */
function hostAddressesIn(line: string): string[] {
  const found = line.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? []
  return found.filter((addr) => {
    if (!isValidIpv4(addr)) return false
    const first = Number(addr.split('.')[0])
    // Multicast (224–239) and 0.0.0.0/255.255.255.255 are destinations, not hosts on the VLAN.
    return first !== 0 && first < 224 && addr !== '255.255.255.255'
  })
}

/**
 * Fold one packet-header line into the tally. tcpdump prints the 802.1Q header on the first line
 * of a packet, so only that line ever needs to be looked at.
 */
function foldVlanLine(tally: VlanTally, line: string): void {
  const m = line.match(/\bvlan (\d+)/i)
  if (!m) return
  const id = Number(m[1])
  if (!Number.isInteger(id) || id < 0 || id > 4094) return

  let entry = tally.get(id)
  if (!entry) {
    entry = { frames: 0, addresses: new Set() }
    tally.set(id, entry)
  }
  entry.frames++
  for (const addr of hostAddressesIn(line)) {
    if (entry.addresses.size >= MAX_ADDRESSES) break
    entry.addresses.add(addr)
  }
}

function toSightings(tally: VlanTally): VlanSighting[] {
  return [...tally.entries()]
    .map(([id, v]) => ({ id, frames: v.frames, addresses: [...v.addresses] }))
    .sort((a, b) => a.id - b.id)
}

/** Every 802.1Q VLAN in a chunk of `tcpdump -e` output, with frame counts and observed hosts. */
export function parseVlanFrames(text: string): VlanSighting[] {
  const tally: VlanTally = new Map()
  for (const line of text.split(/\r?\n/)) foldVlanLine(tally, line)
  return toSightings(tally)
}

// --- The capture ---------------------------------------------------------------------------

/** Arguments for the capture. Shared by the direct and elevated launchers (DRY). */
export function surveyArgs(device: string): string[] {
  return ['-l', '-e', '-nn', '-v', '-s0', '-i', device, FILTER]
}

/**
 * The elevated capture: tcpdump appends to outFile while a loop waits for stopFile to appear.
 * osascript's `do shell script` only returns output once the command exits, so the app cannot read
 * its stdout for a run-until-stopped capture — it tails outFile instead, and creates stopFile to
 * stop, which needs no second password prompt.
 *
 * `kill -9`, not `kill`: SIGTERM does not stop tcpdump while its BPF read is blocked, so `wait`
 * never returns and the collected output is never handed back. That is the exact bug that made
 * this feature report "none heard" with frames on the wire — see docs/VLAN-FINDINGS.md. `-l`
 * keeps the output line-buffered, so SIGKILL loses nothing.
 */
export function surveyScript(device: string, outFile: string, stopFile: string): string {
  const args = surveyArgs(device).map(shQuote).join(' ')
  return (
    `tcpdump ${args} >> ${shQuote(outFile)} 2>&1 & ` +
    `p=$!; n=0; ` +
    `while [ ! -f ${shQuote(stopFile)} ] && [ $n -lt ${MAX_SECONDS} ]; do sleep 1; n=$((n+1)); done; ` +
    `kill -9 $p 2>/dev/null; rm -f ${shQuote(stopFile)}; true`
  )
}

async function toolAvailable(): Promise<boolean> {
  const r = await run('tcpdump', ['--version'], { timeoutMs: 3000 })
  return /tcpdump|libpcap/i.test(`${r.stdout}${r.stderr}`)
}

/**
 * Can we capture without elevating? True where something has opened up /dev/bpf (ChmodBPF) or
 * granted CAP_NET_RAW. The filter deliberately matches nothing: on failure tcpdump exits at once
 * with the permission error, on success it waits and we hit the timeout. SIGKILL on that timeout,
 * because SIGTERM would leave the probe running for the same reason the capture wrapper needs it.
 */
async function canCaptureDirectly(device: string): Promise<boolean> {
  const r = await run(
    'tcpdump',
    ['-i', device, '-c', '1', '-nn', '-w', '/dev/null', 'ether proto 0x9999'],
    { timeoutMs: 1200, killSignal: 'SIGKILL' }
  )
  return !DENIED.test(`${r.stderr}${r.stdout}`)
}

interface ActiveSurvey {
  device: string
  outFile: string
  stopFile: string
  startedAt: number
  offset: number
  remainder: string
  block: string[]
  lldpText: string
  tally: VlanTally
  frames: number
  timer: NodeJS.Timeout
  /** Set for the direct launch; the elevated one is stopped through stopFile instead. */
  child?: ReturnType<typeof spawn>
  onUpdate: (result: SurveyResult) => void
}

let active: ActiveSurvey | null = null

const TIMESTAMP = /^\d{2}:\d{2}:\d{2}\.\d+ /

/** Close the packet block being assembled, keeping it only if a parser can use it. */
function flushBlock(s: ActiveSurvey): void {
  if (s.block.length === 0) return
  const text = s.block.join('\n')
  // Everything else is counted and dropped, which is what keeps memory flat over a long capture.
  if (/\bLLDP\b/.test(text) || /\bCDPv?\d?\b/.test(text)) s.lldpText += `${text}\n`
  s.block = []
}

function ingest(s: ActiveSurvey, chunk: string): void {
  const lines = (s.remainder + chunk).split('\n')
  // A read can land mid-line; hold the tail back until the rest of it arrives.
  s.remainder = lines.pop() ?? ''
  for (const line of lines) {
    if (TIMESTAMP.test(line)) {
      flushBlock(s)
      s.block = [line]
      s.frames++
      foldVlanLine(s.tally, line)
    } else if (s.block.length > 0) {
      s.block.push(line)
    }
  }
}

function snapshot(s: ActiveSurvey, running: boolean): SurveyResult {
  const vlans = toSightings(s.tally)
  const neighbors = parseDiscovery(s.lldpText)
  const found = vlans.length > 0 || neighbors.length > 0
  const elapsedSec = Math.round((Date.now() - s.startedAt) / 1000)
  return {
    status: running || found ? 'ok' : 'none-seen',
    running,
    device: s.device,
    neighbors,
    vlans,
    frames: s.frames,
    elapsedSec,
    message:
      running || found
        ? undefined
        : `No VLAN tags and no LLDP/CDP in ${elapsedSec} s (${s.frames} frames) — the port looks untagged.`
  }
}

/** Read whatever tcpdump has appended since last time. */
function drain(s: ActiveSurvey): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(s.outFile, 'r')
    const size = fs.fstatSync(fd).size
    if (size <= s.offset) return
    // tcpdump writes its "listening on …" banner the moment it starts, so the first bytes are the
    // real start of the capture. Anything before that was spent waiting for the password prompt,
    // which can be minutes and is not time this port was being watched.
    if (s.offset === 0) s.startedAt = Date.now()
    const buf = Buffer.alloc(size - s.offset)
    fs.readSync(fd, buf, 0, buf.length, s.offset)
    s.offset = size
    ingest(s, buf.toString('utf8'))
  } catch {
    // The file may not exist yet on the first tick or two while tcpdump starts up.
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function fail(device: string, status: SurveyResult['status'], message: string): SurveyResult {
  return {
    status,
    running: false,
    device,
    neighbors: [],
    vlans: [],
    frames: 0,
    elapsedSec: 0,
    message
  }
}

/**
 * Start capturing on a device. Resolves as soon as the capture is launched; results arrive through
 * onUpdate until stopSurvey() is called. Only one survey runs at a time.
 */
export async function startSurvey(
  device: string,
  onUpdate: (result: SurveyResult) => void
): Promise<SurveyResult> {
  stopSurvey()

  if (process.platform === 'win32') {
    return fail(
      device,
      'no-tool',
      'The port survey needs tshark + Npcap on Windows (not supported in this version).'
    )
  }
  if (!(await toolAvailable())) {
    return fail(device, 'no-tool', 'tcpdump is missing — install it to survey the port.')
  }

  // Probe before claiming `active`. Everything from here to the launch has to be synchronous: an
  // await in between lets a second start (C pressed twice, or an adapter switch) take over `active`,
  // and this call would then spawn a tcpdump that nothing is tracking and nothing will ever stop.
  const direct = await canCaptureDirectly(device)

  const stamp = `${process.pid}-${Date.now()}`
  const outFile = path.join(os.tmpdir(), `magiceth-survey-${stamp}.txt`)
  const stopFile = path.join(os.tmpdir(), `magiceth-survey-${stamp}.stop`)
  // Create it ourselves so the file belongs to us even when root is the one appending to it.
  fs.writeFileSync(outFile, '')

  const s: ActiveSurvey = {
    device,
    outFile,
    stopFile,
    startedAt: Date.now(),
    offset: 0,
    remainder: '',
    block: [],
    lldpText: '',
    tally: new Map(),
    frames: 0,
    timer: setInterval(() => {
      if (active !== s) return
      drain(s)
      onUpdate(snapshot(s, true))
    }, POLL_MS),
    onUpdate
  }
  active = s

  if (direct) {
    // No shell needed: Node redirects the child's output straight into the file.
    const fd = fs.openSync(outFile, 'a')
    s.child = spawn('tcpdump', surveyArgs(device), { stdio: ['ignore', fd, fd] })
    s.child.on('error', () => stopSurvey())
    fs.closeSync(fd)
  } else {
    // Fire and forget — this only returns when the capture ends, and the prompt happens inside it.
    runElevatedShell(surveyScript(device, outFile, stopFile), MAX_SECONDS * 1000 + 30_000)
      .then((r) => {
        if (active !== s) return
        if (/not authorized|user canceled|-128/i.test(r.stderr)) {
          stopSurvey()
          onUpdate(fail(device, 'needs-privilege', 'Capture cancelled — it needs admin rights.'))
        }
      })
      .catch(() => {
        if (active !== s) return
        stopSurvey()
        onUpdate(fail(device, 'needs-privilege', 'Capture needs admin rights (or ChmodBPF).'))
      })
  }

  return snapshot(s, true)
}

/** Stop the running survey and return everything it collected. Safe to call when none is running. */
export function stopSurvey(): SurveyResult | null {
  const s = active
  if (!s) return null
  active = null
  clearInterval(s.timer)

  if (s.child) {
    // SIGKILL for the same reason the elevated wrapper needs it.
    s.child.kill('SIGKILL')
  } else {
    // The elevated loop is watching for this and kills tcpdump itself — no second prompt.
    try {
      fs.writeFileSync(s.stopFile, '')
    } catch {
      // Nothing more we can do from here; the hard cap in the script is the backstop.
    }
  }

  drain(s)
  flushBlock(s)
  const result = snapshot(s, false)
  try {
    fs.rmSync(s.outFile, { force: true })
  } catch {
    // A leftover temp file is harmless.
  }
  return result
}
