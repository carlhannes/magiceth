// `npm run package` runs this on every OS. The helper itself is a macOS .app, built by the shell
// script next to this file; elsewhere there is nothing to build — and `sh` may not even exist under
// cmd.exe — so this wrapper is what lets the one npm script run everywhere.
import { spawnSync } from 'node:child_process'

if (process.platform !== 'darwin') {
  console.log('build-wifi-helper: macOS only, skipping.')
  process.exit(0)
}
const result = spawnSync('sh', ['scripts/build-wifi-helper.sh'], { stdio: 'inherit' })
process.exit(result.status ?? 1)
