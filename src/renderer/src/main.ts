import './styles.css'
import type { Diagnostics, DiscoveryResult, Dongle, PingResult, Profile } from '../../shared/types'
import { isLinkLocalIpv4 } from '../../shared/net'
import { validateProfileDraft } from '../../shared/profile'
import type { ProfileDraftInput } from '../../shared/profile'

const app = document.getElementById('app') as HTMLElement
const APP_VERSION = __APP_VERSION__

// --- State ---
let dongles: Dongle[] = []
let selected = 0
let diag: Diagnostics | null = null
let running = false
let discovery: DiscoveryResult | null = null
let discoveryDevice: string | null = null
let discovering = false
let profiles: Profile[] = []
let panel = false // profile panel open
let info = false // chipset info sub-view open (mutually exclusive with the profile panel)
let profileSel = 0
let notice: string | null = null
let busy = false // privileged action in progress
let editorOpen = false // profile form is shown (pauses background re-render)
let editorProfile: Profile | null = null // profile being edited (null = new)

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

function speedText(mbps?: number): string {
  if (!mbps) return '—'
  return mbps >= 1000 ? `${mbps / 1000} Gbit/s` : `${mbps} Mbit/s`
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
  const loss = p.lossPct ? ` · ${p.lossPct}% loss` : ''
  return `${rtt}${loss}`
}

function row(label: string, value: string, cls = ''): string {
  return `<div class="row"><span class="dot ${cls}"></span><span class="label">${label}</span><span class="val">${escapeHtml(value)}</span></div>`
}

function currentNet() {
  const d = dongles[selected]
  return d && diag && diag.device === d.device ? diag.net : null
}

function renderSelector(): string {
  if (dongles.length <= 1) return ''
  return `<div class="selector">${dongles
    .map((d, i) => {
      const name = d.chipset ? `${d.chipset.vendor} ${d.chipset.chipset}` : d.portName || d.device
      return `<span class="chip${i === selected ? ' active' : ''}">${escapeHtml(name)}</span>`
    })
    .join('')}<span class="selector-hint">↑ ↓ switch</span></div>`
}

function renderDiagnostics(d: Dongle): string {
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
      ${row('Link', `up · ${speedText(net.linkSpeedMbps)}${net.duplex ? ` · ${net.duplex} duplex` : ''}`, 'ok')}
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
    <article class="dongle ${d.known ? 'known' : 'unknown'}">
      <div class="dongle-head">
        <span class="badge">${d.known ? 'IDENTIFIED' : 'UNKNOWN'}</span>
        <h2>${escapeHtml(title)}</h2>
        <span class="dev">${escapeHtml(d.device)}</span>
      </div>
      <div class="diag">${body}</div>
      <div class="diag">${renderDiscovery(d)}</div>
    </article>`
}

function renderDiscovery(d: Dongle): string {
  const forThis = discovery && discoveryDevice === d.device ? discovery : null
  let inner: string
  if (discovering && discoveryDevice === d.device) {
    inner = `<p class="status-msg">Listening for LLDP/CDP… (up to 35 s)</p>`
  } else if (!forThis) {
    inner = `<p class="status-msg">Press <b>C</b> to listen for switch/VLAN.</p>`
  } else if (forThis.status !== 'ok') {
    inner = `<p class="status-msg">${escapeHtml(forThis.message ?? 'No info')}</p>`
  } else {
    inner = forThis.neighbors
      .map(
        (n) => `
          ${row('Protocol', n.protocol, 'ok')}
          ${n.systemName ? row('Switch', n.systemName) : ''}
          ${n.portId ? row('Port', n.portId) : ''}
          ${n.vlan != null ? row('VLAN', String(n.vlan)) : ''}
          ${n.mgmtAddress ? row('Mgmt-IP', n.mgmtAddress) : ''}`
      )
      .join('')
  }
  return `<div class="section-title">Switch / VLAN</div>${inner}`
}

// Chipset sub-view (I). The capabilities live in resources/chipsets.json; the raw USB IDs are
// what you need to file a new-chipset PR when a dongle is not in the database yet.
function renderInfo(d: Dongle): string {
  if (!info) return ''
  const chip = d.chipset
  const usb = d.usb
  const usbId = usb ? `${usb.vendorId}:${usb.productId}` : ''
  return `<section class="panel-card">
    <div class="section-title">Chipset / hardware</div>
    ${row('Vendor', chip?.vendor ?? usb?.vendorName ?? '—')}
    ${row('Chipset', chip?.chipset ?? 'unknown', d.known ? 'ok' : 'warn')}
    ${chip?.maxSpeedMbps ? row('Max speed', speedText(chip.maxSpeedMbps)) : ''}
    ${chip ? row('VLAN', chip.vlan ? 'yes' : 'no') : ''}
    ${row('USB ID', usbId || '—', usbId ? '' : 'warn')}
    ${usb?.productName ? row('USB name', usb.productName) : ''}
    ${row('Port', d.portName || '—')}
    ${chip?.brands?.length ? `<p class="notes">Sold as: ${escapeHtml(chip.brands.join(', '))}</p>` : ''}
    ${chip?.notes ? `<p class="notes">${escapeHtml(chip.notes)}</p>` : ''}
    ${
      !d.known && usbId
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
  editorProfile = profile ?? null
  renderEditor()
}

function closeEditor(): void {
  editorOpen = false
  editorProfile = null
  render()
}

function renderEditor(): void {
  const p = editorProfile
  const isStatic = p?.mode === 'static'
  const v = (s?: string): string => escapeHtml(s ?? '')
  app.innerHTML = `
    <header class="topbar"><h1>magiceth</h1><span class="ver">v${APP_VERSION}</span></header>
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
    </section>
    <footer class="hint">Fill in with the mouse · <b>Esc</b> cancels</footer>`

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
    notice = `${wasEdit ? 'Updated' : 'Created'} profile: ${result.profile.name}`
  } catch (e) {
    if (errEl) errEl.textContent = `Could not save: ${String(e)}`
    return
  }
  closeEditor()
}

