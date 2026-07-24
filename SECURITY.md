# Security Policy

## Reporting a vulnerability

Do **not** open a public issue for security problems. Instead, report privately via GitHub's
[Security Advisories](https://github.com/carlhannes/magiceth/security/advisories/new) or email
**<security-contact@example.com>**. We'll respond as soon as we can and are happy to credit the reporter.

## Supported versions

Only the latest released version receives security updates (the project is in an early phase).

## Security model

`magiceth` is a local tool — it should be understood before running it with elevated privileges:

- **Runs OS commands injection-safely.** Everything goes through `execFile` with arguments as an
  array (no shell), so input can't be interpreted as commands. See `src/main/util/run-command.ts`.
- **Least privilege.** The app and all read-only diagnostics run unprivileged. Only packet capture
  (LLDP/CDP) and adapter changes (MAC/IP) are elevated, and then **per action** via the OS's own
  prompt (macOS password / Linux `pkexec` / Windows UAC). The entire app never needs to run as admin.
- **No telemetry.** The tool sends no data anywhere. Network traffic happens only when you
  start it yourself: ping (gateway, `1.1.1.1`/`8.8.8.8`), a DNS lookup, and passive
  LLDP/CDP listening. It reads local network configuration; nothing is written outside your machine.
- **Unsigned builds.** Release builds are unsigned, so macOS Gatekeeper and Windows SmartScreen
  warn the first time ("unknown developer" / "Windows protected your PC"). This is expected —
  verify that you obtained the build from the right source, or build it yourself from source.
  Signing can be added by whoever distributes it.

## What to keep in mind

Active actions (MAC rolling, DHCP/static reconfiguration) change your **actual** network
configuration and can temporarily disrupt connectivity on that interface. Only run them on
equipment you own or have permission to troubleshoot.
