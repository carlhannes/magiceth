# Backlog

Known issues and gaps that are understood but not yet fixed. Each one records what is wrong, where,
and why it is still open — so picking one up does not mean starting the investigation over.

Small enough to fix in one PR unless noted. See [CONTRIBUTING.md](../CONTRIBUTING.md) first.

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
