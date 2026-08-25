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
    capabilities/
      adapters.ts          # dongle list + chipset lookup
      diagnostics.ts       # orchestrates netinfo + probes
      probe.ts             # bound pings + DNS test (+ ping parser)
      survey.ts            # port survey: VLAN tags off the wire + LLDP/CDP, capture + parsers
      speedtest.ts           # manual throughput test: curl transfers, Node counts the bytes
      reconfig.ts          # MAC rolling + profile application + undo
      profiles.ts          # fs/electron glue for profile storage
      profiles-core.ts     # pure profile operations (upsert/remove/…)
  preload/index.ts
  renderer/
    index.html
    src/main.ts            # dashboard + keyboard logic + profile editor
    src/styles.css
    src/env.d.ts
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
}
```

**Pattern:** each platform file splits the logic into (1) **pure parsers** that take raw
command output → typed objects (exported and unit-tested) and (2) thin async functions that
run the command and call the parser. Example (macOS): `parseIfconfig`, `parseIpconfigSummary`,
`parseIoregUsbMacs`, `joinDarwinAdapters`. This is the load-bearing test surface — see
[test philosophy](#test-philosophy).

Examples of commands per OS: macOS `ioreg`/`networksetup`/`ifconfig`/`ipconfig getsummary`;
Linux `ip -j`/`udevadm`/sysfs/`resolvectl`; Windows `Get-NetAdapter`/`Get-NetIPAddress`/`netsh`
(via `powershell ... | ConvertTo-Json`). JSON output is preferred where available to avoid
brittle text parsing.

## IPC contract

The preload exposes `window.api` per `MagicethApi` (`src/shared/types.ts`). Channels:

- **Reads:** `dongles:list`, `diagnostics:run`, `profiles:list`
- **Writes (profiles, unprivileged):** `profiles:save`, `profiles:saveCurrent`, `profiles:delete`
- **Privileged:** `reconfig:rollMac`, `reconfig:applyProfile`, `reconfig:undo`
- **Long-running (privileged):** `survey:start`, `survey:stop`
- **Long-running (unprivileged):** `speedtest:start`, `speedtest:stop`
- **Push events (main → renderer):** `dongles:changed`, `survey:update`, `speedtest:update`

Every channel has a consumer in the renderer — if a capability stops being used, its channel,
its `MagicethApi` method and its preload wiring go with it.

## Data flow & hotplug

Main polls cheaply (`os.networkInterfaces()`, every 1.5 s) and computes a signature
(`interfaceSignature()`, main-only — it never crosses IPC). When it changes (dongle in/out, link
up/down) the heavier dongle enumeration runs and `dongles:changed` is pushed. The renderer then automatically runs diagnostics for the selected dongle → so "plug
in the cable → everything shows up" works without user interaction. Pings are bound to the
dongle's interface/source IP so the internet test goes via the dongle, not via a possible Wi-Fi
default route.

## Privilege model

Least privilege: the app and all read-only diagnostics run unprivileged. Only `survey`
(capture) and `reconfig` (MAC/IP) are elevated, and then **per action** via `src/main/privilege.ts`:

- **macOS:** `osascript -e 'do shell script "…" with administrator privileges'`
- **Linux:** `pkexec`
- **Windows:** `Start-Process -Verb RunAs` (UAC), with `-EncodedCommand` (base64/UTF-16LE) to avoid quoting issues

Changes are verified by re-reading netinfo afterwards (e.g. that the MAC was actually changed).
`reconfig` saves the previous state so `Undo` (`U`) can restore it.

## Chipset database

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
on screen after it ends. Both are torn down when the selected dongle changes or the app quits, so
a measurement never outlives the port it belongs to.

Two sub-views hang below the diagnostics — the profile panel (`P`) and the chipset view (`I`,
which is where `chipsets.json`'s capabilities and the raw USB IDs are shown). Each is a
`render*()` that returns `''` when closed, they share the `.panel-card` shell, and opening one
closes the other so the single screen never grows past a glance.

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
dongle and asks first on a built-in. The prompt goes in the notice bar, which is `position: sticky`
on purpose — the window scrolls past it, and a confirmation you cannot see is worse than none: the
first press looks like it did nothing, so you press again, and that is the press that acts.

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
