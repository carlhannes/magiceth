// `iw dev <if> scan dump` — the Linux view of the air.
//
// Linux has no raw-bytes route to a scanned beacon from an ordinary process: `iw` reads the kernel's
// scan cache over nl80211 and prints every element it understands already decoded, keeping the raw
// bytes only for the ones it does not. So where macOS and Windows hand `ie80211.readBeacon()` a hex
// string, Linux hands this parser text, and both produce the same BeaconFacts. The labels are
// shared with the byte decoder (securityLabel, phyLabel, vhtWidth) so the two cannot drift apart.
//
// The output is organised as one block per BSS, each line indented with tabs: one tab for an
// element or field, two or three for its details. The parser reads it that way — sections by
// name, details by regex inside the section — rather than by line number, which is what keeps it
// standing when a new iw version adds an element in the middle.

import { phyLabel, securityLabel, vhtWidth, withPrivacyBit } from '../capabilities/ie80211'
import type { BeaconFacts } from '../capabilities/ie80211'
import type { PhyChannel } from '../capabilities/monitor/plan'
import { shQuote } from '../privilege'
import type { MonitorSpec } from '.'

export interface IwBss {
  bssid: string
  ssid: string
  freqMhz?: number
  /** dBm. Absent when the driver reports signal in unspecified units rather than dBm. */
  rssi?: number
  /** How long ago the kernel last heard this BSS, from `last seen: N ms ago`. */
  ageMs?: number
  associated: boolean
  facts: BeaconFacts
}

interface Section {
  name: string
  text: string
}

/** Split one BSS block into its named sections; a name can repeat (`Vendor specific`). */
function sections(block: string): Section[] {
  const out: Section[] = []
  for (const line of block.split('\n')) {
    if (line === '') continue
    const header = line.match(/^\t(?!\t)([^:\t]+):?(.*)$/)
    if (header) {
      out.push({ name: header[1].trim(), text: header[2] })
    } else if (out.length > 0) {
      out[out.length - 1].text += `\n${line}`
    }
  }
  return out
}

function first(secs: Section[], name: string): string | undefined {
  return secs.find((s) => s.name === name)?.text
}

function has(secs: Section[], name: string): boolean {
  return secs.some((s) => s.name === name)
}

/** `iw` writes anything unprintable in an SSID as `\xNN`; a hidden network is NULs or nothing. */
export function decodeIwSsid(raw: string): string {
  const bytes: number[] = []
  // Only the SSID line itself; the name is the rest of that line and nothing after it.
  const text = raw.split('\n')[0].replace(/^ /, '')
  for (let i = 0; i < text.length; i++) {
    const esc = text.slice(i).match(/^\\x([0-9a-fA-F]{2})/)
    if (esc) {
      bytes.push(Number.parseInt(esc[1], 16))
      i += 3
    } else {
      bytes.push(...new TextEncoder().encode(text[i]))
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes)).replace(/\0+$/, '')
}

/** `0-15` → 2 streams, `0-31` → 4: eight MCS indexes per spatial stream. */
function htStreamsFrom(text: string | undefined): number | undefined {
  const m = text?.match(/HT RX MCS rate indexes supported: 0-(\d+)/)
  if (!m) return undefined
  return Math.ceil((Number(m[1]) + 1) / 8) || undefined
}

/** Count the `N streams: MCS …` lines under a heading, ignoring `not supported`. */
function streamsUnder(text: string | undefined, heading: RegExp): number | undefined {
  const at = text?.search(heading)
  if (text === undefined || at === undefined || at < 0) return undefined
  const lines = text.slice(at).split('\n').slice(1)
  let streams = 0
  for (const line of lines) {
    const m = line.match(/^\t\t\t(\d) streams: (.*)$/)
    if (!m) break
    if (/MCS/.test(m[2])) streams++
  }
  return streams || undefined
}

/**
 * The AKM names `iw` prints (scan.c print_auth): PSK, FT/PSK, PSK/SHA-256, SAE, FT/SAE, OWE,
 * IEEE 802.1X and its FT, SHA-256, SUITE-B and FILS variants.
 */
function securityFrom(rsn: string | undefined, wpa: string | undefined): string | undefined {
  const suites = (rsn ?? wpa)?.match(/Authentication suites: (.*)/)?.[1]
  if (suites === undefined)
    return rsn !== undefined ? 'WPA2' : wpa !== undefined ? 'WPA' : undefined
  const names = suites.trim().split(/\s+/)
  const label = securityLabel({
    sae: names.some((n) => /^(FT\/)?SAE$/.test(n)),
    psk: names.some((n) => /^(FT\/)?PSK(\/SHA-256)?$/.test(n)),
    enterprise: names.some((n) => /802\.1X|FILS/.test(n)),
    owe: names.includes('OWE')
  })
  // The old WPA element alone is WPA1 whatever it calls its suites.
  return rsn === undefined ? 'WPA' : label
}

