import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join, normalize, resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

// Version (single source: package.json) is injected into the renderer so it can be shown in the UI.
const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string

// Built-in Configure-mode plugins: each folder under src/plugins is bundled as its own main-process
// entry, and its package.json — the manifest the app reads before loading any code — is copied
// next to the bundle, so a built-in plugin and a user plugin in Documents have the same shape. The
// bundle is then checked to require nothing a user plugin could not.
const PLUGINS_DIR = 'src/plugins'
const pluginEntries = Object.fromEntries(
  readdirSync(PLUGINS_DIR)
    .filter((id) => existsSync(join(PLUGINS_DIR, id, 'package.json')))
    .map((id) => [`plugins/${id}/index`, resolve(PLUGINS_DIR, id, 'index.ts')])
)

/**
 * A built-in plugin may require only Node built-ins and files in its own folder — exactly what a
 * user plugin in Documents can do. Anything else (a shared chunk, a package, electron) would make
 * the built-in a different kind of plugin, so the build fails on it.
 */
function checkPluginBundle(id: string, outDir: string): void {
  for (const file of readdirSync(outDir).filter((f) => f.endsWith('.js'))) {
    const code = readFileSync(join(outDir, file), 'utf8')
    const literal = [...code.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g)].map((m) => m[2])
    const total = (code.match(/\brequire\(/g) ?? []).length
    const outside = literal.filter(
      (t) => !(isBuiltin(t) || (t.startsWith('./') && !normalize(t).startsWith('..')))
    )
    const problems = outside.map((t) => `require("${t}")`)
    if (total !== literal.length) problems.push('a non-literal require()')
    if (problems.length > 0) {
      throw new Error(
        `plugins/${id}/${file}: ${problems.join(', ')} — a built-in plugin may only require Node built-ins and files in its own folder, like a user plugin. Copy the helper into the plugin, or make the import \`import type\`.`
      )
    }
  }
}

function builtInPlugins(): Plugin {
  return {
    name: 'built-in-plugins',
    closeBundle() {
      for (const id of Object.keys(pluginEntries).map((k) => k.split('/')[1])) {
        const out = join('out/main/plugins', id)
        mkdirSync(out, { recursive: true })
        copyFileSync(join(PLUGINS_DIR, id, 'package.json'), join(out, 'package.json'))
        checkPluginBundle(id, out)
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), builtInPlugins()],
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
