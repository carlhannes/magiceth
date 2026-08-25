# Backlog

Known issues and gaps that are understood but not yet fixed. Each one records what is wrong, where,
and why it is still open — so picking one up does not mean starting the investigation over.

Small enough to fix in one PR unless noted. See [CONTRIBUTING.md](../CONTRIBUTING.md) first.

## A single unmodified keypress changes real network configuration

`M` (roll MAC), `S` (save profile), `U` (undo) and `1`–`9` (apply profile) all act immediately, with
no modifier and no confirmation. That is deliberate — the whole point is one-handed operation at a
rack — but it means any stray keystroke reaching the window reconfigures the port.

This is not hypothetical: on 2026-08-04 `en9`'s MAC was found rolled to a locally-administered
address with nobody having pressed `M` on purpose. The likeliest explanation is characters landing
in the app while an authentication dialog was expected to have focus, and the app happens to sit
focused a lot while those dialogs come and go.

Worth a deliberate decision rather than drift. Options, roughly in order of how much they cost the
one-handed workflow: ignore keystrokes for a moment after the window regains focus; require a
confirm keypress for the destructive four; or leave it and document it. Note also that `U` cannot
rescue a mistake across a restart — `undoStore` (`reconfig.ts`) is in-memory only.

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

## The window scrolls when a sub-view is open

At the default 480×820, opening the profile panel (`P`) or the chipset view (`I`) pushes the
content past the bottom of the window. Both sub-views append below the diagnostics card rather than
replacing it, which keeps the port readout visible but costs a scroll.

Alternative would be to have a sub-view replace the diagnostics body while open. Worth deciding
deliberately rather than drifting into it.
