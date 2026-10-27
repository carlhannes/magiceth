// Electron/fs glue: one JSON file per plugin in userData/plugins/. Same shape as profiles.ts —
// synchronous, no cache, the file is the truth. The id was validated by parseManifest, which is
// what makes building a path from it safe.

import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PluginHost } from '../../shared/plugin'

export function pluginStorage(id: string): PluginHost['storage'] {
  const file = join(app.getPath('userData'), 'plugins', `${id}.json`)
  return {
    load<T>(fallback: T): T {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as T
      } catch {
        return fallback
      }
    },
    save(value: unknown): void {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
    }
  }
}
