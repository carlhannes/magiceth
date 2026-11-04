import { describe, it, expect } from 'vitest'
import {
  LINUX_HELPER,
  LINUX_HELPER_SCRIPT,
  elevationRefused,
  linuxAdminRule,
  linuxAdminSetupScript,
  linuxSudoersFile
} from '../src/main/privilege'

describe('linuxAdminRule', () => {
  it('names one user, one helper, no password', () => {
    expect(linuxAdminRule('hannes')).toBe(
      'hannes ALL=(root) NOPASSWD: /usr/local/libexec/magiceth-elevate'
    )
    expect(linuxSudoersFile('hannes')).toBe('/etc/sudoers.d/magiceth-hannes')
  })
})

describe('linuxAdminSetupScript', () => {
  const script = linuxAdminSetupScript('hannes')

  it('writes the helper root-owned and executable, then the rule read-only', () => {
    expect(script).toContain(`> '${LINUX_HELPER}'`)
    expect(script).toContain(`chown root:root '${LINUX_HELPER}'`)
    expect(script).toContain(`chmod 0755 '${LINUX_HELPER}'`)
    expect(script).toContain('chmod 0440 "$t"')
    expect(script).toContain('chown root:root "$t"')
    for (const line of LINUX_HELPER_SCRIPT.split('\n')) expect(script).toContain(`'${line}'`)
  })

  it('checks the rule with visudo before moving it into place, from a name sudo ignores', () => {
    expect(script).toContain('t=$(mktemp /etc/sudoers.d/.magiceth.XXXXXX)')
    expect(script.indexOf('visudo -cf "$t"')).toBeLessThan(
      script.indexOf(`mv -f "$t" '/etc/sudoers.d/magiceth-hannes'`)
    )
    expect(script.startsWith('set -e; umask 022;')).toBe(true)
    expect(script).toContain(`trap 'rm -f "$t"' EXIT`)
  })

  it('refuses a name that is not a plain unix username', () => {
    for (const bad of ['Bad.Name', '-x', 'a b', '', 'root;rm', 'ÅSA']) {
      expect(() => linuxAdminSetupScript(bad)).toThrow()
    }
    expect(() => linuxAdminSetupScript('tech-01')).not.toThrow()
    expect(() => linuxAdminSetupScript('_svc')).not.toThrow()
  })
})

describe('elevationRefused', () => {
  const r = (code: number, stderr = ''): { code: number; stdout: string; stderr: string } => ({
    code,
    stdout: '',
    stderr
  })

  it('recognises every OS saying no', () => {
    expect(elevationRefused(r(126))).toBe(true) // pkexec: dialog dismissed
    expect(elevationRefused(r(127))).toBe(true) // pkexec: not authorised
    expect(elevationRefused(r(1, 'execution error: User canceled. (-128)'))).toBe(true)
    expect(elevationRefused(r(1, 'Error executing command as another user: Not authorized'))).toBe(
      true
    )
    expect(elevationRefused(r(1, 'The operation was canceled by the user.'))).toBe(true)
    expect(elevationRefused(r(1, 'sudo: a password is required'))).toBe(true)
  })

  it('leaves a script that merely failed alone', () => {
    expect(elevationRefused(r(0))).toBe(false)
    expect(elevationRefused(r(1))).toBe(false)
    expect(elevationRefused(r(2, 'ip: RTNETLINK answers: Operation not supported'))).toBe(false)
  })
})