function widthFrom(secs: Section[]): number | undefined {
  const vht = first(secs, 'VHT operation')
  if (vht) {
    const width = Number(vht.match(/channel width: (\d)/)?.[1] ?? 0)
    const seg1 = Number(vht.match(/center freq segment 1: (\d+)/)?.[1] ?? 0)
    const seg2 = Number(vht.match(/center freq segment 2: (\d+)/)?.[1] ?? 0)
    const wide = vhtWidth(width, seg1, seg2)
    if (wide !== undefined) return wide
  }
  const ht = first(secs, 'HT operation')
  if (ht) return /secondary channel offset: (above|below)/.test(ht) ? 40 : 20
  return undefined
}

function factsOf(secs: Section[], capability: string | undefined): BeaconFacts {
  const facts: BeaconFacts = { vendorOuis: [] }
  const ssid = first(secs, 'SSID')
  if (ssid !== undefined) facts.ssid = decodeIwSsid(ssid) || undefined

  const load = first(secs, 'BSS Load')
  const stations = load?.match(/station count: (\d+)/)
  const util = load?.match(/channel utili[sz]ation: (\d+)\/255/)
  if (stations && util) {
    facts.clients = Number(stations[1])
    facts.utilizationPct = Math.round((Number(util[1]) / 255) * 100)
  }

  const htCaps = first(secs, 'HT capabilities')
  const vhtCaps = first(secs, 'VHT capabilities')
  const heCaps = first(secs, 'HE capabilities')
  // An iw too old to decode HE/EHT prints them as unknown extension elements 35 (0x23) and 108 (0x6c).
  const unknown = secs.filter((s) => /^Unknown IE \(255\)/.test(s.name)).map((s) => s.text)
  const he = heCaps !== undefined || unknown.some((t) => /^:? ?23 /.test(t))
  const eht = has(secs, 'EHT capabilities') || unknown.some((t) => /^:? ?6c /.test(t))
  facts.phy = phyLabel({ ht: htCaps !== undefined, vht: vhtCaps !== undefined, he, eht })
  facts.streams =
    streamsUnder(vhtCaps, /VHT RX MCS set:/) ??
    htStreamsFrom(htCaps) ??
    streamsUnder(heCaps, /HE RX MCS and NSS set/)

  const rsn = first(secs, 'RSN')
  const wpa = first(secs, 'WPA')
  facts.security = securityFrom(rsn, wpa)

  const wps = first(secs, 'WPS')
  const manufacturer = wps?.match(/\* Manufacturer: (.+)/)?.[1].trim()
  const model = wps?.match(/\* Model: (.+)/)?.[1].trim()
  if (manufacturer) facts.manufacturer = manufacturer
  if (model) facts.model = model

  for (const s of secs) {
    if (s.name !== 'Vendor specific') continue
    const oui = s.text.match(/OUI ([0-9a-f]{2}):([0-9a-f]{2}):([0-9a-f]{2})/i)
    if (!oui) continue
    const key = `${oui[1]}${oui[2]}${oui[3]}`.toLowerCase()
    if (!facts.vendorOuis.includes(key)) facts.vendorOuis.push(key)
  }

  const country = first(secs, 'Country')?.match(/^\s*([A-Z]{2})\b/)
  if (country) facts.countryCode = country[1]

  facts.widthMhz = widthFrom(secs)
  return withPrivacyBit(facts, capability !== undefined && /\bPrivacy\b/.test(capability))
}

/** Every BSS in a scan dump. A block the parser cannot place (no BSSID) is skipped, never thrown on. */
export function parseIwScan(text: string): IwBss[] {
  const out: IwBss[] = []
  const blocks = text.replace(/\r\n/g, '\n').split(/^(?=BSS )/m)
  for (const block of blocks) {
    const head = block.match(/^BSS ([0-9a-f]{2}(?::[0-9a-f]{2}){5})\(on [^)]*\)(.*)$/im)
    if (!head) continue
    const secs = sections(block)
    const freq = first(secs, 'freq')?.match(/(\d+)(?:\.\d+)?/)
    const signal = first(secs, 'signal')?.match(/(-?\d+(?:\.\d+)?) dBm/)
    const age = secs.find((s) => s.name === 'last seen' && /ms ago/.test(s.text))
    const ageMs = age?.text.match(/(\d+) ms ago/)
    const facts = factsOf(secs, first(secs, 'capability'))
    out.push({
      bssid: head[1].toLowerCase(),
      ssid: facts.ssid ?? '',
      freqMhz: freq ? Number(freq[1]) : undefined,
      rssi: signal ? Math.round(Number(signal[1])) : undefined,
      ageMs: ageMs ? Number(ageMs[1]) : undefined,
      associated: /associated|joined/.test(head[2]),
      facts
    })
  }
  return out
}

