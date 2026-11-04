import { describe, it, expect } from 'vitest'
import { scratchDirFor, scratchDirProblem } from '../src/main/util/scratch'

describe('scratchDirFor', () => {
  it('is one directory per user under the temp directory', () => {
    expect(scratchDirFor('/tmp', 1000)).toBe('/tmp/magiceth-1000')
    expect(scratchDirFor('/var/folders/x', 'hannes')).toBe('/var/folders/x/magiceth-hannes')
  })
})

// Root writes into this directory on the user's say-so, and /tmp is shared: a directory somebody
// else made at the predictable name must be refused, whatever it contains.
describe('scratchDirProblem', () => {
  const dir = (uid: number, mode: number, isDir = true) => ({ uid, mode, isDirectory: () => isDir })

  it('accepts our own private directory', () => {
    expect(scratchDirProblem(dir(1000, 0o40700), 1000)).toBeUndefined()
    expect(scratchDirProblem(dir(1000, 0o40755), 1000)).toBeUndefined()
  })

  it('refuses a symbolic link or file at the name', () => {
    expect(scratchDirProblem(dir(1000, 0o120777, false), 1000)).toBe('is not a directory')
  })

  it('refuses a directory another account made first', () => {
    expect(scratchDirProblem(dir(1001, 0o40700), 1000)).toBe('belongs to uid 1001, not 1000')
  })

  it('refuses a directory others can write into', () => {
    expect(scratchDirProblem(dir(1000, 0o40777), 1000)).toBe('is writable by others')
    expect(scratchDirProblem(dir(1000, 0o40720), 1000)).toBe('is writable by others')
  })
})
