# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

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
