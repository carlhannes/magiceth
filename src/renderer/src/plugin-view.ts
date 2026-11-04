// Pure: a plugin's view blocks → HTML. No DOM, no state, so it can be unit-tested, and one
// renderer per block kind so every plugin looks like the rest of the app. Form blocks are not
// drawn here: the form takes over the screen and reads its fields back, which configure.ts does.

import type { Block, KeyHint } from '../../shared/plugin'
import { escapeHtml } from './view'
import type { Hint } from './view'

function title(text?: string): string {
  return text ? `<div class="section-title">${escapeHtml(text)}</div>` : ''
}

export function renderBlock(block: Block): string {
  switch (block.kind) {
    case 'text':
      return `<p class="${block.tone === 'warn' ? 'status-msg warn-text' : block.tone === 'muted' ? 'notes' : 'status-msg'}">${escapeHtml(block.text)}</p>`
    case 'table':
      return (
        title(block.title) +
        block.rows
          .map(
            ([label, value]) =>
              `<div class="row"><span class="dot"></span><span class="label">${escapeHtml(label)}</span><span class="val">${escapeHtml(value)}</span></div>`
          )
          .join('')
      )
    case 'list': {
      if (block.rows.length === 0) {
        return (
          title(block.title) +
          (block.empty ? `<p class="status-msg">${escapeHtml(block.empty)}</p>` : '')
        )
      }
      const items = block.rows
        .map(
          (text, i) =>
            `<li class="profile${i === block.selected ? ' sel' : ''}"><span class="pi">${i + 1}</span><span class="pn">${escapeHtml(text)}</span></li>`
        )
        .join('')
      return `${title(block.title)}<ul class="profiles">${items}</ul>`
    }
    case 'log':
      return `${title(block.title)}<pre class="log">${block.lines.map(escapeHtml).join('\n')}</pre>`
    case 'form':
      return ''
    case 'html':
      return block.html
    default:
      // A block kind this app does not know — from a plugin written for a newer app — draws nothing.
      return ''
  }
}

export function renderBlocks(blocks: Block[]): string {
  return blocks.map(renderBlock).join('')
}

// A plugin's legend names its keys as display text ('↑↓', 'Esc', 'N'), which is what the API has
// always taken. To make those entries tappable they are mapped back to the key values a press would
// carry; whatever does not map ('any', '1-9') stays as text. Letters go lower-case, because that is
// what an unshifted key sends and what every shipped plugin compares against (`'n' || 'N'`).
const GLYPH: Record<string, string> = {
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '←': 'ArrowLeft',
  '→': 'ArrowRight'
}
const WORD: Record<string, string> = {
  Esc: 'Escape',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Space: ' '
}

function keysFor(display: string): string[] {
  const glyphs = [...display].map((g) => GLYPH[g])
  if (glyphs.length > 0 && glyphs.every((k): k is string => k !== undefined)) return glyphs
  const word = WORD[display]
  if (word !== undefined) return [word]
  if (/^[a-z0-9]$/i.test(display)) return [display.toLowerCase()]
  return []
}

/** A plugin's legend as the shell's hints: the same entries, with the keys a tap should send. */
export function pluginHints(keys: KeyHint[]): Hint[] {
  return keys.map(({ key, label }) => ({ keys: keysFor(key), label }))
}
