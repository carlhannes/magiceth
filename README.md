# magiceth

> One-handed network port diagnostics via a USB-to-ethernet dongle.

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![arch](https://img.shields.io/badge/arch-arm64%20%7C%20amd64-lightgrey)
![license](https://img.shields.io/badge/license-WTFPL-green)

Plug in a USB-ethernet dongle, connect it to a network port, and immediately see everything a
network technician needs to troubleshoot the port — IP, DHCP, gateway, DNS, link speed, ping
to the gateway and the internet, and (optionally) VLAN/switch info via LLDP/CDP. Change the MAC
address or switch between saved DHCP/static profiles with a couple of keystrokes. Everything is
designed to be operable **with one hand** — for the technician holding the laptop in the other
up by the rack.

Works on **Windows, macOS, and Linux** (arm64 + amd64). The tool is a thin Electron GUI that
orchestrates the OS's own network commands — no custom drivers, no background service.

<!-- TODO: add a screenshot here, e.g. docs/screenshot.png -->

---

## Features

- **Identification** — detects the dongle on insertion and shows chipset + capabilities (VID:PID is looked up against a built-in database). Deltaco, Plexgear, Saitech, Apple, UGreen, and others are resellers — the underlying chipset (ASIX, Realtek, …) is what matters.
- **Diagnostics** — IP/mask, gateway, DNS, full DHCP info (server, lease, domain), link speed/duplex, and MAC. Runs automatically as soon as the dongle gets link.
- **Connectivity test** — pings the gateway + `1.1.1.1`/`8.8.8.8` *bound to the dongle* (not via Wi-Fi), plus a DNS test against the DHCP-assigned server.
- **VLAN / switch port** *(optional)* — passive LLDP/CDP listening via `tcpdump` shows switch name, port, VLAN, and management IP.
- **Active control** — roll a new (locally-administered) MAC, switch between DHCP and static profiles, create/edit profiles inline, and undo the last change.

## Hardware support

Most USB-ethernet dongles are built on a handful of chipsets. `magiceth` recognizes them via
`USB VID:PID` (see [`resources/chipsets.json`](resources/chipsets.json)) — including ASIX AX88179/772,
Realtek RTL8153/8152/8156, Microchip/SMSC LAN7500/7800, and Apple's USB adapter. Unknown dongles
are still shown with raw USB info and usually work via the OS's own driver.

## Platform status

| Platform | Status |
|---|---|
| **macOS** (arm64/amd64) | Read-only diagnostics live-verified; privileged actions manually verified |
| **Linux** (arm64/amd64) | Implemented against documented command formats; parsers unit-tested — **verify on real hardware** |
| **Windows** (arm64/amd64) | Implemented against documented command formats; parsers unit-tested — **verify on real hardware** |

## Installation

### Prebuilt binary
Download the latest build for your platform from [Releases](https://github.com/carlhannes/magiceth/releases).
The builds are **unsigned** (internal tool) — see [SECURITY.md](SECURITY.md) regarding warnings from
Gatekeeper/SmartScreen.

### From source
```sh
git clone https://github.com/carlhannes/magiceth.git
cd magiceth
npm install
npm run dev        # starts the app in development mode
```

## Usage

Launch the app (does **not** require admin). With a dongle plugged in, identification and
diagnostics are shown automatically. Everything is controlled from the keyboard:

| Key | Action |
|---|---|
| `↑` `↓` | Switch selected dongle (or navigate the profile panel) |
| `R` / space | Re-run diagnostics |
| `C` | Listen for VLAN/switch (LLDP/CDP) |
| `M` | Roll a new MAC address |
| `P` | Open/close the profile panel |
| `1`–`9` / `Enter` | Apply a profile to the adapter |
| `N` / `E` | New / edit the selected profile (the form is filled in with the mouse) |
| `Backspace` | Delete the selected profile |
| `S` | Save the current config as a profile |
| `U` | Undo the last change |

### Privileged actions
Reads/diagnostics run unprivileged. Actions that *change* the adapter (MAC, IP config) or
capture packets (LLDP/CDP) require admin/root and request it **per action** via an OS prompt
(macOS password dialog, Linux `pkexec`, Windows UAC). See [SECURITY.md](SECURITY.md).

## Building & packaging

```sh
npm run build      # compile main/preload/renderer to out/
npm run package    # build an installable app with electron-builder (per platform)
npm run typecheck  # tsc --noEmit (main + renderer)
npm run lint       # eslint
npm test           # vitest (pure parsers/functions)
```

Unsigned, unpacked Windows build from any platform (no Wine):
```sh
npx electron-builder --win --x64 --dir
```

## How it works

`magiceth` runs the OS's own commands (`ifconfig`/`ipconfig`, `ip`, `networksetup`, `netsh`,
`ping`, `tcpdump`, …) via a shared, injection-safe helper and parses the output into typed
objects. Platform differences sit behind a `PlatformOps` interface. See
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full picture.

## Contributing

Contributions are welcome — new chipsets, platform verification, bug fixes. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Disclaimer

A tool for network troubleshooting on your own/authorized equipment. Active actions (MAC change,
IP reconfiguration) change your actual network configuration — use with good judgment.

## License

[WTFPL v2](LICENSE) © 2026 carlhannes
