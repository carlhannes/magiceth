// WLAN mode — the Wi-Fi scanner.
//
// Three levels, navigated with the arrow keys: the networks in earshot, the access points behind
// one network, and everything known about one access point. The same drill-down a technician does
// out loud — "who else is on channel 6?" — without typing a command.

import type {
  Adapter,
  ChannelBucket,
  ChannelLoad,
  MonitorStatus,
  RecordingSummary,
  SavedRecording,
  WifiBss,
  WifiNetwork,
  WifiRange,
  WifiScanResult,
  WifiTrack
} from '../../shared/types'
import { clock, escapeHtml, plural, row, rowWithSub } from './view'
import type { Hint } from './view'
import {
  confirmStep,
  consumePending,
  hints,
  renderShell,
  requestRender,
  setMode,
  setNotice
} from './shell'

let device = ''
let result: WifiScanResult | null = null
let scanning = false
let recording = false
let level: 'networks' | 'aps' | 'detail' | 'channels' | 'buckets' | 'saved' = 'networks'
let netSel = 0
let apSel = 0
let savedList: RecordingSummary[] = []
let savedSel = 0
/**
 * A recording read back from disk, shown instead of the live scan. It carries the same derived
 * views a live result does, so every screen below renders it without knowing which it is looking at.
 */
let loaded: SavedRecording | null = null

/** What pressing O is about to do, on the one OS that offers it. Asked before, never assumed. */
const ENABLE_ACCESS_EXPLAINER =
  'Turn Location on for me: removes the policy keys that pin it off (a privacy tool usually left them), switches on Location services and desktop-app access, and starts the location service. Asks for admin (UAC).'

/** What pressing L is about to do. Shown as the confirmation, not as standing hint text. */
const RECORD_EXPLAINER =
  'Recording — keeps scanning and tracks every access point over time, so signal, clients and channel load get a min/max/average. Walk around, then press L again to stop.'

/**
 * What pressing M is about to do. Shown as the confirmation, and honest about the cost: Wi-Fi goes
 * off. confirmStep adds "Press M again to start."
 */
const MONITOR_EXPLAINER =
  "Monitor mode — listens to every Wi-Fi frame on every channel to show how busy the air really is and which access points are there, including hidden ones. Nothing is sent, and the contents of other people's traffic are never read. This computer's Wi-Fi is disconnected for the duration and reconnected when you stop (allow about ten seconds). Asks for admin."

const RECONNECT_NOTE =
  'Stopped listening. Wi-Fi is being reconnected — give it about ten seconds, then R scans again.'

/** Deauthentications heard from one access point before it reads as a warning, and as bad. */
const DEAUTH_WARN = 3
const DEAUTH_BAD = 10

/** True while a listening session is running on this screen's live result. */
function listening(): boolean {
  return !loaded && result?.monitor?.running === true
}

function networks(): WifiNetwork[] {
  return loaded ? loaded.networks : (result?.networks ?? [])
}

function tracks(): WifiTrack[] {
  return loaded ? loaded.tracks : (result?.tracks ?? [])
}

function channels(): ChannelLoad[] {
  return loaded ? loaded.channels : (result?.channels ?? [])
}

function buckets(): ChannelBucket[] {
  return loaded ? loaded.buckets : (result?.buckets ?? [])
}

function bandTitle(band: string): string {
  return band === '?' ? 'Unknown band' : `${band} GHz`
}

/**
 * Stations on a channel, counted once per radio.
 *
 * Says so plainly when nothing advertised a count, because no access point reporting is a
 * different thing from nobody being connected. When only some of them report, the total is a
 * floor rather than a figure — written `≥` rather than spelled out, which would wrap the line.
 */
function clientsText(clients: number | undefined, fromAps: number, accessPoints: number): string {
  if (clients === undefined) return 'clients not advertised'
  // "at least zero" says nothing, so the qualifier is only worth showing on a real figure.
  const atLeast = clients > 0 && fromAps < accessPoints ? '≥' : ''
  return `${atLeast}${plural(clients, 'client')}`
}

