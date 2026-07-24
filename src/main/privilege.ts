import { run } from './util/run-command'
import type { RunResult } from './util/run-command'

// Run commands with elevated privileges via a clear OS prompt. Used by capture (M3)
// and later by reconfig (M4). Read-only diagnostics never need this.
//
// NOTE: the actual password prompt cannot be unit-tested — the pure parts
// (shQuote, command building) are tested, the rest is verified live (spike).

/** Safely sh-quote an argument (for shell commands that must go through a shell during elevation). */
export function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Escape a string to be embedded in an AppleScript string literal. */
export function appleScriptEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Run a complete shell command line with elevated privileges (GUI password prompt). */
export async function runElevatedShell(shellCmd: string, timeoutMs = 60000): Promise<RunResult> {
  if (process.platform === 'darwin') {
    const script = `do shell script "${appleScriptEscape(shellCmd)}" with administrator privileges`
    return run('osascript', ['-e', script], { timeoutMs })
  }
  if (process.platform === 'linux') {
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
  const outer = `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', outer], { timeoutMs })
}
