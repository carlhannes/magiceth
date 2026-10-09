# Backlog

Known issues and gaps that are understood but not yet fixed. Each one records what is wrong, where,
and why it is still open — so picking one up does not mean starting the investigation over.

Small enough to fix in one PR unless noted. See [CONTRIBUTING.md](../CONTRIBUTING.md) first.

## A single unmodified keypress changes real network configuration — on a dongle

**Partly addressed.** `M`, `U` and `1`–`9` now ask for a confirming second press when the selected
port is built-in Wi-Fi or Ethernet, so a stray keystroke can no longer reconfigure the machine's
own connection. On a **dongle** they still act immediately, with no modifier and no confirmation.
That is deliberate — the whole point is one-handed operation at a rack — but it means any stray
keystroke reaching the window reconfigures the port.

`S` (save profile) is deliberately outside the gate: it writes a profile and changes nothing on the
adapter.

This is not hypothetical: on 2026-08-04 `en9`'s MAC was found rolled to a locally-administered
address with nobody having pressed `M` on purpose. The likeliest explanation is characters landing
in the app while an authentication dialog was expected to have focus, and the app happens to sit
focused a lot while those dialogs come and go.

Still worth a deliberate decision for dongles rather than drift. Options, roughly in order of how
much they cost the one-handed workflow: ignore keystrokes for a moment after the window regains
focus; extend the confirm keypress to dongles as well; or leave it and document it. Note also that
`U` cannot rescue a mistake across a restart — `undoStore` (`reconfig.ts`) is in-memory only.

The confirmation is cleared by any other keypress and never by a timer, because self-clearing
notices are their own open question further down this file.

## WLAN mode: what is missing

The scanner works on macOS and is verified end to end ([WIFI-FINDINGS.md](WIFI-FINDINGS.md)). What
is still open:

- **Linux is implemented but has not been run on hardware; Windows has run on one machine.** Every
  claim they rest on, and what to measure first, is listed in [WIFI-FINDINGS.md](WIFI-FINDINGS.md).
  Until then the `iw` fixture in `test/iw.test.ts` and the Windows entries in
  `test/wifi-helper.test.ts` are documented format rather than captures. Monitor mode (`tcpdump -I`) was considered and
  rejected for Linux: it needs root, drops the association the machine is using, hears one channel
  at a time, and adds nothing the screens show — client counts and load come from BSS Load, which
  `iw` already prints. Per-client visibility would be a different feature.
- **Linux without NetworkManager asks for a password.** Triggering a sweep needs `CAP_NET_ADMIN`, so
  the fallback is one `pkexec` prompt for a loop that scans every few seconds until a stop file, a
  3600 s cap, or five idle minutes. Those two numbers are guesses at what feels right: too short and
  a once-scan a minute after the last one prompts again, too long and the radio stays off-channel
  for nothing. `iwctl` (iwd) and `wpa_cli` could trigger without root on some systems and were left
  out to keep one fallback. NetworkManager is detected by `nmcli --version` alone, so a machine
  with `nmcli` installed but the service stopped takes the NetworkManager path and only ever sees
  what the kernel cache happens to hold.
- **Linux cadence is one sweep per ~10 s**, because NetworkManager rejects a rescan inside ten
  seconds of the last one. A recording on Linux therefore has coarser snapshots than on macOS.
- **The Windows helper cannot raise the consent prompt.** Windows only shows it for a process
  outside `System32`, and the helper is hosted by `powershell.exe`. A compiled helper `.exe` shipped
  in the app's resources would get the prompt; it needs a .NET toolchain at build time and an
  unsigned binary SmartScreen may flag, so for now a refusal opens the Location settings page.
- **The `O` Location fix edits HKCU as whoever answered the UAC prompt.** On a machine where the
  user is not an administrator and a different account approves the elevation, the user-level
  consent switches land in that administrator's hive, and the user still has to flip them in
  Settings. The machine-wide switch and the policy keys are fixed either way.
- **`Add-Type` fails under Constrained Language Mode** (AppLocker/WDAC policies), which the Windows
  helper reports as an error rather than working around.
- **No noise figure off macOS.** `iw` reports noise per channel (`iw dev <if> survey dump`), not per
  access point, and the Windows API reports none; the Noise row is simply absent there.
- **No 6 GHz width on Linux.** The HE Operation element's 6 GHz information is decoded from bytes
  (macOS, Windows) but not yet from `iw`'s text, whose format for it has not been seen.
- **Only Linux can tell WEP from open.** The elements alone cannot; `iw` prints the Privacy
  capability bit, the other two helpers do not pass it on.
- **Two Ethernet screenshots are from v0.2.0.** `docs/shots/screenshot.png` and
  `screenshot-vlan.png` predate the mode chooser, the speed test and the current footer, so they
  show keys and hints that no longer exist. Reproducing them needs hardware: a dongle with link
  into a port with no DHCP server for the first, and a trunk plus an admin capture for the second.
  The chipset and profile shots have the same problem _and_ the chipset one was captured
  mid-scroll, so its heading is cut off — those two only need a dongle plugged into USB, no cable.
