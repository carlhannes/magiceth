import type {
  Diagnostics,
  Adapter,
  NetInfo,
  PingResult,
  Profile,
  SpeedPhase,
  SpeedTestResult,
  SurveyResult
} from '../../shared/types'
import { isLinkLocalIpv4 } from '../../shared/net'
import { pickSelected } from '../../shared/adapter'
import { validateProfileDraft } from '../../shared/profile'
import type { ProfileDraftInput } from '../../shared/profile'
import { clock, escapeHtml, plural, row, speedText } from './view'
import {
  app,
  confirmStep,
  consumePending,
  getPending,
  renderShell,
  requestRender,
  setMode,
  setNotice,
  setPending,
  setRenderSuspended
} from './shell'

// --- State ---
let adapters: Adapter[] = []
let selected = 0
let diag: Diagnostics | null = null
let running = false
let survey: SurveyResult | null = null
let surveyDevice: string | null = null
let surveying = false
let speed: SpeedTestResult | null = null
let speedDevice: string | null = null
let measuring = false
let profiles: Profile[] = []
let panel = false // profile panel open
let info = false // chipset info sub-view open (mutually exclusive with the profile panel)
let profileSel = 0
let busy = false // privileged action in progress
let editorOpen = false // profile form is shown (pauses background re-render)
let editorProfile: Profile | null = null // profile being edited (null = new)

/** True for the machine's own ports, which the chipset database says nothing about. */
function isBuiltIn(d: Adapter): boolean {
  return d.kind !== 'usb'
}

/**
 * IDENTIFIED/UNKNOWN is a statement about the chipset database, which only covers USB dongles —
 * so applying it to built-in Wi-Fi would read as "we do not recognise your laptop", which is both
 * untrue and alarming. Built-ins say what they are instead.
 */
function badgeText(d: Adapter): string {
  if (d.kind === 'wifi') return 'WI-FI'
  if (d.kind === 'ethernet') return 'BUILT-IN'
  return d.known ? 'IDENTIFIED' : 'UNKNOWN'
}

function cardClass(d: Adapter): string {
  return isBuiltIn(d) ? 'builtin' : d.known ? 'known' : 'unknown'
}

/**
 * The link row. Wi-Fi reports no `baseT` media on macOS, so there is no negotiated rate to show —
 * "up" alone says what is known, where "up · —" reads like something failed to load.
 */
function linkText(net: NetInfo): string {
  const parts = ['up']
  if (net.linkSpeedMbps) parts.push(speedText(net.linkSpeedMbps))
  if (net.duplex) parts.push(`${net.duplex} duplex`)
  return parts.join(' · ')
}

function pingClass(p?: PingResult): string {
  if (!p) return 'bad'
  if (p.ok && (p.lossPct ?? 0) === 0) return 'ok'
  if (p.ok) return 'warn'
  return 'bad'
}

function pingText(p?: PingResult): string {
  if (!p) return '—'
  if (!p.ok) return 'no response'
  const rtt = p.avgMs != null ? `${p.avgMs.toFixed(1)} ms` : 'response'
  const jitter = p.jitterMs != null ? ` ±${p.jitterMs.toFixed(1)}` : ''
  // Always spell the loss out, 0% included: "we measured and it was clean" and "we never really
  // measured" must not look the same on screen.
  const loss = p.lossPct != null ? ` · ${p.lossPct}% loss` : ''
  return `${rtt}${jitter}${loss}`
}

function currentNet() {
  const d = adapters[selected]
  return d && diag && diag.device === d.device ? diag.net : null
}

function renderSelector(): string {
  if (adapters.length <= 1) return ''
  return `<div class="selector">${adapters
    .map((d, i) => {
      // Lead with the device: it is the one thing guaranteed unique, so two adapters of the same
      // model stay tellable apart. The vendor is dropped — the card below spells it out in full.
      const name = `${d.device} · ${d.chipset ? d.chipset.chipset : d.portName || 'USB Ethernet'}`
      return `<span class="chip${i === selected ? ' active' : ''}">${escapeHtml(name)}</span>`
    })
    .join('')}<span class="selector-hint">↑ ↓ switch</span></div>`
}

