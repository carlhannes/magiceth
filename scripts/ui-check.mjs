/* global document, setTimeout, WebSocket, Buffer, KeyboardEvent */
// Drives the built app and checks Configure mode end to end — plugin chooser, the UniFi plugin's
// form, a user plugin, unload and reload — straight over Electron's own debugging endpoints, with
// nothing installed: the Chrome DevTools Protocol for the page (evaluate, screenshots) and the
// Node inspector for the main process (to hide the window). Keys are synthetic KeyboardEvents
// dispatched inside the page, never the system keyboard, so whoever is at the machine can keep
// typing. See AGENTS.md.
//
//   npm run build && node scripts/ui-check.mjs
//
// Writes screenshots to the folder named by UI_CHECK_SHOTS (default: a temp folder).
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const shots = process.env.UI_CHECK_SHOTS ?? mkdtempSync(join(tmpdir(), 'magiceth-ui-'))
mkdirSync(shots, { recursive: true })

// --- A user plugin to exercise, written where the app looks for them ---

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

// --- The smallest DevTools Protocol client that will do ---

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.next = 1
    this.pending = new Map()
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.data ?? ''})`))
        else resolve(msg.result)
      }
    })
  }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', reject)
    })
    return new Cdp(ws)
  }
  send(method, params = {}) {
    const id = this.next++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  close() {
    this.ws.close()
  }
}

/** Evaluate in a context; returns the value. Functions are stringified and called. */
async function evalIn(cdp, fn, ...args) {
  const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result.value
}

// --- Launch and attach ---

const child = spawn(
  require('electron'),
  ['--inspect=0', '--remote-debugging-port=0', 'out/main/index.js'],
  {
    stdio: ['ignore', 'pipe', 'pipe']
  }
)
const errors = []
let stderr = ''
child.stderr.on('data', (d) => {
  stderr += String(d)
})
child.stdout.on('data', (d) => {
  const text = String(d)
  if (/error|warn/i.test(text)) errors.push(`main stdout: ${text}`)
})

async function until(check, what, timeoutMs = 10000) {
  const started = Date.now()
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

const inspectorUrl = await until(
  () => stderr.match(/Debugger listening on (ws:\/\/\S+)/)?.[1],
  'the inspector'
)
const devtoolsPort = await until(
  () => stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1],
  'DevTools'
)
const pageUrl = await until(async () => {
  const targets = await fetch(`http://127.0.0.1:${devtoolsPort}/json`)
    .then((r) => r.json())
    .catch(() => [])
  return targets.find(
    (t) => t.type === 'page' && /magiceth|index\.html/.test(`${t.title} ${t.url}`)
  )?.webSocketDebuggerUrl
}, 'the app page')

const main = await Cdp.connect(inspectorUrl)
// Keystrokes and screenshots go over the protocol, so the window need not be in front — and must
// not be: a visible test window steals focus, and whatever is typed meanwhile lands in it.
// The inspector's global scope has no `require`; a Module.createRequire from the app folder goes
// through Electron's own loader, which is what resolves 'electron'.
const electronApp = (what) =>
  `process.getBuiltinModule('node:module').createRequire(process.cwd() + '/')('electron').app.${what}()`
await main.send('Runtime.evaluate', { expression: electronApp('hide') }).then((r) => {
  if (r.exceptionDetails)
    throw new Error(`could not hide the window: ${r.exceptionDetails.exception?.description}`)
})
const page = await Cdp.connect(pageUrl)
await page.send('Runtime.enable')
page.ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data)
  if (msg.method === 'Runtime.exceptionThrown')
    errors.push(`renderer exception: ${msg.params.exceptionDetails.exception?.description}`)
  if (
    msg.method === 'Runtime.consoleAPICalled' &&
    (msg.params.type === 'error' || msg.params.type === 'warning')
  ) {
    errors.push(
      `renderer ${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`
    )
  }
})

// --- The page-side helpers ---