/** Hard cap on the elevated loop, so a lost stop file can never leave a root loop scanning forever. */
export const LOOP_MAX_SECONDS = 3600

/** The loop ends by itself once nobody has asked for a scan for this long. */
export const LOOP_IDLE_MINUTES = 5

/**
 * The elevated scan loop, for a Linux without NetworkManager: triggering a sweep needs
 * CAP_NET_ADMIN, and asking for a password on every press is not a tool anyone would use. So one
 * password buys a loop that scans every few seconds and writes each result atomically to outFile,
 * on the same stop-file pattern as the port survey's capture. It also stops on its own — after the
 * hard cap, or when keepFile has not been touched for a while, which is how a once-scan does not
 * keep the radio off-channel for an hour after the last press.
 */
export function iwScanLoopScript(
  device: string,
  outFile: string,
  stopFile: string,
  keepFile: string
): string {
  const out = shQuote(outFile)
  const tmp = shQuote(`${outFile}.tmp`)
  return (
    `n=0; while [ ! -f ${shQuote(stopFile)} ] && [ $n -lt ${LOOP_MAX_SECONDS} ] && ` +
    `[ -n "$(find ${shQuote(keepFile)} -mmin -${LOOP_IDLE_MINUTES} 2>/dev/null)" ]; do ` +
    `iw dev ${shQuote(device)} scan > ${tmp} 2>&1; mv -f ${tmp} ${out}; ` +
    `sleep 5; n=$((n+5)); done; rm -f ${shQuote(stopFile)}; true`
  )
}

// --- Listening: the card's monitor mode ---------------------------------------------------------

/** The second interface the session adds next to the station; the station is left in place, down. */
export const MONITOR_INTERFACE = 'magicmon0'

/** A listening session ends by itself after this long, whatever else happens. */
export const MONITOR_MAX_SECONDS = 900

/** ...or when the capture file reaches this size, which a dense office can do in minutes. */
export const MONITOR_MAX_BYTES = 256 * 1024 * 1024

/** `iw dev <if> info` names the wiphy the interface belongs to: `wiphy 0`. */
export function parseIwWiphy(text: string): number | undefined {
  const m = /^\s*wiphy (\d+)\s*$/m.exec(text)
  return m ? Number(m[1]) : undefined
}

/**
 * `iw phy phyN info`: whether the card lists monitor among its interface modes, and every
 * frequency it reports. A frequency line reads `* 5180 MHz [36] (22.0 dBm)`, newer iw adds a
 * decimal (`5180.0 MHz`), and the flags follow in parentheses: `(disabled)`, `(no IR)`,
 * `(radar detection)`. Only disabled keeps a channel out — receiving where transmitting is
 * forbidden is allowed, and listening is all this does.
 */
export function parseIwPhy(text: string): { monitor: boolean; channels: PhyChannel[] } {
  let monitor = false
  let inModes = false
  const channels: PhyChannel[] = []
  for (const line of text.split('\n')) {
    if (/^\s*Supported interface modes:/.test(line)) {
      inModes = true
      continue
    }
    if (inModes) {
      const mode = /^\s*\* (\S+)\s*$/.exec(line)
      if (mode) {
        if (mode[1] === 'monitor') monitor = true
        continue
      }
      inModes = false
    }
    const freq = /^\s*\* (\d{4})(?:\.\d+)? MHz \[\d+\](.*)$/.exec(line)
    if (freq) channels.push({ freqMhz: Number(freq[1]), disabled: /\(disabled\)/.test(freq[2]) })
  }
  return { monitor, channels }
}

