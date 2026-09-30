# Wi-Fi findings

What macOS will and will not tell an application about the air around it, and how `magiceth` gets
at the rest. Everything below was measured on 2026-09-29; commands and their results are quoted so
the conclusions can be re-checked rather than taken on trust.

This file owns the Wi-Fi scanning topic. [ARCHITECTURE.md](ARCHITECTURE.md) links here instead of
repeating it.

## The rig

|        |                                             |
| ------ | ------------------------------------------- |
| Host   | macOS 27.0 (build 26A428), arm64, Swift 6.4 |
| `en0`  | built-in Wi-Fi, the only wireless interface |
| Around | a residential street, later a moving car    |

## What every obvious route gives you

| Route                                 | Verdict                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `airport` CLI                         | **Gone.** Removed by Apple; not on disk.                                                                                                                                                    |
| `wdutil info`                         | No scan subcommand at all, and it covers only the current association. SSID and BSSID come back `<redacted>` **even under sudo**.                                                           |
| `system_profiler SPAirPortDataType`   | 4.8 s per run, every SSID `<redacted>`, and **no BSSID field exists** in the output. Channel, width, PHY mode and signal/noise are there.                                                   |
| Legacy private `Apple80211`           | Still loads — `dlopen` succeeds from the dyld shared cache and `Apple80211Scan` resolves — but `BindToInterface` returns `-1` and `Scan` returns `-3900`. Refused, and private API besides. |
| **CoreWLAN, unprivileged**            | Scans. Returns SSID, RSSI, channel, band, width, beacon interval. Returns **nil** for `bssid`, `informationElementData` and `countryCode`.                                                  |
| **CoreWLAN as root (uid 0)**          | Finds more networks (8 vs 4), but `bssid` and the information elements are **still nil**.                                                                                                   |
| **CoreWLAN with Location authorized** | Everything: BSSID, country code, and the full beacon information elements.                                                                                                                  |
| `tcpdump -I -i en0 -L`                | Monitor mode **is** supported (`IEEE802_11_RADIO`). Needs root, disassociates Wi-Fi, and hears one channel at a time.                                                                       |

### Root is the wrong key for this lock

The single most useful negative result: **elevation does not help.** Privacy redaction is enforced
by TCC against the responsible process, which is a different mechanism from POSIX privilege, so
running as root changes nothing. This was confirmed three separate ways — `wdutil` still redacting,
a CoreWLAN scan as uid 0 still returning nil BSSIDs, and the legacy framework still refusing.

Every capability the app needs beyond a bare network list therefore depends on Location Services,
not on an admin prompt. That is why WLAN mode, unlike the port survey, never asks for a password.

### Asking for permission requires a bundle, and asking requires LaunchServices

Two separate traps, and each one fails silently:

1. **A bare executable cannot ask.** `CLLocationManager.requestWhenInUseAuthorization()` from a
   command-line binary is a no-op: no dialog, no error, and the status stays `notDetermined`.
   macOS only prompts for a process with a `CFBundleIdentifier` and an
   `NSLocationWhenInUseUsageDescription`. That is why the helper is a real `.app`.
2. **A child process inherits its parent's identity.** TCC attributes a request to the
   _responsible_ process, so the helper launched from a shell was judged as the terminal and the
   request died against the terminal's identity. Launched through LaunchServices (`open`) it is
   responsible for itself, and the dialog appears as expected.

Note the asymmetry that makes the design workable: **requesting** the grant needs LaunchServices,
but **using** one already granted does not. Once the user has approved it, running the helper's
executable directly returns full results — so the normal path is a plain `execFile`, and `open` is
only used to raise the prompt the first time.

There is no way to pre-authorize the app by hand: the Location Services pane has no "+" button, and
an app appears in that list only after it has asked at least once.

## What the beacons actually carry

Decoded from ten real neighbours. This is the payoff — none of it needs monitor mode:

| Element                     | Yields                                                             | Seen on     |
| --------------------------- | ------------------------------------------------------------------ | ----------- |
| BSS Load (11)               | client count and channel utilization, e.g. `clients=11, util=30%`  | 9 of 10 APs |
| HT Capabilities (45)        | spatial streams — MIMO 2x2 and 4x4 both observed                   | 7 of 10     |
| VHT Capabilities (191)      | spatial streams for the 5/6 GHz radio                              | 4 of 10     |
| HE / EHT (255.35 / 255.108) | 802.11ax, and 802.11be on six of the ten                           | 10 / 6      |
| RSN (48)                    | the AKM suites, which is what actually separates WPA2 from WPA3    | 10 of 10    |
| Vendor (221)                | `00:15:6d` — Ubiquiti, identifiable even behind a randomised BSSID | most        |
| WPS (221 / `00:50:f2:04`)   | manufacturer and model name                                        | **none**    |

Two consequences worth stating plainly:

- **AP model is usually unavailable.** Only WPS carries a self-declared model, and none of the
  observed access points broadcast it — Ubiquiti gear does not. An absent model is shown as absent
  and never inferred from the vendor.
- **Security must come from the AKM list, not the cipher list.** Observed on one physical access
  point serving two SSIDs: `tardis_nomap` advertises SAE alone (WPA3-Personal) while `tdc_nomap` on
  the same radio advertises PSK alone (WPA2-Personal). A readout derived from the hardware rather
  than from each beacon would get one of them wrong.
- **Randomised BSSIDs are common.** Several access points had the locally-administered bit set in
  the first octet, which makes an OUI lookup meaningless. The UI says so rather than reporting an
  unknown vendor.

## The grant is scoped to the copy, not just the bundle id

Worth knowing before shipping. A packaged build at a new path does **not** inherit the grant the
development copy holds, even though both carry the same `CFBundleIdentifier` and the same ad-hoc
signature. Measured on the packaged app: `CLLocationManager` reported `authorizedAlways` while
CoreWLAN still returned nil BSSIDs — so the authorization status is not a reliable indicator on its
own, which is why the helper reports `needs-permission` when a scan comes back with no BSSIDs
rather than trusting what the status claims.

Launching the packaged copy once through LaunchServices registers it and everything works from then
on, including ordinary direct execution:

| Packaged helper, launched by                  | Result                         |
| --------------------------------------------- | ------------------------------ |
| direct exec, before it had ever been launched | `needs-permission`, 0 BSSIDs   |
| `open` (LaunchServices)                       | `ok`, 12 of 12 with BSSID + IE |
| direct exec, afterwards                       | `ok`, 12 of 12                 |

That is exactly the sequence the app performs by itself: a scan that comes back without BSSIDs
triggers an `open` of the helper bundle, and the next scan succeeds.

## Verified end to end

On the rig above, in the app: entering WLAN mode scans automatically; networks group by SSID with
their access points beneath; the detail view shows SSID, BSSID, vendor, security, PHY mode with
MIMO, frequency, width, signal, noise, channel utilization, clients and country. Recording was run
three times in succession, each correctly resetting its counters, accumulating access points met
while the machine moved, and producing min/max/average for signal. No orphaned helper processes
after any run.

**Not verified:** Linux and Windows are not implemented at all — see
[BACKLOG.md](BACKLOG.md). Nothing here has been tried against an enterprise network, a captive
portal, or an access point that does broadcast WPS.
