import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Version (single source: package.json) is injected into the renderer so it can be shown in the UI.
const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } }
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