/**
 * The elevated listening session, as a POSIX shell script (the helper runs it with /bin/sh, which
 * is dash on Ubuntu). In order: remember how to get the network back, put the card aside, add a
 * monitor interface, start tcpdump, and hop between channels until told to stop — a stop file, the
 * time and size caps, or tcpdump dying. Every way out, including SIGTERM, runs `restore`.
 *
 * Why it is shaped like this:
 *  - tcpdump's output goes through this shell's own redirection. Ubuntu's tcpdump drops to the
 *    `tcpdump` user and is confined by AppArmor, so letting it open the file fails; root's shell
 *    opens it, and creates it (`umask 022`) where the app may read and delete it.
 *  - `kill -9`, as the port survey's script: SIGTERM does not stop tcpdump while its read is blocked.
 *  - The hop journal says what the radio really did. The app cannot see the channel from the
 *    outside, and without it a channel the card refused looks the same as a silent one.
 *  - A pin file holds the radio on one channel (and width) in place of the sweep.
 *  - `-s 1024` keeps the first kilobyte of each frame. The real Wi-Fi 6E and 7 beacons in the
 *    test fixtures are 392 and 484 bytes before the radio header, so a beacon fits easily, while
 *    a longer capture would only put more of other people's data frames on disk, where nothing
 *    reads them. A beacon that does not fit is read up to the cut, and the decoder says it was cut.
 *  - Errors from every command land in the log file, which the app shows when a session ends early.
 *  - Exit codes are 0 (asked to stop, or capped), 1 (could not start) and 128+signal; never 126
 *    or 127, which the app reads as "the admin prompt was refused".
 *  - SIGKILL on the shell itself cannot be caught. The interface then stays down and the monitor
 *    interface stays; the next session removes a leftover first, and a reboot clears the rest.
 */
export function linuxMonitorScript(spec: MonitorSpec): string {
  if (!spec.freqs.every((f) => Number.isInteger(f) && f > 0)) {
    throw new Error('Monitor frequencies must be positive integers.')
  }
  if (spec.freqs.length === 0) throw new Error('A listening session needs at least one channel.')
  const q = shQuote
  const nm = spec.support.networkManager
  const [stop, pin, pcap, hops] = [spec.stopFile, spec.pinFile, spec.pcapFile, spec.hopsFile].map(q)
  const lines = [
    'umask 022',
    `exec 2>> ${q(spec.logFile)}`,
    `D=${q(spec.device)}`,
    `M=${MONITOR_INTERFACE}`,
    'P=',
    nm ? 'C=$(nmcli -g GENERAL.CONNECTION device show "$D" 2>/dev/null)' : 'C=',
    'restore() {',
    '  trap "" INT TERM HUP',
    '  [ -n "$P" ] && kill -9 "$P" 2>/dev/null',
    '  iw dev "$M" del 2>/dev/null',
    '  ip link set "$D" up 2>/dev/null',
    ...(nm
      ? [
          '  nmcli device set "$D" managed yes 2>/dev/null',
          '  [ -n "$C" ] && [ "$C" != -- ] && nmcli -w 20 connection up id "$C" >/dev/null 2>&1'
        ]
      : []),
    `  rm -f ${stop} ${pin}`,
    '  true',
    '}',
    'trap restore EXIT',
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    "trap 'exit 129' HUP",
    'iw dev "$M" del 2>/dev/null',
    ...(nm ? ['nmcli device set "$D" managed no || exit 1'] : []),
    'ip link set "$D" down || exit 1',
    'iw dev "$D" interface add "$M" type monitor || exit 1',
    'ip link set "$M" up || exit 1',
    `tcpdump -i "$M" -nn -U -s 1024 -w - ${q('not type ctl')} >> ${pcap} &`,
    'P=$!',
    'T=$(date +%s)',
    'visit() {',
    `  [ -e ${stop} ] && exit 0`,
    `  [ $(( $(date +%s) - T )) -ge ${spec.maxSeconds} ] && exit 0`,
    `  [ "$(stat -c %s ${pcap})" -ge ${spec.maxBytes} ] && exit 0`,
    '  kill -0 "$P" 2>/dev/null || exit 1',
    `  if iw dev "$M" set freq "$@" 2>/dev/null; then echo "ok $pass $1" >> ${hops}`,
    `  elif [ $# -gt 1 ] && iw dev "$M" set freq "$1" 2>/dev/null; then echo "ok $pass $1" >> ${hops}`,
    `  else echo "fail $pass $1" >> ${hops}; fi`,
    `  sleep ${(spec.dwellMs / 1000).toFixed(3)}`,
    '}',
    'pass=0',
    'while :; do',
    '  pass=$((pass + 1))',
    `  if [ -f ${pin} ] && read -r pf pw pc < ${pin} && [ -n "$pc" ]; then`,
    '    n=0',
    '    while [ $n -lt 5 ]; do visit "$pf" "$pw" "$pc"; n=$((n + 1)); done',
    '  else',
    `    for f in ${spec.freqs.join(' ')}; do visit "$f"; done`,
    '  fi',
    'done'
  ]
  return lines.join('\n')
}
