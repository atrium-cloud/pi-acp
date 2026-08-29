// The MCP client that runs INSIDE Pi. Bundled self-contained by
// scripts/generate-mcp-extension.mjs and loaded with `-e`, so it may import only
// this package's MCP client and Node builtins: jiti resolves from the temp file
// that has no node_modules above it, and the release bundle ships without any.
// The Pi package is never imported; `pi` is typed by the local interface below.

import { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { Transport } from '@modelcontextprotocol/client'

import {
  ENV_MCP_SERVERS,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_OUTPUT_MAX_BYTES,
  MCP_OUTPUT_MAX_LINES,
  MCP_STDERR_TAIL_BYTES,
  MCP_TOOL_PREFIX,
  MCP_TOOL_SEPARATOR,
  MCP_VERSION_NEGOTIATION_MODE,
} from './mcpConstants.js'
import type { McpServerSpec } from './servers.js'

// ── CONSTANTS ─────────────────────────────────────────────────────────────────

const LOG_PREFIX = 'pi-acp mcp: '
const TOOL_LABEL_PREFIX = 'MCP: '
const TOOL_NAME_PART_SEPARATOR = '/'
const TOOL_NAME_DISALLOWED = /[^A-Za-z0-9_]/g
const CONTENT_SEPARATOR = '\n'
const EVENT_SESSION_SHUTDOWN = 'session_shutdown'
const STDIO_STDERR_MODE = 'pipe'
const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {} }
const SCHEMA_KEY_SCHEMA = '$schema'
const SCHEMA_KEY_ADDITIONAL_PROPERTIES = 'additionalProperties'
const UNWRAPPED_SCHEMA_TYPES = new Set(['object', 'array'])
const IMAGE_MIME_PREFIX = 'image/'
const DEFAULT_IMAGE_MIME = 'image/png'
const UNKNOWN_MIME = 'unknown'
const JSON_INDENT = 2
const TRUNCATION_NOTICE = `[truncated: MCP tool output is bounded to ${MCP_OUTPUT_MAX_BYTES} bytes and ${MCP_OUTPUT_MAX_LINES} lines]`
const BASE64_BYTES_PER_CHAR = 3 / 4
const TRAILING_REPLACEMENT_CHAR = new RegExp(`${String.fromCharCode(0xff_fd)}$`)

// ── Local types ───────────────────────────────────────────────────────────────

/** The slice of Pi's extension API this file uses. Declared locally so the
 * bundle never mentions the Pi package. */
interface PiExtensionApi {
  registerTool: (tool: unknown) => void
  on: (event: string, handler: (...args: never[]) => unknown) => unknown
}

/** Pi tool result content: text or image, nothing else. */
export type PiContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface PiToolResult {
  content: PiContent[]
  details: unknown
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
}

interface SetupOptions {
  signal?: AbortSignal
  timeout?: number
}

export interface McpConnection {
  readonly client: Client
  readonly stderrTail: () => string
}

// ── Tool naming ───────────────────────────────────────────────────────────────

/** Providers reject anything outside `[A-Za-z0-9_]` in a tool name, dots
 * included. */
export function sanitizeToolPart(part: string): string {
  return part.replace(TOOL_NAME_DISALLOWED, '_')
}

