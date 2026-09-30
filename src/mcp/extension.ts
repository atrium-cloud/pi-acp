import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ENV_MCP_SERVERS, GATE_DIR_PREFIX, MCP_EXTENSION_FILENAME } from '../constants.js'

// The MCP extension source, materialized to a temp file and loaded with `-e` by a
// session whose request carries servers. It only forwards the adapter's
// translated specs to Pi's built-in MCP support. Plain untyped JS so it never
// mentions the dev-only Pi package (the build purity guard greps `dist/index.js`).
export const MCP_EXTENSION_SOURCE = [
  `const ENV_MCP_SERVERS = ${JSON.stringify(ENV_MCP_SERVERS)}`,
  `export default function (pi) {`,
  `  const payload = process.env[ENV_MCP_SERVERS]`,
  // Before any registration: Pi's stdio transport spreads process.env into every
  // MCP server subprocess, and the payload carries every server's env and headers.
  `  delete process.env[ENV_MCP_SERVERS]`,
  `  if (!payload) return`,
  `  for (const { name, config } of JSON.parse(payload)) pi.registerMcpServer(name, config)`,
  `}`,
  '',
].join('\n')

/** Writes the MCP extension to the per-process temp file and returns its absolute
 * path; the directory is removed on process exit. Shares the gate's directory,
 * which may already exist by the time this runs. */
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
