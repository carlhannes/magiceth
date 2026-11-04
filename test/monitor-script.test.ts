import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MONITOR_INTERFACE, linuxMonitorScript } from '../src/main/platform/iw'
import type { MonitorSpec } from '../src/main/platform'

// The listening script is the one piece that changes the machine's network, so it is run, not
// just read: under a real `sh`, with stand-ins for iw, ip, nmcli, tcpdump and stat that write down
// what they were asked to do. What a real card does is for LINUX-TEST.md section 7; what the
// script does with whatever the card does — in what order, and how it puts things back when it is
// stopped, killed or cannot start — is checked here.

const STUBS: Record<string, string> = {
  iw: `echo "iw $*" >> "$CALLS"
case "$*" in
  *"interface add"*) [ -n "$FAIL_ADD" ] && exit 1 ;;
  *"set freq 5500"*) exit 1 ;;
  *"set freq 5180 80 5210"*) [ -n "$FAIL_WIDTH" ] && exit 1 ;;
esac
exit 0`,
  ip: `echo "ip $*" >> "$CALLS"`,
  nmcli: `echo "nmcli $*" >> "$CALLS"
case "$*" in *GENERAL.CONNECTION*) echo Office ;; esac`,
  tcpdump: `echo "tcpdump $*" >> "$CALLS"
echo $$ > "$DIR/tcpdump.pid"
printf 'PCAP'
exec sleep 30`,
  stat: `wc -c < "$3" | tr -d ' '`
}

let dirs: string[] = []
let children: ChildProcess[] = []
afterEach(() => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL')
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
  children = []
})

interface Rig {
  dir: string
  spec: MonitorSpec
  calls: () => string[]
  hops: () => string[]
  start: (env?: Record<string, string>) => { child: ChildProcess; done: Promise<number | null> }
}

function rig(over: Partial<MonitorSpec> = {}, networkManager = true): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'magiceth-script-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  writeFileSync(join(dir, 'README'), '')
  mkdirSync(bin)
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  const spec: MonitorSpec = {
    device: 'wlan0',
    support: { channels: [], networkManager },
    freqs: [2412, 5500, 5180],
    dwellMs: 30,
    pcapFile: join(dir, 'monitor.pcap'),
    hopsFile: join(dir, 'monitor.hops'),
    logFile: join(dir, 'monitor.log'),
    stopFile: join(dir, 'monitor.stop'),
    pinFile: join(dir, 'monitor.pin'),
    maxSeconds: 60,
    maxBytes: 1_000_000,
    ...over
  }
  const read = (file: string): string[] =>
    existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  return {
    dir,
    spec,
    calls: () => read(join(dir, 'calls.log')),
    hops: () => read(spec.hopsFile),
    start: (env = {}) => {
      const child = spawn('sh', ['-c', linuxMonitorScript(spec)], {
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          CALLS: join(dir, 'calls.log'),
          DIR: dir,
          ...env
        },
        stdio: 'ignore'
      })
      children.push(child)
      const done = new Promise<number | null>((resolve) =>
        child.on('exit', (code) => resolve(code))
      )
      return { child, done }
    }
  }
}

