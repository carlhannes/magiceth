// Where a command-line tool lives, without running it. The app leans on tools it does not ship —
// tcpdump, curl, iw, nmcli, pkexec — and "is it installed" comes up at start-up and before every
// feature that needs one. A PATH lookup answers in microseconds and tells a missing tool from a
// broken one, which `run(tool, ['--version'])` cannot: there ENOENT and exit 1 look the same.

import { accessSync, constants, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/**
 * Debian's login PATH leaves the sbin directories out for an ordinary user, and `iw` lives in
 * /usr/sbin — a desktop session there would report it missing while root (and sudo, whose
 * `secure_path` has them) finds it fine. Searched after PATH, on Linux only.
 */
export const LINUX_EXTRA_DIRS = ['/usr/sbin', '/sbin', '/usr/local/sbin']

const WIN_PATHEXT = '.EXE;.CMD;.BAT'

/** Pure: the first directory on `pathEnv` (then the Linux extras) holding an executable `name`. */
export function findExecutable(
  name: string,
  pathEnv: string | undefined,
  platform: NodeJS.Platform,
  canExec: (file: string) => boolean,
  pathext?: string
): string | undefined {
  const windows = platform === 'win32'
  const join = windows ? win32.join : posix.join
  const dirs = (pathEnv ?? '').split(windows ? ';' : ':').filter(Boolean)
  if (platform === 'linux') {
    for (const dir of LINUX_EXTRA_DIRS) if (!dirs.includes(dir)) dirs.push(dir)
  }
  const suffixes = windows ? ['', ...(pathext ?? WIN_PATHEXT).split(';').filter(Boolean)] : ['']
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const file = join(dir, name + suffix)
      if (canExec(file)) return file
    }
  }
  return undefined
}

function executableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * The real lookup. Not memoised: a tool can be installed while the app runs — the start screen
 * does exactly that — and the next check must see it.
 */
export function toolPath(name: string): string | undefined {
  return findExecutable(
    name,
    process.env.PATH,
    process.platform,
    executableFile,
    process.env.PATHEXT
  )
}
