// WLAN mode — the Wi-Fi scanner.
//
// Three levels, navigated with the arrow keys: the networks in earshot, the access points behind
// one network, and everything known about one access point. The same drill-down a technician does
// out loud — "who else is on channel 6?" — without typing a command.

import type { Adapter, WifiBss, WifiNetwork, WifiRange, WifiScanResult } from '../../shared/types'
import { clock, escapeHtml, plural, row } from './view'
import { renderNotice, renderTopbar, requestRender, setMode, setNotice } from './shell'

let device = ''
let result: WifiScanResult | null = null
let scanning = false
let recording = false
let level: 'networks' | 'aps' | 'detail' = 'networks'
let netSel = 0
let apSel = 0

/** What pressing L is about to do. Shown as the confirmation, not as standing hint text. */
const RECORD_EXPLAINER =
  'Recording — keeps scanning and tracks every access point over time, so signal, clients and channel load get a min/max/average. Walk around, then press L again to stop.'

function networks(): WifiNetwork[] {
  return result?.networks ?? []
}

function currentNetwork(): WifiNetwork | undefined {
  return networks()[netSel]
}

function currentAp(): WifiBss | undefined {
  return currentNetwork()?.bssids[apSel]
}

/** -60 dBm and better is a good link; below -75 is where throughput starts falling apart. */
function rssiClass(rssi: number): string {
  if (rssi >= -60) return 'ok'
  if (rssi >= -75) return 'warn'
  return 'bad'
}

/** A five-step bar, because "-67 dBm" means nothing at a glance and a bar does. */
function meter(rssi: number): string {
  const filled = rssi >= -55 ? 5 : rssi >= -65 ? 4 : rssi >= -72 ? 3 : rssi >= -80 ? 2 : 1
  const bars = Array.from(
    { length: 5 },
    (_, i) => `<span class="bar${i < filled ? ' on' : ''}"></span>`
  ).join('')
  return `<span class="meter ${rssiClass(rssi)}">${bars}</span>`
}

function bandsText(bands: string[]): string {
  return bands.map((b) => (b === '?' ? 'unknown' : `${b} GHz`)).join(' + ')
}

function ssidText(ssid: string): string {
  return ssid === '' ? '‹hidden›' : ssid
}

/** `-63 dBm · min -78 / max -55 / avg -66.2` once a recording has more than one sighting. */
function rangeText(range: WifiRange, unit: string, sightings: number): string {
  const now = `${range.last}${unit}`
  if (sightings < 2 || (range.min === range.max && range.avg === range.last)) return now
  return `${now} · min ${range.min} / max ${range.max} / avg ${range.avg}`
}

function trackFor(bssid: string) {
  return result?.tracks.find((t) => t.bssid === bssid)
}

function statusLine(): string {
  if (!result) return scanning ? 'Scanning…' : ''
  const count = plural(networks().length, 'network')
  const aps = plural(
    networks().reduce((n, x) => n + x.bssids.length, 0),
    'access point'
  )
  if (recording) {
    return `Recording ${clock(result.elapsedSec)} · ${result.scans} scans · ${count}, ${aps}`
  }
  return `${count}, ${aps} · ${result.scans} ${result.scans === 1 ? 'scan' : 'scans'}`
}

function renderNetworkList(): string {
  const list = networks()
  if (list.length === 0) {
    return `<p class="status-msg">${scanning ? 'Scanning the air…' : 'No networks heard yet — press R.'}</p>`
  }
  const items = list
    .map((n, i) => {
      const detail = `${n.bssids.length} AP${n.bssids.length === 1 ? '' : 's'} · ${bandsText(n.bands)}`
      return `<li class="profile${i === netSel ? ' sel' : ''}">
        <span class="pi">${meter(n.bestRssi)}</span>
        <span class="pn">${escapeHtml(ssidText(n.ssid))}<br><span class="sub-line">${escapeHtml(detail)}</span></span>
        <span class="pd ${rssiClass(n.bestRssi)}">${n.bestRssi} dBm</span>
      </li>`
    })
    .join('')
  return `<ul class="profiles">${items}</ul>`
}

