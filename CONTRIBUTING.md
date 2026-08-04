# Contributing to magiceth

Thanks for wanting to contribute! Contributions that are especially valuable: **verification on
real hardware** (especially Linux/Windows), **new chipsets**, and bug fixes. By participating you
agree to our [code of conduct](CODE_OF_CONDUCT.md).

## Development environment

Requires Node.js 20+ and npm.

```sh
git clone https://github.com/carlhannes/magiceth.git
cd magiceth
npm install
npm run dev
```

## Scripts

| Command             | Does                                            |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | Starts the app in development mode (hot reload) |
| `npm run typecheck` | `tsc --noEmit` for main + renderer              |
| `npm run lint`      | ESLint                                          |
| `npm run format`    | Prettier                                        |
| `npm test`          | Vitest (pure parsers/functions)                 |
| `npm run build`     | Compiles to `out/`                              |
| `npm run package`   | Builds an installable app (electron-builder)    |

**Run `npm run typecheck && npm run lint && npm test` before submitting a PR.**

## Project structure

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full picture. In short: the main
process runs OS commands and parses output; platform differences sit behind `PlatformOps`; the
renderer is a thin keyboard-driven dashboard.

## Code style

- **TypeScript strict.** Prettier + ESLint govern formatting/rules (`npm run format`, `npm run lint`).
- **Functional style** — functions and modules, not classes (natural for JS/TS).
- **Never run commands via a shell.** Use `run()`/`runJson()` in `util/run-command.ts`
  (`execFile` with arguments as an array) — it keeps quoting/injection out.
- **Prefer structured output** (`ip -j`, `ConvertTo-Json`, `-json`) over text parsing.
- **Keep parsing in pure, exported functions** that take a string and return typed objects —
  so they can be unit-tested without running real commands.

## Testing methodology

The load-bearing test surface is pure parsers tested against **real** command output (macOS) or
**documented** format (Linux/Windows), see `test/`. When you add/change a parser:

1. Capture real output on real hardware if you can (`ioreg …`, `ip -j …`, `Get-NetAdapter …`).
2. Add the output as a fixture in the test and assert against the typed result.
3. Run `npm test`.

Privileged actions (MAC/IP config) and packet capture can't be run without admin/root and are
not covered by the automated tests — verify them manually per
[SUDO-TEST.md](SUDO-TEST.md) (macOS/Linux) and [WINDOWS-TEST.md](WINDOWS-TEST.md).

## Common contributions

- **New chipset:** add a `"vid:pid"` entry in [`resources/chipsets.json`](resources/chipsets.json). No code needed.
- **Platform logic:** adjust `src/main/platform/<os>.ts`, keep the parsing pure + tested, verify on hardware.
- **New IPC:** handler in `src/main/index.ts`, method in `MagicethApi` (`src/shared/types.ts`), expose it in `src/preload/index.ts`.

## Pull requests

- Keep PRs small and focused.
- **State which platform/hardware you tested on** (e.g. "macOS 15 arm64, ASIX AX88179A").
- Include/update tests and docs. Update [CHANGELOG.md](CHANGELOG.md) under `Unreleased`.