function renderDiagnostics(d: Adapter): string {
  const chip = d.chipset
  const title = chip ? `${chip.vendor} ${chip.chipset}` : d.portName || 'USB Ethernet'
  const diagForThis = diag && diag.device === d.device ? diag : null
  const net = diagForThis?.net

  let body: string
  if (!net) {
    body = running
      ? `<p class="status-msg">Running diagnostics…</p>`
      : `<p class="status-msg">Waiting for diagnostics… (press R)</p>`
  } else if (!net.linkUp) {
    body = `${row('Link', 'no link — plug in a network cable', 'bad')}${row('MAC', net.mac || '—')}`
  } else {
    // A 169.254 address means nothing answered — the OS assigned it to itself. Saying so is the
    // whole point of the tool, so it must not look like a working lease.
    const linkLocal = net.ipv4 != null && isLinkLocalIpv4(net.ipv4)
    const ipText = net.ipv4
      ? `${net.ipv4}${net.cidr != null ? `/${net.cidr}` : ''}${linkLocal ? ' · link-local' : ''}`
      : 'no IP'
    const dhcp = net.dhcp
    // DHCP counts as working only once it has produced a usable address. Still negotiating (no IP
    // yet) or fallen back to link-local are both "not there yet", so neither goes green.
    const dhcpWorking = dhcp.enabled && net.ipv4 != null && !linkLocal
    const dhcpText = !dhcp.enabled
      ? 'static / not DHCP'
      : linkLocal
        ? `no server answered${dhcp.state ? ` (${dhcp.state})` : ''}`
        : `${dhcp.state ?? 'on'}${dhcp.server ? ` · server ${dhcp.server}` : ''}`
    body = `
      ${row('Link', linkText(net), 'ok')}
      ${row('IPv4', ipText, net.ipv4 ? (linkLocal ? 'warn' : 'ok') : 'bad')}
      ${net.netmask ? row('Netmask', net.netmask) : ''}
      ${row('Gateway', net.gateway ?? '—', net.gateway ? '' : 'warn')}
      ${row('DHCP', dhcpText, dhcpWorking ? 'ok' : 'warn')}
      ${dhcp.domain ? row('Domain', dhcp.domain) : ''}
      ${dhcp.leaseExpiration ? row('Lease until', dhcp.leaseExpiration) : ''}
      ${row('DNS', net.dnsServers.join(', ') || '—', net.dnsServers.length ? '' : 'warn')}
      ${row('MAC', net.mac || '—')}
      <div class="section-title">Connection</div>
      ${row('Gateway ping', pingText(diagForThis?.gatewayPing), pingClass(diagForThis?.gatewayPing))}
      ${(diagForThis?.internetPings ?? [])
        .map((p) => row(`Internet ${p.label}`, pingText(p), pingClass(p)))
        .join('')}
      ${row(
        'DNS test',
        diagForThis?.dns
          ? diagForThis.dns.ok
            ? `ok · ${diagForThis.dns.host} → ${diagForThis.dns.addresses[0] ?? ''}${diagForThis.dns.ms != null ? ` (${diagForThis.dns.ms} ms)` : ''}`
            : 'failed'
          : '—',
        diagForThis?.dns ? (diagForThis.dns.ok ? 'ok' : 'bad') : 'warn'
      )}
    `
  }

  return `
    <article class="adapter ${cardClass(d)}">
      <div class="adapter-head">
        <span class="badge">${badgeText(d)}</span>
        <h2>${escapeHtml(title)}</h2>
        <span class="dev">${escapeHtml(d.device)}</span>
      </div>
      <div class="diag">${body}</div>
      ${[renderSpeed(d), renderSurvey(d)]
        .filter(Boolean)
        .map((section) => `<div class="diag">${section}</div>`)
        .join('')}
    </article>`
}

/**
 * Measured throughput. speedText() stays for the negotiated link rate: that one is an exact
 * integer reported by the driver, this one is a measurement and wants significant digits.
 */
