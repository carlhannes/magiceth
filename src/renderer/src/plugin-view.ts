// Pure: a plugin's view blocks → HTML. No DOM, no state, so it can be unit-tested, and one
// renderer per block kind so every plugin looks like the rest of the app. Form blocks are not
// drawn here: the form takes over the screen and reads its fields back, which configure.ts does.

import type { Block } from '../../shared/plugin'
import { escapeHtml } from './view'

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
  }
}

export function renderBlocks(blocks: Block[]): string {
  return blocks.map(renderBlock).join('')
}
