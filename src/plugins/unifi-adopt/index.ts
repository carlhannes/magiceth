// UniFi adoption: point a factory-default device at a remote controller from this port.
//
// The device gets a lease from this laptop with option 43 naming the controller's address, and
// the laptop shares its own internet with the link for the session, so the device talks to the
// controller directly, exactly as it will from its final network. Clicking Adopt there completes
// the adoption on the bench; the device keeps the controller's inform host (the Override Inform
// Host set there once) and comes back online wherever it is cabled in afterwards. Discovery on
// UDP 10001 shows the device as it appears, with model, firmware and whether it is still factory
// default; it stops announcing once adopted, which is the sign the adoption took.
//
// Three screens: the saved controllers, the form for one, and a running session.

import dns from 'node:dns'
import type {
  Block,
  DhcpEvent,
  DhcpLink,
  DhcpSession,
  KeyPress,
  PluginHost,
  PluginInstance,
  PluginView
} from '../../shared/plugin'
import { startDiscovery } from './discovery'
import type { DiscoveredDevice, DiscoveryHandle } from './discovery'
import { normalizeInformUrl } from './inform-url'
import { option43Hex } from './option43'

interface Target {
  id: string
  name: string
  informUrl: string
}

interface Stored {
  targets: Target[]
}

interface Form {
  id?: string
  values: Record<string, string>
  error?: string
}

interface Run {
  target: Target
  startedAt: number
  /** The controller's hostname as saved, and the address it resolved to for option 43. */
  controller?: { host: string; ip: string }
  session?: DhcpSession
  link?: DhcpLink
  /** Where the device's traffic leaves this laptop, once the host reports it. */
  upstream?: { device: string; dnsServers: string[] }
  discovery?: DiscoveryHandle
  /** The address is on the port and port 67 is open. */
  listening: boolean
  leases: Map<string, string>
  devices: Map<string, DiscoveredDevice & { from: string; seenAt: number }>
  /** Re-renders while the session runs, so the age on a device row keeps counting. */
  ticker?: NodeJS.Timeout
  ended?: string
  error?: string
}

const FORM_ID = 'controller'
/** Ubiquiti devices identify themselves with this vendor class; nothing else ever gets a lease. */
const VENDOR_CLASS = 'ubnt'
/** Where a UniFi device puts itself when no DHCP server answers; its discovery packets come from here. */
const UBNT_FALLBACK_IP = '192.168.1.20'
/**
 * A device announces itself every few seconds only while it is unadopted, so a row this old is
 * history: the flag it last sent no longer says what the device is now.
 */
const DISCOVERY_STALE_MS = 30_000

const PREREQUISITES =
  'Connect the device to this port and nothing else — power it from a PoE injector or USB-C. Keep this laptop online (Wi-Fi, a phone): the device gets its internet through it for the session and talks to the controller directly. On the controller, set Override Inform Host once, to its hostname, then click Adopt when the device shows up there.'

function isTarget(value: unknown): value is Target {
  if (typeof value !== 'object' || value === null) return false
  const t = value as Record<string, unknown>
  return typeof t.id === 'string' && typeof t.name === 'string' && typeof t.informUrl === 'string'
}

/**
 * A plugin is standalone by design: it may use Node built-ins and its own files, nothing from the
 * app — the same rule a user plugin lives under, and the build enforces it. Hence a local copy.
 */
function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) | (parseInt(octet, 10) & 0xff)) >>> 0, 0)
}

function inSubnet(ip: string, link: DhcpLink): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false
  const mask = link.cidr === 0 ? 0 : (0xffffffff << (32 - link.cidr)) >>> 0
  return (ipToInt(ip) & mask) >>> 0 === (ipToInt(link.serverIp) & mask) >>> 0
}

