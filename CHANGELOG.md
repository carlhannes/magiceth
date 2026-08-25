# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
[semantic versioning](https://semver.org/).

0.1.0 and 0.2.0 predate this repository's first commit, so they have no tag to link to — the
initial commit already shipped 0.2.0. Tagging starts at 0.3.0.

## [Unreleased]

### Added

- **Speed test** (`T`) — what the uplink behind the port actually delivers, both directions, bound
  to the dongle so it measures the port rather than whatever holds the default route. Figures
  appear within a second and update as it runs, so a slow uplink is obvious long before the test
  ends. It transfers real data to `speed.cloudflare.com`, capped at 200 MB or 10 s per direction,
  and runs only when you press `T`. `curl` does the transfer and the bytes are counted as they
  stream, so there is no output format to parse — and no test at all where `curl` is missing,
  which the app says out loud instead of failing.

### Changed

- Windows 11: MAC rolling is now recorded as verified on real hardware. It was confirmed against
  0.2.0; the only change to `winSetMacScript` since is that the adapter name goes through
  `psEscapeDouble`, which is byte-identical for an ordinary name like `Ethernet 3`, so the result
  carries over.
- Pings now send five packets instead of two, so packet loss is a figure rather than a coin flip
  (two packets could only ever report 0/50/100%). macOS and Linux space them 0.2 s apart and
  finish in under a second — faster than the two-packet run they replace; Windows has no interval
  flag and takes about four.
- Latency rows show jitter and always state the loss, `0% loss` included. The old rendering hid a
  zero, which made "measured, clean" and "never really measured" look identical.

## [0.3.0] – 2026-08-05

### Added

- **Port survey** (`C`) replaces the old LLDP/CDP listener. It captures until you stop it and lists
  every 802.1Q VLAN on the port as it is discovered, with a frame count and the addresses seen
  inside each — read straight off the wire, so it works on any switch rather than only on ones that
  advertise. LLDP/CDP still contributes the switch name, port and management IP when offered. The
  panel shows how long the capture has run, and says up front that a quiet VLAN can take ~30 s to
  appear.
- Chipset sub-view (`I`): max speed, VLAN support, reselling brands and the raw USB VID:PID — the
  capabilities that were already in `chipsets.json` but never shown. The USB IDs are what a
  "please add this chipset" issue needs for a dongle that isn't in the database.
- CI (`.github/workflows/ci.yml`) running prettier, typecheck, lint and tests on every push and PR.
- Screenshots in the README (`docs/screenshot*.png`).
- [`docs/BACKLOG.md`](docs/BACKLOG.md) — known gaps with the evidence behind each, linked from
  CONTRIBUTING.
- [`AGENTS.md`](AGENTS.md) — working notes for automated contributors, including how to drive and
  screenshot the app on macOS without verifying against a stale Electron instance.
- [`docs/VLAN-FINDINGS.md`](docs/VLAN-FINDINGS.md) — what the VLAN claims are actually worth,
  measured on two dongles across an unmanaged switch. 802.1Q tagging is **confirmed** on both the
  ASIX AX88179A and the Realtek RTL8153, so the `vlan: true` flags in `chipsets.json` are correct.
  The LLDP parser now has a fixture captured off real hardware — `tcpdump` prints "TLV" in every
  header and nests the port VLAN under an org-specific TLV, neither of which the hand-written
  fixture showed.

### Fixed

- VLAN/switch discovery worked in no case at all, and leaked a root `tcpdump` on every attempt. The
  capture was stopped with `kill`, but SIGTERM does not stop `tcpdump` while its BPF read is
  blocked — so `wait` hung, `do shell script` never returned the output it had collected, the
  `execFile` timeout handed back an empty string, and that became "none heard". Proven by running
  the wrapper both ways with frames on the wire: with `kill` it never returned and left the process
  alive; with `kill -9` it returned on time with the output intact. Every capture now uses SIGKILL.
- macOS: two dongles no longer show up as three. Some drivers (Realtek RTL8153) publish
  `IOMACAddress` on more than one node of the `ioreg` tree, so the same dongle was emitted twice
  and `joinDarwinAdapters` had no dedup — the ASIX used for development publishes it once, which
  is why this only surfaced with a second dongle attached.
- The dongle selector chips lead with the device name (`en9 · AX88179 / AX88179A`), so two dongles
  of the same model can be told apart. They are also shorter, so the selector stops wrapping.
- A dongle plugged in **without a network cable** is now detected. The hotplug poll watched
  `os.networkInterfaces()`, which omits interfaces that have no address — so a cable-less dongle
  (and its removal) never moved the signature. The real enumeration now also runs every ~4.5 s.
- A self-assigned `169.254.x.x` address no longer reads as a healthy IP: the address is marked
  `link-local` and the DHCP row says `no server answered` instead of showing a green "INIT". The
  link itself stays green, because the cable really is fine. The DHCP row likewise stays amber
  while a lease is still being negotiated and there is no address yet.
- Diagnostics failures are shown in the app instead of only in the console. On Windows a blank
  PowerShell reply used to leave the UI on "Waiting for diagnostics…" with no explanation.
- Windows: the adapter name is escaped before it goes into the elevated PowerShell scripts, so a
  name containing `$`, `"` or a backtick no longer breaks (or reshapes) the command.
- Stored profiles are format-validated when loaded, keeping a hand-edited `profiles.json` out of
  the elevated command line built for `netsh`. `NetInfo.dnsServers` is filtered through
  `isValidIpv4` on all three platforms so a parser can never feed it a malformed address.
- The profile rows sat ~40px right of their own section title: the global reset clears margin but
  not padding, so the `<ul>` kept its default indent. They are now aligned, roomier, and the index
  is drawn as the keycap you press to apply it.
- Linux: DHCP is detected from the address lifetime reported by `ip -j addr` instead of always
  reporting "static". Undo after applying a static profile now returns the interface to DHCP
  rather than restoring the old address statically. _Not yet verified on real hardware._

### Removed

- Unused `system:snapshot` / `adapters:changed` IPC surface left over from the M0 spike, along
  with the three shared types that only existed to carry it.
- The one-shot `discover:run` channel, replaced by `survey:start` / `survey:stop` plus a
  `survey:update` push — a capture that runs until stopped cannot be a single request/response.

### Changed

- `capabilities/discover.ts` is now `capabilities/survey.ts`, and `DiscoveryResult` /
  `DiscoveryStatus` are `SurveyResult` / `SurveyStatus`, so the code is named after what it does.
  `parseDiscovery` keeps its name: it really does parse the discovery protocols, LLDP and CDP.
- The whole repo is Prettier-formatted, and `test/**` is now type-checked.

## 0.2.0 – 2026-07-23

### Added

- Inline profile management: create (`N`), edit (`E`), and delete (`Backspace`) profiles directly in
  the profile panel, with a form filled in using the mouse. Field validation (IPv4, prefix/netmask,
  DNS, MAC) via a shared, tested validator.
- The version number is shown in the app's topbar (injected at build time from `package.json`).

### Fixed

- Windows: dongle identification read the wrong casing on the `Get-NetAdapter` property
  (`PnpDeviceID` → `PNPDeviceID`), which meant USB dongles weren't detected. All
  PowerShell JSON keys are now set deterministically via calculated properties.

## 0.1.0 – 2026-07-23

### Added

- **Dongle identification** via USB `VID:PID` against a built-in chipset database (`chipsets.json`).
- **Diagnostics**: IP/mask, gateway, DNS, full DHCP info, link speed/duplex, and MAC — run
  automatically on link.
- **Connectivity test**: ping to the gateway + `1.1.1.1`/`8.8.8.8` bound to the dongle, plus a DNS test.
- **VLAN/switch discovery** (optional) via passive LLDP/CDP listening with `tcpdump`.
- **Active control**: roll MAC, switch between DHCP/static profiles, undo — with per-action elevation.
- Platform support for Windows/macOS/Linux (arm64 + amd64); packaging via electron-builder (unsigned).
- macOS live-verified; Linux/Windows implemented against documented format with unit-tested parsers.

[Unreleased]: https://github.com/carlhannes/magiceth/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/carlhannes/magiceth/releases/tag/v0.3.0
