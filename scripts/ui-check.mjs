/* global document, setTimeout */
// Drives the built app through Playwright's Electron support and checks the Configure mode end
// to end — plugin chooser, the UniFi plugin's form, a user plugin, unload and reload. Keystrokes
// go to the page over the debugging protocol, never through the system keyboard, so running this
// while typing elsewhere is safe. See AGENTS.md.
//
//   npm run build && node scripts/ui-check.mjs
//
// Writes screenshots to the folder named by UI_CHECK_SHOTS (default: a temp folder).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const shots = process.env.UI_CHECK_SHOTS ?? mkdtempSync(join(tmpdir(), 'magiceth-ui-'))
mkdirSync(shots, { recursive: true })

const helloDir = join(homedir(), 'Documents', 'magiceth', 'plugins', 'hello')
const helloPlugin = (text) => `let presses = 0
module.exports = {
  activate(host) {
    host.log('hello activated on ' + host.device)
    return {
      render: () => ({
        status: 'saying hello',
        blocks: [
          { kind: 'text', text: ${JSON.stringify(text)} },
          { kind: 'table', rows: [['Port', host.device], ['Presses', String(presses)]] },
          { kind: 'log', title: 'Log', lines: host.lines() }
        ],
        keys: [{ key: 'any', label: 'counts' }]
      }),
      onKey(k) { presses++; host.log('key ' + k.key) },
      deactivate() { host.log('bye') }
    }
  }
}
`
mkdirSync(helloDir, { recursive: true })
writeFileSync(
  join(helloDir, 'package.json'),
  JSON.stringify({
    name: 'hello',
    version: '0.1.0',
    description: 'A user plugin that says hello.',
    author: 'ui-check',
    magiceth: { api: 1, title: 'Hello plugin' }
  })
)
writeFileSync(join(helloDir, 'index.js'), helloPlugin('Hello from a user plugin.'))

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['out/main/index.js']
})
const errors = []
app.process().stderr?.on('data', (d) => errors.push(String(d)))
const win = await app.firstWindow()
// Keyboard and screenshots go over the debugging protocol, so the window need not be in front —
// and must not be: a visible test window steals focus, and whatever is typed meanwhile lands in it.
await app.evaluate(({ app: electronApp }) => electronApp.hide())
win.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning')
    errors.push(`renderer ${m.type()}: ${m.text()}`)
})
win.on('pageerror', (e) => errors.push(`renderer exception: ${e.message}`))
await win.waitForSelector('.chooser')

let step = 0
const trace = []
const press = async (key) => {
  await win.keyboard.press(key)
  await new Promise((r) => setTimeout(r, 150))
  trace.push(
    `${key} → ${await win.evaluate(() => document.querySelector('.scroll')?.dataset.view)} / notice: ${await win.evaluate(() => document.querySelector('.notice')?.textContent ?? '')}`
  )
}
async function shot(name) {
  step++
  await win.screenshot({ path: join(shots, `${String(step).padStart(2, '0')}-${name}.png`) })
}
async function expectText(text) {
  await win.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout: 5000 })
}
// Section titles are upper-cased by CSS and innerText reflects that, so the chooser is
// recognised by a plugin's own name instead.
async function expectChooser() {
  await expectText('Hello plugin')
  await expectNoText('saying hello')
}
/** Walk the chooser's selection to the plugin with this title (the list wraps). */
async function selectPlugin(title) {
  for (let i = 0; i < 10; i++) {
    const selected = await win.evaluate(
      () => document.querySelector('.profile.sel .pn')?.firstChild?.textContent ?? ''
    )
    if (selected === title) return
    await press('ArrowDown')
  }
  throw new Error(`could not select "${title}"`)
}
async function expectNoText(text) {
  await win.waitForFunction((t) => !document.body.innerText.includes(t), text, { timeout: 5000 })
}

async function run() {
  await press('3')
  await expectText('UniFi adoption')
  await expectText('Hello plugin')
  await shot('chooser')

  await press('Enter')
  await expectText('No controller saved yet')
  await shot('unifi-empty')

  await press('n')
  await win.waitForSelector('#pf-0')
  await win.fill('#pf-0', 'Home office')
  await win.fill('#pf-1', 'ftp://nope')
  await press('Enter')
  await win.waitForFunction(() =>
    (document.getElementById('f-error')?.textContent ?? '').includes('http')
  )
  await shot('form-error')
  // The form was redrawn with the error; what was typed survived.
  if ((await win.inputValue('#pf-0')) !== 'Home office')
    throw new Error('form lost its values on error')

  await win.fill('#pf-1', 'unifi.example.com')
  await press('Enter')
  await expectText('Home office — http://unifi.example.com:8080/inform')
  await shot('unifi-saved')

  await press('e')
  await win.waitForSelector('#pf-1')
  if ((await win.inputValue('#pf-1')) !== 'http://unifi.example.com:8080/inform')
    throw new Error('edit form not prefilled')
  await press('Escape')
  await expectText('Home office — http://unifi.example.com:8080/inform')
  await expectNoText('Edit controller')

  await press('d')
  await expectText('Press D again to delete "Home office"')
  await press('d')
  await expectText('No controller saved yet')

  await press('Escape')
  await expectChooser()
  await selectPlugin('Hello plugin')
  await press('Enter')
  await expectText('Hello from a user plugin.')
  await press('x')
  await press('y')
  await expectText('Presses')
  await win.waitForFunction(() => /Presses\s+2/.test(document.body.innerText))
  await expectText('key y')
  await shot('hello-plugin')

  await press('Escape')
  await expectChooser()
  // Edit the user plugin on disk; the next open must show the new text without a restart.
  writeFileSync(join(helloDir, 'index.js'), helloPlugin('Hello again, reloaded.'))
  await selectPlugin('Hello plugin')
  await press('Enter')
  await expectText('Hello again, reloaded.')
  await shot('hello-reloaded')
  await press('Escape')
  await expectChooser()
  await press('Escape')
  await win.waitForSelector('.chooser')
  await shot('mode-chooser')
}

try {
  await run()
} catch (err) {
  await win.screenshot({ path: join(shots, 'FAILED.png') }).catch(() => undefined)
  const text = await win.evaluate(() => document.body.innerText).catch(() => '')
  console.error(
    `FAILED at step ${step + 1}: ${err.message}\n--- trace ---\n${trace.join('\n')}\n--- errors ---\n${errors.join('')}\n--- screen text ---\n${text}`
  )
  await app.close()
  process.exit(1)
}

await app.close()
if (errors.length) {
  console.log('stderr/console errors seen:\n' + errors.join(''))
}
console.log(`PASS — screenshots in ${shots}`)
