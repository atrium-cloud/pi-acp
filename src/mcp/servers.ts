import * as acp from '@agentclientprotocol/sdk'
import type { EnvVariable, HttpHeader, McpServer, McpServerHttp, McpServerStdio } from '@agentclientprotocol/sdk'

import {
  JSONRPC_INVALID_PARAMS,
  MCP_EXPOSURE,
  MCP_SERVER_NAME_PATTERN,
  PI_CONFIG_COMMAND_PREFIX,
  PI_CONFIG_DOLLAR,
  PI_CONFIG_ESCAPED_DOLLAR,
} from '../constants.js'

// ── Transport tags ────────────────────────────────────────────────────────────
//
// The ACP union leaves stdio untagged, so the tag is read structurally: an
// explicit `type: "stdio"` is legal on the wire even though the generated type
// does not model it.

const TRANSPORT_STDIO = 'stdio'
const TRANSPORT_HTTP = 'http'
const TRANSPORT_SSE = 'sse'
const TRANSPORT_ACP = 'acp'

// Pi refuses to register a url with any other scheme.
const HTTP_URL_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:'])

// Pi's `McpServerConfig`, narrowed to the fields the adapter sets. Pi picks its
// HTTP transport by the presence of a `url` key, so each shape carries only its own.
interface PiMcpStdioConfig {
  readonly type: typeof TRANSPORT_STDIO
  readonly command: string
  readonly args: string[]
  readonly env: Record<string, string>
  readonly exposure: typeof MCP_EXPOSURE
}

interface PiMcpHttpConfig {
  readonly type: typeof TRANSPORT_HTTP
  readonly url: string
  readonly headers: Record<string, string>
  readonly exposure: typeof MCP_EXPOSURE
}

/** One `pi.registerMcpServer(name, config)` call, as the extension receives it
 * over `PI_ACP_MCP_SERVERS`. */
export interface McpServerSpec {
  readonly name: string
  readonly config: PiMcpStdioConfig | PiMcpHttpConfig
}

/** Translates the ACP `mcpServers` list, rejecting everything Pi would refuse to
 * register. A server that later fails to connect is Pi's to report. */
export function translateMcpServers(servers: McpServer[] | undefined): McpServerSpec[] {
  if (servers === undefined) return []
  const specs: McpServerSpec[] = []
  const seen = new Set<string>()
  for (const server of servers) {
    if (!MCP_SERVER_NAME_PATTERN.test(server.name)) {
      throw invalidParams(`MCP server name "${server.name}" may contain only letters, digits, "_" and "-"`)
    }
    if (seen.has(server.name)) throw invalidParams(`mcpServers contains more than one server named "${server.name}"`)
    seen.add(server.name)
    specs.push({ name: server.name, config: translateConfig(server) })
  }
  return specs
}

function translateConfig(server: McpServer): PiMcpStdioConfig | PiMcpHttpConfig {
  const tag = transportTag(server)
  if (tag === TRANSPORT_STDIO) {
    const stdio = server as McpServerStdio
    return { type: TRANSPORT_STDIO, command: stdio.command, args: [...stdio.args], env: toEscapedRecord(stdio.env), exposure: MCP_EXPOSURE }
  }
  if (tag === TRANSPORT_HTTP) {
    const http = server as McpServerHttp
    return { type: TRANSPORT_HTTP, url: checkUrl(http.name, http.url), headers: toEscapedRecord(http.headers), exposure: MCP_EXPOSURE }
  }
  if (tag === TRANSPORT_SSE) {
    throw invalidParams(
      `MCP server "${server.name}" requests the legacy "${TRANSPORT_SSE}" transport, which Pi does not support; use the server's streamable HTTP url with the "${TRANSPORT_HTTP}" transport`,
    )
  }
  if (tag === TRANSPORT_ACP) {
    throw invalidParams(`MCP server "${server.name}" requests the "${TRANSPORT_ACP}" transport, which this agent does not support`)
  }
  throw invalidParams(`MCP server "${server.name}" requests an unknown transport "${tag}"`)
}

function transportTag(server: McpServer): string {
  const tag = (server as { type?: unknown }).type
  return typeof tag === 'string' ? tag : TRANSPORT_STDIO
}

/** Checks only: the client's string is passed through verbatim so Pi connects to
 * the URL the request named. */
function checkUrl(name: string, url: string): string {
  const parsed = URL.parse(url)
  if (parsed === null) throw invalidParams(`MCP server "${name}" has an unparseable url "${url}"`)
  if (!HTTP_URL_PROTOCOLS.has(parsed.protocol)) {
    throw invalidParams(`MCP server "${name}" has a url "${url}" that is not http or https`)
  }
  return url
}

function toEscapedRecord(entries: readonly (EnvVariable | HttpHeader)[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const entry of entries) record[entry.name] = escapePiConfigValue(entry.value)
  return record
}

// `$` is doubled first so the `$` guarding a leading `!` stays single. split/join
// because `$$` in a `replaceAll` replacement string means one `$`.
function escapePiConfigValue(value: string): string {
  const escaped = value.split(PI_CONFIG_DOLLAR).join(PI_CONFIG_ESCAPED_DOLLAR)
  return escaped.startsWith(PI_CONFIG_COMMAND_PREFIX) ? `${PI_CONFIG_DOLLAR}${escaped}` : escaped
}

// The SDK's RequestError statics bury the message in `data` behind a literal
// "Invalid params", so the code is passed explicitly (src/server/errors.ts).
function invalidParams(message: string): acp.RequestError {
  return new acp.RequestError(JSONRPC_INVALID_PARAMS, message)
}
