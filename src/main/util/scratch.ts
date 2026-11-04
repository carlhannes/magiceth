// A per-user scratch directory under the system temp directory, for the files the elevated scripts
// write. Bare /tmp is sticky and world-writable, and on a Linux with `fs.protected_regular` (every
// systemd distribution; Ubuntu sets it to 2) root is refused an O_CREAT open of a file there that
// belongs to someone else — so `tcpdump … >> file` as root into a file the app had created fails
// with EACCES, silently, and the survey sits at zero frames. A directory the user owns has no such
// rule: root creates its files inside it, and the user, owning the directory, reads and deletes them.

import { lstatSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Pure: where the scratch files go. */
export function scratchDirFor(tmpdir: string, owner: string | number): string {
  return path.join(tmpdir, `magiceth-${owner}`)
}

/**
 * Pure: why a directory root is about to write into must not be used, or nothing. The name is
 * predictable and /tmp is shared, so another local account could have made it first and pointed
 * root at files of its choosing; a directory that is ours, a real directory, and writable by nobody
 * else cannot have been.
 */
export function scratchDirProblem(
  st: { uid: number; mode: number; isDirectory(): boolean },
  uid: number
): string | undefined {
  if (!st.isDirectory()) return 'is not a directory'
  if (st.uid !== uid) return `belongs to uid ${st.uid}, not ${uid}`
  if ((st.mode & 0o022) !== 0) return 'is writable by others'
  return undefined
}

/** `name` inside the scratch directory, which is created if needed — 0700, nobody else's business. */
export function scratchFile(name: string): string {
  const uid = process.getuid?.()
  const dir = scratchDirFor(os.tmpdir(), uid ?? os.userInfo().username)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (uid !== undefined) {
    // lstat, so a symbolic link planted at the name fails the directory check.
    const problem = scratchDirProblem(lstatSync(dir), uid)
    if (problem) throw new Error(`Scratch directory ${dir} ${problem} — remove it and try again.`)
  }
  return path.join(dir, name)
}
