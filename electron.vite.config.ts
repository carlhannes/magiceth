import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

// Version (single source: package.json) is injected into the renderer so it can be shown in the UI.
const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string

// Built-in Configure-mode plugins: each folder under src/plugins is bundled as its own main-process
// entry, and its package.json — the manifest the app reads before loading any code — is copied
// next to the bundle, so a built-in plugin and a user plugin in Documents have the same shape.
const PLUGINS_DIR = 'src/plugins'
const pluginEntries = Object.fromEntries(
  readdirSync(PLUGINS_DIR)
    .filter((id) => existsSync(join(PLUGINS_DIR, id, 'package.json')))
    .map((id) => [`plugins/${id}/index`, resolve(PLUGINS_DIR, id, 'index.ts')])
)

function copyPluginManifests(): Plugin {
  return {
    name: 'copy-plugin-manifests',
    closeBundle() {
      for (const id of Object.keys(pluginEntries).map((k) => k.split('/')[1])) {
        const out = join('out/main/plugins', id)
        mkdirSync(out, { recursive: true })
        copyFileSync(join(PLUGINS_DIR, id, 'package.json'), join(out, 'package.json'))
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyPluginManifests()],
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts'), ...pluginEntries } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } } }
  },
  renderer: {
    root: 'src/renderer',
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } }
  }
})