function renderApList(): string {
  const net = currentNetwork()
  if (!net) return `<p class="status-msg">That network is gone.</p>`
  const items = net.bssids
    .map((b, i) => {
      const detail = `ch ${b.channel} · ${b.band} GHz${b.widthMhz ? ` · ${b.widthMhz} MHz` : ''}${b.phy ? ` · ${b.phy}` : ''}`
      return `<li class="profile${i === apSel ? ' sel' : ''}">
        <span class="pi">${meter(b.rssi)}</span>
        <span class="pn">${escapeHtml(b.bssid)}<br><span class="sub-line">${escapeHtml(detail)}</span></span>
        <span class="pd ${rssiClass(b.rssi)}">${b.rssi} dBm</span>
      </li>`
    })
    .join('')
  return `<div class="section-title">${escapeHtml(ssidText(net.ssid))} — ${plural(net.bssids.length, 'access point')}</div>
    <ul class="profiles">${items}</ul>`
}

function renderApDetail(): string {
  const b = currentAp()
  if (!b) return `<p class="status-msg">That access point is gone.</p>`
  const track = trackFor(b.bssid)
  const sightings = track?.sightings ?? 1
  const freq = `Ch. ${b.channel} (${b.band} GHz${b.widthMhz ? `, ${b.widthMhz} MHz` : ''})`
  const mimo = b.streams ? `${b.phy ?? '—'}, MIMO ${b.streams}×${b.streams}` : (b.phy ?? '—')

  return `<div class="section-title">Access point</div>
    ${row('SSID', ssidText(b.ssid))}
    ${row('BSSID', b.bssid)}
    ${row('Vendor', b.vendor ?? (b.locallyAdministered ? 'randomised BSSID — no vendor to look up' : '—'), b.vendor ? '' : 'warn')}
    ${b.model ? row('Model', b.model) : ''}
    ${row('Security', b.security, b.security === 'Open' ? 'warn' : 'ok')}
    ${row('PHY mode', mimo)}
    ${row('Frequency', freq)}
    ${b.widthMhz ? row('Channel width', `${b.widthMhz} MHz`) : ''}
    ${row('Signal', track ? rangeText(track.rssi, ' dBm', sightings) : `${b.rssi} dBm`, rssiClass(b.rssi))}
    ${b.noise != null ? row('Noise', `${b.noise} dBm`) : ''}
    ${
      b.utilizationPct != null
        ? row(
            'Channel utilization',
            track?.utilizationPct
              ? rangeText(track.utilizationPct, '%', sightings)
              : `${b.utilizationPct}%`,
            b.utilizationPct > 60 ? 'bad' : b.utilizationPct > 30 ? 'warn' : 'ok'
          )
        : row('Channel utilization', 'not advertised', 'warn')
    }
    ${
      b.clients != null
        ? row(
            'Clients',
            track?.clients ? rangeText(track.clients, '', sightings) : String(b.clients)
          )
        : row('Clients', 'not advertised', 'warn')
    }
    ${b.countryCode ? row('Country', b.countryCode) : ''}
    ${track && sightings > 1 ? row('Seen', `${plural(sightings, 'time')} over ${clock(track.lastSeenSec - track.firstSeenSec)}`) : ''}
    <p class="hint2"><b>←</b>/<b>Esc</b> back</p>`
}

function renderBody(): string {
  if (result && result.status !== 'ok' && networks().length === 0) {
    return `<section class="panel-card">
      <div class="section-title">Wi-Fi scan</div>
      <p class="status-msg">${escapeHtml(result.message ?? 'The scan failed.')}</p>
    </section>`
  }
  const inner =
    level === 'networks' ? renderNetworkList() : level === 'aps' ? renderApList() : renderApDetail()
  return `<section class="panel-card">${inner}</section>`
}