- **Radio de-duplication is a heuristic.** Per-channel client totals treat two access points as
  one radio when they advertise the same station count and their BSSIDs differ in at most two
  octets. It is right on every case in the captures taken so far, but it will merge two genuine
  neighbours that happen to serve the same number of clients from similar hardware, and it will
  fail to merge a multi-SSID radio whose addresses differ more widely. The alternative — trusting
  the raw sum — was measured reporting 98 clients where there were 37.
- **Channel overlap assumes a wide access point is centred on its primary channel.** Every source
  reports the primary, so a 40/80/160 MHz span is placed symmetrically around it; at 160 MHz that
  can be out by up to 70 MHz. `ie80211.ts` now decodes the VHT/HE Operation elements for the width,
  and the centre segments are read in the same place — carrying one more field through the track
  and the CSV is all that is left.
- **320 MHz (802.11be) is not decoded.** It lives in the EHT Operation element, which nothing here
  reads yet; such an access point shows the width its VHT/HE elements claim.
- **The OUI database goes stale.** `resources/oui.json` is generated by `scripts/fetch-oui.mjs`
  from the IEEE registries and committed; nothing reminds anyone to regenerate it, and a block
  assigned after the last run resolves to nothing. Re-running the script is the whole fix.
- **`UNINFORMATIVE_OUIS` is a judgement call.** Vendor elements from Microsoft (WPS/WMM), the
  Wi-Fi Alliance, Qualcomm, Broadcom and MediaTek are filtered out when naming the maker of an
  access point with a randomised BSSID, because they answer "whose protocol" or "whose chipset"
  rather than "whose product". The list is hand-picked and will be wrong for some vendor that
  genuinely builds access points under one of those OUIs.
- **AP model is still almost never available.** Only a WPS element carries a self-declared model
  name, and none of the access points seen so far broadcast one. Some vendors put model
  information in their own elements — Ubiquiti's `00:15:6d` payload is the obvious one to decode
  next — but that is per-vendor reverse engineering, not a general solution.
- **No card selection.** The interface is whichever port enumerates as Wi-Fi, or the OS's default
  when none does. Every platform half accepts a name and reports the interfaces it can see, so the
  plumbing exists. A USB Wi-Fi stick enumerates as a dongle, not as Wi-Fi, so on a machine with
  both the built-in card is the one scanned.
- **No channel-overlap view.** The next question after "who else is on channel 6" is the spectrum
  picture, which needs the channel/width pairs drawn rather than listed.
- **Unverified against enterprise networks, captive portals, or WPS-broadcasting access points.**
  The AKM parser handles 802.1X suites but has never met one.
- **A TCC grant is keyed to a code signature.** The helper is ad-hoc signed, so a rebuild may
  re-prompt for Location access. This has not been measured across a version bump.
- **Recordings are never pruned or deleted from the app.** They accumulate in
  `~/Documents/magiceth` until removed by hand. Each is small — a ten-minute walk with twenty
  access points is well under a megabyte — so this is untidiness rather than a problem, but a
  delete key in the saved list is the obvious fix.
- **The snapshot interval is a floor, not a cadence.** Snapshots can only be taken when a scan
  returns, and a full channel sweep sometimes takes six seconds, so real gaps vary between two and
  about seven. Measured on 2026-09-29: `0 6 8 10 13 19 22 25 27 33`. Filling them would mean
  re-emitting a reading the radio never took.
- **Nothing ties a recording to where you were standing.** The obvious next step for a site survey
  is a position, whether a label typed per room or taken from Core Location.
- **The scan cadence is not adaptive.** A recording scans as fast as the radio allows, which moves
  it off-channel continuously and will cost throughput on the machine's own connection.

## Port survey: gaps left after the rebuild

The survey works and is verified against a synthetic trunk
([VLAN-FINDINGS.md](VLAN-FINDINGS.md) §5). What is still open:

- **Quitting mid-survey is untested.** `before-quit` writes the sentinel and the capture script caps
  itself at 10 minutes, so a leak is bounded either way, but the path has never been exercised.
- **No real managed switch has been seen.** In particular Cisco PVST+ sends a BPDU per VLAN every
  2 s, which would enumerate an entire trunk — the parser has never met one.
- **STP as a switch-identity fallback.** When LLDP is off, the root-bridge MAC in a BPDU still
  identifies the switch. The frames are already being captured; only a parser is missing.
- **Windows.** `discover()` returns `no-tool` there; it needs tshark + Npcap.
- **Active VLAN probing** — tag an interface and try DHCP on it, to prove a VLAN is usable from this
  port rather than merely present. Feasible: both dongles are confirmed to pass 802.1Q. It changes
  real network config, so it wants its own design pass.

## Speed test: what the figures do and do not cover

The test works and is verified end to end on macOS (556 Mbit/s down, 331 up over `en0`, both caps
holding exactly). What is still open:

