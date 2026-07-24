import { execFile } from 'node:child_process'

// Shared helper for running OS commands. Uses execFile (arguments as an array,
// no shell) to avoid quoting/injection problems. Reused by all
// capability modules (DRY).

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  timeoutMs?: number
}

export function run(file: string, args: string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = 8000 } = opts
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((err as unknown as { code: number }).code ?? 0)
            : err
              ? 1
              : 0
        resolve({ code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' })
      }
    )
  })
}

/** Run a command and parse stdout as JSON. Throws if the output is not valid JSON. */
export async function runJson<T>(file: string, args: string[] = [], opts?: RunOptions): Promise<T> {
  const { stdout } = await run(file, args, opts)
  return JSON.parse(stdout) as T
}