export function buildToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeToolPart(server)}${MCP_TOOL_SEPARATOR}${sanitizeToolPart(tool)}`
}

// ── Arguments ─────────────────────────────────────────────────────────────────

/** Pi's validator branches on the absence of the TypeBox brand and handles raw
 * JSON Schema, so the server's schema passes through. The root `$schema` and
 * `additionalProperties` are dropped: providers reject or ignore them. */
export function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return { ...EMPTY_OBJECT_SCHEMA }
  const normalized = { ...(schema as Record<string, unknown>) }
  delete normalized[SCHEMA_KEY_SCHEMA]
  delete normalized[SCHEMA_KEY_ADDITIONAL_PROPERTIES]
  return normalized
}

/** Models routinely emit a JSON string where the schema declares an object or
 * an array. One layer is unwrapped; anything else is left for Pi's validator to
 * report. */
export function unwrapJsonStringParams(schema: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
  const properties = schema['properties']
  if (typeof properties !== 'object' || properties === null) return params
  const declared = properties as Record<string, unknown>
  const unwrapped: Record<string, unknown> = { ...params }
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string') continue
    const property = declared[key]
    if (typeof property !== 'object' || property === null) continue
    const type = (property as Record<string, unknown>)['type']
    if (typeof type !== 'string' || !UNWRAPPED_SCHEMA_TYPES.has(type)) continue
    try {
      unwrapped[key] = JSON.parse(value)
    } catch {
      // Not JSON after all; the raw string is what the server was asked for.
    }
  }
  return unwrapped
}

// ── Results ───────────────────────────────────────────────────────────────────

/** Head-truncates to the byte and line bounds and names the truncation. Images
 * never reach here: base64 pixels are not text context, so counting them
 * against a text budget would throw the real output away. */
export function boundOutput(text: string): string {
  let head = text
  let truncated = false
  const lines = head.split(CONTENT_SEPARATOR)
  if (lines.length > MCP_OUTPUT_MAX_LINES) {
    head = lines.slice(0, MCP_OUTPUT_MAX_LINES).join(CONTENT_SEPARATOR)
    truncated = true
  }
  if (Buffer.byteLength(head, 'utf8') > MCP_OUTPUT_MAX_BYTES) {
    head = truncateToBytes(head, MCP_OUTPUT_MAX_BYTES)
    truncated = true
  }
  if (!truncated) return text
  return `${head}${CONTENT_SEPARATOR}${TRUNCATION_NOTICE}`
}

/** Flattens an MCP result onto Pi's text/image content, bounds the text, and
 * turns `isError` into the throw Pi's tool contract requires. */
export function mapCallToolResult(result: unknown, toolName: string): PiToolResult {
  const raw = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>
  const blocks = Array.isArray(raw['content']) ? (raw['content'] as unknown[]) : []
  const texts: string[] = []
  const images: PiContent[] = []
  for (const block of blocks) {
    const mapped = mapContentBlock(block)
    if (mapped.type === 'image') images.push(mapped)
    else texts.push(mapped.text)
  }
  const structured = raw['structuredContent']
  if (blocks.length === 0 && structured !== undefined) texts.push(JSON.stringify(structured, null, JSON_INDENT))

  const bounded = boundOutput(texts.join(CONTENT_SEPARATOR))
  if (raw['isError'] === true) throw new Error(bounded === '' ? `MCP tool ${toolName} failed` : bounded)

  const content: PiContent[] = []
  if (bounded !== '') content.push({ type: 'text', text: bounded })
  content.push(...images)
  return { content, details: result }
}

function mapContentBlock(block: unknown): PiContent {
  if (typeof block !== 'object' || block === null) return textContent(JSON.stringify(block))
  const fields = block as Record<string, unknown>
  switch (fields['type']) {
    case 'text':
      return textContent(asString(fields['text']))
    case 'image':
      return { type: 'image', data: asString(fields['data']), mimeType: asString(fields['mimeType'], DEFAULT_IMAGE_MIME) }
    case 'audio':
      return textContent(`[Audio content: ${asString(fields['mimeType'], UNKNOWN_MIME)}]`)
    case 'resource':
      return mapEmbeddedResource(fields)
    case 'resource_link':
      return textContent(`[Resource link: ${asString(fields['name'])}] uri: ${asString(fields['uri'])}`)
    default:
      return textContent(JSON.stringify(block))
  }
}

/** Pi has no resource content type, so an embedded resource is flattened: text
 * keeps a `uri:` header line, a blob survives only when it is an image. */
function mapEmbeddedResource(fields: Record<string, unknown>): PiContent {
  const resource = fields['resource']
  if (typeof resource !== 'object' || resource === null) return textContent(JSON.stringify(fields))
  const contents = resource as Record<string, unknown>
  const uri = asString(contents['uri'])
  const text = contents['text']
  if (typeof text === 'string') return textContent(`uri: ${uri}${CONTENT_SEPARATOR}${text}`)
  const blob = contents['blob']
  if (typeof blob === 'string') {
    const mimeType = asString(contents['mimeType'], UNKNOWN_MIME)
    if (mimeType.startsWith(IMAGE_MIME_PREFIX)) return { type: 'image', data: blob, mimeType }
    return textContent(`[Resource: ${uri}] ${mimeType}, ${base64ByteLength(blob)} bytes`)
  }
  return textContent(JSON.stringify(fields))
}

function textContent(text: string): PiContent {
  return { type: 'text', text }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(value.length * BASE64_BYTES_PER_CHAR) - padding)
}

function truncateToBytes(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.byteLength <= maxBytes) return value
  // Cutting mid-codepoint leaves a replacement char the decoder inserts.
  return new TextDecoder().decode(encoded.subarray(0, maxBytes)).replace(TRAILING_REPLACEMENT_CHAR, '')
}

// ── Connecting ────────────────────────────────────────────────────────────────

/** Connects one server. The transport is closed here on failure: no client owns
 * it yet, so an aborted connect would otherwise leak a running subprocess. */
export async function connectServer(spec: McpServerSpec, options?: SetupOptions): Promise<McpConnection> {
  const { transport, stderrTail } = createTransport(spec)
  const client = new Client(
    { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    { versionNegotiation: { mode: MCP_VERSION_NEGOTIATION_MODE } },
  )
  try {
    await client.connect(transport, options ?? setupBudget())
  } catch (error) {
    await closeQuietly(transport)
    throw withStderrTail(error, stderrTail())
  }
  return { client, stderrTail }
}

export async function listAllTools(client: Client, options?: SetupOptions): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor }, options ?? setupBudget())
    tools.push(...(page.tools as McpToolInfo[]))
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return tools
}

function createTransport(spec: McpServerSpec): { transport: Transport; stderrTail: () => string } {
  if (spec.kind === 'stdio') return createStdioTransport(spec)
  const requestInit: RequestInit = { headers: { ...spec.headers } }
  if (spec.kind === 'http') {
    return { transport: new StreamableHTTPClientTransport(new URL(spec.url), { requestInit }), stderrTail: noStderr }
  }
  // EventSourceInit has no headers field, so the stream request carries them
  // through a fetch wrapper; the POST leg uses requestInit as usual.
  const transport = new SSEClientTransport(new URL(spec.url), {
    requestInit,
    eventSourceInit: {
      fetch: (input: string | URL, init?: RequestInit) => fetch(input, { ...init, headers: { ...headersOf(init), ...spec.headers } }),
    },
  })
  return { transport, stderrTail: noStderr }
}

function createStdioTransport(spec: Extract<McpServerSpec, { kind: 'stdio' }>): { transport: Transport; stderrTail: () => string } {
  // The transport spawns with the SDK's own safe-list (HOME, LOGNAME, PATH,
  // SHELL, TERM, USER; Windows equivalents) under these entries, never the full
  // `process.env`: one server's secrets must not reach another's subprocess.
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...spec.env },
    cwd: process.cwd(),
    stderr: STDIO_STDERR_MODE,
  })

  // The only diagnostic for a server that fails to start, and an undrained pipe
  // fills and stalls the subprocess.
  let tail = Buffer.alloc(0)
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    tail = Buffer.concat([tail, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')])
    if (tail.byteLength > MCP_STDERR_TAIL_BYTES) tail = tail.subarray(tail.byteLength - MCP_STDERR_TAIL_BYTES)
  })
  return { transport, stderrTail: () => tail.toString('utf8').trim() }
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const headers = init?.headers
  if (headers === undefined) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  const record: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers as Record<string, string | undefined>)) {
    if (value !== undefined) record[key] = value
  }
  return record
}

function noStderr(): string {
  return ''
}

/** One deadline for connect plus `listTools`, so a server that answers the
 * handshake and then hangs is still bounded. Unref'd: a pending timer must not
 * keep the Pi subprocess alive after the client disconnects. */
function setupBudget(): SetupOptions {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`MCP server setup exceeded ${MCP_CONNECT_TIMEOUT_MS}ms`))
  }, MCP_CONNECT_TIMEOUT_MS)
  timer.unref()
  return { signal: controller.signal, timeout: MCP_CONNECT_TIMEOUT_MS }
}

function withStderrTail(error: unknown, tail: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(tail === '' ? message : `${message}${CONTENT_SEPARATOR}${tail}`)
}

async function closeQuietly(closable: { close: () => Promise<void> }): Promise<void> {
  try {
    await closable.close()
  } catch {
    // Teardown of an already-broken connection has nothing to report.
  }
}

// ── Extension ─────────────────────────────────────────────────────────────────

async function startServer(spec: McpServerSpec): Promise<{ connection: McpConnection; tools: McpToolInfo[] }> {
  const options = setupBudget()
  const connection = await connectServer(spec, options)
  try {
    return { connection, tools: await listAllTools(connection.client, options) }
  } catch (error) {
    await closeQuietly(connection.client)
    throw withStderrTail(error, connection.stderrTail())
  }
}

function registerServerTools(pi: PiExtensionApi, spec: McpServerSpec, connection: McpConnection, tools: McpToolInfo[], taken: Set<string>): void {
  for (const tool of tools) {
    const name = buildToolName(spec.name, tool.name)
    if (taken.has(name)) {
      warn(`skipping ${spec.name}${TOOL_NAME_PART_SEPARATOR}${tool.name}: the name ${name} is already registered`)
      continue
    }
    taken.add(name)
    const parameters = normalizeInputSchema(tool.inputSchema)
    pi.registerTool({
      name,
      label: `${TOOL_LABEL_PREFIX}${spec.name}${TOOL_NAME_PART_SEPARATOR}${tool.name}`,
      description: tool.description ?? '',
      parameters,
      // A cancelled turn leaves the connection up: only a failed setup or
      // session shutdown closes a client.
      execute: async (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => {
        const args = unwrapJsonStringParams(parameters, params ?? {})
        const result = await connection.client.callTool({ name: tool.name, arguments: args }, signal === undefined ? {} : { signal })
        return mapCallToolResult(result, name)
      },
    })
  }
}

function warn(message: string): void {
  process.stderr.write(`${LOG_PREFIX}${message}${CONTENT_SEPARATOR}`)
}

export default async function (pi: PiExtensionApi): Promise<void> {
  const payload = process.env[ENV_MCP_SERVERS]
  // Deleted before any tool or MCP subprocess can inherit it: the value carries
  // the client's headers and server environments.
  delete process.env[ENV_MCP_SERVERS]
  if (payload === undefined || payload === '') return

  const specs = JSON.parse(payload) as McpServerSpec[]
  if (specs.length === 0) return

  const started = await Promise.all(
    specs.map(async (spec) => {
      try {
        return await startServer(spec)
      } catch (error) {
        warn(`server ${spec.name} failed: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    }),
  )

  const connections: McpConnection[] = []
  const taken = new Set<string>()
  for (const [index, result] of started.entries()) {
    const spec = specs[index]
    if (result === null || spec === undefined) continue
    connections.push(result.connection)
    registerServerTools(pi, spec, result.connection, result.tools, taken)
  }

  pi.on(EVENT_SESSION_SHUTDOWN, async () => {
    await Promise.all(connections.map((connection) => closeQuietly(connection.client)))
  })
}
