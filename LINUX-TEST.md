# magiceth — Linux test (the field laptop)

The Linux path of magiceth was written against documentation and parsers and had never run on
Linux hardware before this. The first machine is an HP Pro x360 Fortis 11 G9 — Pentium Silver
N6000, 8 GB, an 11.6" 1366×768 touch screen, Intel AX201 Wi-Fi, a built-in RJ-45 on a Realtek
RTL8111H — bought to be a dedicated field device: touch only, no keyboard, no password prompts.
This page is the order to check things in, what each step is expected to show, and where the
results go. Steps are in fail-fast order: each one costs a minute and rules out a cause for anything
later, so run them in sequence the first time.

Results go in three places. The **log** at the bottom of this page records what was run and what it
showed. Anything that turns out false goes into [docs/BACKLOG.md](docs/BACKLOG.md). What the Wi-Fi
card does and does not do in monitor mode goes into
[docs/WIFI-FINDINGS.md](docs/WIFI-FINDINGS.md), with the numbers.

## 0. Preparing the machine

Ubuntu 24.04 LTS Desktop, the standard GNOME on Wayland. GNOME is the only Linux desktop with an
on-screen keyboard that opens on focus, rotation through `iio-sensor-proxy` and a tablet mode for a
convertible; the lighter desktops have none of the three, and battery life comes from the kernel's
power management and the screen, not from the desktop's memory footprint. "Lightweight" is a
minimal installation and the Power Saver profile, not a different desktop.

1. **Install.** Leave Secure Boot on for now. Ubuntu 24.04.3 Desktop, "Minimal installation",
   then update. Give the account a plain lower-case username: the app's admin rule accepts
   `[a-z_][a-z0-9_-]{0,31}` and refuses anything else.
2. **Hardware, unprivileged.** Expected: both the RJ-45 and the Wi-Fi listed and `managed`; the
   drivers `r8169` and `iwlwifi`; touch and rotation working on the desktop.

   ```sh
   ip -br link
   nmcli device
   grep DRIVER /sys/class/net/*/device/uevent
   ```

3. **Tools.** Expected on a fresh 24.04.3: `tcpdump` present, `iw` and `curl` missing — the image's
   package manifest says so. Leave them missing: step 2 below is the app installing them.

   ```sh
   command -v tcpdump iw curl
   ```

4. **Power.** Settings → Power → Power Saver on battery, screen off after five minutes. No TLP: it
   fights `power-profiles-daemon`, which Ubuntu ships.

## 1. Installing the app

Build on a Linux host (`npm ci && npm run package -- --linux`; the Wi-Fi helper step prints
"macOS only, skipping" and that is fine). Whether electron-builder can also produce the `.deb` from
a Mac is unverified; if it cannot, the laptop builds its own. Then:

```sh
sudo apt install ./magiceth_<version>_amd64.deb   # apt pulls the Recommends; dpkg -i would not
ls -l /etc/apparmor.d/magiceth /usr/bin/magiceth /opt/magiceth/magiceth
```

Expected: the profile and the launcher exist; the app starts from the Dash without `--no-sandbox`
and without an error about user namespaces; the dock shows the app's own icon while it runs. Start
it once from a terminal too (`magiceth`) and keep that terminal: anything the main process logs
lands there.

## 2. The start screen's setup card

Under the three mode cards a fourth, warning-bordered one is expected to list three lines: "Admin
password — asked for every privileged action", `iw` and `curl` (and `tcpdump` too, if the installer
dropped it). Nothing else about the app needs them to be installed first.

- **`K` before `A`.** Press `K` first: expected one `pkexec` prompt, a notice naming the packages,
  and the tool lines gone when it finishes. `apt` is told to wait up to two minutes for the lock,
  which a fresh Ubuntu's unattended upgrades can hold; a second `K` after a minute is the remedy if
  it reports the lock.
- **`A`.** The first press shows the explanation at the top of the window — read it; it is the
  honest description of what is about to happen. The second press raises one `pkexec` prompt.
  Expected afterwards: the line gone, and

  ```sh
  sudo -n /usr/local/libexec/magiceth-elevate true && echo passwordless
  ls -l /etc/sudoers.d/magiceth-$USER /usr/local/libexec/magiceth-elevate   # 0440 root, 0755 root
  sudo visudo -c
  ```

