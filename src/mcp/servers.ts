import * as acp from '@agentclientprotocol/sdk'
import type { EnvVariable, HttpHeader, McpServer, McpServerHttp, McpServerSse, McpServerStdio } from '@agentclientprotocol/sdk'

import { JSONRPC_INVALID_PARAMS } from '../constants.js'

// ── Transport tags ────────────────────────────────────────────────────────────
//
// The ACP union leaves stdio untagged, so the tag is read structurally: an
// explicit `type: "stdio"` is legal on the wire even though the generated type
// does not model it.

const TRANSPORT_STDIO = 'stdio'
const TRANSPORT_HTTP = 'http'
const TRANSPORT_SSE = 'sse'
const TRANSPORT_ACP = 'acp'

/** What the extension receives over `PI_ACP_MCP_SERVERS`: the ACP request's
 * server list flattened to transport configs, with the `{name, value}` arrays
 * already turned into records. */
export type McpServerSpec =
  | { readonly kind: typeof TRANSPORT_STDIO; readonly name: string; readonly command: string; readonly args: string[]; readonly env: Record<string, string> }
  | { readonly kind: typeof TRANSPORT_HTTP; readonly name: string; readonly url: string; readonly headers: Record<string, string> }
  | { readonly kind: typeof TRANSPORT_SSE; readonly name: string; readonly url: string; readonly headers: Record<string, string> }

/** Translates the ACP `mcpServers` list, rejecting only what cannot be served.
 * A structurally valid list never fails here; a server that later fails to
 * connect is the extension's problem, not this function's. */
export function translateMcpServers(servers: McpServer[] | undefined): McpServerSpec[] {
  if (servers === undefined) return []
  const specs: McpServerSpec[] = []
  const seen = new Set<string>()
  for (const server of servers) {
    if (seen.has(server.name)) throw invalidParams(`mcpServers contains more than one server named "${server.name}"`)
    seen.add(server.name)
    specs.push(translateServer(server))
  }
  return specs
}

function translateServer(server: McpServer): McpServerSpec {
  const tag = transportTag(server)
  if (tag === TRANSPORT_STDIO) {
    const stdio = server as McpServerStdio
    return { kind: TRANSPORT_STDIO, name: stdio.name, command: stdio.command, args: [...stdio.args], env: toRecord(stdio.env) }
  }
  if (tag === TRANSPORT_HTTP || tag === TRANSPORT_SSE) {
    const http = server as McpServerHttp | McpServerSse
    return { kind: tag, name: http.name, url: parseUrl(http.name, http.url), headers: toRecord(http.headers) }
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

/** Parse check only: the client's string is passed through verbatim so the
 * extension builds the same URL the request named. */
function parseUrl(name: string, url: string): string {
  try {
    void new URL(url)
  } catch {
    throw invalidParams(`MCP server "${name}" has an unparseable url "${url}"`)
  }
  return url
}

function toRecord(entries: readonly (EnvVariable | HttpHeader)[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const entry of entries) record[entry.name] = entry.value
  return record
}

// The SDK's RequestError statics bury the message in `data` behind a literal
// "Invalid params", so the code is passed explicitly (src/server/errors.ts).
function invalidParams(message: string): acp.RequestError {
  return new acp.RequestError(JSONRPC_INVALID_PARAMS, message)
}
