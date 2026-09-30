// Pure view helpers shared by every mode.
//
// No state, no DOM, no imports: a string goes in and a string comes out. That is what lets the
// Ethernet dashboard and the WLAN scanner draw identical-looking rows without either one importing
// the other, and it keeps the only widely-used code in the renderer trivially reviewable.

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

/** The universal key/value line. `label` is a trusted literal; `value` is always escaped. */
export function row(label: string, value: string, cls = ''): string {
  return `<div class="row"><span class="dot ${cls}"></span><span class="label">${label}</span><span class="val">${escapeHtml(value)}</span></div>`
}

/** A row carrying a second, muted line under its value — the shape the lists already use. */
export function rowWithSub(label: string, value: string, sub: string, cls = ''): string {
  return `<div class="row"><span class="dot ${cls}"></span><span class="label">${label}</span><span class="val">${escapeHtml(value)}<br><span class="sub-line">${escapeHtml(sub)}</span></span></div>`
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function keyLabel(key: string): string {
  return key === 'Enter' ? 'Enter' : key.toUpperCase()
}

export function speedText(mbps?: number): string {
  if (!mbps) return '—'
  return mbps >= 1000 ? `${mbps / 1000} Gbit/s` : `${mbps} Mbit/s`
}