export function renderWlan(): string {
  const status = statusLine()
  const footer =
    level === 'networks'
      ? `<b>↑↓</b> select · <b>Enter</b> open · <b>R</b> scan · <b>L</b> ${recording ? 'stop' : 'record'} · <b>Tab</b> ethernet`
      : `<b>↑↓</b> select · <b>Enter</b> open · <b>←</b> back · <b>R</b> scan · <b>L</b> ${recording ? 'stop' : 'record'}`
  return `
    ${renderTopbar(scanning || recording)}
    ${renderNotice()}
    ${status ? `<div class="selector"><span class="selector-hint">${escapeHtml(status)}</span></div>` : ''}
    ${renderBody()}
    <footer class="hint">${footer}</footer>`
}

async function resolveDevice(): Promise<string> {
  if (device) return device
  try {
    const adapters: Adapter[] = await window.api.listAdapters()
    device = adapters.find((a) => a.kind === 'wifi')?.device ?? 'en0'
  } catch {
    device = 'en0'
  }
  return device
}

async function scan(mode: 'once' | 'record'): Promise<void> {
  const dev = await resolveDevice()
  scanning = true
  if (mode === 'record') {
    recording = true
    // Say what recording does at the moment it starts, rather than as standing hint text.
    setNotice(RECORD_EXPLAINER)
  }
  requestRender()
  try {
    result = await window.api.startWifiScan(dev, mode)
    // A refused start (no helper, no permission) comes back already stopped.
    recording = result.running
  } catch (err) {
    console.error('wifi scan failed', err)
    recording = false
    setNotice(`Wi-Fi scan failed: ${String(err)}`)
  } finally {
    scanning = false
    requestRender()
  }
}

async function stopRecording(): Promise<void> {
  recording = false
  // The explainer described something that is no longer happening, so it goes with it.
  setNotice(null)
  requestRender()
  try {
    const final = await window.api.stopWifiScan()
    if (final) result = final
  } catch (err) {
    console.error('stopping the recording failed', err)
  }
  requestRender()
}

function move(delta: number): void {
  if (level === 'networks') {
    const n = networks().length
    if (n === 0) return
    netSel = (netSel + delta + n) % n
    apSel = 0
  } else if (level === 'aps') {
    const n = currentNetwork()?.bssids.length ?? 0
    if (n === 0) return
    apSel = (apSel + delta + n) % n
  }
  requestRender()
}

function descend(): void {
  if (level === 'networks' && currentNetwork()) level = 'aps'
  else if (level === 'aps' && currentAp()) level = 'detail'
  else return
  requestRender()
}

function ascend(): void {
  if (level === 'detail') level = 'aps'
  else if (level === 'aps') level = 'networks'
  else {
    if (recording) void stopRecording()
    setMode('chooser')
  }
  requestRender()
}

export function handleWlanKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') move(1)
  else if (e.key === 'ArrowUp') move(-1)
  else if (e.key === 'Enter' || e.key === 'ArrowRight') descend()
  else if (e.key === 'Escape' || e.key === 'ArrowLeft') ascend()
  else if (e.key === 'r' || e.key === 'R' || e.key === ' ') {
    if (!scanning) void scan('once')
  } else if (e.key === 'l' || e.key === 'L') {
    if (recording) void stopRecording()
    else void scan('record')
  } else return
  e.preventDefault()
}

/** Leaving the mode stops the radio work; a recording must not outlive the screen it belongs to. */
export function leaveWlan(): void {
  if (!recording) return
  recording = false
  void window.api
    .stopWifiScan()
    .then((final) => {
      if (final) result = final
      requestRender()
    })
    .catch(() => undefined)
}

/** Entering the mode takes one scan by itself — "look and see" is the whole promise. */
export function enterWlan(): void {
  if (result === null && !scanning) void scan('once')
}

export function initWlan(): void {
  window.api.onWifiUpdate((update) => {
    if (update.device && update.device !== device) return
    result = update
    recording = update.running
    requestRender()
  })
}