export function activate(host: PluginHost): PluginInstance {
  let targets = host.storage.load<Stored>({ targets: [] }).targets.filter(isTarget)
  let sel = 0
  let form: Form | null = null
  let pendingDelete: string | null = null
  let run: Run | null = null

  function save(): void {
    host.storage.save({ targets } satisfies Stored)
  }

  // --- The session ---

  function onDhcp(r: Run, event: DhcpEvent): void {
    if (run !== r) return
    switch (event.kind) {
      case 'address':
        r.listening = true
        r.upstream = event.upstream
        r.discovery?.setProbeTarget(r.link?.broadcast ?? '')
        host.log(
          `DHCP server on ${event.serverIp}/${event.cidr}${event.upstream ? `, internet shared from ${event.upstream.device} (DNS ${event.upstream.dnsServers.join(', ')})` : ''} — plug the device in now.`
        )
        break
      case 'discover':
        host.log(
          `DHCP discover from ${event.mac}${event.hostname ? ` (${event.hostname})` : ''}, vendor class ${event.vendorClass ?? 'none'}.`
        )
        break
      case 'offer':
        host.log(`Offered ${event.ip} to ${event.mac}.`)
        break
      case 'ack': {
        // The Flex Mini renews every 60 s (half its 120 s lease); only a new or changed lease
        // is worth a line. The table above shows the current state either way.
        const renewal = r.leases.get(event.mac) === event.ip
        r.leases.set(event.mac, event.ip)
        if (renewal) host.update()
        else
          host.log(
            `Lease ${event.ip} → ${event.mac}. It has the controller's address and a way out; it should show up there as pending within a minute.`
          )
        break
      }
      case 'release':
        r.leases.delete(event.mac)
        host.log(`${event.mac} released ${event.ip}.`)
        break
      case 'ignored':
        host.log(`Ignored ${event.mac}: ${event.reason}.`)
        break
      case 'error':
        r.error = event.message
        host.log(`Error: ${event.message}`)
        break
      case 'stopped':
        if (!r.ended) void stop(r, event.reason)
        break
    }
  }

  function onDiscovered(r: Run, device: DiscoveredDevice, from: string): void {
    if (run !== r) return
    // The socket hears every interface. Keep what can only be on this link: our subnet, or the
    // address a UniFi device gives itself before any lease.
    const onLink =
      from === UBNT_FALLBACK_IP ||
      (r.link !== undefined &&
        (inSubnet(from, r.link) || (device.ip !== undefined && inSubnet(device.ip, r.link))))
    if (!onLink) return
    const key = device.mac ?? from
    const first = !r.devices.has(key)
    r.devices.set(key, { ...device, from, seenAt: Date.now() })
    if (first) {
      const what = [device.model ?? device.product, device.version ?? device.firmware]
        .filter(Boolean)
        .join(' · ')
      host.log(
        `Discovered ${key}${what ? ` (${what})` : ''} at ${device.ip ?? from}${device.isDefault === false ? ', already adopted' : ''}.`
      )
    } else {
      host.update()
    }
  }

  async function start(target: Target): Promise<void> {
    const r: Run = {
      target,
      startedAt: Date.now(),
      listening: false,
      leases: new Map(),
      devices: new Map()
    }
    run = r
    host.clearLog()
    host.update()
    try {
      // Option 43 carries an address, not a name, so the controller is resolved here, on the
      // laptop; an address typed as the controller resolves to itself. Later the device gets the
      // hostname from the controller and resolves it with the DNS the lease hands it.
      const controllerHost = new URL(target.informUrl).hostname
      const ip = await dns.promises
        .lookup(controllerHost, { family: 4 })
        .then((a) => a.address)
        .catch(() => {
          throw new Error(`Could not resolve ${controllerHost} — is this laptop online?`)
        })
      r.controller = { host: controllerHost, ip }
      host.log(
        controllerHost === ip
          ? `Controller ${ip}: option 43 will carry that address.`
          : `Controller ${controllerHost} is ${ip}: option 43 will carry that address.`
      )
      // The unprivileged listener first, so a taken port fails before any admin prompt.
      r.discovery = await startDiscovery((d, from) => onDiscovered(r, d, from))
      r.session = await host.dhcp.start({
        vendorClassPrefix: VENDOR_CLASS,
        shareInternet: true,
        options: () => [{ code: 43, hex: option43Hex({ ip }) }],
        onEvent: (event) => onDhcp(r, event)
      })
      r.link = {
        serverIp: r.session.serverIp,
        cidr: r.session.cidr,
        broadcast: r.session.broadcast
      }
      r.ticker = setInterval(() => host.update(), 5000)
      host.log(`Waiting for admin approval to put ${r.session.serverIp} on ${host.device}…`)
    } catch (err) {
      r.error = err instanceof Error ? err.message : String(err)
      host.log(`Could not start: ${r.error}`)
      await stop(r, 'could not start')
    }
  }

  async function stop(r: Run, reason: string): Promise<void> {
    if (r.ended) return
    r.ended = reason
    if (r.ticker) clearInterval(r.ticker)
    r.discovery?.close()
    r.session?.stop()
    host.log(
      `Session ended: ${reason}.${r.upstream ? ' Internet sharing and the address are being removed.' : ''}`
    )
  }

  // --- Screens ---

  function targetRows(): string[] {
    return targets.map((t) => `${t.name} — ${t.informUrl}`)
  }

  function renderTargets(): PluginView {
    const blocks: Block[] = [
      { kind: 'text', text: PREREQUISITES, tone: 'muted' },
      {
        kind: 'list',
        title: 'Controllers',
        rows: targetRows(),
        selected: sel,
        empty:
          'No controller saved yet — press N and enter its inform URL, e.g. http://unifi.example.com:8080/inform.'
      }
    ]
    const t = targets[sel]
    if (pendingDelete && t && pendingDelete === t.id) {
      blocks.push({ kind: 'text', text: `Press D again to delete "${t.name}".`, tone: 'warn' })
    }
    if (run?.ended) {
      blocks.push({ kind: 'log', title: 'Last session', lines: host.lines() })
    }
    return {
      blocks,
      keys: [
        { key: '↑↓', label: 'select' },
        { key: 'Enter', label: 'start' },
        { key: 'N', label: 'new' },
        { key: 'E', label: 'edit' },
        { key: 'D', label: 'delete' }
      ]
    }
  }

  function renderForm(f: Form): PluginView {
    return {
      blocks: [
        {
          kind: 'form',
          id: FORM_ID,
          title: f.id ? 'Edit controller' : 'New controller',
          fields: [
            { key: 'name', label: 'Name', value: f.values.name ?? '', hint: 'Head office' },
            {
              key: 'informUrl',
              label: 'Inform URL (or just the hostname)',
              value: f.values.informUrl ?? '',
              hint: 'http://unifi.example.com:8080/inform'
            }
          ],
          error: f.error
        }
      ],
      keys: []
    }
  }

  function quietSeconds(seenAt: number): number {
    return Math.round((Date.now() - seenAt) / 1000)
  }

  function deviceRows(r: Run): string[] {
    return [...r.devices.values()]
      .sort((a, b) => a.seenAt - b.seenAt)
      .map((d) => {
        const name = d.model ?? d.product ?? d.hostname ?? 'UniFi device'
        const quiet = quietSeconds(d.seenAt)
        const state =
          quiet * 1000 > DISCOVERY_STALE_MS
            ? ` · quiet for ${quiet} s`
            : d.isDefault === undefined
              ? ''
              : d.isDefault
                ? ' · factory default'
                : ' · adopted'
        const fw = d.version ?? d.firmware
        return `${name} · ${d.mac ?? d.from} · ${d.ip ?? d.from}${fw ? ` · ${fw}` : ''}${state}`
      })
  }

  /** A leased device stopped announcing itself: it is adopted and talking to the controller. */
  function wentQuiet(r: Run): boolean {
    if (r.leases.size === 0) return false
    return [...r.devices.values()].some((d) => quietSeconds(d.seenAt) * 1000 > DISCOVERY_STALE_MS)
  }

  function renderRunning(r: Run): PluginView {
    const live = !r.ended
    const where = r.link ? `${r.link.serverIp}/${r.link.cidr}` : 'choosing a subnet…'
    const controller = r.controller
      ? r.controller.host === r.controller.ip
        ? r.controller.ip
        : `${r.controller.host} = ${r.controller.ip}`
      : r.target.informUrl
    const internet = r.upstream
      ? `shared from ${r.upstream.device} (NAT) · DNS ${r.upstream.dnsServers.join(', ')}`
      : live
        ? 'shared once the address is up'
        : 'was shared for the session'
    const blocks: Block[] = [
      {
        kind: 'table',
        title: r.target.name,
        rows: [
          ['Controller', controller],
          [
            'This laptop',
            r.listening ? where : live ? `${where} — waiting for admin approval` : where
          ],
          ['Internet', internet],
          [
            'Leases',
            r.leases.size === 0
              ? 'none yet'
              : [...r.leases.entries()].map(([mac, ip]) => `${ip} ${mac}`).join(', ')
          ]
        ]
      },
      {
        kind: 'list',
        title: 'Devices seen',
        rows: deviceRows(r),
        empty: 'Nothing discovered yet.'
      },
      { kind: 'log', title: 'Activity', lines: host.lines() }
    ]
    if (r.ended) {
      blocks.splice(1, 0, {
        kind: 'text',
        text: `Ended: ${r.ended}. A device adopted here keeps the controller's address and comes back online in the controller wherever it has internet.`,
        tone: r.error ? 'warn' : 'muted'
      })
    } else if (r.leases.size > 0) {
      blocks.splice(
        1,
        0,
        wentQuiet(r)
          ? {
              kind: 'text',
              text: 'The device went quiet here, which is what adoption looks like: it now talks to the controller directly through this laptop. Once the controller shows it online and provisioned, stop the session and ship it.',
              tone: 'muted'
            }
          : {
              kind: 'text',
              text: 'The device has an address, the controller’s address and a way out through this laptop. It should appear in the controller as pending within a minute; click Adopt there.',
              tone: 'muted'
            }
      )
    }
    return {
      status: live
        ? r.listening
          ? `serving ${where}${r.upstream ? ` · internet via ${r.upstream.device}` : ''}`
          : 'starting…'
        : 'ended',
      busy: live && !r.listening,
      running: live,
      blocks,
      keys: [{ key: 'S', label: live ? 'stop' : 'back to the list' }]
    }
  }

  function render(): PluginView {
    if (form) return renderForm(form)
    if (run && (!run.ended || run.leases.size > 0 || run.error)) return renderRunning(run)
    return renderTargets()
  }

  // --- Keys ---

  function openForm(target?: Target): void {
    form = {
      id: target?.id,
      values: target ? { name: target.name, informUrl: target.informUrl } : {}
    }
  }

  async function onKey(key: KeyPress): Promise<void> {
    if (form) {
      if (key.key === 'Escape') form = null
      return
    }
    if (run && render() === undefined) return

    const onRunning = run !== null && !run.ended
    if (onRunning) {
      if (key.key === 's' || key.key === 'S') await stop(run!, 'stopped')
      return
    }
    if (run?.ended && (key.key === 's' || key.key === 'S')) {
      run = null
      return
    }

    const wasPending = pendingDelete
    pendingDelete = null
    const n = targets.length
    switch (key.key) {
      case 'ArrowDown':
        if (n > 0) sel = (sel + 1) % n
        break
      case 'ArrowUp':
        if (n > 0) sel = (sel - 1 + n) % n
        break
      case 'Enter':
        if (targets[sel]) {
          run = null
          await start(targets[sel])
        }
        break
      case 'n':
      case 'N':
        openForm()
        break
      case 'e':
      case 'E':
        if (targets[sel]) openForm(targets[sel])
        break
      case 'd':
      case 'D':
      case 'Backspace':
      case 'Delete': {
        const t = targets[sel]
        if (!t) break
        if (wasPending === t.id) {
          targets = targets.filter((x) => x.id !== t.id)
          sel = Math.min(sel, Math.max(0, targets.length - 1))
          save()
        } else {
          pendingDelete = t.id
        }
        break
      }
    }
  }

  function onSubmit(formId: string, values: Record<string, string>): void {
    if (formId !== FORM_ID || !form) return
    const name = (values.name ?? '').trim()
    const url = normalizeInformUrl(values.informUrl ?? '')
    if (!name) {
      form = { ...form, values, error: 'A name is required.' }
      return
    }
    if (!url.ok) {
      form = { ...form, values, error: url.error }
      return
    }
    const id = form.id ?? `t-${Date.now().toString(36)}`
    const target: Target = { id, name, informUrl: url.url }
    const idx = targets.findIndex((t) => t.id === id)
    targets = idx >= 0 ? targets.map((t) => (t.id === id ? target : t)) : [...targets, target]
    sel = targets.findIndex((t) => t.id === id)
    save()
    form = null
  }

  async function deactivate(): Promise<void> {
    if (run) await stop(run, 'the plugin was closed')
  }

  return { render, onKey, onSubmit, deactivate }
}
