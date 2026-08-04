# magiceth — Windows test (first run on Windows)

Thanks for testing! This is a small tool for troubleshooting network ports via a
USB-to-ethernet dongle. It has been built and tested on macOS — **this is the first time
it's running on Windows**, so we want to know what works and what doesn't.

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
- So you don't need to launch as administrator. (If you want to avoid repeated prompts you can
  right-click → "Run as administrator", but for the test it's enough to run it normally.)

## What you're testing

**Without admin (should just work):**

- Plug in a USB-ethernet dongle → it should show up and be identified (chipset/vendor).
- Connect the dongle to a network port → IP, netmask, gateway, DNS, DHCP, and link speed
  should show automatically, plus ping to the gateway and the internet (1.1.1.1 / 8.8.8.8) and a DNS test.
- Press **R** to re-run.

**Changes the adapter (UAC dialog per action — optional to test):**

- **M** = randomize a new MAC address. **U** = undo.
- **P** = profiles → **1–9**/**Enter** applies DHCP or a static IP. **S** = save the current one as a profile.
- In the profile panel: **N** = new profile, **E** = edit the selected one (the form is filled in with the mouse,
  Save/Cancel), **Backspace** = delete. Feel free to try creating your own static profile and applying it.

**Optional/may not work:** VLAN/switch info (**C**) requires Wireshark/Npcap, which isn't
included — it should then show a clear "not supported" notice, not crash.

## What we want to know

- Was the dongle detected? Correct chipset/vendor?
- Did IP/gateway/DNS/DHCP match what you know about the network? Did the pings work?
- If you tested the admin things: did the MAC change work? Could you switch DHCP/static?
- Feel free to send a screenshot + anything that was missing or looked off.

Keys: **↑↓** switch dongle · **R** re-run · **M** roll MAC · **P** profiles (**N** new /
**E** edit / **Backspace** delete in the panel) · **S** save · **U** undo · **C** VLAN.
