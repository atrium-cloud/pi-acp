import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GATE_DIR_PREFIX, MCP_EXTENSION_FILENAME } from '../constants.js'

import { MCP_EXTENSION_SOURCE } from './extensionSource.generated.js'

/** Writes the bundled MCP extension to the per-process temp file and returns its
 * absolute path; the directory is removed on process exit. Shares the gate's
 * directory, which may already exist by the time this runs. `.mjs` so jiti loads
 * it as compiled JavaScript rather than transforming 400 KB as TypeScript. */
export function materializeMcpExtension(): string {
  const dir = join(tmpdir(), `${GATE_DIR_PREFIX}${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, MCP_EXTENSION_FILENAME)
  writeFileSync(path, MCP_EXTENSION_SOURCE, 'utf8')
  process.once('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort on exit; the OS reclaims the temp dir regardless.
    }
  })
  return path
}
