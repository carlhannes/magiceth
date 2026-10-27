// Pure: what someone types as "the controller" → the inform URL the relay posts to.
// Tested in test/inform-url.test.ts.
//
// Accepts a bare hostname, a host with a port, or a full URL. The device-side URL is always
// `http://<something>:8080/inform`, so that is the shape a bare host becomes; a full URL is kept
// as written, because a hosted controller may front its inform endpoint differently.

export type InformUrlResult = { ok: true; url: string } | { ok: false; error: string }

export function normalizeInformUrl(raw: string): InformUrlResult {
  const text = raw.trim()
  if (!text) return { ok: false, error: 'The controller address is required.' }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, error: 'That is not a valid URL.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'The inform URL must start with http:// or https://.' }
  }
  if (!url.hostname) return { ok: false, error: 'The controller needs a hostname or address.' }
  if (url.username || url.password)
    return { ok: false, error: 'Credentials do not belong in the inform URL.' }
  if (url.search || url.hash)
    return { ok: false, error: 'The inform URL takes no query or fragment.' }
  if (url.pathname === '/' || url.pathname === '') {
    url.pathname = '/inform'
    if (!url.port && url.protocol === 'http:') url.port = '8080'
  }
  return { ok: true, url: url.toString() }
}