async function until(condition: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Index of the first call starting with `prefix`; -1 when there was none. */
const at = (calls: string[], prefix: string): number => calls.findIndex((c) => c.startsWith(prefix))

const NAMES = {
  ready: [
    'nmcli -g GENERAL.CONNECTION device show wlan0',
    'nmcli device set wlan0 managed no',
    'ip link set wlan0 down',
    `iw dev wlan0 interface add ${MONITOR_INTERFACE} type monitor`,
    `ip link set ${MONITOR_INTERFACE} up`,
    'tcpdump -i magicmon0'
  ],
  restored: [
    `iw dev ${MONITOR_INTERFACE} del`,
    'ip link set wlan0 up',
    'nmcli device set wlan0 managed yes',
    'nmcli -w 20 connection up id Office'
  ]
}

describe.skipIf(process.platform === 'win32')('linuxMonitorScript, run', () => {
  it('sets up in order, sweeps the channels, and puts everything back when the stop file appears', async () => {
    const r = rig()
    const { done } = r.start()
    await until(() => r.hops().length >= 4, 'the second sweep to begin')
    writeFileSync(r.spec.stopFile, '')
    expect(await done).toBe(0)

    const calls = r.calls()
    const order = [...NAMES.ready, `iw dev ${MONITOR_INTERFACE} set freq 2412`].map((p) =>
      at(calls, p)
    )
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // Everything is put back, after the last thing the session did, in this order.
    const back = NAMES.restored.map((p) => calls.lastIndexOf(calls.find((c) => c.startsWith(p))!))
    expect(back.every((i) => i > order[order.length - 1])).toBe(true)
    expect([...back].sort((a, b) => a - b)).toEqual(back)

    // The journal tells a channel the card refused from one that was merely quiet.
    expect(r.hops().slice(0, 4)).toEqual(['ok 1 2412', 'fail 1 5500', 'ok 1 5180', 'ok 2 2412'])
    expect(existsSync(r.spec.stopFile)).toBe(false)
    // tcpdump was killed with the session.
    const pid = Number(readFileSync(join(r.dir, 'tcpdump.pid'), 'utf8'))
    await until(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, 'tcpdump to be gone')
  })

  it('restores and exits 143 when it is terminated mid-sweep', async () => {
    const r = rig()
    const { child, done } = r.start()
    await until(() => r.hops().length >= 2, 'the sweep to begin')
    child.kill('SIGTERM')
    expect(await done).toBe(143)
    const calls = r.calls()
    for (const prefix of NAMES.restored) expect(at(calls, prefix)).toBeGreaterThan(-1)
  })

  it('restores, writes nothing to the capture, and exits 1 when the monitor interface cannot be added', async () => {
    const r = rig()
    const { done } = r.start({ FAIL_ADD: '1' })
    expect(await done).toBe(1)
    const calls = r.calls()
    expect(at(calls, 'tcpdump')).toBe(-1)
    // The station was taken down and must come back, and so must NetworkManager's hold on it.
    expect(at(calls, 'ip link set wlan0 up')).toBeGreaterThan(at(calls, 'ip link set wlan0 down'))
    expect(at(calls, 'nmcli device set wlan0 managed yes')).toBeGreaterThan(-1)
  })

  it('leaves NetworkManager alone on a machine without it', async () => {
    const r = rig({}, false)
    const { done } = r.start()
    await until(() => r.hops().length >= 1, 'the first dwell')
    writeFileSync(r.spec.stopFile, '')
    expect(await done).toBe(0)
    expect(r.calls().some((c) => c.startsWith('nmcli'))).toBe(false)
    expect(at(r.calls(), 'ip link set wlan0 up')).toBeGreaterThan(-1)
  })

  it('holds one channel at its width while a pin file exists, and sweeps again once it is gone', async () => {
    const r = rig({ freqs: [2412, 2437] })
    const { done } = r.start()
    await until(() => r.hops().length >= 2, 'a first sweep')
    writeFileSync(r.spec.pinFile, '5180 80 5210\n')
    await until(
      () => r.calls().some((c) => c.endsWith('set freq 5180 80 5210')),
      'the pin to apply'
    )
    const before = r.hops().length
    await until(() => r.hops().length >= before + 6, 'dwells while pinned')
    const pinned = r.hops().slice(before)
    expect(pinned.every((h) => h.endsWith(' 5180'))).toBe(true)
    rmSync(r.spec.pinFile)
    await until(
      () =>
        r
          .hops()
          .slice(before + 6)
          .some((h) => h.endsWith(' 2412')),
      'the sweep to resume'
    )
    writeFileSync(r.spec.stopFile, '')
    expect(await done).toBe(0)
  })

  it('falls back to the plain channel when the card refuses the width', async () => {
    const r = rig({ freqs: [2412] })
    const { done } = r.start({ FAIL_WIDTH: '1' })
    await until(() => r.hops().length >= 1, 'the first dwell')
    writeFileSync(r.spec.pinFile, '5180 80 5210\n')
    await until(
      () => r.hops().some((h) => h.endsWith(' 5180') && h.startsWith('ok')),
      'the fallback'
    )
    expect(r.calls().some((c) => c.endsWith('set freq 5180'))).toBe(true)
    writeFileSync(r.spec.stopFile, '')
    expect(await done).toBe(0)
  })

  it('ends by itself when the capture reaches its size cap, and restores', async () => {
    const r = rig({ maxBytes: 3 }) // the stand-in tcpdump writes four bytes
    const { done } = r.start()
    expect(await done).toBe(0)
    expect(at(r.calls(), 'ip link set wlan0 up')).toBeGreaterThan(-1)
  })

  it('ends by itself when tcpdump dies, and restores', async () => {
    const r = rig()
    const { done } = r.start()
    await until(() => existsSync(join(r.dir, 'tcpdump.pid')), 'tcpdump to start')
    process.kill(Number(readFileSync(join(r.dir, 'tcpdump.pid'), 'utf8')), 'SIGKILL')
    expect(await done).toBe(1)
    expect(at(r.calls(), 'nmcli device set wlan0 managed yes')).toBeGreaterThan(-1)
  })
})

describe('linuxMonitorScript, written', () => {
  const spec = rig().spec

  it('refuses frequencies that are not plain integers, and an empty list', () => {
    expect(() => linuxMonitorScript({ ...spec, freqs: [2412, NaN] })).toThrow(/integers/)
    expect(() => linuxMonitorScript({ ...spec, freqs: [] })).toThrow(/at least one/)
    expect(() =>
      linuxMonitorScript({ ...spec, freqs: ['5180; reboot' as unknown as number] })
    ).toThrow()
  })

  it('quotes the device and every file name, so odd names cannot add commands', () => {
    const script = linuxMonitorScript({
      ...spec,
      device: "wl'an; reboot",
      pcapFile: '/tmp/a b/$(id).pcap'
    })
    expect(script).toContain(`D='wl'\\''an; reboot'`)
    expect(script).toContain(`'/tmp/a b/$(id).pcap'`)
  })

  it('reads as valid shell', async () => {
    const check = spawn('sh', ['-n', '-c', linuxMonitorScript(spec)])
    const code = await new Promise((resolve) => check.on('exit', resolve))
    expect(code).toBe(0)
  })

  it('runs restore on every way out, and never exits with the codes that mean a refused prompt', () => {
    const script = linuxMonitorScript(spec)
    expect(script).toMatch(/trap restore EXIT/)
    expect(script).toMatch(/trap 'exit 143' TERM/)
    expect(script).not.toMatch(/exit 12[67]\b/)
    // tcpdump is killed outright before anything is put back.
    expect(script.indexOf('kill -9')).toBeLessThan(script.indexOf('iw dev "$M" del'))
  })
})