/**
 * The dot reflects what the access points say about their own load, which is a measurement.
 * Overlap is shown as a number but deliberately does not drive the colour: wide channels overlap
 * a great deal by design, so colouring on it turns every 5 GHz row amber and says nothing.
 */
function loadClass(utilizationPct?: number): string {
  if (utilizationPct === undefined) return ''
  if (utilizationPct > 50) return 'bad'
  if (utilizationPct > 25) return 'warn'
  return 'ok'
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

function trackFor(bssid: string): WifiTrack | undefined {
  return tracks().find((t) => t.bssid === bssid)
}

const megabytes = (bytes: number): string =>
  bytes < 1024 * 1024 ? '<1 MB' : `${Math.round(bytes / 1024 / 1024)} MB`

/** `Listening · 38 channels · 4 312 frames · 38 MB · Wi-Fi off until you stop`, plus what is notable. */
function listeningLine(m: MonitorStatus): string {
  if (m.pcapBytes === 0) return 'Starting to listen — approve the admin prompt if one appears…'
  const parts = [
    'Listening',
    plural(m.channelsVisited, 'channel'),
    `${m.frames.toLocaleString('en')} ${m.frames === 1 ? 'frame' : 'frames'}`,
    megabytes(m.pcapBytes)
  ]
  if (m.channelsFailed > 0) parts.push(`${m.channelsFailed} could not be tuned`)
  if (m.pinnedChannel !== undefined) parts.push(`held on ch ${m.pinnedChannel}`)
  parts.push('Wi-Fi off until you stop')
  return parts.join(' · ')
}

function statusLine(): string {
  if (listening() && result?.monitor) return listeningLine(result.monitor)
  if (loaded) {
    const s = loaded.summary
    return `Saved ${s.startedAt} · ${clock(s.durationSec)} · ${plural(s.networks, 'network')}, ${plural(s.accessPoints, 'access point')}`
  }
  if (!result) return scanning ? 'Scanning…' : ''
  const count = plural(networks().length, 'network')
  const aps = plural(
    networks().reduce((n, x) => n + x.bssids.length, 0),
    'access point'
  )
  if (recording) {
    // Say whether it is reaching disk. A walk you thought was being saved and was not is the
    // worst outcome this feature has, so the absence of a file is stated rather than implied.
    // Name the stem, not a file: the time log is being appended to right now and the aggregate
    // does not exist until the recording stops, so naming either one alone would be wrong.
    const where = result.savedTo
      ? `saving as ${result.savedTo.replace(/^.*[\\/]/, '').replace(/\.agg\.csv$/, '')}`
      : 'NOT being saved — could not write to Documents'
    return `Recording ${clock(result.elapsedSec)} · ${result.scans} scans · ${count}, ${aps} · ${where}`
  }
  return `${count}, ${aps} · ${result.scans} ${result.scans === 1 ? 'scan' : 'scans'}`
}

function renderNetworkList(): string {
  const list = networks()
  if (list.length === 0) {
    if (listening()) {
      return `<p class="status-msg">Listening — the first sweep of the channels takes about fifteen seconds.</p>`
    }
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

/**
 * A vendor read off the address is a fact; one inferred from a beacon element on a randomised
 * BSSID is weaker, so the two are not shown as though they were the same thing.
 */
function vendorText(b: WifiBss): string {
  if (b.vendor && b.locallyAdministered) return `${b.vendor} · from beacon, BSSID randomised`
  if (b.vendor) return b.vendor
  return b.locallyAdministered ? 'randomised BSSID — nothing to look up' : '—'
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
    ${row('Vendor', vendorText(b), b.vendor ? '' : 'warn')}
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
    ${b.airFramesPerSec != null ? row('Air', `≈ ${b.airFramesPerSec} frames/s · ${b.airRetryPct ?? 0}% retries`, (b.airRetryPct ?? 0) > 30 ? 'bad' : (b.airRetryPct ?? 0) > 15 ? 'warn' : '') : ''}
    ${b.deauths != null ? row('Deauths heard', String(b.deauths), b.deauths >= DEAUTH_BAD ? 'bad' : b.deauths >= DEAUTH_WARN ? 'warn' : '') : ''}
    ${track && sightings > 1 ? row('Seen', `${plural(sightings, 'time')} over ${clock(track.lastSeenSec - track.firstSeenSec)}`) : ''}`
}

/** What listening measured on a channel, kept apart from the load its access points advertise. */
function airText(c: ChannelLoad): string | undefined {
  if (c.visited === undefined) return undefined
  if (c.visited === 0) return 'the card could not tune to it'
  return `heard ≈ ${c.framesPerSec ?? 0} frames/s · ${c.retryPct ?? 0}% retries`
}

function airClass(c: ChannelLoad): string {
  if (c.visited === 0) return 'warn'
  if ((c.retryPct ?? 0) > 30) return 'bad'
  if ((c.retryPct ?? 0) > 15) return 'warn'
  return ''
}

/** Which channels are crowded, and whether the crowd is near enough to matter. */
function renderChannels(): string {
  const list = channels()
  if (list.length === 0) return `<p class="status-msg">Nothing heard yet — press R.</p>`
  const busiest = Math.max(1, ...list.map((c) => c.accessPoints))
  let band = ''
  const out: string[] = []
  for (const c of list) {
    if (c.band !== band) {
      band = c.band
      out.push(`<div class="section-title">${bandTitle(band)}</div>`)
    }
    // Capped at five so the busiest row still fits on one line in a 480px window.
    const bars = '▋'.repeat(Math.max(1, Math.round((c.accessPoints / busiest) * 5)))
    const detail = [
      c.accessPoints > 0 ? clientsText(c.clients, c.clientsFromAps, c.accessPoints) : undefined,
      c.maxUtilizationPct != null ? `load ${c.maxUtilizationPct}%` : undefined,
      airText(c),
      // Only worth saying when something beyond this channel's own access points reaches it.
      c.overlappingAps > c.accessPoints ? `${c.overlappingAps} overlapping` : undefined
    ]
      .filter(Boolean)
      .join(' · ')
    // A channel nobody advertises on has no bars and no strongest signal; the air line carries it.
    const value =
      c.accessPoints > 0 && c.bestRssi !== undefined
        ? `${bars} ${plural(c.accessPoints, 'AP')} · ${c.bestRssi} dBm`
        : 'no AP heard'
    out.push(
      rowWithSub(
        `Ch ${c.channel}`,
        value,
        detail,
        c.maxUtilizationPct !== undefined ? loadClass(c.maxUtilizationPct) : airClass(c)
      )
    )
  }
  return out.join('')
}

/**
 * The same picture rolled up into the blocks channels are planned in: the non-overlapping thirds
 * on 2.4 GHz, and the named regulatory blocks above it. Answers "which part of the band is busy"
 * without reading twenty rows.
 */
function renderBuckets(): string {
  const list = buckets()
  if (list.length === 0) return `<p class="status-msg">Nothing heard yet — press R.</p>`
  const busiest = Math.max(...list.map((b) => b.accessPoints))
  let band = ''
  const out: string[] = []
  for (const b of list) {
    if (b.band !== band) {
      band = b.band
      out.push(`<div class="section-title">${bandTitle(band)}</div>`)
    }
    const bars = '▋'.repeat(Math.max(1, Math.round((b.accessPoints / busiest) * 5)))
    const detail = [
      clientsText(b.clients, b.clientsFromAps, b.accessPoints),
      b.maxUtilizationPct != null ? `load ${b.maxUtilizationPct}%` : undefined,
      `ch ${b.channels.join(', ')} in use`
    ]
      .filter(Boolean)
      .join(' · ')
    out.push(
      rowWithSub(
        b.label,
        `${bars} ${plural(b.accessPoints, 'AP')} · ${b.bestRssi} dBm`,
        detail,
        loadClass(b.maxUtilizationPct)
      )
    )
  }
  return out.join('')
}

/** Recordings written to Documents/magiceth, newest first. */
function renderSavedList(): string {
  if (savedList.length === 0) {
    return `<div class="section-title">Saved recordings</div>
      <p class="status-msg">Nothing saved yet. ${hints([{ keys: ['l'], label: 'record a walk' }])} — it is written to your Documents folder as it runs.</p>`
  }
  const items = savedList
    .map(
      (r, i) => `<li class="profile${i === savedSel ? ' sel' : ''}">
        <span class="pi">${i + 1}</span>
        <span class="pn">${escapeHtml(r.startedAt)}<br><span class="sub-line">${escapeHtml(
          `${plural(r.networks, 'network')}, ${plural(r.accessPoints, 'AP')}`
        )}</span></span>
        <span class="pd">${clock(r.durationSec)}</span>
      </li>`
    )
    .join('')
  return `<div class="section-title">Saved recordings — Documents/magiceth</div>
    <ul class="profiles">${items}</ul>`
}

function renderLevel(): string {
  switch (level) {
    case 'saved':
      return renderSavedList()
    case 'buckets':
      return renderBuckets()
    case 'channels':
      return renderChannels()
    case 'aps':
      return renderApList()
    case 'detail':
      return renderApDetail()
    default:
      return renderNetworkList()
  }
}

function renderBody(): string {
  if (result && result.status !== 'ok' && networks().length === 0) {
    const fix = result.canEnableAccess
      ? `<p class="hint2">${hints([
          { keys: ['o'], label: 'turn Location on for me (asks for admin)' },
          { keys: ['r'], label: 'scan again' }
        ])}</p>`
      : ''
    return `<section class="panel-card">
      <div class="section-title">Wi-Fi scan</div>
      <p class="status-msg">${escapeHtml(result.message ?? 'The scan failed.')}</p>
      ${fix}
    </section>`
  }
  return `<section class="panel-card">${renderLevel()}</section>`
}

/** The legend for the level on screen: only keys that do something there. */
function footerHints(): Hint[] {
  const select: Hint = { keys: ['ArrowUp', 'ArrowDown'], label: 'select' }
  const open: Hint = { keys: ['Enter'], label: 'open' }
  const back: Hint = { keys: ['ArrowLeft', 'Escape'], label: 'back' }
  const scan: Hint = { keys: ['r'], label: 'scan' }
  const record: Hint = { keys: ['l'], label: recording ? 'stop' : 'record' }
  const channel: Hint = {
    keys: ['c'],
    label: level === 'channels' ? 'groups' : level === 'buckets' ? 'close' : 'channels'
  }
  const next: Hint = { keys: ['Tab'], label: 'configure' }
  // Listening is a separate key because it is a different act: it disconnects. R has nothing to
  // scan with while it runs, so it is not offered.
  const live = listening()
  const listen: Hint[] =
    result?.canMonitor && !loaded
      ? [{ keys: ['m'], label: live ? 'stop listening' : 'listen' }]
      : []
  const scanKey: Hint[] = live ? [] : [scan]
  switch (level) {
    case 'saved':
      return [
        select,
        open,
        { keys: ['f'], label: 'folder' },
        { keys: ['s', 'Escape'], label: 'close' },
        next
      ]
    case 'networks': {
      const extra: Hint[] = []
      if (result?.canEnableAccess && networks().length === 0)
        extra.push({ keys: ['o'], label: 'location' })
      if (loaded) extra.push({ keys: ['f'], label: 'folder' })
      return [
        select,
        open,
        channel,
        { keys: ['s'], label: 'saved' },
        ...scanKey,
        record,
        ...listen,
        ...extra,
        next,
        { keys: ['Escape'], label: loaded ? 'saved list' : 'back' }
      ]
    }
    case 'aps':
      return [select, open, back, channel, ...scanKey, record, ...listen]
    case 'detail': {
      const held = live && currentAp()?.channel === result?.monitor?.pinnedChannel
      const pin: Hint[] = live
        ? [{ keys: ['k'], label: held ? 'sweep again' : 'hold channel' }]
        : []
      return [back, channel, ...scanKey, record, ...listen, ...pin]
    }
    default:
      // channels, buckets: nothing to select or open.
      return [back, channel, ...scanKey, record, ...listen]
  }
}

export function renderWlan(): string {
  const status = statusLine()
  return renderShell({
    // Which list you are on, and which row you opened — so moving the selection keeps your place
    // while descending into something else starts at the top.
    key: `wlan:${level}:${level === 'detail' ? `${netSel}:${apSel}` : level === 'aps' ? netSel : ''}`,
    busy: scanning || recording || listening(),
    // Live while recording: elapsed time, scans, and the file being written. Worth keeping on
    // screen while scrolling a long list.
    status: status
      ? `<div class="selector"><span class="selector-hint">${escapeHtml(status)}</span></div>`
      : '',
    footer: footerHints(),
    body: renderBody()
  })
}

async function resolveDevice(): Promise<string> {
  if (device) return device
  try {
    const adapters: Adapter[] = await window.api.listAdapters()
    // '' means "whatever the OS considers its Wi-Fi card" — main resolves it per platform.
    device = adapters.find((a) => a.kind === 'wifi')?.device ?? ''
  } catch {
    device = ''
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

/** Put Wi-Fi aside and listen. A refusal leaves what was on screen alone and says why. */
async function startListening(): Promise<void> {
  const dev = await resolveDevice()
  scanning = true
  // The status line says what is happening, prompt included; a standing notice would outlive it.
  setNotice(null)
  requestRender()
  try {
    const next = await window.api.startMonitor(dev)
    if (next.status === 'ok') {
      result = next
      recording = next.running
    } else {
      setNotice(next.message ?? 'Could not start listening.')
    }
  } catch (err) {
    console.error('starting to listen failed', err)
    setNotice(`Could not start listening: ${String(err)}`)
  } finally {
    scanning = false
    requestRender()
  }
}

async function stopListening(): Promise<void> {
  setNotice(RECONNECT_NOTE)
  try {
    const final = await window.api.stopMonitor()
    if (final) result = final
  } catch (err) {
    console.error('stopping listening failed', err)
  }
  requestRender()
}

/** K on an access point: hold the radio on its channel and width, or sweep again. */
async function togglePin(): Promise<void> {
  const ap = currentAp()
  if (!ap || !listening()) return
  const held = ap.channel === result?.monitor?.pinnedChannel
  setNotice(
    held
      ? null
      : `Holding the radio on channel ${ap.channel}, so every frame on it is heard. K again to sweep all channels.`
  )
  try {
    const next = await window.api.pinMonitor(held ? null : ap.bssid)
    if (next) result = next
  } catch (err) {
    console.error('pinning the channel failed', err)
  }
  requestRender()
}

/** The one-key Location fix. Whatever comes back is shown; a failure leaves the screen as it was. */
async function enableAccess(): Promise<void> {
  scanning = true
  setNotice(null)
  requestRender()
  let outcome = { ok: false, message: 'Could not change the Location settings.' }
  try {
    outcome = await window.api.enableWifiAccess()
  } catch (err) {
    outcome = { ok: false, message: `Could not change the Location settings: ${String(err)}` }
  }
  scanning = false
  setNotice(outcome.message)
  requestRender()
  if (outcome.ok) void scan('once')
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

async function openSavedList(): Promise<void> {
  try {
    savedList = await window.api.listRecordings()
  } catch (err) {
    console.error('listing recordings failed', err)
    savedList = []
  }
  savedSel = 0
  level = 'saved'
  requestRender()
}

async function openSelectedRecording(): Promise<void> {
  const summary = savedList[savedSel]
  if (!summary) return
  try {
    const recording = await window.api.readRecording(summary.id)
    if (!recording) {
      setNotice('That recording could not be read.')
      requestRender()
      return
    }
    loaded = recording
    level = 'networks'
    netSel = 0
    apSel = 0
  } catch (err) {
    setNotice(`Could not open that recording: ${String(err)}`)
  }
  requestRender()
}

/** Drop back to the live scan. Scanning into a saved recording makes no sense. */
function backToLive(): void {
  loaded = null
  netSel = 0
  apSel = 0
}

function move(delta: number): void {
  if (level === 'saved') {
    const n = savedList.length
    if (n === 0) return
    savedSel = (savedSel + delta + n) % n
  } else if (level === 'networks') {
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
  if (level === 'saved') {
    void openSelectedRecording()
    return
  }
  if (level === 'channels' || level === 'buckets') return
  if (level === 'networks' && currentNetwork()) level = 'aps'
  else if (level === 'aps' && currentAp()) level = 'detail'
  else return
  requestRender()
}

function ascend(): void {
  if (level === 'detail') level = 'aps'
  else if (level === 'aps') level = 'networks'
  else if (level === 'channels' || level === 'buckets') level = 'networks'
  else if (level === 'saved') level = 'networks'
  else if (loaded) {
    // Viewing a saved recording: step back to the list it came from, not out of the mode.
    backToLive()
    void openSavedList()
    return
  } else {
    if (recording) void stopRecording()
    setMode('chooser')
  }
  requestRender()
}

export function handleWlanKey(e: KeyboardEvent): void {
  // Every keystroke consumes any outstanding confirmation: only the very next press of the same
  // key counts, exactly as in Ethernet mode.
  const pending = consumePending()
  if (e.key === 'ArrowDown') move(1)
  else if (e.key === 'ArrowUp') move(-1)
  else if (e.key === 'Enter' || e.key === 'ArrowRight') descend()
  else if (e.key === 'Escape' || e.key === 'ArrowLeft') ascend()
  else if (e.key === 'r' || e.key === 'R' || e.key === ' ') {
    // While listening the station is down: a scan would only fail.
    if (!scanning && !listening()) {
      backToLive()
      void scan('once')
    }
  } else if (e.key === 'm' || e.key === 'M') {
    if (!result?.canMonitor || loaded || scanning) return
    if (listening()) void stopListening()
    else if (confirmStep('m', '', MONITOR_EXPLAINER, pending)) void startListening()
  } else if (e.key === 'k' || e.key === 'K') {
    if (level !== 'detail' || !listening()) return
    void togglePin()
  } else if (e.key === 'l' || e.key === 'L') {
    if (recording) void stopRecording()
    else {
      backToLive()
      void scan('record')
    }
  } else if (e.key === 'c' || e.key === 'C') {
    // Cycles through the two ways of reading the spectrum, then back out.
    level = level === 'channels' ? 'buckets' : level === 'buckets' ? 'networks' : 'channels'
    requestRender()
  } else if (e.key === 's' || e.key === 'S') {
    if (level === 'saved') {
      level = 'networks'
      requestRender()
    } else void openSavedList()
  } else if (e.key === 'f' || e.key === 'F') {
    const summary = level === 'saved' ? savedList[savedSel] : loaded?.summary
    if (summary) void window.api.revealRecording(summary.id)
  } else if (e.key === 'o' || e.key === 'O') {
    if (!result?.canEnableAccess || scanning) return
    if (confirmStep('o', '', ENABLE_ACCESS_EXPLAINER, pending)) void enableAccess()
  } else return
  e.preventDefault()
}

/** Leaving the mode stops the radio work; a recording must not outlive the screen it belongs to. */
export function leaveWlan(): void {
  // Listening first: it has Wi-Fi switched off, and the stop is what switches it back on.
  if (listening()) void window.api.stopMonitor().catch(() => undefined)
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
    const wasListening = listening()
    result = update
    recording = update.running
    // A session that ended on its own (refused prompt, a cap, an error) says why, once.
    if (wasListening && update.monitor && !update.monitor.running) {
      setNotice(update.monitor.message ?? RECONNECT_NOTE)
    }
    requestRender()
  })
}
