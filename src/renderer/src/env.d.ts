/// <reference types="vite/client" />
import type { MagicethApi } from '../../shared/types'

declare global {
  interface Window {
    api: MagicethApi
  }
  // Injiceras vid build via electron.vite.config.ts (define).
  const __APP_VERSION__: string
}
