# Configure mode: manual verification

What to run, in order, the first time the UniFi adoption plugin meets real hardware — and what to
bring back. Everything in Configure mode was built without a UniFi device in reach, so each step
below both verifies a claim and records what was actually seen. The findings go into
`docs/BACKLOG.md` (remove what is verified) and the captures replace the hand-built fixtures in
`test/` (see [AGENTS.md](AGENTS.md)).

Hardware: a factory-default USW-Flex-Mini (hold reset ten seconds with power on), a PoE injector
or USB-C power for it, a USB Ethernet dongle, and a self-hosted controller reachable from the
laptop's own internet connection with **Override Inform Host** set to its public hostname.

Approvals may take a while to arrive; nothing below depends on answering a prompt quickly.

## 0. Without hardware (any Mac, today)

Done on 2026-10-13 on the development Mac, worth repeating after a change to `dhcp/`:

- `npm run typecheck && npm run lint && npm test && npx prettier --check .` — green.
- `npm run build` — `out/main/plugins/unifi-adopt/index.js` and `package.json` exist, the bundle's
  only requires are `node:*` modules and `../../chunks/*`.
- Port 67 binds without root: `node -e "require('dgram').createSocket('udp4').bind(67,'0.0.0.0',()=>{console.log('ok');process.exit()})"`.
- Loopback smoke test of the server's socket half, with the app not running and nothing else on
  port 67 or 68 (no `sudo` needed — 127.0.0.1 stands in for the dongle's broadcast, which macOS cannot deliver on loopback):

  ```sh
  DHCP_SMOKE=1 npx vitest run test/dhcp-smoke.test.ts
  ```

- `npm run ui-check` — builds the app and drives it over Electron's own debugging endpoints
  (window hidden, no system keyboard, nothing installed): chooser, the UniFi form with a bad and a good URL, edit, delete, a user plugin in
  `Documents/magiceth/plugins/hello` (copied from `examples/plugins/hello` by the script) with keys, its form, and a reload after editing
  it, Esc all the way out. Screenshots land in a temp folder it names.
- By hand (`npm run dev`, check `out/main/index.js` is newer than your edit): `3` → the chooser
  lists **UniFi adoption**; `Enter` → the empty controller list; `N` → the form; saving a bad URL
  shows the error in the form; saving a good one lists it; `Esc` → chooser. Drop a folder with a
  `package.json` (`"magiceth": {"api": 1}`) and an `index.js` exporting
  `activate: () => ({ render: () => ({ blocks: [{ kind: 'text', text: 'hi' }], keys: [] }), onKey() {}, deactivate() {} })`
  into `Documents/magiceth/plugins/hello/`; leave and re-enter the mode; it is listed and renders.
  Edit the text, leave and re-enter; the new text shows without a restart.

## Results so far

**2026-10-26, macOS, en9 (AX88179A), USW-Flex-Mini 2.1.6.762, controller = a UniFi OS gateway on
the home LAN.** Steps 1–5 run; the device ended up Connected in the controller.

- Step 1: capture in `test/fixtures/flexmini-capture.ts`. DISCOVER every 20 s with vendor class
  `ubnt`, hostname `USW-Flex-Mini`, parameter list 1 3 28 6 12 15 43, broadcast flag clear, no
  client id. Discovery (v2, command 6) every 10 s from 192.168.1.20, default flag set. The Mac's
  own DHCP client also DISCOVERs on the link, without a vendor class.
- Step 2: alias on the port within 5 s of approval, present throughout; removed within 2 s of `S`,
  and at the 15-minute cap; stop file gone; nothing left running.
- Step 3: lease a few seconds after `DHCP server on …` — the device accepts the OFFER to the
  subnet broadcast. Discovery row with model and version. Renewal every 60 s. Informs every ~96 s,
  3.3 kB. **The controller answers 404 to an unadopted device's inform** and still lists it as
  "Click to Adopt" with its dongle-link address; 404 means "pending, nothing for you", not a
  rejection.
- Step 4: after Adopt, the next inform got 200 and a 715-byte inform followed two seconds later
  (the device acknowledging with its new key). Three more 200s within 25 s, one fresh DHCP
  exchange while the device re-applied its network, then silence: it now informs to the
  controller's own address, which it cannot reach from the dongle. That is what the ended-session
  text assumes.
- Step 5: `S`, cable moved to the real network, Connected in the controller shortly after.
- Also seen: a DISCOVER from a device on the laptop's Wi-Fi LAN, ignored as designed. A Flex Mini
  powered by PoE from the previous switch is dead when moved to the dongle — it needs its own
  power (USB-C PD worked).

## 1. Capture the device before the plugin sees it

The one step that produces the fixtures. Dongle in the laptop, Flex Mini powered, port 2 of the
Flex Mini to the dongle, nothing else connected to it. No app running.

```sh
sudo tcpdump -i <dongle> -w flexmini-boot.pcap 'port 67 or port 68 or port 10001' &
# power-cycle the Flex Mini, wait 90 s
sudo kill %1
tcpdump -r flexmini-boot.pcap -vvv -nn
```

Record:

- The DHCP DISCOVER: vendor class (option 60 — `ubnt`?), the broadcast flag, option 55's list,
  option 61, the hostname. Paste the packet bytes (`tcpdump -r … -x`) into `test/fixtures/dhcp.ts`
  as a constant and point `dhcp-codec.test.ts` and `dhcp-lease.test.ts` at it.
- The discovery broadcasts on 10001: from which source address (expected 192.168.1.20 after the
  DHCP attempts fail), how often, and the bytes — into `test/discovery.test.ts`.
- Whether the device also tries `http://unifi:8080/inform` by name (a DNS query would show in a
  wider capture; not needed).

## 2. The address hold, on its own

Still no device needed. In the app, `3`, `Enter` on UniFi adoption, a controller saved, `Enter`.
Approve the prompt.

- `ifconfig <dongle>` shows the alias (10.254.254.1/24 unless that subnet was taken) within a
  second of approval; the screen says `DHCP server on 10.254.254.1/24`.
- Plug the Flex Mini's cable in (link comes up): the alias is still there a few seconds later.
  This is the configd claim — if the alias vanishes and comes back within a second, the re-assert
  in the loop is doing its job; if it vanishes for good, that is a finding.
- `S`: the alias is gone within two seconds, and `ls "$TMPDIR"magiceth-dhcp-*` shows no stop file (the session writes it to the OS temp dir, which on macOS is not `/tmp`).
- Start again and quit the app mid-session: the alias is gone within two seconds.
- Start again and wait: the session ends by itself at fifteen minutes with the alias removed.

## 3. The lease and the inform

Controller saved with its real inform URL, Flex Mini factory default and connected only to the
dongle, session started and approved. Expected on screen, in order, within about a minute:

1. `Discovered … (USW-Flex-Mini …) at 192.168.1.20` (if the device announces before leasing) —
   the discovery parser against a real packet.
2. `DHCP discover from <mac> …, vendor class ubnt` → `Offered 10.254.254.10` → `Lease 10.254.254.10 → <mac>`.
   If the discover shows but no lease follows, the device did not take the OFFER: capture the
   exchange (`sudo tcpdump -i <dongle> -nn port 67 or port 68 -vvv`) and note the destination
   address of the OFFER and whether the device re-sends DISCOVER. That is the subnet-broadcast
   question in the backlog.
3. `Inform from <mac> (… bytes) → controller answered 200 in … ms` repeating every ~10 s — the
   relay. Save one inform body for `test/inform-relay.test.ts` by adding a temporary
   `writeFileSync` in `inform-relay.ts`, or from a capture on port 8080.
4. The device listed as **Pending Adoption** in the controller.

## 4. Adopt

Click Adopt in the controller.

- The next relayed inform carries the adoption; the device shows **Adopting**.
- Record what the device does next: keeps informing through the relay (controller shows it move
  to Provisioning/Connected while still on the dongle) or goes quiet (it is now informing to the
  override host, which it cannot reach). Both are fine; the status text assumes the second and
  should be adjusted if the first is what happens.
- `S`, unplug, cable the Flex Mini into its real network: it reaches **Connected** in the
  controller within a few minutes.

## 5. Linux and Windows

The same steps 2–4 on each. In addition:

- Linux: `sysctl net.ipv4.ip_unprivileged_port_start` is 67 during the session and back to its
  previous value after; `ip addr show <dongle>` has the alias; with NetworkManager managing the
  port, note whether it removes the alias when the link comes up (the loop re-adds it).
- Windows: `Get-NetFirewallRule -DisplayName 'magiceth*'` shows three rules during the session
  and none after; `netsh interface ipv4 show addresses "<adapter>"` has the extra address; if
  `netsh add address` refused on a DHCP-configured adapter (the session never reports
  `DHCP server on …`), that is the backlog's fallback case.
- Both: the device gets its lease and informs, exactly as in step 3.

## What to write down

For each OS: the three outcomes above that are not yet verified (vendor class, OFFER acceptance,
alias survival), the relay's HTTP status for an unadopted device's inform, and what the device did
after adoption. Then: fixtures replaced, BACKLOG trimmed, and this file updated with dates.
