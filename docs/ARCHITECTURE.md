# Architecture

`magiceth` is an Electron GUI that acts as a thin **shell around the operating system's own
network commands**. There is no background service and no custom driver. Traffic only leaves the
machine because a test put it there: the automatic ones (ping/DNS) stay on the local link and its
gateway, and the one that reaches a third party — the speed test, which transfers filler bytes to
`speed.cloudflare.com` — runs only on a keypress. The design goals are KISS, low risk, and code
that can still be understood long afterwards.

## Process model

Electron provides three contexts; we keep a strict separation of responsibilities between them:

| Context         | Source                 | Responsibility                                                      |
| --------------- | ---------------------- | ------------------------------------------------------------------- |
| **Main** (Node) | `src/main/`            | Runs OS commands, parses output, all business logic. Registers IPC. |
| **Preload**     | `src/preload/index.ts` | Exposes a small, typed API on `window.api` via `contextBridge`.     |
| **Renderer**    | `src/renderer/`        | One-handed single-screen dashboard (vanilla TS). No Node access.    |
| **Shared**      | `src/shared/`          | Pure types and helpers used by multiple contexts.                   |

Security settings (in `src/main/index.ts`): `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: false` (required for the preload's `contextBridge`), plus a CSP in `index.html`. The
renderer therefore can **never** reach Node/Electron directly — only the methods on `window.api`.

## Directory structure

```
src/
  main/
    index.ts               # app lifecycle, windows, IPC registration, hotplug poll
    util/run-command.ts    # run()/runJson() — shared command helper (execFile, no shell)
    privilege.ts           # elevation: runElevatedShell/runElevatedPlan (osascript/pkexec/UAC)
    platform/
      index.ts             # PlatformOps interface + getPlatform()
      darwin.ts            # macOS implementation (+ pure parsers)
      linux.ts             # Linux implementation (+ pure parsers)
      win32.ts             # Windows implementation (+ pure parsers)
      iw.ts                # pure: `iw scan dump` text → beacon facts (Linux), the elevated scan loop
      wifi-helper.ts       # pure: the JSON both Wi-Fi helpers (macOS, Windows) print
    capabilities/
      adapters.ts          # dongle list + chipset lookup
      diagnostics.ts       # orchestrates netinfo + probes
      probe.ts             # bound pings + DNS test (+ ping parser)
      survey.ts            # port survey: VLAN tags off the wire + LLDP/CDP, capture + parsers
      speedtest.ts           # manual throughput test: curl transfers, Node counts the bytes
      reconfig.ts          # MAC rolling + profile application + undo
      profiles.ts          # fs/electron glue for profile storage
      profiles-core.ts     # pure profile operations (upsert/remove/…)
      wifiscan.ts          # WLAN mode: the active scan + recording loop; the OS half is in platform/
      wifi-model.ts        # pure: group APs by SSID, fold into tracks, channel load and blocks
      ie80211.ts           # pure: decode 802.11 beacon information elements
      oui.ts               # pure: who made this radio, from the IEEE registries
      recordings.ts        # fs/electron glue for saved recordings (+ reveal in the file manager)
      recordings-core.ts   # pure: the recording CSV, written and read back
  preload/index.ts
  renderer/
    index.html
    src/main.ts            # entry: mounts, dispatches render + keys by mode
    src/shell.ts           # mode chooser, notice bar, pending confirmations, render hook
    src/view.ts            # pure formatters shared by both modes (row, clock, escapeHtml…)
    src/ethernet.ts        # Ethernet mode: the port dashboard + profile editor
    src/wlan.ts            # WLAN mode: network list, AP list, AP detail, recording
    src/styles.css
    src/env.d.ts
resources/wifi-helper/     # the macOS helper .app (Swift + Info.plist) and the Windows helper (.ps1)
  shared/
    types.ts               # shared types + the MagicethApi contract
    mac.ts                 # MAC helpers (normalize, randomize locally-administered)
    net.ts                 # cidr<->netmask, isValidIpv4
    adapter.ts             # sortAdapters / pickSelected (pure, used by main + renderer)
    profile.ts             # validateProfileDraft (shared by renderer + tests)
resources/chipsets.json    # VID:PID -> chipset (single source of truth, bundled in at build)
test/                      # vitest — pure parsers/functions
```

## Capability modules

Each capability is a platform-independent interface in `capabilities/` that delegates to
`platform/`. A shared `run()` helper (`util/run-command.ts`) runs commands with `execFile`
(arguments as an array, **no shell**) — which makes quoting/injection a non-issue — with a
timeout and `windowsHide`.

| Module                       | Privileges | What it does                                                                                                  |
| ---------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| `adapters`                   | None       | Enumerates the ports worth showing, dongles first; looks up chipsets via `chipsets.json`.                     |
| `diagnostics` → `probe`      | None       | Reads netinfo and runs gateway/internet ping + DNS test in parallel.                                          |
| `survey`                     | Root/admin | Port survey: runs `tcpdump` until stopped, tallying 802.1Q VLANs and LLDP/CDP. Optional; degrades gracefully. |
| `speedtest`                  | None       | Throughput both ways, bound to the dongle. Manual only — it moves real traffic. Degrades gracefully.          |
| `reconfig`                   | Root/admin | Rolls MAC, applies DHCP/static profile, undoes.                                                               |
| `profiles` / `profiles-core` | None       | Reads/writes profile JSON; pure CRUD operations.                                                              |
| `wifiscan` → `ie80211`       | Location\* | WLAN mode. Asks the platform for a sweep, decodes beacons, accumulates a recording. All three OSes.           |
| `recordings` / `-core`       | None       | Writes a recording to CSV in Documents, reads it back, reveals it in the file manager.                        |

\* Location consent on macOS and Windows; nothing on Linux with NetworkManager, one `pkexec`
prompt without it. See [reading the air](#reading-the-air-on-each-os).

## Platform layer (`PlatformOps`)

`src/main/platform/index.ts` defines the interface that each OS implements; `getPlatform()`
picks the right one based on `process.platform`:

```ts
interface PlatformOps {
  enumerateAdapters(): Promise<RawAdapter[]>
  readNetInfo(device: string): Promise<NetInfo>
  pingCommand(target, opts): PingSpec // flags differ per OS (-b/-I/-S)
  speedTestBind(device, srcIp): string | undefined // curl --interface: name, or address on Windows
  buildSetMacPlan(device, mac): Promise<ElevatedPlan>
  buildProfilePlan(device, profile): Promise<ElevatedPlan>
  scanWifi(device): Promise<WifiScanOutcome> // one sweep of the air, decoded to beacon facts
  requestWifiAccess(): void // raise the OS's consent dialog/page; no-op on Linux
  endWifiSession(): void // stop anything long-lived (the Linux elevated loop)
}
```

**Pattern:** each platform file splits the logic into (1) **pure parsers** that take raw
command output → typed objects (exported and unit-tested) and (2) thin async functions that
run the command and call the parser. Example (macOS): `parseIfconfig`, `parseIpconfigSummary`,
`parseIoregUsbMacs`, `joinDarwinAdapters`. This is the load-bearing test surface — see
[test philosophy](#test-philosophy).

Examples of commands per OS: macOS `ioreg`/`networksetup`/`ifconfig`/`ipconfig getsummary` and
the Wi-Fi helper `.app`; Linux `ip -j`/`udevadm`/sysfs/`resolvectl` and `iw`/`nmcli`; Windows
`Get-NetAdapter`/`Get-NetIPAddress`/`netsh` (via `powershell ... | ConvertTo-Json`) and the Wi-Fi
helper `.ps1`. JSON output is preferred where available to avoid brittle text parsing.

## IPC contract

The preload exposes `window.api` per `MagicethApi` (`src/shared/types.ts`). Channels:

- **Reads:** `adapters:list`, `diagnostics:run`, `profiles:list`
- **Writes (profiles, unprivileged):** `profiles:save`, `profiles:saveCurrent`, `profiles:delete`
- **Privileged:** `reconfig:rollMac`, `reconfig:applyProfile`, `reconfig:undo`
- **Long-running (privileged):** `survey:start`, `survey:stop`
- **Long-running (unprivileged):** `speedtest:start`, `speedtest:stop`
- **Long-running (unprivileged):** `wifi:start`, `wifi:stop`
- **Saved recordings:** `recordings:list`, `recordings:read`, `recordings:reveal`
- **Push events (main → renderer):** `adapters:changed`, `survey:update`, `speedtest:update`, `wifi:update`

Every channel has a consumer in the renderer — if a capability stops being used, its channel,
its `MagicethApi` method and its preload wiring go with it.

## Data flow & hotplug

Main polls cheaply (`os.networkInterfaces()`, every 1.5 s) and computes a signature
(`interfaceSignature()`, main-only — it never crosses IPC). When it changes (dongle in/out, link
up/down) the heavier adapter enumeration runs and `adapters:changed` is pushed. The renderer
re-runs diagnostics for the selected adapter → so "plug in the cable → everything shows up" works
without user interaction. A dongle that has just appeared takes the selection (`pickSelected`),
because the list always holds the machine's own ports and would otherwise never visibly change.
Pings and the speed test are bound to the adapter's interface/source IP, so they measure that port
rather than a possible Wi-Fi default route.

## Privilege model

Least privilege: the app and all read-only diagnostics run unprivileged. Only `survey`
(capture) and `reconfig` (MAC/IP) are elevated, and then **per action** via `src/main/privilege.ts`:

- **macOS:** `osascript -e 'do shell script "…" with administrator privileges'`
- **Linux:** `pkexec`
- **Windows:** `Start-Process -Verb RunAs` (UAC), with `-EncodedCommand` (base64/UTF-16LE) to avoid quoting issues

Wi-Fi scanning is the one read-only feature that can need elevation, and only on a Linux without
NetworkManager: triggering a sweep needs `CAP_NET_ADMIN`, so one `pkexec` prompt starts a scan loop
(`iw.ts`) that ends on a stop file, a hard cap, or five idle minutes — the port survey's pattern.

Changes are verified by re-reading netinfo afterwards (e.g. that the MAC was actually changed).
`reconfig` saves the previous state so `Undo` (`U`) can restore it.

## Chipset database

`resources/oui.json` is the same idea for radios rather than dongles: every IEEE OUI assignment,
generated by `scripts/fetch-oui.mjs` and committed so a build needs no network. All three registry
tiers are included, because an MA-M or MA-S address looked up against MA-L alone resolves to "IEEE
Registration Authority" — true and useless — so `oui.ts` matches longest-prefix. It is the one
file `.prettierignore` covers, being 1.8 MB on a single line.

A globally administered BSSID names its maker directly. A randomised one does not, so the beacon's
own vendor elements are used instead, minus a documented list of elements that ride in nearly every
beacon: reading the WPS element as the manufacturer would report most of the world's Wi-Fi as
Microsoft. The UI distinguishes the two, because one is a fact and the other is an inference.

`resources/chipsets.json` is the single source of truth: `{ vendors, chipsets }` keyed by
`"vid:pid"` (hex). It is `import`-ed into the main bundle at build time (no runtime file path).
`adapters.resolveChipset()` falls back to the known vendor when the exact chipset is missing.

## Profile storage

Profiles live in a single JSON file in `app.getPath('userData')`. `profiles-core.ts` contains
the pure operations (parse/serialize/upsert/remove/`ensureDefaults`) and `profiles.ts` does the
fs/electron glue. `DHCP` always exists as a default profile and cannot be deleted. Validation of
form drafts is done by `validateProfileDraft` in `src/shared/profile.ts` — placed in `shared/`
precisely so the renderer can validate directly without importing from `main/`.

## Renderer & one-handed UX

A single `#app` that is redrawn with `innerHTML` on each `render()`. Navigation happens with
arrow keys + simple keys (see README). The profile editor opens inline (`N`/`E`); while it is
open, `render()` becomes a **no-op** so that background events (hotplug/diagnostics) don't reset
the input fields — field values are read from the DOM only on Save. The version is injected at
build time (`__APP_VERSION__` via Vite `define`) and shown in the topbar.

Below the diagnostics sit two sections that fill in over time rather than on request: the speed
test (`T`) and the port survey (`C`). Both follow the same shape — a `start`/`stop` pair plus an
`*:update` push, one module-level "active run" in main, and a renderer that keeps the last result
on screen after it ends. Both are torn down when the selected adapter changes or the app quits, so
a measurement never outlives the port it belongs to.

Two sub-views hang below the diagnostics — the profile panel (`P`) and the chipset view (`I`,
which is where `chipsets.json`'s capabilities and the raw USB IDs are shown). Each is a
`render*()` that returns `''` when closed, they share the `.panel-card` shell, and opening one
closes the other so the single screen never grows past a glance.

## Two modes

The app opens on a chooser: **Ethernet**, the wired port dashboard, and **WLAN**, the Wi-Fi
scanner. `Tab` switches between them and `Esc` steps back out. They are separate because they
answer different questions, and mixing them on one screen would cost the at-a-glance readability
the whole tool is built around.

`main.ts` is the only module that knows both exist. `shell.ts` holds what they share — the mode,
the notice bar, the pending-confirmation gate and the render hook — and imports neither of them,
so the dependency graph stays a tree. Leaving a mode shuts down whatever it had running, for the
same reason switching adapter does: a capture or a scan belongs to the screen it was started from.

## Reading the spectrum

The channel view is derived in `wifi-model.ts` and crosses IPC already computed, because the
renderer must never import from `main/`. Two parts of it are worth knowing about.

**Client counts are de-duplicated per radio.** The station count in a BSS Load element belongs to
the radio, so a radio broadcasting five SSIDs reports the same number five times; adding them up
reads 30 clients where there are 6. Two access points on one channel are treated as one radio when
they advertise the same count _and_ their BSSIDs differ in at most two octets — the count is what
catches a pair registered to different vendors, the addresses are what stop two genuine neighbours
being merged. It is a heuristic, and `docs/BACKLOG.md` records where it breaks.

**Overlap is computed from real spectrum**, not from channel numbers: each access point's span is
its centre frequency plus or minus half its width, and a channel counts every span that touches its
own 20 MHz. That is why 1, 6 and 11 come out clear of each other while 1 and 3 do not. The centre
is approximated from the _primary_ channel, which is all CoreWLAN reports — noted in the backlog.

## Reading the air on each OS

Every OS answers "what is around me" differently, and only macOS and Windows will hand over the
beacon bytes. So the seam is one level up: `PlatformOps.scanWifi()` returns **sightings whose
beacon facts are already decoded** (`BeaconFacts` from `ie80211.ts`), and `wifiscan.ts`, the
model, the recordings and the screens never learn which OS they are on. The vendor lookup is the
one thing added after the seam, in `toBss()`, so it happens in exactly one place.

| OS      | Sweep                                                                                                                                                                                                                                                                             | Decoded by                                                                        | Gate                                                                                                                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS   | The Swift helper `.app` scans through CoreWLAN and prints JSON with the raw elements as hex.                                                                                                                                                                                      | `readBeacon()` on the bytes                                                       | Location Services, held by the helper's bundle identity; `open -a` raises the prompt.                                                                                                                                    |
| Linux   | `nmcli device wifi rescan` asks NetworkManager for a sweep (rejected within 10 s of the last one, so calls are spaced), then `iw dev <if> scan dump` reads the kernel cache unprivileged. Without NetworkManager, one `pkexec` prompt starts a loop that runs `iw … scan` itself. | `parseIwScan()` on `iw`'s text — the kernel keeps no raw bytes for known elements | None for reading; `pkexec` once on the fallback path.                                                                                                                                                                    |
| Windows | A PowerShell helper calls `WlanScan` / `WlanGetNetworkBssList` through P/Invoke and prints the same JSON as the macOS helper, with the raw element blob.                                                                                                                          | `readBeacon()` on the bytes                                                       | Location consent since Windows 11 24H2. The one-time prompt is only raised for a process outside `System32`, which `powershell.exe` is not, so a refusal opens `ms-settings:privacy-location` with instructions instead. |

**The helpers stay deliberately stupid.** Both print what the OS handed them and decode nothing, so
the untestable Swift and PowerShell surfaces stay small and every parser is a pure function tested
against real captured beacons. The macOS one is a **real `.app` bundle** because macOS reveals a
scanned network's BSSID and its beacon elements only to a process holding a Location grant, and
only ever offers that grant to something with a bundle identity — elevation does not substitute,
because TCC and root are independent gates. Build it with `scripts/build-wifi-helper.sh`; `npm run
package` does so first, and skips it off macOS. The Windows one is a script shipped as-is.

**Three label rules are shared**, not duplicated: `securityLabel()` names a suite from AKM flags,
`phyLabel()` the generation from which capability elements exist, and `vhtWidth()` tells 80 from
160 MHz by the distance between the VHT centre segments — which matters because `iw` prints the
width field's label and that label is wrong for the newer 160 MHz encoding. The byte decoder and
the `iw` text parser both call them, so the two cannot disagree about the same access point.

The evidence for the macOS claims, and what each other OS has been checked against, is in
[WIFI-FINDINGS.md](WIFI-FINDINGS.md).

## Saved recordings

A WLAN recording writes two CSVs into `~/Documents/magiceth` — a time log appended while it runs,
and an aggregate written when it stops. They go in Documents rather than `userData` because the
point of saving them is that you can find, open and send them, and Application Support is somewhere
nobody looks.

**The CSV is the only artifact.** The app reads its own aggregate back to list and display past
recordings, so there is no second format to drift out of sync with the one you open in a
spreadsheet. The start time lives in the filename and everything else — duration, access points,
networks — is derived from the rows, which is what keeps the file free of metadata lines.

`recordings-core.ts` holds all of it as pure functions (RFC 4180 quoting, because SSIDs contain
commas and quotes), and `recordings.ts` is the fs/electron glue, on exactly the pattern
`profiles-core.ts`/`profiles.ts` already set. `recordings.ts` is the only module that touches
`shell`, and it validates every id against the filename pattern before building a path — the id
arrives from the renderer, and that check is what keeps it inside the folder.

A run of fewer than three snapshots deletes itself, so a stray keypress leaves nothing behind.
Writes are synchronous because `before-quit` does not await, which is what lets quitting
mid-recording still finalise the file.

## Test philosophy

- **Pure functions are unit-tested** (`test/`, vitest) — parsers are fed _real_ captured
  command output (macOS) or documented format (Linux/Windows) and asserted against typed
  results. This is the deterministic, platform-independent test surface.
- **Platform implementations are verified on real hardware** ("spikes") — especially the
  privileged ones (MAC/IP) and capture. Manual procedures are in
  [`../SUDO-TEST.md`](../SUDO-TEST.md) and [`../WINDOWS-TEST.md`](../WINDOWS-TEST.md).
- Run `npm run typecheck && npm run lint && npm test` before every PR.

## What counts as an adapter

The tool lists USB dongles, built-in Ethernet and built-in Wi-Fi, and nothing else — no loopback,
bridges, Docker/veth, VPN tunnels or internal plumbing. Each platform decides this with a
**structural** signal rather than by matching interface names, because names are the thing most
likely to differ on a machine nobody here has:

| OS      | Signal                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS   | Hardware present in `networksetup -listallhardwareports` **and** configured as a service in `-listnetworkserviceorder`, minus bridges. The hardware list alone still offers Thunderbolt ports and the T2 `anpi` plumbing; the service list alone still names dongles unplugged months ago, because SystemConfiguration keeps services after the hardware leaves. Only the intersection means anything. |
| Linux   | `/sys/class/net/<if>/device` exists. Every entry in `/sys/class/net` is a symlink into `/sys/devices`, and only hardware-backed ones carry that entry — virtual interfaces resolve under `/sys/devices/virtual/net` instead. Wi-Fi is the `wireless` directory or udev `DEVTYPE=wlan`.                                                                                                                 |
| Windows | `Get-NetAdapter`'s `Virtual` and `HardwareInterface` properties, filtered in the parser rather than via the `-Physical` switch — a switch that failed would return _no_ adapters, whereas a property the parser cannot see simply leaves the adapter in. Wi-Fi is `PhysicalMediaType` 802.11 or `NdisPhysicalMedium` 1/9.                                                                              |

USB detection stays independent of all of this — a dongle is found because `ioreg`/udev/the PnP ID
says it is one — so no built-in rule can ever hide a dongle. `AdapterKind` (`usb` | `ethernet` |
`wifi`) rides along on `RawAdapter` and drives sort order, the badge, and whether a
config-changing key needs confirming. `sortAdapters` and `pickSelected` are pure and live in
`src/shared/adapter.ts`, for the same reason `validateProfileDraft` does: the renderer needs them
and must never import from `main/`.

A key that changes real configuration (`M`, `U`, applying a profile) acts on the first press for a
dongle and asks first on a built-in. The prompt goes in the notice bar, which sits outside the
scrolling region and so is always on screen: a confirmation you cannot see is worse than none,
because the first press looks like it did nothing, so you press again — and that is the press that
acts.

## One shell, one scrolling region

Every screen is assembled by `renderShell()` in `src/renderer/src/shell.ts` from a `ModeView`: a
topbar, the notice, an optional pinned status line, the body, and the key legend. Only the body
scrolls. The frame is fixed because the legend is how anyone discovers what the app does, and a
legend that scrolls away on any list longer than the window is a legend nobody reads.

Having one function assemble it is what keeps the five screens that need it — both Ethernet states,
the profile editor, WLAN and the chooser — from drifting apart. `shell.ts` imports neither mode, so
the graph stays a tree.

Two details in `main.ts` that are easy to lose and hard to notice:

- **The scroll offset is carried across renders of the same screen.** Replacing the markup destroys
  the scrolling element, and push updates arrive about once a second while scanning, so without
  this a long list would snap back to the top continuously. `ModeView.key` identifies the screen;
  a different key starts at the top. The offset is applied _after_ reading a layout property, or
  the browser clamps it against the previous, shorter height and the list creeps upward.
- **The selection is scrolled into view only when it moves.** Arrow keys walk a selection through a
  list taller than the window. Doing this on every render instead would drag the reader back to the
  selection each time a scan landed.

## Measuring throughput

`speedtest.ts` is the one capability that talks to a third party, so its choices are worth
spelling out. `curl` does the transfer and Node counts the bytes off the child's stdout (download)
or into its stdin (upload) — no output format to parse, and `--interface` is what makes the test
measure _this_ port instead of whatever holds the default route. macOS and Linux bind by interface
name; Windows can only bind a source address, which is the same split `pingCommand` already has.

Throughput is always a trailing one-second window, never total ÷ elapsed, and the first second of
each direction is discarded: it holds TCP slow start going down and buffer fill coming up, neither
of which is the speed of the link. Each direction stops at a time cap or a byte cap, whichever
comes first, because the bandwidth being spent belongs to whoever owns the network under test.

## Extending the tool

- **New chipset:** add a `"vid:pid"` entry in `resources/chipsets.json`. No code needed.
- **New/changed platform logic:** implement/adjust the methods in `platform/<os>.ts`, keep the
  parsing in an exported pure function, and add a test in `test/` against real/documented
  output. Then verify on real hardware.
- **New IPC:** add a handler in `src/main/index.ts`, a method in `MagicethApi` (`src/shared/types.ts`),
  and expose it in `src/preload/index.ts`.
