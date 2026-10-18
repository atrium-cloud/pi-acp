import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GATE_DIR_PREFIX } from '../constants.js'

/** Writes a pi-acp-owned extension into the per-process temp directory and returns
 * its absolute path, for a session to load with `-e`; the directory is removed on
 * process exit. Every extension shares the directory, which may already exist. */
export function materializeExtension(filename: string, source: string): string {
  const dir = join(tmpdir(), `${GATE_DIR_PREFIX}${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, filename)
  writeFileSync(path, source, 'utf8')
  process.once('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort on exit; the OS reclaims the temp dir regardless.
    }
  })
  return path
}
