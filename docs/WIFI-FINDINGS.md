# Wi-Fi findings

What each operating system will and will not tell an application about the air around it, and how
`magiceth` gets at the rest. The macOS sections were measured on 2026-09-29; commands and their
results are quoted so the conclusions can be re-checked rather than taken on trust. The Linux and
Windows sections at the end are **from documentation and source, not from measurement** — they say
exactly which claims are waiting for a machine.

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

Re-run on 2026-10-09 after the OS-specific half moved behind `PlatformOps.scanWifi`: same
networks, same detail values, and the width the new operation-element decoder reads off the beacon
(160 MHz for both 5 GHz radios) is the width CoreWLAN reports for them.

**Not verified:** nothing here has been tried against an enterprise network, a captive portal, or
an access point that does broadcast WPS.

## Linux — implemented, not yet run on hardware

What the implementation relies on, and where each claim comes from:

| Claim                                                                                                                     | Source                                                                                                                                     | Status                |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `iw dev <if> scan dump` reads the kernel's scan cache without privileges                                                  | nl80211: `NL80211_CMD_GET_SCAN` is unprivileged, `NL80211_CMD_TRIGGER_SCAN` needs `CAP_NET_ADMIN`                                          | documentation         |
| The cache expires entries 30 s after they were last heard                                                                 | cfg80211 `IEEE80211_SCAN_RESULT_EXPIRE`                                                                                                    | documentation         |
| `iw` prints BSS Load, HT/VHT/HE/EHT capabilities and operation, RSN suites, WPS fields, vendor OUIs, country, `last seen` | iw `scan.c`                                                                                                                                | documentation         |
| `iw`'s "(80 MHz)" label on VHT width 1 ignores the centre segments; 160 MHz is segment distance 8                         | 802.11-2020 9.4.2.158.3; the same rule is checked against CoreWLAN on macOS                                                                | measured (macOS side) |
| `nmcli device wifi rescan` is allowed for an active local session without a password                                      | polkit action `org.freedesktop.NetworkManager.wifi.scan`, `allow_active=yes` by default                                                    | documentation         |
| NetworkManager rejects a rescan within 10 s of the previous one; `nmcli … --rescan yes` can block 15 s when rejected      | NetworkManager `nm-device-wifi.c` scan threshold; plasma-nm commit "Before requesting a scan, check the time threshold"; nmcli `devices.c` | documentation         |
| `iw dev <if> scan` as root works while NetworkManager manages the interface                                               | common practice; both talk to the same kernel cache                                                                                        | documentation         |

Consequences in the code: calls are spaced ten seconds apart, the rescan's answer is ignored, the
cache is read five seconds after asking, and entries older than fifteen seconds are dropped unless
that would leave nothing. Without `nmcli`, `pkexec` starts the loop in `iw.ts`, which ends on a stop
file, a 3600 s cap, or five minutes without a request.

**To measure on a Linux box with a Wi-Fi card:** that `scan dump` returns blocks unprivileged;
that two rescans three seconds apart get the second rejected; a full real dump saved as the
`test/iw.test.ts` fixture in place of the documented-format one; that the pkexec path prompts once,
scans continuously, exits on idle, and leaves no root `sh` behind after quitting the app; and that
a recording's snapshot rows are not duplicated sweeps.

## Windows — verified on one machine

Run on 2026-10-09 on a Windows 11 Pro desktop with a local account (build not recorded): the scan
listed every network in reach, with channels, clients and channel utilization, the channel and
block views worked, and nothing crashed. The first attempt did not scan at all, and the reason is
the most useful thing learned:

**The Location page said "some of these settings are managed by your organization"** on a
personal machine. gpedit showed every location policy as not configured. The cause was
`DisableLocation = 1` under `HKLM\SOFTWARE\Policies\Microsoft\Windows\LocationAndSensors`,
written straight into the registry — most likely by a privacy or debloat tool at setup time, since
gpedit only shows what it set itself. Deleting the value and turning the two switches on in
Settings was enough. That sequence is now the `O` key: an opt-in, confirmed, UAC-elevated script
(`winEnableLocationScript`) that removes the policy values, sets the consent switches and starts
the location service, then re-reads the machine-wide switch to report whether it worked.

Still waiting for a capture: the real helper envelope as the `test/wifi-helper.test.ts` fixture
(the Windows entries there are built from the documented layout), and the scan duration.

What the implementation relies on, and where each claim comes from:

| Claim                                                                                                                                         | Source                                                                                                                                            | Status        |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `WlanGetNetworkBssList` returns real dBm (`lRssi`), the centre frequency in kHz, and the raw information elements                             | [WLAN_BSS_ENTRY](https://learn.microsoft.com/en-us/windows/win32/api/wlanapi/ns-wlanapi-wlan_bss_entry)                                           | documentation |
| `WlanScan` returns at once; a logo-compliant driver completes within 4 s; the service alone scans every 60 s, sometimes never while connected | [WlanScan](https://learn.microsoft.com/en-us/windows/win32/api/wlanapi/nf-wlanapi-wlanscan)                                                       | documentation |
| Since Windows 11 24H2 these calls return `ERROR_ACCESS_DENIED` (5) unless the user allows precise location                                    | [Changes to API behavior for Wi-Fi access and location](https://learn.microsoft.com/en-us/windows/win32/nativewifi/wi-fi-access-location-changes) | documentation |
| The one-time consent prompt is raised only for a process "running within the user's context and outside of `C:\Windows\System32`"             | same page — and `powershell.exe` lives in `System32\WindowsPowerShell\v1.0`, so a script-hosted helper can never raise it                         | documentation |
| `netsh wlan show networks mode=bssid` is gated the same way, and reports signal as a percentage with no elements                              | Microsoft Q&A reports; `netsh` output format                                                                                                      | documentation |
| `Add-Type` compiles the P/Invoke bindings with the .NET Framework compiler in Windows PowerShell 5.1 (≈1–2 s)                                 | PowerShell documentation                                                                                                                          | documentation |

Consequences in the code: the helper is a `.ps1` run with `-ExecutionPolicy Bypass -File`, it sleeps
the four seconds the API contract allows, and a code 5 from either call becomes `needs-permission`,
on which the app opens `ms-settings:privacy-location`, tells the user which two switches to turn on
— _Location_ and _Let desktop apps access your location_ — and offers `O`.
