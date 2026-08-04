# Notes for AI agents

Working agreements and hard-won gotchas for automated contributors. Read
[CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first — this
file only covers what is specific to driving this repo from an agent session.

## Before you report anything as done

```sh
npm run typecheck && npm run lint && npm test && npx prettier --check .
```

The load-bearing test surface is the pure parsers in `test/`. If you change a parser, feed it
**real captured output** rather than output you invented — the two multi-dongle bugs found on
2026-08-04 were both invisible to hand-written fixtures because they came from a driver quirk
nobody would have guessed. Real captures live in the test files as string constants; add to them.

## Running the app: kill every Electron instance, not just Vite

**This is the one that will waste your time.** `npm run dev` starts Vite _and_ an Electron app as a
child process. Killing the dev server does **not** kill Electron:

```sh
pkill -f "electron-vite dev"        # kills Vite only — the app keeps running
```

Stale instances accumulate silently. They keep their window open, still named `magiceth`, still
looking plausible — but running the code from whenever they started. Screenshot one of those and
you will "verify" a fix that never ran, which is exactly what happened once already: three
instances open at once, and the capture landed on the oldest.

Kill both, and confirm:

```sh
pkill -f "electron-vite"; pkill -f "Electron.app/Contents/MacOS/Electron"
pgrep -f "Electron.app/Contents/MacOS/Electron" | wc -l   # must be 0 before you start a new one
```

If you target a window by name, sort candidates by window id descending (highest = newest) and
warn when there is more than one. Never assume the first match is the live build.

## Driving the UI on macOS

Screenshots and keystrokes need two separate macOS permissions for the process running the agent —
**Screen Recording** (for `screencapture`) and **Accessibility** (for System Events keystrokes).
They are granted independently, and a failure in one looks nothing like a failure in the other:
`screencapture` prints `could not create image from display`, while System Events raises
`osascript is not allowed assistive access. (-1719)`.

Finding the window id needs `CGWindowListCopyWindowInfo`. There is no pyobjc on a stock machine,
but `/usr/bin/swift` can run a script directly.

```sh
screencapture -l<windowid> -o -x -t png out.png   # -o drops the shadow, -x silences the shutter
```

Sending keys: activate the process, then **wait ~0.8 s before the keystroke**. A shorter delay
sends the key before Electron is frontmost and it lands in whatever app was focused — which reads
exactly like the feature being broken. A 0.3 s delay produced a false "this keybinding doesn't
work" report once.

`Date`-free note: `osascript -e 'delay N'` is the reliable sleep here.

## Verifying things that need hardware

Plenty of this project cannot be checked without a dongle, a cable and a switch. Say so plainly
rather than implying coverage:

- Read-only diagnostics can be verified live on macOS if a dongle is attached.
- Privileged actions (`M`, `U`, applying a profile) change real network configuration. Do not run
  them speculatively.
- Physically plugging and unplugging is the user's job. Ask, and state which claims depend on it.
- Linux and Windows behaviour is verified through parsers plus documented command formats. Never
  describe them as tested when they are not — [docs/BACKLOG.md](docs/BACKLOG.md) tracks what is
  genuinely unverified.

## Do not weaken the invariants

- Commands run through `run()`/`runJson()` (`execFile`, argument array, no shell). The single
  exception is elevation in `privilege.ts`, where every interpolated value goes through `shQuote`
  or `psEscapeDouble`.
- Parsing stays in exported pure functions so it can be unit-tested without touching hardware.
- `resources/chipsets.json` is the only chipset source of truth.
