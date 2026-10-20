import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GATE_DIR_PREFIX } from '../constants.js'

let processDir: string | undefined

/** Writes a pi-acp-owned extension into this process's temp directory and returns
 * its absolute path, for a Pi to load with `-e`. The directory is created once,
 * shared by every extension the process writes, and removed on process exit. */
export function materializeExtension(filename: string, source: string): string {
  const path = join(extensionDir(), filename)
  writeFileSync(path, source, 'utf8')
  return path
}

// Named by mkdtemp, never the pid: every sandboxed pi-acp is pid 1, so a probe
// exiting would remove the extensions of the adapter still running.
function extensionDir(): string {
  if (processDir !== undefined) return processDir
  const dir = mkdtempSync(join(tmpdir(), GATE_DIR_PREFIX))
  process.once('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort on exit; the OS reclaims the temp dir regardless.
    }
  })
  processDir = dir
  return dir
}
