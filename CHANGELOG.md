# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- Chipset sub-view (`I`): max speed, VLAN support, reselling brands and the raw USB VID:PID — the
  capabilities that were already in `chipsets.json` but never shown. The USB IDs are what a
  "please add this chipset" issue needs for a dongle that isn't in the database.
- CI (`.github/workflows/ci.yml`) running prettier, typecheck, lint and tests on every push and PR.
- Screenshots in the README (`docs/screenshot*.png`).

### Fixed

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

### Changed

- The whole repo is Prettier-formatted, and `test/**` is now type-checked.

## [0.2.0] – 2026-07-23

### Added

- Inline profile management: create (`N`), edit (`E`), and delete (`Backspace`) profiles directly in
  the profile panel, with a form filled in using the mouse. Field validation (IPv4, prefix/netmask,
  DNS, MAC) via a shared, tested validator.
- The version number is shown in the app's topbar (injected at build time from `package.json`).

### Fixed

- Windows: dongle identification read the wrong casing on the `Get-NetAdapter` property
  (`PnpDeviceID` → `PNPDeviceID`), which meant USB dongles weren't detected. All
  PowerShell JSON keys are now set deterministically via calculated properties.

## [0.1.0] – 2026-07-23

### Added

- **Dongle identification** via USB `VID:PID` against a built-in chipset database (`chipsets.json`).
- **Diagnostics**: IP/mask, gateway, DNS, full DHCP info, link speed/duplex, and MAC — run
  automatically on link.
- **Connectivity test**: ping to the gateway + `1.1.1.1`/`8.8.8.8` bound to the dongle, plus a DNS test.
- **VLAN/switch discovery** (optional) via passive LLDP/CDP listening with `tcpdump`.
- **Active control**: roll MAC, switch between DHCP/static profiles, undo — with per-action elevation.
- Platform support for Windows/macOS/Linux (arm64 + amd64); packaging via electron-builder (unsigned).
- macOS live-verified; Linux/Windows implemented against documented format with unit-tested parsers.

[Unreleased]: https://github.com/carlhannes/magiceth/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/carlhannes/magiceth/releases/tag/v0.2.0
[0.1.0]: https://github.com/carlhannes/magiceth/releases/tag/v0.1.0
