// The smallest useful magiceth plugin, and the one the repo's own checks run against.
//
// A plugin is a folder with a package.json (the manifest the app reads before loading anything)
// and this file: a CommonJS module exporting activate(host). It runs in the app's main process as
// plain Node — no DOM, no window — and describes its screen as blocks. The app draws them, sends
// every key here, and adds Esc to leave. docs/PLUGINS.md is the reference; copy this folder into
// Documents/magiceth/plugins to start your own.

const FRUIT = ['apple', 'banana', 'cherry']

module.exports = {
  activate(host) {
    // What the plugin remembers between runs goes through host.storage: one JSON file per plugin.
    const saved = host.storage.load({ opens: 0, name: '' })
    saved.opens += 1
    host.storage.save(saved)

    let presses = 0
    // A list's selection is the plugin's to move: the app only highlights the row it is told to.
    let picked = 0
    // While this is set the form block is rendered and takes over the screen.
    let form = null

    host.log('hello activated on ' + host.device)

    return {
      // Called after activate(), after every key, and whenever host.log() or host.update() runs.
      render() {
        const blocks = [
          { kind: 'text', text: 'Hello from a user plugin.' },
          {
            kind: 'table',
            rows: [
              ['Port', host.device],
              ['Presses', String(presses)],
              ['Opened', `${saved.opens} time${saved.opens === 1 ? '' : 's'}`],
              ['Name', saved.name || '—']
            ]
          },
          { kind: 'list', title: 'Pick a fruit', rows: FRUIT, selected: picked },
          { kind: 'log', title: 'Log', lines: host.lines() }
        ]
        if (form) {
          // Leaving the form block out of the next render is what closes it.
          blocks.push({
            kind: 'form',
            id: 'name',
            title: 'Your name',
            fields: [{ key: 'name', label: 'Name', value: saved.name, hint: 'anything but empty' }],
            error: form.error
          })
        }
        return {
          status: 'saying hello',
          blocks,
          keys: [
            { key: '↑↓', label: 'pick' },
            { key: 'N', label: 'name' },
            { key: 'any', label: 'counts' }
          ]
        }
      },

      // key.key is the DOM KeyboardEvent.key: 'ArrowDown', 'Enter', 'n', 'Escape', …
      onKey(key) {
        if (form) {
          // While the form is open the fields own the keyboard; only Esc (or Cancel) arrives here.
          if (key.key === 'Escape') form = null
          return
        }
        if (key.key === 'ArrowDown') picked = (picked + 1) % FRUIT.length
        else if (key.key === 'ArrowUp') picked = (picked - 1 + FRUIT.length) % FRUIT.length
        else if (key.key === 'n' || key.key === 'N') form = {}
        else {
          presses += 1
          host.log('key ' + key.key)
        }
      },

      // Enter in a field, or the Save button. A changed `error` redraws the form; nothing else does.
      onSubmit(formId, values) {
        const name = (values.name ?? '').trim()
        if (!name) {
          form = { error: 'A name, please.' }
          return
        }
        saved.name = name
        host.storage.save(saved)
        form = null
        host.log('named ' + name)
      },

      // Close every socket and timer you opened. This plugin has none.
      deactivate() {
        host.log('bye')
      }
    }
  }
}
