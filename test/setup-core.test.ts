import { describe, it, expect } from 'vitest'
import { detectPackageManager, installPackagesScript } from '../src/main/capabilities/setup-core'

describe('detectPackageManager', () => {
  it('prefers apt, then dnf, pacman, zypper', () => {
    const having =
      (...names: string[]) =>
      (n: string): boolean =>
        names.includes(n)
    expect(detectPackageManager(having('apt-get', 'dnf'))).toBe('apt')
    expect(detectPackageManager(having('dnf', 'zypper'))).toBe('dnf')
    expect(detectPackageManager(having('pacman'))).toBe('pacman')
    expect(detectPackageManager(having('zypper'))).toBe('zypper')
    expect(detectPackageManager(having('brew'))).toBeUndefined()
  })
})

describe('installPackagesScript', () => {
  it('installs unattended with apt, refreshing the lists only when the first try fails', () => {
    const s = installPackagesScript('apt', ['tcpdump', 'iw'])
    expect(s.startsWith('export DEBIAN_FRONTEND=noninteractive; ')).toBe(true)
    expect(s).toContain("apt-get -o DPkg::Lock::Timeout=120 install -y 'tcpdump' 'iw' || {")
    expect(s).toContain('update -qq &&')
    expect(s.match(/install -y 'tcpdump' 'iw'/g)).toHaveLength(2)
  })

  it('never asks with the other managers either', () => {
    expect(installPackagesScript('dnf', ['curl'])).toBe("dnf install -y 'curl'")
    expect(installPackagesScript('pacman', ['curl'])).toBe("pacman -S --noconfirm --needed 'curl'")
    expect(installPackagesScript('zypper', ['curl'])).toBe(
      "zypper --non-interactive install 'curl'"
    )
  })

  it('quotes package names', () => {
    expect(installPackagesScript('dnf', ["a'b"])).toContain("'a'\\''b'")
  })
})
