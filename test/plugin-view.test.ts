import { describe, it, expect } from 'vitest'
import { renderBlock, renderBlocks } from '../src/renderer/src/plugin-view'

describe('renderBlock', () => {
  it('escapes text in every kind that shows text', () => {
    expect(renderBlock({ kind: 'text', text: '<b>' })).toContain('&lt;b&gt;')
    expect(renderBlock({ kind: 'table', rows: [['<l>', '<v>']] })).not.toContain('<l>')
    expect(renderBlock({ kind: 'list', rows: ['<r>'] })).toContain('&lt;r&gt;')
    expect(renderBlock({ kind: 'log', lines: ['<x>'] })).toContain('&lt;x&gt;')
  })

  it('marks the selected row with the class the shell scrolls to', () => {
    const html = renderBlock({ kind: 'list', rows: ['a', 'b'], selected: 1 })
    expect(html.match(/class="profile sel"/g)).toHaveLength(1)
    expect(html).toContain('<span class="pi">2</span><span class="pn">b</span>')
  })

  it('shows the empty text instead of an empty list', () => {
    const html = renderBlock({ kind: 'list', title: 'T', rows: [], empty: 'nothing' })
    expect(html).toContain('nothing')
    expect(html).not.toContain('<ul')
    expect(html).toContain('T')
  })

  it('passes html through and draws no form', () => {
    expect(renderBlock({ kind: 'html', html: '<em>x</em>' })).toBe('<em>x</em>')
    expect(renderBlock({ kind: 'form', id: 'f', title: 't', fields: [] })).toBe('')
  })

  it('tones text', () => {
    expect(renderBlock({ kind: 'text', text: 'x', tone: 'warn' })).toContain('warn-text')
    expect(renderBlock({ kind: 'text', text: 'x', tone: 'muted' })).toContain('class="notes"')
  })
})

describe('renderBlocks', () => {
  it('concatenates in order', () => {
    const html = renderBlocks([
      { kind: 'text', text: 'first' },
      { kind: 'log', title: 'Log', lines: ['second'] }
    ])
    expect(html.indexOf('first')).toBeLessThan(html.indexOf('second'))
  })
})