- **Upload is counted at the pipe, not the wire.** `speedtest.ts` counts bytes handed to `curl`;
  the pipe and curl's own buffer hold a constant amount back, so the final total overstates by
  roughly one buffer. It cancels out of a trailing-window rate, which is why the headline is a
  windowed peak — but `bytes` itself is very slightly generous.
- **Request boundaries cost a little.** The download chains 50 MB requests over one reused
  connection; each boundary is a brief gap, and one was measured depressing a quarter-second
  window to 134 Mbit/s on a link doing 550. Larger chunks would mean fewer boundaries, but the
  endpoint refuses 100 MB and 50 MB keeps headroom if that limit ever tightens. The figure errs
  low, which is the safe direction.
- **Latency under load (bufferbloat) is not measured.** It is what a technician actually wants
  next — "the uplink is 100/100 but ping goes to 900 ms while it is busy". macOS `networkQuality`
  measures exactly this, so a cross-platform version needs the pings to run _during_ a transfer.
- **Windows and Linux are unverified.** The code paths are shared and only the bind value differs
  (`speedTestBind`), but neither has been run on real hardware.
- **Only tested against Cloudflare.** A captive portal or transparent proxy is handled as an error
  rather than a wrong number, but no such network has actually been tried.

## Ping: worst-case RTT is parsed and thrown away

`parsePing` reads `min/avg/max/stddev` and keeps the average and the deviation. The maximum is the
one that spots an intermittently bad port — a 15 ms average with a 900 ms outlier is a very
different port from a steady 15 ms — but showing it needs a rule for when it is worth the width,
so it was left out rather than guessed at.

Related and older: the regexes assume English output. `Minimum`/`Maximum`/`Average` are localized
on non-English Windows, so latency would be missing there while loss (a bare `%`) still parses.

## Built-in ports: only macOS has been seen working

Built-in Wi-Fi is verified live on macOS, where the rule leaves exactly the one real port on the
development machine. What is still open:

- **Built-in Ethernet has never been seen.** The development Mac is a laptop with none. The rule
  that classifies it (a hardware port named `Ethernet` with a network service) is unit-tested
  against a hand-built fixture, not real output from a Mac mini or iMac.
- **Linux and Windows enumeration are unverified on hardware.** Both changed shape: Linux now
  filters on the sysfs `device` entry instead of running `udevadm` per interface, and Windows now
  filters on `Virtual`/`HardwareInterface` and classifies Wi-Fi from the physical medium. The
  parsers are unit-tested; nothing has been run on a real machine.
- **Wi-Fi has no link rate on macOS.** `ifconfig` prints no `baseT` media for it, so the Link row
  says `up` with no speed. `system_profiler SPAirPortDataType` knows the rate but takes seconds,
  which is too slow for the enumeration poll. SSID, channel and signal strength are missing for the
  same reason — every OS answers differently and macOS removed `airport`.
- **A Mac where the user deleted a port's network service** will not list that built-in port, since
  the service list is half the rule. Dongles are unaffected — they are found through `ioreg`.

## Linux: static profiles silently drop DNS

`linuxProfileScript` (`src/main/platform/linux.ts`) applies the address and default route for a
static profile but never touches DNS, so a profile created with DNS servers applies without them
and the user gets no warning. macOS applies all of them via `networksetup -setdnsservers`.

Open because there is no single right way to do it on Linux: `/etc/resolv.conf` may be a symlink
managed by `systemd-resolved`, NetworkManager may own the connection, or the file may be plain.
Needs a decision on which to support, and hardware to verify on.

## Windows: only the first DNS server is applied

`winProfileScript` (`src/main/platform/win32.ts`) emits `netsh interface ip set dns … static
<dns[0]>` and ignores the rest of `profile.dns`. The fix is presumably a follow-up
`netsh interface ip add dns name="…" <addr> index=2`, but that is unverified command emission on
an elevated path, so it wants a Windows box to test against before shipping.

Low impact — it only bites profiles with two or more DNS servers.

## Linux: DHCP detection is inferred, not verified

`parseIpAddr` (`src/main/platform/linux.ts`) reads the `dynamic` flag that `ip -j addr` reports for
addresses with a finite lifetime, which is what a DHCP lease produces. This has not been checked
against a real machine across dhclient / NetworkManager / dhcpcd.

The failure mode is bounded: if the flag never appears the result is `false`, which is what the
code did before the inference existed. If it turns out unreliable, `ip -j route show default` also
carries `"protocol": "dhcp"` as a second signal.

## Notices never clear on their own

`notice` in `src/renderer/src/main.ts` persists until some other action replaces it, so a message
like "That profile cannot be deleted." can still be on screen several diagnostics runs later.

Deliberately left alone for now because the fix is a design choice, not a bug fix: auto-dismiss on
a timer, clear on the next successful action, or clear on any keypress. Note that `runDiag` must
_not_ clear it on success — `runReconfig` calls `runDiag` immediately after setting its own result
message, and clearing there would wipe it.