- **No prompt from here on.** Every privileged action in the rest of this page should now run
  without a dialog. If any still asks, note which, and check `journalctl -t sudo -n 20` for the
  refusal — a hardened `sudoers` (`requiretty`, a `secure_path` without `/usr/sbin`) is the likely
  cause, and the app silently stays on `pkexec` in that case.
- **Undo, once, to prove it.** Remove the two files, restart the app: the line is back. Then press
  `A` again.

  ```sh
  sudo rm /etc/sudoers.d/magiceth-$USER /usr/local/libexec/magiceth-elevate
  ```

## 3. Ethernet mode on the built-in port

The RJ-45 is the field port on this machine, but the app still treats it as built-in: `M`, `U` and
a profile need a confirming second press. That stays — Wi-Fi carries the internet here, and a stray
tap in tablet mode is as easy as a stray key.

1. **Listed and identified.** The port appears badged `BUILT-IN`; with a cable in, IP, DHCP,
   gateway, DNS, link speed and the pings fill in.
2. **MAC rolling under NetworkManager.** `M`, `M`: expected a new address in `ip -br link`, a
   short blink while NetworkManager reactivates the connection, and DHCP back with the new address.
   `U` restores it. If NetworkManager puts the old address back by itself, note it: it means the
   connection has `ethernet.cloned-mac-address` set, and the profile script needs the
   NetworkManager branch sooner.
3. **Profiles.** NetworkManager manages this port, so a profile becomes a connection of the app's
   own, `magiceth-<port>`, in memory only. Apply a static profile with DNS servers: expected the
   address, gateway and DNS in the readout within a few seconds, and

   ```sh
   nmcli -t -f NAME,DEVICE,ACTIVE connection show      # magiceth-<port> active on the port
   nmcli -t -f connection.autoconnect-priority connection show magiceth-<port>   # 100
   resolvectl dns <port>                                # the profile's servers
   ```

   Then a DHCP profile: expected a lease back and the static address gone. Then, with the static
   profile applied again, unplug and replug the cable: expected the static address back by itself
   (autoconnect priority). Reboot: expected the system's own connection, and no `magiceth-` entry
   in `nmcli connection show`. First, before any of it, save what the app will read:

   ```sh
   nmcli -t -f GENERAL.TYPE,GENERAL.STATE device show <port>   # the two lines parseNmDevice reads
   ```

   If a profile fails, `journalctl -u NetworkManager --since=-5min` and the notice text are what
   to record; BACKLOG lists what is assumed here.

4. **Port survey.** `C`: expected to run for its full time without a prompt. The frames go into
   `/tmp/magiceth-$(id -u)/survey-<stamp>.txt`, created by root with mode 0644 — check that the
   file exists, is not empty and is deletable as the user. If it stays empty, look for AppArmor
   denying tcpdump the file:

   ```sh
   journalctl -k -g apparmor --since=-10min
   ```

   A denial here is the case BACKLOG describes; the fallback is noted there.

5. **Speed test.** `T`, `T`: numbers in the right range for the uplink.

## 4. Wi-Fi mode

Linux has no Location gate: BSSIDs come straight from `iw`. NetworkManager is present, so the app
asks it to sweep and reads `iw dev <wlan> scan dump`, which needs no privilege.

- Networks grouped by name with signal bars appear within about ten seconds of entering the mode;
  `Enter` opens the access points behind one, `Enter` again shows BSSID, maker, security, PHY,
  channel and width. Note whether `security` distinguishes WEP from open — Linux is the one
  platform that can.
- `C` cycles the channel views. `L` records a walk; `S` lists it; `F` opens the folder
  (`~/Documents/magiceth`). Confirm two CSV files.
- Does the list keep updating every few seconds? A list that only changes on `R` means the rescan
  is being refused — `nmcli device wifi rescan` by hand says why.

## 5. Configure mode and the DHCP plugin

- Enter the UniFi adoption plugin on the RJ-45 with nothing connected: the address hold is expected
  to run without a prompt and the status to show the pool address on the port.
- The DHCP server binds port 67 as the user: the hold script lowers
  `net.ipv4.ip_unprivileged_port_start`, so `sysctl net.ipv4.ip_unprivileged_port_start` reads 67
  while the plugin is active.
- With a Flex Mini or any UniFi device on the cable, the adoption flow is the same as on macOS —
  see the UniFi plugin's own notes.
- **Quit mid-session** (close the window while the hold is up): expected the extra address gone
  from `ip -br addr` and the sysctl back to its default within a few seconds.

