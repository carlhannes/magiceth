import { describe, it, expect } from 'vitest'
import { keyLabel, renderHints } from '../src/renderer/src/view'
import { pluginHints } from '../src/renderer/src/plugin-view'

describe('keyLabel', () => {
  it('names keys the way the legend shows them', () => {
    expect(keyLabel('Escape')).toBe('Esc')
    expect(keyLabel('ArrowUp')).toBe('↑')
    expect(keyLabel('ArrowDown')).toBe('↓')
    expect(keyLabel('ArrowLeft')).toBe('←')
    expect(keyLabel('ArrowRight')).toBe('→')
    expect(keyLabel(' ')).toBe('Space')
    expect(keyLabel('m')).toBe('M')
    expect(keyLabel('1')).toBe('1')
    expect(keyLabel('Enter')).toBe('Enter')
    expect(keyLabel('Tab')).toBe('Tab')
    expect(keyLabel('Backspace')).toBe('Backspace')
  })
})

describe('renderHints', () => {
  it('draws one key as one button holding the keycap and the label', () => {
    const html = renderHints([{ keys: ['m'], label: 'roll MAC' }])
    expect(html).toBe('<button type="button" class="key" data-press="m"><b>M</b>roll MAC</button>')
  })

  it('draws several keys as one button each, with the label after them', () => {
    const html = renderHints([{ keys: ['ArrowUp', 'ArrowDown'], label: 'select' }])
    expect(html.match(/<button /g)).toHaveLength(2)
    expect(html.startsWith('<span class="keys">')).toBe(true)
    expect(html).toContain('data-press="ArrowUp"><b>↑</b></button>')
    expect(html).toContain('data-press="ArrowDown"><b>↓</b></button>select</span>')
  })

  it('draws an entry without keys as plain text, with nothing to press', () => {
    const html = renderHints([{ keys: [], label: 'type to search' }])
    expect(html).toBe('<span class="keys">type to search</span>')
  })

  it('marks only the entry whose key is waiting for a confirming press', () => {
    const hints = [
      { keys: ['c'], label: 'survey' },
      { keys: ['t'], label: 'speed' },
      { keys: ['p', 'Escape'], label: 'close' }
    ]
    const html = renderHints(hints, 'c')
    expect(html.match(/confirm/g)).toHaveLength(1)
    expect(html).toContain('class="key confirm" data-press="c"')
    expect(renderHints(hints, 'Escape')).toContain('class="keys confirm"')
    expect(renderHints(hints)).not.toContain('confirm')
  })

  it('escapes labels and key values', () => {
    const html = renderHints([{ keys: ['<'], label: 'a <b> & c' }])
    expect(html).toContain('data-press="&lt;"')
    expect(html).toContain('a &lt;b&gt; &amp; c')
  })

  it('separates entries with a space', () => {
    const html = renderHints([
      { keys: ['r'], label: 'rerun' },
      { keys: ['Escape'], label: 'back' }
    ])
    expect(html).toContain('</button> <button')
  })
})

describe('pluginHints', () => {
  it('maps the display text shipped plugins use to the keys a press would send', () => {
    expect(pluginHints([{ key: '↑↓', label: 'pick' }])).toEqual([
      { keys: ['ArrowUp', 'ArrowDown'], label: 'pick' }
    ])
    expect(pluginHints([{ key: '←→', label: 'port' }])[0].keys).toEqual(['ArrowLeft', 'ArrowRight'])
    expect(pluginHints([{ key: 'Esc', label: 'x' }])[0].keys).toEqual(['Escape'])
    expect(pluginHints([{ key: 'Enter', label: 'x' }])[0].keys).toEqual(['Enter'])
    expect(pluginHints([{ key: 'Space', label: 'x' }])[0].keys).toEqual([' '])
    expect(pluginHints([{ key: 'N', label: 'name' }])[0].keys).toEqual(['n'])
    expect(pluginHints([{ key: 'd', label: 'delete' }])[0].keys).toEqual(['d'])
    expect(pluginHints([{ key: '1', label: 'one' }])[0].keys).toEqual(['1'])
  })

  it('leaves what is not a key as text', () => {
    expect(pluginHints([{ key: 'any', label: 'counts' }])[0].keys).toEqual([])
    expect(pluginHints([{ key: '1-9', label: 'apply' }])[0].keys).toEqual([])
    expect(pluginHints([{ key: '', label: 'nothing' }])[0].keys).toEqual([])
  })
})
