import { describe, it, expect } from 'vitest'
import { normalizeInformUrl } from '../src/plugins/unifi-adopt/inform-url'

describe('normalizeInformUrl', () => {
  it('turns a bare hostname into the URL a device would build', () => {
    expect(normalizeInformUrl('unifi.example.com')).toEqual({
      ok: true,
      url: 'http://unifi.example.com:8080/inform'
    })
    expect(normalizeInformUrl('  203.0.113.5 ')).toEqual({
      ok: true,
      url: 'http://203.0.113.5:8080/inform'
    })
  })

  it('keeps a port that was given', () => {
    expect(normalizeInformUrl('unifi.example.com:8443')).toEqual({
      ok: true,
      url: 'http://unifi.example.com:8443/inform'
    })
  })

  it('keeps a full URL as written', () => {
    expect(normalizeInformUrl('http://unifi.example.com:8080/inform')).toEqual({
      ok: true,
      url: 'http://unifi.example.com:8080/inform'
    })
    expect(normalizeInformUrl('https://inform.example.com/inform')).toEqual({
      ok: true,
      url: 'https://inform.example.com/inform'
    })
    expect(normalizeInformUrl('https://example.com')).toEqual({
      ok: true,
      url: 'https://example.com/inform'
    })
  })

  it('refuses what cannot be an inform URL', () => {
    expect(normalizeInformUrl('')).toMatchObject({ ok: false })
    expect(normalizeInformUrl('ftp://x')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/http/)
    })
    expect(normalizeInformUrl('http://user:pw@x/inform')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Credentials/)
    })
    expect(normalizeInformUrl('http://x/inform?x=1')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/query/)
    })
    expect(normalizeInformUrl('http://')).toMatchObject({ ok: false })
  })
})