function render(): void {
  // While the profile form is open we never re-render (otherwise <input> loses focus/value).
  // Background flows update data in memory; the next render() after the form closes shows it.
  if (editorOpen) return
  if (dongles.length === 0) {
    app.innerHTML = `
      <header class="topbar"><h1>magiceth</h1><span class="ver">v${APP_VERSION}</span></header>
      <div class="empty">
        <p class="big">Plug in a USB ethernet dongle</p>
        <p class="sub">The tool detects it automatically and diagnoses the port.</p>
      </div>
      <footer class="hint">waiting for dongle…</footer>`
    return
  }
  const d = dongles[selected]
  const spinner = running || discovering || busy ? '<span class="spin">⟳</span>' : ''
  app.innerHTML = `
    <header class="topbar"><h1>magiceth</h1><span class="ver">v${APP_VERSION}</span>${spinner}</header>
    ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
    ${renderSelector()}
    ${renderDiagnostics(d)}
    ${renderInfo(d)}
    ${renderPanel()}
    <footer class="hint"><b>R</b> rerun · <b>M</b> roll MAC · <b>P</b> profiles · <b>I</b> chipset · <b>S</b> save · <b>U</b> undo · <b>C</b> VLAN</footer>`
}

async function runDiag(device: string): Promise<void> {
  running = true
  render()
  try {
    diag = await window.api.runDiagnostics(device)
  } catch (err) {
    // Never clear the notice on success: runReconfig's finally calls us right after setting
    // its own result message, and clearing here would wipe it.
    console.error('diagnostics failed', err)
    notice = `Diagnostics failed: ${String(err)}`
  } finally {
    running = false
    render()
  }
}

async function runDiscover(device: string): Promise<void> {
  discovering = true
  discoveryDevice = device
  discovery = null
  render()
  try {
    discovery = await window.api.discover(device)
  } catch (err) {
    console.error('discover failed', err)
    discovery = { status: 'error', neighbors: [], message: String(err) }
  } finally {
    discovering = false
    render()
  }
}

// Run a privileged action, show a notice and re-read the diagnostics.
async function runReconfig(
  device: string,
  action: () => Promise<{ ok: boolean; message?: string; newMac?: string }>,
  okMsg: string
): Promise<void> {
  busy = true
  notice = null
  render()
  try {
    const res = await action()
    notice = res.ok
      ? res.newMac
        ? `${okMsg}: ${res.newMac}`
        : okMsg
      : (res.message ?? 'The action failed')
  } catch (err) {
    notice = `Error: ${String(err)}`
  } finally {
    busy = false
    render()
    await runDiag(device)
  }
}

