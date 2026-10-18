import { ENV_MCP_SERVERS, MCP_EXTENSION_FILENAME } from '../constants.js'
import { materializeExtension } from '../pi/extensionFile.js'

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

export function materializeMcpExtension(): string {
  return materializeExtension(MCP_EXTENSION_FILENAME, MCP_EXTENSION_SOURCE)
}