const text = () => evalIn(page, () => document.body.innerText)
const view = () => evalIn(page, () => document.querySelector('.scroll')?.dataset.view ?? '')
let step = 0
const trace = []
async function shot(name) {
  step++
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(
    join(shots, `${String(step).padStart(2, '0')}-${name}.png`),
    Buffer.from(r.data, 'base64')
  )
}
/** What the keyboard would do: the app listens for keydown on the document and reads e.key. */
async function press(key) {
  await evalIn(
    page,
    (k) =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
      ),
    key
  )
  await new Promise((r) => setTimeout(r, 150))
  trace.push(
    `${key} → ${await view()} / notice: ${await evalIn(page, () => document.querySelector('.notice')?.textContent ?? '')}`
  )
}
async function fill(selector, value) {
  await evalIn(
    page,
    (s, v) => {
      const el = document.querySelector(s)
      el.value = v
      el.focus()
    },
    selector,
    value
  )
}
/** Enter inside a form field saves — the listener sits on the input, so it is dispatched there. */
async function submitForm() {
  await evalIn(page, () =>
    document
      .querySelector('input[data-key]')
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
  )
  await new Promise((r) => setTimeout(r, 150))
}
const inputValue = (selector) => evalIn(page, (s) => document.querySelector(s)?.value, selector)
const expectText = (t) => until(async () => (await text()).includes(t), `"${t}"`, 5000)
const expectNoText = (t) => until(async () => !(await text()).includes(t), `"${t}" to go`, 5000)
const expectSelector = (s) =>
  until(() => evalIn(page, (sel) => Boolean(document.querySelector(sel)), s), s, 5000)
// Section titles are upper-cased by CSS and innerText reflects that, so the chooser is recognised
// by a plugin's own name instead.
async function expectChooser() {
  await expectText('Hello plugin')
  await expectNoText('saying hello')
}
/** Walk the chooser's selection to the plugin with this title (the list wraps). */
async function selectPlugin(title) {
  for (let i = 0; i < 10; i++) {
    const selected = await evalIn(
      page,
      () => document.querySelector('.profile.sel .pn')?.firstChild?.textContent ?? ''
    )
    if (selected === title) return
    await press('ArrowDown')
  }
  throw new Error(`could not select "${title}"`)
}

// --- The walk ---

async function run() {
  await expectSelector('.chooser')
  await press('3')
  await expectText('UniFi adoption')
  await expectText('Hello plugin')
  await shot('chooser')

  await press('Enter')
  await expectText('No controller saved yet')
  await shot('unifi-empty')

  await press('n')
  await expectSelector('#pf-0')
  await fill('#pf-0', 'Home office')
  await fill('#pf-1', 'ftp://nope')
  await submitForm()
  await until(
    () =>
      evalIn(page, () => (document.getElementById('f-error')?.textContent ?? '').includes('http')),
    'the form error',
    5000
  )
  await shot('form-error')
  // The form was redrawn with the error; what was typed survived.
  if ((await inputValue('#pf-0')) !== 'Home office')
    throw new Error('form lost its values on error')

  await fill('#pf-1', 'unifi.example.com')
  await submitForm()
  await expectText('Home office — http://unifi.example.com:8080/inform')
  await shot('unifi-saved')

  await press('e')
  await expectSelector('#pf-1')
  if ((await inputValue('#pf-1')) !== 'http://unifi.example.com:8080/inform')
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
  await until(async () => /Presses\s+2/.test(await text()), 'two presses', 5000)
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
  await expectSelector('.chooser')
  await shot('mode-chooser')
}

let failed = false
try {
  await run()
} catch (err) {
  failed = true
  await shot('FAILED').catch(() => undefined)
  const screen = await text().catch(() => '')
  console.error(
    `FAILED at step ${step}: ${err.message}\n--- trace ---\n${trace.join('\n')}\n--- errors ---\n${errors.join('')}\n--- screen text ---\n${screen}`
  )
}

await main.send('Runtime.evaluate', { expression: electronApp('quit') }).catch(() => undefined)
page.close()
main.close()
await new Promise((r) => setTimeout(r, 500))
if (child.exitCode === null) child.kill()
if (failed) process.exit(1)
if (errors.length) console.log('errors seen:\n' + errors.join(''))
console.log(`PASS — screenshots in ${shots}`)