async function saveCurrent(device: string): Promise<void> {
  const net = currentNet()
  if (!net?.ipv4) {
    notice = 'No active IP to save as a profile.'
    render()
    return
  }
  busy = true
  render()
  try {
    profiles = await window.api.saveCurrentAsProfile(device, `Static ${net.ipv4}`)
    notice = `Saved profile: Static ${net.ipv4}`
  } catch (err) {
    notice = `Could not save: ${String(err)}`
  } finally {
    busy = false
    render()
  }
}

async function deleteSelectedProfile(): Promise<void> {
  const p = profiles[profileSel]
  if (!p || p.id === 'dhcp') {
    notice = 'That profile cannot be deleted.'
    render()
    return
  }
  try {
    profiles = await window.api.deleteProfile(p.id)
    profileSel = Math.min(profileSel, profiles.length - 1)
    notice = `Deleted profile: ${p.name}`
  } catch (err) {
    notice = `Could not delete: ${String(err)}`
  }
  render()
}

function applyProfileByIndex(idx: number): void {
  const p = profiles[idx]
  const d = dongles[selected]
  if (!p || !d || busy) return
  void runReconfig(d.device, () => window.api.applyProfile(d.device, p.id), `Applied ${p.name}`)
}

function onDongles(next: Dongle[]): void {
  const prevDevice = dongles[selected]?.device
  dongles = next
  const idx = dongles.findIndex((d) => d.device === prevDevice)
  selected = idx >= 0 ? idx : 0
  render()
  const current = dongles[selected]
  if (current) void runDiag(current.device)
}

document.addEventListener('keydown', (e) => {
  // In edit mode all keystrokes go to the form's fields; only Esc is handled here.
  if (editorOpen) {
    if (e.key === 'Escape') {
      closeEditor()
      e.preventDefault()
    }
    return
  }
  if (dongles.length === 0 || busy) return
  const device = dongles[selected].device

  if (panel) {
    if (e.key === 'ArrowDown') {
      profileSel = (profileSel + 1) % profiles.length
    } else if (e.key === 'ArrowUp') {
      profileSel = (profileSel - 1 + profiles.length) % profiles.length
    } else if (e.key === 'Enter') {
      applyProfileByIndex(profileSel)
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
    render()
    e.preventDefault()
    return
  }

  if (e.key === 'ArrowDown') {
    selected = (selected + 1) % dongles.length
    render()
    void runDiag(dongles[selected].device)
  } else if (e.key === 'ArrowUp') {
    selected = (selected - 1 + dongles.length) % dongles.length
    render()
    void runDiag(dongles[selected].device)
  } else if (e.key === 'r' || e.key === 'R' || e.key === ' ') {
    if (!running) void runDiag(device)
  } else if (e.key === 'c' || e.key === 'C') {
    if (!discovering) void runDiscover(device)
  } else if (e.key === 'm' || e.key === 'M') {
    void runReconfig(device, () => window.api.rollMac(device), 'MAC rolled')
  } else if (e.key === 'u' || e.key === 'U') {
    void runReconfig(device, () => window.api.undo(device), 'Undone')
  } else if (e.key === 's' || e.key === 'S') {
    void saveCurrent(device)
  } else if (e.key === 'p' || e.key === 'P') {
    panel = true
    info = false
    profileSel = 0
    render()
  } else if (e.key === 'i' || e.key === 'I') {
    info = !info
    render()
  } else if (e.key === 'Escape') {
    if (!info) return
    info = false
    render()
  } else if (e.key >= '1' && e.key <= '9') {
    applyProfileByIndex(Number(e.key) - 1)
  } else {
    return
  }
  e.preventDefault()
})

async function init(): Promise<void> {
  ;[dongles, profiles] = await Promise.all([window.api.listDongles(), window.api.listProfiles()])
  render()
  if (dongles[selected]) void runDiag(dongles[selected].device)
  window.api.onDonglesChanged(onDongles)
}

init().catch((err) => {
  app.textContent = `Error on startup: ${String(err)}`
})
