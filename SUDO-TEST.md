# SUDO-TEST — manual validation of privileged features

Everything in `magiceth` that is **read-only** (dongle identification, IP/DHCP/gateway/DNS, ping, DNS test)
is already automatically tested and live-verified on macOS. This document lists what requires
**admin/root** and therefore must be tested manually. The reference rig is two dongles on one
switch: an ASIX AX88179A on `en9` and a Realtek RTL8153 on `en7`.

> ⚠️ These actions **change your real network configuration**. The simplest reset:
> unplug and re-plug the dongle, or apply the DHCP profile. Avoid running on an
> interface you depend on at that moment.

Two ways to test each thing: **(A)** in the app (`npm run dev`) with the keyboard — a password
dialog then pops up (osascript) — or **(B)** manually in the terminal to isolate the OS command.

---

## 1. Port survey — VLANs on the wire, plus LLDP/CDP (M3)

**In the app:** press **C**, approve the password prompt. It runs until you press **C** again,
listing every 802.1Q VLAN it sees with a frame count and the addressing inside each.

Tested in full on 2026-08-04 against two dongles on an unmanaged switch, with both synthetic LLDP
and a synthetic trunk injected onto the wire. Procedure, raw output and verdicts:
**[docs/VLAN-FINDINGS.md](docs/VLAN-FINDINGS.md)**, which owns this topic so the results live in one
place.

If you are stopping a capture by hand, use `kill -9` — SIGTERM does not stop `tcpdump` when nothing
matches the filter, and a `wait` on it will hang your shell. That was a real bug in this app, not a
hypothetical.

---

## 2. MAC rolling (M4)

**In the app:** press **M**. The app randomizes a _locally-administered_ MAC, sets it, and reads
it back to verify. **U** undoes (restores the previous MAC).

**Manually:**

```sh
ifconfig en9 | grep ether                 # note the current MAC
sudo ifconfig en9 ether 02:11:22:33:44:55  # set a test address
ifconfig en9 | grep ether                 # verify it changed
```

**Expected:** the second `grep ether` shows `02:11:22:33:44:55`.
**If unchanged:** the ASIX chipset/OS may not allow a MAC change while the link is up —
try unplugging/re-plugging, or it's a known limitation (the app then shows a clear warning).
**Reset:** `sudo ifconfig en9 ether <your-original-MAC>` or unplug/re-plug the dongle.

---

## 3. DHCP ↔ static switching / profiles (M4)

**In the app:** press **P** for the profile panel. **↑↓** selects, **Enter** (or a number **1–9**)
applies. **S** saves the current config as a static bookmark. **U** undoes the last change.

**Manually (macOS uses the service name, not `en9` — for your dongle it's `AX88179A`):**

```sh
# Save the current state first:
networksetup -getinfo "AX88179A"

# Set a static IP:
sudo networksetup -setmanual "AX88179A" 192.168.70.240 255.255.254.0 192.168.70.1
sudo networksetup -setdnsservers "AX88179A" 1.1.1.1 8.8.8.8
networksetup -getinfo "AX88179A"          # verify

# Back to DHCP:
sudo networksetup -setdhcp "AX88179A"
networksetup -getinfo "AX88179A"          # verify that a DHCP address comes back
```

**Expected:** IP/gateway/DNS change according to the commands; DHCP mode fetches a new address.

---

## 4. What I've already verified (no sudo needed)

- Dongle identification: `en9` → VID:PID `0b95:1790` → "ASIX AX88179 / AX88179A"; `en7` →
  `0bda:8153` → "Realtek RTL8153". Two dongles are listed as two, and switching between them scopes
  the diagnostics correctly.
- Diagnostics: IP `192.168.70.196/23`, gateway/DHCP/DNS `192.168.70.1`, lease, 1 Gbit/s full duplex.
- Bound pings: gateway ~0.4 ms, 1.1.1.1/8.8.8.8 ~11 ms, DNS test ok.
- Link-local fallback: `169.254.x.x` is flagged as link-local and DHCP shows "no server answered".
- 802.1Q tagging on both chipsets, verified on the wire — see
  [docs/VLAN-FINDINGS.md](docs/VLAN-FINDINGS.md).
- All parsers: unit tests green (`npm test`). The LLDP parser is now checked against **real**
  `tcpdump` output, not only the documented format.

## 5. Remaining per-OS spike (not this machine)

- **Linux:** MAC via `ip link`, DHCP/static via `ip`/`dhclient` — note the clash with NetworkManager if active.
- **Windows:** MAC via `Set-NetAdapterAdvancedProperty` (requires the driver to expose `NetworkAddress`),
  IP via `netsh`. Elevation via UAC (`Start-Process -Verb RunAs`).
