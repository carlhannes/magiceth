# SUDO-TEST — manual validation of privileged features

Everything in `magiceth` that is **read-only** (dongle identification, IP/DHCP/gateway/DNS, ping, DNS test)
is already automatically tested and live-verified on macOS. This document lists what requires
**admin/root** and therefore must be tested manually. Preferably run it with your plugged-in AX88179A (`en9`).

> ⚠️ These actions **change your real network configuration**. The simplest reset:
> unplug and re-plug the dongle, or apply the DHCP profile. Avoid running on an
> interface you depend on at that moment.

Two ways to test each thing: **(A)** in the app (`npm run dev`) with the keyboard — a password
dialog then pops up (osascript) — or **(B)** manually in the terminal to isolate the OS command.

---

## 1. VLAN / switch port via LLDP/CDP (M3)

**In the app:** start `npm run dev`, press **C**, approve the password prompt. Wait up to 35 s.

**Manually (to see raw output + validate the parser):**
```sh
sudo sh -c 'tcpdump -l -i en9 -nn -v -s0 "ether proto 0x88cc or ether dst 01:00:0c:cc:cc:cc" & p=$!; sleep 40; kill $p 2>/dev/null'
```
**Expected:** lines with `LLDP` and/or `CDPv2` containing switch name, port, and VLAN.
**If empty:** many access ports don't send LLDP/CDP — in that case the app correctly shows "none heard".
Feel free to paste the raw output to me and I'll fine-tune the parser against your switch.

---

## 2. MAC rolling (M4)

**In the app:** press **M**. The app randomizes a *locally-administered* MAC, sets it, and reads
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

- Dongle identification: `en9` → VID:PID `0b95:1790` → "ASIX AX88179 / AX88179A".
- Diagnostics: IP `192.168.70.196/23`, gateway/DHCP/DNS `192.168.70.1`, lease, 1 Gbit/s full duplex.
- Bound pings: gateway ~0.4 ms, 1.1.1.1/8.8.8.8 ~11 ms, DNS test ok.
- All parsers (macOS live + Linux/Windows against documented format): 47 unit tests green.

## 5. Remaining per-OS spike (not this machine)

- **Linux:** MAC via `ip link`, DHCP/static via `ip`/`dhclient` — note the clash with NetworkManager if active.
- **Windows:** MAC via `Set-NetAdapterAdvancedProperty` (requires the driver to expose `NetworkAddress`),
  IP via `netsh`. Elevation via UAC (`Start-Process -Verb RunAs`).
