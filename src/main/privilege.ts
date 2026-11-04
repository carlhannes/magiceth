import { run } from './util/run-command'
import type { RunResult } from './util/run-command'

// Run commands with elevated privileges via a clear OS prompt — or, on a Linux machine set up for
// it, without one. Used by the port survey, reconfig, the Configure-mode address hold and the Linux
// Wi-Fi scan loop. Read-only diagnostics never need this.
//
// NOTE: the actual password prompt cannot be unit-tested — the pure parts (the escaping helpers,
// the script builders, the refusal classifier) are tested, the rest is verified live.

/** Safely sh-quote an argument (for shell commands that must go through a shell during elevation). */
export function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Escape a string to be embedded in an AppleScript string literal. */
export function appleScriptEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Escape a value to be embedded in a PowerShell double-quoted string ("…").
 * PowerShell expands $var and $(…) inside "…" and uses the backtick as its escape
 * character, so all three must be neutralised. Backtick first — otherwise we would
 * escape the escapes we just added.
 */
export function psEscapeDouble(value: string): string {
  return value.replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"')
}

// --- Linux without a password: one fixed helper and one sudoers rule ----------------------------
//
// pkexec asks for the password on every action, which on a dedicated field laptop is an
// interruption with nobody there to answer it. The alternative is one rule in /etc/sudoers.d that
// lets this user run one root-owned helper without a password, and the helper runs the script it is
// handed. That is passwordless root for that user through that path — as powerful as
// `NOPASSWD: ALL`, because the script is arbitrary — so it is installed only on request, from the
// start screen, after a confirming press, and SECURITY.md says what it means. sudo logs every call.
// Two files; `sudo rm` of both undoes it.

export const LINUX_HELPER = '/usr/local/libexec/magiceth-elevate'

export const LINUX_HELPER_SCRIPT = [
  '#!/bin/sh',
  '# magiceth: runs one elevated script for the user named in /etc/sudoers.d/magiceth-<user>.',
  '# Installed by magiceth from its start screen (A). See SECURITY.md. Remove both files to undo.',
  'exec /bin/sh -c "$1"'
].join('\n')

/** Debian's default `adduser` names. Anything else gets the manual recipe in the README instead. */
export const LINUX_USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/

export function linuxSudoersFile(user: string): string {
  return `/etc/sudoers.d/magiceth-${user}`
}

export function linuxAdminRule(user: string): string {
  return `${user} ALL=(root) NOPASSWD: ${LINUX_HELPER}`
}

/**
 * The one-time setup, run through pkexec. The rule is written next to its final name — sudo ignores
 * names containing a dot, so a half-written file is never read, and the `mv` is atomic on one
 * filesystem — and checked with `visudo -cf` before the move, so a syntax error installs nothing
 * and the trap removes the leftovers.
 */
export function linuxAdminSetupScript(user: string): string {
  if (!LINUX_USERNAME.test(user)) throw new Error(`Cannot write a sudoers rule for user "${user}"`)
  const helper = LINUX_HELPER_SCRIPT.split('\n').map(shQuote).join(' ')
  const rule = [
    '# magiceth: password-free admin for one user through one helper. See SECURITY.md.',
    linuxAdminRule(user)
  ]
    .map(shQuote)
    .join(' ')
  return [
    'set -e',
    'umask 022',
    'mkdir -p /usr/local/libexec',
    `printf '%s\\n' ${helper} > ${shQuote(LINUX_HELPER)}`,
    `chown root:root ${shQuote(LINUX_HELPER)}`,
    `chmod 0755 ${shQuote(LINUX_HELPER)}`,
    't=$(mktemp /etc/sudoers.d/.magiceth.XXXXXX)',
    `trap 'rm -f "$t"' EXIT`,
    `printf '%s\\n' ${rule} > "$t"`,
    'chmod 0440 "$t"',
    'chown root:root "$t"',
    'visudo -cf "$t"',
    `mv -f "$t" ${shQuote(linuxSudoersFile(user))}`
  ].join('; ')
}

/**
 * sudo without a prompt when the rule above is in place, otherwise pkexec. Probed on every call
 * (about ten milliseconds): the OS stays the single source of truth, and the setup takes effect
 * without a restart. Assumes Ubuntu's defaults — `requiretty` off, `secure_path` with /usr/sbin —
 * which is what the setup targets; where sudo refuses, pkexec is used exactly as before.
 */
export async function linuxElevator(): Promise<'sudo' | 'pkexec'> {
  const r = await run('sudo', ['-n', LINUX_HELPER, 'true'], { timeoutMs: 5000 })
  return r.code === 0 ? 'sudo' : 'pkexec'
}

/**
 * Whether a result means the OS prompt was refused rather than the script having failed, in the
 * words each OS uses: osascript's "User canceled" (-128), polkit's "Not authorized" and pkexec's
 * exit codes 126 (dialog dismissed) and 127 (not authorised), UAC's "canceled by the user", and
 * `sudo -n` finding no rule. Only meaningful for a script that ends in `true`, because a script
 * whose own last command is missing also exits 127 — every long-running script here does end so.
 */
export function elevationRefused(r: RunResult): boolean {
  return (
    r.code === 126 ||
    r.code === 127 ||
    /user canceled|-128|not authorized|canceled by the user|a password is required/i.test(r.stderr)
  )
}

/** Run a complete shell command line with elevated privileges (GUI password prompt). */
export async function runElevatedShell(shellCmd: string, timeoutMs = 60000): Promise<RunResult> {
  if (process.platform === 'darwin') {
    const script = `do shell script "${appleScriptEscape(shellCmd)}" with administrator privileges`
    return run('osascript', ['-e', script], { timeoutMs })
  }
  if (process.platform === 'linux') {
    if ((await linuxElevator()) === 'sudo') {
      return run('sudo', ['-n', LINUX_HELPER, shellCmd], { timeoutMs })
    }
    return run('pkexec', ['sh', '-c', shellCmd], { timeoutMs })
  }
  throw new Error(`Elevated shell not supported on platform: ${process.platform}`)
}

// A platform-independent "elevation plan": a script + which interpreter should run it.
// sh is used on macOS/Linux, powershell on Windows.
export interface ElevatedPlan {
  interpreter: 'sh' | 'powershell'
  script: string
}

/** Run an elevation plan. Windows: UAC via Start-Process -Verb RunAs (stdout is not captured — verify by re-reading). */
export async function runElevatedPlan(plan: ElevatedPlan, timeoutMs = 40000): Promise<RunResult> {
  if (plan.interpreter === 'sh') {
    return runElevatedShell(plan.script, timeoutMs)
  }
  // powershell (Windows). EncodedCommand avoids all quoting issues.
  const encoded = Buffer.from(plan.script, 'utf16le').toString('base64')
  // Hidden, because a Configure-mode address hold keeps the elevated shell alive for the whole
  // session and a console window sitting on screen for fifteen minutes reads as something stuck.
  const outer = `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', outer], { timeoutMs })
}