## 6. Touch

Everything in the legend is a button and every row can be tapped; a tap sends the same key the
legend shows. Check, without touching the keyboard:

- A tap on a legend key does what the key does; a tap on a row selects it; a second tap on a
  selected row opens it; the two-press confirmations (`M` on this port, `A` on the start screen)
  can be completed by tapping the yellow question itself.
- **The on-screen keyboard.** Open a form (`P`, `N` in Ethernet mode) and tap a field. Expected: the
  GNOME keyboard slides up and the window is not covered. This is the one touch claim the plan
  could not prove without the machine. If nothing opens, two comparisons tell the story apart:
  `ELECTRON_OZONE_PLATFORM_HINT=x11 magiceth` from a terminal, and GNOME → Settings →
  Accessibility → Screen Keyboard turned on by hand.
- Start a recording in Wi-Fi mode and fling-scroll the list while it updates: does the scroll
  position survive the re-render? A jump back to the top is a known risk with a known fix.
- Rotate the machine into tablet mode: the window follows and the legend stays reachable.

## 7. Monitor mode, phase 0 — by hand, before any app code

The app's monitor-mode feature is built against a capture from a Mac first; what the AX201 really
does under Linux decides the script that will run on this machine. Everything below is manual, as
root, with the laptop's own Wi-Fi off the air for its duration — do it on the RJ-45 or without
internet. Save the raw outputs; two of them become test fixtures.

```sh
iw list > ~/iw-list.txt                                  # fixture; must show "* monitor" under interface modes
iw reg get
nmcli -t -f DEVICE,STATE,CONNECTION device                # note the wlan name and its connection
W=<wlan>
sudo nmcli device set $W managed no
sudo ip link set $W down
sudo iw dev $W interface add magicmon0 type monitor
sudo ip link set magicmon0 up
for ch in 1 6 13 36 100 149; do sudo iw dev magicmon0 set channel $ch && echo "ch $ch ok"; done
sudo iw dev magicmon0 set freq 5180 80 5210 && echo "80 MHz ok"   # the kernel-bug check (bugzilla 217051)
```

Expected: every channel sets; 80 MHz sets. If the 5 GHz channels or the 80 MHz setting fail with
`Invalid argument`, that is the known iwlwifi regression; the out-of-tree backport in the gist from
the plan needs `build-essential linux-headers-$(uname -r)` and either Secure Boot off or a signed
module. Record the kernel version (`uname -r`) with the result either way.

Then a capture, hopping by hand from a second terminal:

```sh
D=/tmp/magiceth-$(id -u); mkdir -p "$D"      # the app's scratch directory; root creates the file, as the app's script will
sudo sh -c "umask 022; tcpdump -i magicmon0 -nn -U -s 1024 -w - 'not type ctl' >> $D/monitor-ax201.pcap 2>> $D/monitor.log" &
for ch in 1 6 11 36 44 100 149; do sudo iw dev magicmon0 set channel $ch; sleep 4; done   # second terminal
sudo pkill -INT -x tcpdump                   # INT, so tcpdump flushes and prints its counts into the log
tcpdump -r "$D/monitor-ax201.pcap" -e -nn | head -40
journalctl -k -g apparmor --since=-10min
```

Expected in the dump: radiotap headers with a dBm signal and a channel, many BSSIDs, frames from
the 5 GHz channels, QoS data frames with the retry flag. Expected in the journal: nothing about
tcpdump. Trim the file to a few hundred frames and keep it: it is the second fixture.

Restore, and time it:

```sh
sudo iw dev magicmon0 del
sudo ip link set $W up
sudo nmcli device set $W managed yes
nmcli connection up "<the connection noted above>"
```

How many seconds until a page loads again? That number sets what the app's notice promises.

## 8. Leaving things clean

After quitting the app, each of these should hold:

```sh
pgrep -af tcpdump            # nothing
nmcli -t -f DEVICE,STATE device   # wlan connected, RJ-45 as before
ip -br addr                  # no leftover pool address on the RJ-45
ls -la /tmp/magiceth-$(id -u) # survey files you meant to keep, nothing else
```

## Log

One row per run; the most recent at the top. "Not yet run" is a valid entry — it is the state of
every step until the machine is here.

| Date | Step | Result      | Notes                               |
| ---- | ---- | ----------- | ----------------------------------- |
| —    | all  | not yet run | the laptop is on order (2026-11-04) |