function rateText(mbps: number): string {
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(2)} Gbit/s`
  if (mbps >= 100) return `${Math.round(mbps)} Mbit/s`
  return `${mbps.toFixed(1)} Mbit/s`
}

/** The headline for one direction: the best trailing second, with the live figure while it runs. */
function phaseText(p: SpeedPhase): string {
  if (p.done) {
    const best = p.peakMbps ?? p.nowMbps
    return best != null ? rateText(best) : (p.message ?? 'nothing moved')
  }
  if (p.nowMbps == null) return 'starting…'
  return p.peakMbps != null
    ? `${rateText(p.nowMbps)} · peak ${rateText(p.peakMbps)}`
    : rateText(p.nowMbps)
}

/** What pressing T is about to do. Shown as the confirmation, not as standing hint text. */
const SPEED_EXPLAINER =
  'Speed test — a real transfer to speed.cloudflare.com bound to this port, up to ~200 MB each way, about 20 s.'

function renderSpeed(d: Adapter): string {
  const forThis = speed && speedDevice === d.device ? speed : null
  const live = forThis?.running === true
  let inner: string

  // Nothing to say until it has run: the footer already offers T, and the explanation arrives when
  // it is actually wanted. A paragraph that never changes is a paragraph nobody reads twice.
  if (!forThis) return ''
  if (forThis.status !== 'ok' && !live) {
    inner = `<p class="status-msg">${escapeHtml(forThis.message ?? 'The speed test failed.')}</p>`
  } else {
    const rows = (['download', 'upload'] as const)
      .map((kind) => {
        const label = kind === 'download' ? 'Download' : 'Upload'
        const p = forThis.phases.find((x) => x.kind === kind)
        if (!p) return row(label, live ? 'waiting…' : '—', 'warn')
        const measured = (p.peakMbps ?? p.nowMbps) != null
        return row(label, phaseText(p), measured ? 'ok' : p.done ? 'bad' : '')
      })
      .join('')

    const moved = forThis.phases.reduce((sum, p) => sum + p.bytes, 0)
    const volume = `${Math.round(moved / 1e6)} MB`
    const footer = live
      ? `<p class="hint2">Testing ${clock(forThis.elapsedSec)} · ${volume} · <b>T</b> stops</p>`
      : `<p class="hint2">Ran ${clock(forThis.elapsedSec)} · ${volume} moved · <b>T</b> tests again</p>`

    inner = rows + footer
  }
  return `<div class="section-title">Speed test</div>${inner}`
}

/**
 * Addresses observed inside a VLAN, condensed. Deliberately renders "10.20.0.x" and never a
 * prefix length — a capture shows addresses, never netmasks, and "/24" would be a guess printed
 * as a fact.
 */
function addressSummary(addresses: string[]): string {
  if (addresses.length === 0) return ''
  const prefixes = new Set(addresses.map((a) => a.split('.').slice(0, 3).join('.')))
  if (prefixes.size === 1) return `${[...prefixes][0]}.x`
  return addresses.slice(0, 2).join(', ')
}

/** What pressing C is about to do. Shown as the confirmation, not as standing hint text. */
const SURVEY_EXPLAINER =
  'Port survey — captures on this port until you stop it and lists every VLAN it carries. Needs admin rights, and a quiet VLAN can take ~30 s to show up.'

function renderSurvey(d: Adapter): string {
  const forThis = survey && surveyDevice === d.device ? survey : null
  const live = forThis?.running === true
  let inner: string

  if (!forThis) return ''
  if (forThis.status !== 'ok' && !live) {
    inner = `<p class="status-msg">${escapeHtml(forThis.message ?? 'No info')}</p>`
  } else {
    // The VLAN list is the part that works on any switch; LLDP/CDP below it is a bonus.
    const verdict = forThis.vlans.length
      ? row('Trunk', `${plural(forThis.vlans.length, 'VLAN')} seen`, 'ok')
      : row(
          'Tagging',
          live ? 'nothing tagged yet' : 'no tagged frames — access port',
          live ? '' : 'warn'
        )

    const vlans = forThis.vlans
      .map((v) =>
        row(
          `VLAN ${v.id}`,
          [plural(v.frames, 'frame'), addressSummary(v.addresses)].filter(Boolean).join(' · '),
          'ok'
        )
      )
      .join('')

    const neighbors = forThis.neighbors
      .map(
        (n) => `
          ${row('Protocol', n.protocol, 'ok')}
          ${n.systemName ? row('Switch', n.systemName) : ''}
          ${n.portId ? row('Port', n.portId) : ''}
          ${n.vlan != null ? row('Port VLAN', String(n.vlan)) : ''}
          ${n.mgmtAddress ? row('Mgmt-IP', n.mgmtAddress) : ''}`
      )
      .join('')

    // Nothing found yet is the state that needs explaining — otherwise a quiet first half-minute
    // reads like a broken feature rather than a port that has not spoken yet.
    const quiet =
      live && forThis.vlans.length === 0 && forThis.neighbors.length === 0
        ? `<p class="notes">Nothing identified yet. A quiet VLAN can take ~30 s to beacon; LLDP is typically every 30 s too.</p>`
        : ''

    const footer = live
      ? `<p class="hint2">Surveying ${clock(forThis.elapsedSec)} · ${plural(forThis.frames, 'frame')} · <b>C</b> stops</p>`
      : `<p class="hint2">Ran ${clock(forThis.elapsedSec)} · ${plural(forThis.frames, 'frame')} · <b>C</b> surveys again</p>`

    inner = verdict + vlans + neighbors + quiet + footer
  }
  return `<div class="section-title">Switch / VLAN</div>${inner}`
}

// Chipset sub-view (I). The capabilities live in resources/chipsets.json; the raw USB IDs are
// what you need to file a new-chipset PR when a dongle is not in the database yet. A built-in port
// has no USB identity at all, so those rows are dropped rather than shown empty.
function renderInfo(d: Adapter): string {
  if (!info) return ''
  const chip = d.chipset
  const usb = d.usb
  const usbId = usb ? `${usb.vendorId}:${usb.productId}` : ''
  const builtIn = isBuiltIn(d)
  return `<section class="panel-card">
    <div class="section-title">Chipset / hardware</div>
    ${row('Kind', builtIn ? (d.kind === 'wifi' ? 'built-in Wi-Fi' : 'built-in Ethernet') : 'USB dongle')}
    ${builtIn ? '' : row('Vendor', chip?.vendor ?? usb?.vendorName ?? '—')}
    ${builtIn ? '' : row('Chipset', chip?.chipset ?? 'unknown', d.known ? 'ok' : 'warn')}
    ${!builtIn && chip?.maxSpeedMbps ? row('Max speed', speedText(chip.maxSpeedMbps)) : ''}
    ${!builtIn && chip ? row('VLAN', chip.vlan ? 'yes' : 'no') : ''}
    ${builtIn ? '' : row('USB ID', usbId || '—', usbId ? '' : 'warn')}
    ${usb?.productName ? row('USB name', usb.productName) : ''}
    ${row('Port', d.portName || '—')}
    ${row('MAC', d.mac || '—')}
    ${chip?.brands?.length ? `<p class="notes">Sold as: ${escapeHtml(chip.brands.join(', '))}</p>` : ''}
    ${chip?.notes ? `<p class="notes">${escapeHtml(chip.notes)}</p>` : ''}
    ${
      builtIn
        ? `<p class="notes">Built-in port — the chipset database covers USB dongles, so there is nothing to look up here.</p>`
        : !d.known && usbId
          ? `<p class="notes">Not in the chipset database — add "${escapeHtml(usbId)}" to resources/chipsets.json.</p>`
          : ''
    }
    <p class="hint2"><b>I</b> or <b>Esc</b> closes</p>
  </section>`
}

function renderPanel(): string {
  if (!panel) return ''
  const items = profiles
    .map((p, i) => {
      const detail =
        p.mode === 'dhcp' ? 'DHCP' : `static ${p.ip ?? ''}${p.cidr != null ? `/${p.cidr}` : ''}`
      return `<li class="profile${i === profileSel ? ' sel' : ''}">
        <span class="pi">${i + 1}</span>
        <span class="pn">${escapeHtml(p.name)}</span>
        <span class="pd">${escapeHtml(detail)}</span>
      </li>`
    })
    .join('')
  return `<section class="panel-card">
    <div class="section-title">Profiles — apply to the adapter</div>
    <ul class="profiles">${items}</ul>
    <p class="hint2"><b>↑↓</b> select · <b>Enter</b>/<b>1-9</b> apply · <b>N</b> new · <b>E</b> edit · <b>Backspace</b> delete · <b>P</b> close</p>
  </section>`
}

function fieldValue(id: string): string {
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null
  return el?.value ?? ''
}

function openEditor(profile?: Profile): void {
  editorOpen = true
  // The form writes #app itself and reads its fields back on save, so nothing else may repaint
  // while it is up — a hotplug event mid-typing would otherwise wipe what was entered.
  setRenderSuspended(true)
  editorProfile = profile ?? null
  renderEditor()
}

function closeEditor(): void {
  editorOpen = false
  setRenderSuspended(false)
  editorProfile = null
  requestRender()
}

function renderEditor(): void {
  const p = editorProfile
  const isStatic = p?.mode === 'static'
  const v = (s?: string): string => escapeHtml(s ?? '')
  app.innerHTML = renderShell({
    key: 'ethernet:editor',
    footer: 'Fill in with the mouse · <b>Esc</b> cancels',
    body: `
    <section class="editor">
      <div class="section-title">${p ? 'Edit profile' : 'New profile'}</div>
      <label class="fld">Name<input id="f-name" type="text" value="${v(p?.name)}" /></label>
      <label class="fld">Mode
        <select id="f-mode">
          <option value="dhcp"${!isStatic ? ' selected' : ''}>DHCP</option>
          <option value="static"${isStatic ? ' selected' : ''}>Static</option>
        </select>
      </label>
      <div id="static-fields" class="${isStatic ? '' : 'hidden'}">
        <label class="fld">IP<input id="f-ip" type="text" value="${v(p?.ip)}" placeholder="192.168.1.50" /></label>
        <label class="fld">Prefix/netmask<input id="f-cidr" type="text" value="${p?.cidr != null ? String(p.cidr) : ''}" placeholder="24 or 255.255.255.0" /></label>
        <label class="fld">Gateway (optional)<input id="f-gw" type="text" value="${v(p?.gateway)}" placeholder="192.168.1.1" /></label>
        <label class="fld">DNS (optional)<input id="f-dns" type="text" value="${v((p?.dns ?? []).join(', '))}" placeholder="1.1.1.1, 8.8.8.8" /></label>
      </div>
      <label class="fld">MAC override (optional)<input id="f-mac" type="text" value="${v(p?.macOverride)}" placeholder="02:11:22:33:44:55" /></label>
      <p id="f-error" class="form-error"></p>
      <div class="form-actions">
        <button id="f-save" class="btn primary">Save</button>
        <button id="f-cancel" class="btn">Cancel</button>
      </div>
    </section>`
  })

  const modeSel = document.getElementById('f-mode') as HTMLSelectElement
  const staticFields = document.getElementById('static-fields') as HTMLElement
  modeSel.addEventListener('change', () => {
    staticFields.classList.toggle('hidden', modeSel.value !== 'static')
  })
  ;(document.getElementById('f-save') as HTMLElement).addEventListener(
    'click',
    () => void submitEditor()
  )
  ;(document.getElementById('f-cancel') as HTMLElement).addEventListener('click', () =>
    closeEditor()
  )
  ;(document.getElementById('f-name') as HTMLInputElement).focus()
}

async function submitEditor(): Promise<void> {
  const draft: ProfileDraftInput = {
    id: editorProfile?.id,
    name: fieldValue('f-name'),
    mode: fieldValue('f-mode') === 'static' ? 'static' : 'dhcp',
    ip: fieldValue('f-ip'),
    cidr: fieldValue('f-cidr'),
    gateway: fieldValue('f-gw'),
    dns: fieldValue('f-dns'),
    macOverride: fieldValue('f-mac')
  }
  const result = validateProfileDraft(draft)
  const errEl = document.getElementById('f-error')
  if (!result.ok) {
    if (errEl) errEl.textContent = result.error
    return
  }
  try {
    const wasEdit = Boolean(editorProfile)
    profiles = await window.api.saveProfile(result.profile)
    const idx = profiles.findIndex(
      (pp) => (result.profile.id && pp.id === result.profile.id) || pp.name === result.profile.name
    )
    if (idx >= 0) profileSel = idx
    setNotice(`${wasEdit ? 'Updated' : 'Created'} profile: ${result.profile.name}`)
  } catch (e) {
    if (errEl) errEl.textContent = `Could not save: ${String(e)}`
    return
  }
  closeEditor()
}

export function renderEthernet(): string {
  if (adapters.length === 0) {
    return renderShell({
      key: 'ethernet:empty',
      footer: 'waiting for a port… · <b>Tab</b> wi-fi · <b>Esc</b> back',
      body: `
      <div class="empty">
        <p class="big">No network ports found</p>
        <p class="sub">Plug in a USB ethernet dongle — it is detected automatically.</p>
      </div>`
    })
  }
  const d = adapters[selected]
  return renderShell({
    // Keyed on the adapter, so switching port starts at the top while a re-run of the same one
    // keeps your place.
    key: `ethernet:${d.device}`,
    busy: running || surveying || measuring || busy,
    // The selector says which port everything below belongs to, so it stays put.
    status: renderSelector(),
    footer: `<b>R</b> rerun · <b>M</b> roll MAC · <b>P</b> profiles · <b>I</b> chipset · <b>S</b> save · <b>U</b> undo · <b>C</b> ${surveying ? 'stop' : 'survey'} · <b>T</b> ${measuring ? 'stop' : 'speed'} · <b>Tab</b> wi-fi`,
    body: `
    ${renderDiagnostics(d)}
    ${renderInfo(d)}
    ${renderPanel()}`
  })
}

async function runDiag(device: string): Promise<void> {
  running = true
  requestRender()
  try {
    diag = await window.api.runDiagnostics(device)
  } catch (err) {
    // Never clear the notice on success: runReconfig's finally calls us right after setting
    // its own result message, and clearing here would wipe it.
    console.error('diagnostics failed', err)
    setNotice(`Diagnostics failed: ${String(err)}`)
  } finally {
    running = false
    requestRender()
  }
}

/** C starts the survey and, while one is running, stops it. Results stay on screen either way. */
async function toggleSurvey(device: string): Promise<void> {
  if (surveying) {
    surveying = false
    requestRender()
    try {
      const final = await window.api.stopSurvey()
      if (final) survey = final
    } catch (err) {
      console.error('stopping the survey failed', err)
      setNotice(`Stopping the survey failed: ${String(err)}`)
    }
    requestRender()
    return
  }

  surveying = true
  surveyDevice = device
  survey = null
  requestRender()
  try {
    survey = await window.api.startSurvey(device)
    // A refused start (no tcpdump, Windows) comes back already stopped.
    surveying = survey.running
  } catch (err) {
    console.error('survey failed', err)
    surveying = false
    survey = {
      status: 'error',
      running: false,
      neighbors: [],
      vlans: [],
      frames: 0,
      elapsedSec: 0,
      message: String(err)
    }
  }
  requestRender()
}

/** Stop a running survey when it is no longer the thing on screen. */
function endSurveyIfRunning(): void {
  if (!surveying) return
  surveying = false
  // Keep the final snapshot rather than the last live one: switching back to that adapter should
  // show what the capture found, not claim it is still running.
  void window.api
    .stopSurvey()
    .then((final) => {
      if (final) survey = final
      requestRender()
    })
    .catch(() => undefined)
}

/** T starts the speed test and, while one is running, stops it. Results stay on screen either way. */
async function toggleSpeedTest(device: string): Promise<void> {
  if (measuring) {
    measuring = false
    requestRender()
    try {
      const final = await window.api.stopSpeedTest()
      if (final) speed = final
    } catch (err) {
      console.error('stopping the speed test failed', err)
      setNotice(`Stopping the speed test failed: ${String(err)}`)
    }
    requestRender()
    return
  }

  measuring = true
  speedDevice = device
  speed = null
  requestRender()
  try {
    speed = await window.api.startSpeedTest(device)
    // A refused start (no curl, no address) comes back already stopped.
    measuring = speed.running
  } catch (err) {
    console.error('speed test failed', err)
    measuring = false
    speed = { status: 'error', running: false, phases: [], elapsedSec: 0, message: String(err) }
  }
  requestRender()
}

/** Stop a running speed test when it is no longer the thing on screen. */
function endSpeedTestIfRunning(): void {
  if (!measuring) return
  measuring = false
  // Keep the final snapshot rather than the last live one, for the same reason the survey does.
  void window.api
    .stopSpeedTest()
    .then((final) => {
      if (final) speed = final
      requestRender()
    })
    .catch(() => undefined)
}

// Run a privileged action, show a notice and re-read the diagnostics.
async function runReconfig(
  device: string,
  action: () => Promise<{ ok: boolean; message?: string; newMac?: string }>,
  okMsg: string
): Promise<void> {
  busy = true
  setNotice(null)
  requestRender()
  try {
    const res = await action()
    setNotice(
      res.ok
        ? res.newMac
          ? `${okMsg}: ${res.newMac}`
          : okMsg
        : (res.message ?? 'The action failed')
    )
  } catch (err) {
    setNotice(`Error: ${String(err)}`)
  } finally {
    busy = false
    requestRender()
    await runDiag(device)
  }
}

async function saveCurrent(device: string): Promise<void> {
  const net = currentNet()
  if (!net?.ipv4) {
    setNotice('No active IP to save as a profile.')
    requestRender()
    return
  }
  busy = true
  requestRender()
  try {
    profiles = await window.api.saveCurrentAsProfile(device, `Static ${net.ipv4}`)
    setNotice(`Saved profile: Static ${net.ipv4}`)
  } catch (err) {
    setNotice(`Could not save: ${String(err)}`)
  } finally {
    busy = false
    requestRender()
  }
}

async function deleteSelectedProfile(): Promise<void> {
  const p = profiles[profileSel]
  if (!p || p.id === 'dhcp') {
    setNotice('That profile cannot be deleted.')
    requestRender()
    return
  }
  try {
    profiles = await window.api.deleteProfile(p.id)
    profileSel = Math.min(profileSel, profiles.length - 1)
    setNotice(`Deleted profile: ${p.name}`)
  } catch (err) {
    setNotice(`Could not delete: ${String(err)}`)
  }
  requestRender()
}

/**
 * Gate for the keys that change real network configuration. A dongle acts on the first press —
 * one-handed operation at a rack is the whole point. A built-in port is the machine's own
 * connection, so the first press asks and only the very next press of the same key acts.
 */
function confirmed(
  key: string,
  d: Adapter,
  what: string,
  pending: { key: string; device: string } | null
): boolean {
  if (!isBuiltIn(d)) return true
  const where = d.kind === 'wifi' ? 'built-in Wi-Fi' : 'built-in Ethernet'
  return confirmStep(key, d.device, `${what} on ${where} (${d.device})?`, pending)
}

function applyProfileByIndex(
  idx: number,
  key: string,
  pending: { key: string; device: string } | null
): void {
  const p = profiles[idx]
  const d = adapters[selected]
  if (!p || !d || busy) return
  if (!confirmed(key, d, `Apply "${p.name}"`, pending)) return
  void runReconfig(d.device, () => window.api.applyProfile(d.device, p.id), `Applied ${p.name}`)
}

function onAdapters(next: Adapter[]): void {
  const previous = adapters
  const prevDevice = previous[selected]?.device
  adapters = next
  selected = pickSelected(previous, next, prevDevice)
  // A pending confirmation belongs to the port it was asked about. If a dongle has just arrived
  // and taken the selection, the next press would land on that dongle instead — and a dongle acts
  // on the first press, so the question and the answer would be about different ports.
  const outstanding = getPending()
  if (outstanding && adapters[selected]?.device !== outstanding.device) {
    setPending(null)
    setNotice(null)
  }
  requestRender()
  const current = adapters[selected]
  if (current) void runDiag(current.device)
}

/**
 * Leaving the mode ends both long-running measurements. They belong to the adapter that was on
 * screen, and a root tcpdump or a curl saturating someone's uplink must not outlive the view.
 */
export function leaveEthernet(): void {
  endSurveyIfRunning()
  endSpeedTestIfRunning()
}

/** Every keystroke while the Ethernet dashboard is the mode on screen. */
export function handleEthernetKey(e: KeyboardEvent): void {
  // In edit mode all keystrokes go to the form's fields; only Esc is handled here.
  if (editorOpen) {
    if (e.key === 'Escape') {
      closeEditor()
      e.preventDefault()
    }
    return
  }
  if (adapters.length === 0 || busy) return
  const adapter = adapters[selected]
  const device = adapter.device
  // Every keystroke consumes any outstanding confirmation: only the very next press of the same
  // key can confirm, so anything in between cancels it. Take the question off screen with it —
  // leaving "press M again to confirm" up after it stopped being true is how a prompt teaches
  // people to ignore it. Whatever happens next sets its own notice.
  const pending = consumePending()
  if (pending) {
    setNotice(null)
    requestRender()
  }

  if (panel) {
    if (e.key === 'ArrowDown') {
      profileSel = (profileSel + 1) % profiles.length
    } else if (e.key === 'ArrowUp') {
      profileSel = (profileSel - 1 + profiles.length) % profiles.length
    } else if (e.key === 'Enter') {
      applyProfileByIndex(profileSel, e.key, pending)
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      void deleteSelectedProfile()
    } else if (e.key === 'n' || e.key === 'N') {
      openEditor()
      e.preventDefault()
      return
    } else if (e.key === 'e' || e.key === 'E') {
      if (profiles[profileSel]) openEditor(profiles[profileSel])
      e.preventDefault()
      return
    } else if (e.key === 'i' || e.key === 'I') {
      // Only one sub-view at a time.
      panel = false
      info = true
    } else if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') {
      panel = false
    } else {
      return
    }
    requestRender()
    e.preventDefault()
    return
  }

  if (e.key === 'ArrowDown') {
    // Both belong to the adapter they were started on, so switching away ends them rather than
    // leaving a privileged tcpdump — or a curl saturating the uplink — on a port that is no longer
    // on screen.
    endSurveyIfRunning()
    endSpeedTestIfRunning()
    selected = (selected + 1) % adapters.length
    requestRender()
    void runDiag(adapters[selected].device)
  } else if (e.key === 'ArrowUp') {
    endSurveyIfRunning()
    endSpeedTestIfRunning()
    selected = (selected - 1 + adapters.length) % adapters.length
    requestRender()
    void runDiag(adapters[selected].device)
  } else if (e.key === 'r' || e.key === 'R' || e.key === ' ') {
    if (!running) void runDiag(device)
  } else if (e.key === 'c' || e.key === 'C') {
    // Stopping is always safe and immediate; starting explains itself first.
    if (surveying || confirmStep('c', device, SURVEY_EXPLAINER, pending)) void toggleSurvey(device)
  } else if (e.key === 't' || e.key === 'T') {
    if (measuring || confirmStep('t', device, SPEED_EXPLAINER, pending)) {
      void toggleSpeedTest(device)
    }
  } else if (e.key === 'm' || e.key === 'M') {
    if (confirmed('m', adapter, 'Roll the MAC', pending)) {
      void runReconfig(device, () => window.api.rollMac(device), 'MAC rolled')
    }
  } else if (e.key === 'u' || e.key === 'U') {
    if (confirmed('u', adapter, 'Undo the last change', pending)) {
      void runReconfig(device, () => window.api.undo(device), 'Undone')
    }
  } else if (e.key === 's' || e.key === 'S') {
    void saveCurrent(device)
  } else if (e.key === 'p' || e.key === 'P') {
    panel = true
    info = false
    profileSel = 0
    requestRender()
  } else if (e.key === 'i' || e.key === 'I') {
    info = !info
    requestRender()
  } else if (e.key === 'Escape') {
    // Esc closes whatever sub-view is open; with nothing open it steps back out to the mode
    // chooser. Leaving the mode ends the two long-running measurements for the same reason
    // switching adapter does — they belong to the port that is no longer on screen.
    if (info) {
      info = false
    } else {
      endSurveyIfRunning()
      endSpeedTestIfRunning()
      setMode('chooser')
    }
    requestRender()
  } else if (e.key >= '1' && e.key <= '9') {
    applyProfileByIndex(Number(e.key) - 1, e.key, pending)
  } else {
    return
  }
  e.preventDefault()
}

export async function initEthernet(): Promise<void> {
  ;[adapters, profiles] = await Promise.all([window.api.listAdapters(), window.api.listProfiles()])
  requestRender()
  if (adapters[selected]) void runDiag(adapters[selected].device)
  window.api.onAdaptersChanged(onAdapters)
  window.api.onSurveyUpdate((result) => {
    // Partial results keep arriving until the capture is stopped. Drop any that belong to a
    // adapter we have since switched away from.
    if (result.device && result.device !== surveyDevice) return
    survey = result
    surveying = result.running
    if (!editorOpen) requestRender()
  })
  window.api.onSpeedTestUpdate((result) => {
    if (result.device && result.device !== speedDevice) return
    speed = result
    measuring = result.running
    if (!editorOpen) requestRender()
  })
}
