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

/**
 * One entry of a key legend: the keys that do it, as real `KeyboardEvent.key` values, and what it
 * does. Every key is drawn as a button, so a legend entry is also the touch control for that key —
 * which is why the keys must be the ones the handlers compare against (lower-case letters,
 * `Escape`, `ArrowDown`…) and never display text. An entry with no keys is plain text.
 */
export interface Hint {
  keys: string[]
  label: string
}

const KEY_NAMES: Record<string, string> = {
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ' ': 'Space'
}

/** The keycap text for a key value: `Esc`, `↑`, `M`; `Enter`, `Tab` and `Backspace` as they are. */
export function keyLabel(key: string): string {
  return KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key)
}

/**
 * A legend as buttons. One key: the keycap and the label share a button, so the whole entry is the
 * target. Several keys (`↑↓`, `1`/`E`): one button per key with the label after them. The entry
 * whose key is waiting for a confirming second press is marked, so the question in the notice bar
 * and the button that answers it look alike. main.ts turns a click on `data-press` into that key.
 */
export function renderHints(hints: Hint[], pendingKey?: string): string {
  return hints
    .map((h) => {
      const confirm = pendingKey !== undefined && h.keys.includes(pendingKey) ? ' confirm' : ''
      const label = escapeHtml(h.label)
      if (h.keys.length === 0) return `<span class="keys">${label}</span>`
      const cap = (k: string): string => `<b>${escapeHtml(keyLabel(k))}</b>`
      const press = (k: string): string => `data-press="${escapeHtml(k)}"`
      if (h.keys.length === 1) {
        const k = h.keys[0]
        return `<button type="button" class="key${confirm}" ${press(k)}>${cap(k)}${label}</button>`
      }
      const buttons = h.keys
        .map((k) => `<button type="button" class="key" ${press(k)}>${cap(k)}</button>`)
        .join('')
      return `<span class="keys${confirm}">${buttons}${label}</span>`
    })
    .join(' ')
}

export function speedText(mbps?: number): string {
  if (!mbps) return '—'
  return mbps >= 1000 ? `${mbps / 1000} Gbit/s` : `${mbps} Mbit/s`
}
