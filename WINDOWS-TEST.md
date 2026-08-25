# magiceth — Windows test (first run on Windows)

Thanks for testing! This is a small tool for troubleshooting network ports — via a USB-to-ethernet
dongle, and now also via the machine's own Wi-Fi and Ethernet.

Identification, diagnostics, ping, DHCP/static switching and MAC rolling have all been confirmed
working on Windows 11. **What is new and unverified on Windows is which ports get listed at all:**
the app now decides that from `Get-NetAdapter`'s `Virtual` and `HardwareInterface` properties, and
nobody has watched it do so on a real machine. That is the thing most worth your eyes.

## How to run it

1. Unzip the file somewhere (e.g. the desktop).
2. Double-click **`magiceth.exe`** — **launch it normally, NOT as administrator.**
3. Windows SmartScreen will probably say "Windows protected your PC" (the app is unsigned).
   Click **More info → Run anyway**. (Harmless — it's just not code-signed.)

## About administrator privileges (UAC)

- All **reads/diagnostics** (detecting the dongle, showing IP/DHCP/gateway/DNS, ping, DNS test)
  run **without admin** — no UAC dialog.
- The app **asks for admin itself, per action**, only when you _change_ the adapter: `M` (roll MAC),
  apply a profile, `U` (undo). A **UAC dialog then pops up → click Yes**. One prompt per action.
- On a **built-in** port (your Wi-Fi or onboard Ethernet) those three keys ask first: the first
  press shows a question at the top of the window, and only the very next press of the same key
  does it. On a **dongle** they act immediately. This is deliberate — a stray keystroke should not
  be able to take down the machine's own connection.
- So you don't need to launch as administrator. (If you want to avoid repeated prompts you can
  right-click → "Run as administrator", but for the test it's enough to run it normally.)

## What you're testing

**Which ports are listed (the new, unverified part):**

- With no dongle attached you should still see something — your **Wi-Fi** and/or **built-in
  Ethernet**, badged `WI-FI` / `BUILT-IN`.
- You should **not** see Hyper-V or WSL virtual switches, VPN/TAP adapters, loopback, or anything
  else that is not a real port. If any of those show up, that is the bug we are looking for.
- Plug in a dongle → it should appear **first in the list and become selected by itself**.

**Without admin (should just work):**

- The dongle should be identified (chipset/vendor); built-ins say `BUILT-IN`/`WI-FI` instead,
  because the chipset database only covers USB dongles.
- Connect a port → IP, netmask, gateway, DNS, DHCP, and link speed should show automatically, plus
  ping to the gateway and the internet (1.1.1.1 / 8.8.8.8) and a DNS test. Latency comes with a
  jitter figure and a packet-loss percentage.
- Press **R** to re-run.
- Press **T** for a speed test. It explains itself first and starts on a second **T**. Note it
  transfers real data to speed.cloudflare.com — up to ~200 MB each way, about 20 s — so skip it on
  a metered connection.

**Changes the adapter (UAC dialog per action — optional to test):**

- **M** = randomize a new MAC address. **U** = undo.
- **P** = profiles → **1–9**/**Enter** applies DHCP or a static IP. **S** = save the current one as a profile.
- In the profile panel: **N** = new profile, **E** = edit the selected one (the form is filled in with the mouse,
  Save/Cancel), **Backspace** = delete. Feel free to try creating your own static profile and applying it.

**Optional/may not work:** VLAN/switch info (**C**) requires Wireshark/Npcap, which isn't
included — it should then show a clear "not supported" notice, not crash.

## What we want to know

- **Which ports were listed?** Anything missing, and — more importantly — anything listed that is
  not a real port (Hyper-V, WSL, VPN, loopback)? A screenshot of the list answers this best.
- Did a dongle you plugged in appear first and take the selection?
- Was the dongle identified with the right chipset/vendor?
- Did IP/gateway/DNS/DHCP match what you know about the network? Did the pings work?
- Did the speed test (**T**) produce sensible numbers for that connection?
- If you tested the admin things: did the MAC change work? Could you switch DHCP/static? Did the
  built-in ports ask for a confirming second press first?
- Feel free to send a screenshot + anything that was missing or looked off.

Keys: **↑↓** switch port · **R** re-run · **I** chipset info · **T** speed test · **C** VLAN survey
· **M** roll MAC · **P** profiles (**N** new / **E** edit / **Backspace** delete in the panel) ·
**S** save · **U** undo.
