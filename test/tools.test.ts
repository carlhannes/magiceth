import { describe, it, expect } from 'vitest'
import { LINUX_EXTRA_DIRS, findExecutable } from '../src/main/util/tools'

const only =
  (...files: string[]) =>
  (f: string): boolean =>
    files.includes(f)

describe('findExecutable', () => {
  it('takes the first directory on PATH that has it', () => {
    const found = findExecutable(
      'tcpdump',
      '/usr/local/bin:/usr/bin:/bin',
      'darwin',
      only('/usr/bin/tcpdump', '/bin/tcpdump')
    )
    expect(found).toBe('/usr/bin/tcpdump')
  })

  it('looks in the sbin directories after PATH on Linux, where Debian keeps iw', () => {
    expect(findExecutable('iw', '/usr/bin:/bin', 'linux', only('/usr/sbin/iw'))).toBe(
      '/usr/sbin/iw'
    )
    expect(findExecutable('iw', '/usr/bin:/bin', 'darwin', only('/usr/sbin/iw'))).toBeUndefined()
    expect(LINUX_EXTRA_DIRS).toContain('/usr/sbin')
  })

  it('tries PATHEXT on Windows', () => {
    expect(
      findExecutable(
        'curl',
        'C:\\Windows\\System32;C:\\Tools',
        'win32',
        only('C:\\Windows\\System32\\curl.EXE'),
        '.COM;.EXE'
      )
    ).toBe('C:\\Windows\\System32\\curl.EXE')
    expect(findExecutable('x', 'C:\\Tools', 'win32', only('C:\\Tools\\x.CMD'))).toBe(
      'C:\\Tools\\x.CMD'
    )
  })

  it('reports nothing for an empty PATH or a missing tool', () => {
    expect(findExecutable('curl', undefined, 'darwin', () => true)).toBeUndefined()
    expect(findExecutable('curl', '/usr/bin', 'darwin', () => false)).toBeUndefined()
  })
})
