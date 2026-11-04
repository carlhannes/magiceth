// Pure: which package manager a Linux machine has, and the one command that installs a list of
// packages with it unattended. Kept apart from setup.ts so the scripts can be tested without a
// machine to run them on.

import { shQuote } from '../privilege'

export type PackageManager = 'apt' | 'dnf' | 'pacman' | 'zypper'

/** The binary that gives a manager away, in the order they are tried. */
const MANAGERS: [string, PackageManager][] = [
  ['apt-get', 'apt'],
  ['dnf', 'dnf'],
  ['pacman', 'pacman'],
  ['zypper', 'zypper']
]

export function detectPackageManager(has: (name: string) => boolean): PackageManager | undefined {
  return MANAGERS.find(([binary]) => has(binary))?.[1]
}

/**
 * Install `packages` without asking anything. apt refreshes its lists only if the first attempt
 * fails (a fresh image has stale lists; a maintained one does not need the wait), and waits for the
 * dpkg lock, which unattended-upgrades holds for a while after first boot.
 */
export function installPackagesScript(pm: PackageManager, packages: string[]): string {
  const list = packages.map(shQuote).join(' ')
  switch (pm) {
    case 'apt': {
      const apt = 'apt-get -o DPkg::Lock::Timeout=120'
      return `export DEBIAN_FRONTEND=noninteractive; ${apt} install -y ${list} || { ${apt} update -qq && ${apt} install -y ${list}; }`
    }
    case 'dnf':
      return `dnf install -y ${list}`
    case 'pacman':
      return `pacman -S --noconfirm --needed ${list}`
    case 'zypper':
      return `zypper --non-interactive install ${list}`
  }
}
