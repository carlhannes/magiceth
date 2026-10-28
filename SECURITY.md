# Security Policy

## Reporting a vulnerability

Do **not** open a public issue for security problems. Instead, report privately via GitHub's
[Security Advisories](https://github.com/carlhannes/magiceth/security/advisories/new). This is a
hobby project maintained on a best-effort basis — we'll respond when we can and are happy to
credit the reporter.

## Supported versions

Only the latest released version receives security updates (the project is in an early phase).

## Security model

`magiceth` is a local tool — it should be understood before running it with elevated privileges:

- **Runs OS commands injection-safely.** Everything goes through `execFile` with arguments as an
  array (no shell), so input can't be interpreted as commands. See `src/main/util/run-command.ts`.
- **Least privilege.** The app and all read-only diagnostics run unprivileged. Only packet capture
  (LLDP/CDP), adapter changes (MAC/IP), the Linux Wi-Fi scan loop on a machine without
  NetworkManager, and the opt-in Windows Location fix (`O`) are elevated, and then **per action**
  via the OS's own prompt (macOS password / Linux `pkexec` / Windows UAC). The entire app never
  needs to run as admin.
- **A Configure-mode session holds an address on the port.** One prompt adds an extra address to
  the selected port and removes it when the session ends, through the same elevated script, so the
  port's own configuration is never touched and the removal happens even if the app has gone. The
  DHCP server runs unprivileged and answers only clients the plugin allows (the UniFi plugin: the
  `ubnt` vendor class), only with addresses from its own pool, only on the port's own broadcast,
  and never with a NAK — the socket hears every interface of a laptop that is usually also on an
  office LAN, and a production device there must never get a lease from it. On Linux the script
  also lowers `net.ipv4.ip_unprivileged_port_start` to 67 for the session, which lets any user
  process on the machine bind ports 67–1023 until it is put back; on Windows it adds inbound
  firewall rules for UDP 67 and UDP 10001 scoped to the app's executable and removes them.
- **A session can share this computer's internet with the port.** When the plugin asks for it
  (the UniFi plugin does), the same script also turns on IP forwarding and a NAT rule in pf for
  the session's /24 through the interface your default route uses, machine-wide, until the
  session ends — then the rule is flushed, pf's reference released and forwarding put back to
  what it was. A device on the port is a NAT client behind your laptop for that time: it can reach
  whatever your laptop can reach, nothing can reach it from outside, and nothing else on your
  laptop is exposed. macOS only; the script's own fifteen-minute cap is the backstop if the app
  dies with a session open.
- **Plugins run with the app's privileges.** A plugin in `Documents/magiceth/plugins` is plain
  Node code loaded into the main process when — and only when — you open it from the Configure
  chooser; until then the app reads its `package.json` and nothing else. Treat the folder like a
  place you put programs: anything that can write there (including a cloud sync of your Documents)
  can put code there, and the chooser shows every plugin's origin — `built in`, or the folder it
  was found in — and its author before you open it.
- **No telemetry.** The tool sends no data anywhere. Network traffic happens only when you
  start it yourself: ping (gateway, `1.1.1.1`/`8.8.8.8`), a DNS lookup, passive LLDP/CDP
  listening, the speed test, and in Configure mode whatever the plugin you opened does — the
  built-in UniFi plugin resolves the controller you saved and lets the device on the port talk to
  it through your connection. It reads local network configuration; nothing else is written
  outside your machine.
- **No developer certificate.** Release builds are ad-hoc signed and not notarized, so macOS
  Gatekeeper and Windows SmartScreen warn the first time: "Apple could not verify…" (then System
  Settings → Privacy & Security → Open Anyway) and "Windows protected your PC" (More info → Run
  anyway). This is expected — verify that you obtained the build from the right source, check it
  against the `SHA256SUMS.txt` on the release, or build it yourself from source. A macOS copy that
  is refused as "damaged" is a 0.5.0 or 0.6.0 download, whose bundle shipped with a broken seal; use
  a newer release. Developer ID signing and notarization can be added by whoever distributes it.

## What to keep in mind

Active actions (MAC rolling, DHCP/static reconfiguration) change your **actual** network
configuration and can temporarily disrupt connectivity on that interface. Only run them on
equipment you own or have permission to troubleshoot.
