import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext, AvailableCommand, McpServer } from '@agentclientprotocol/sdk'
import { parse as parseYaml } from 'yaml'

import {
  AGENT_NAME,
  BUILTIN_COMMANDS,
  CARRIAGE_RETURN_LINE_BREAK,
  COMMAND_SOURCE_PROMPT,
  ENV_MCP_SERVERS,
  FRONTMATTER_DELIMITER,
  FRONTMATTER_KEY_ARGUMENT_HINT,
  FRONTMATTER_YAML_OPTIONS,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  LINE_FEED,
  PI_SESSION_ARG,
} from '../constants.js'
import type { McpServerSpec } from '../mcp/servers.js'
import { translateMcpServers } from '../mcp/servers.js'
import type { PiLaunch } from '../pi/errors.js'
import { PiRpcClient } from '../pi/PiRpcClient.js'
import { asMessage } from '../server/errors.js'
import type { ModelChoice } from '../turn/configOptions.js'
import { type CreatePiClient, SessionConnection } from './SessionConnection.js'
import { stripBom } from './sessionDirectory.js'

const defaultCreatePiClient: CreatePiClient = (options) => new PiRpcClient(options)

export interface SessionSetupDeps {
  readonly launch: PiLaunch
  readonly rpcTimeoutMs: number
  readonly notifier: AgentContext
  /** Whether the client advertised `session.notices` on initialize. */
  readonly clientSupportsNotices: boolean
  /** Absolute path to the materialized permission gate, loaded with `-e`. Absent
   * in tests (the fake client ignores args), so no temp file is written. */
  readonly gateExtensionPath?: string | undefined
  /** Absolute path to the materialized MCP extension, loaded with a second `-e`
   * only by a session whose request carries servers. */
  readonly mcpExtensionPath: string
  /** Command names left out of the advertised commands. */
  readonly hiddenCommands: ReadonlySet<string>
  /** Injectable for tests; defaults to spawning a real Pi RPC subprocess. */
  readonly createPiClient?: CreatePiClient | undefined
}

export interface EstablishedSession {
  readonly connection: SessionConnection
  readonly sessionId: string
  readonly configOptions: acp.SessionConfigOption[]
  readonly availableCommands: AvailableCommand[]
}

/** `new` starts an empty session; `open` reopens a stored one from its file. Pi's
 * RPC mode has no id resolution, so `sessionFile` is always an absolute path. */
export type SessionSetupMode =
  | { readonly kind: 'new' }
  | { readonly kind: 'open'; readonly sessionFile: string; readonly expectedSessionId: string }

/** The shape shared by `session/new`, `session/resume` and `session/load`;
 * structural so all three SDK request types satisfy it. */
export interface SessionSetupRequest {
  readonly cwd: string
  readonly mcpServers?: McpServer[] | undefined
  readonly additionalDirectories?: readonly string[] | undefined
}

export async function establishSession(
  request: SessionSetupRequest,
  deps: SessionSetupDeps,
  mode: SessionSetupMode = { kind: 'new' },
): Promise<EstablishedSession> {
  const mcpServers = validateSessionRequest(request)

  const connection = new SessionConnection({
    notifier: deps.notifier,
    cwd: request.cwd,
    clientSupportsNotices: deps.clientSupportsNotices,
  })
  const createPiClient = deps.createPiClient ?? defaultCreatePiClient
  // The gate loads alongside the user's own extensions (no --no-extensions).
  const args = deps.gateExtensionPath !== undefined ? ['-e', deps.gateExtensionPath] : []
  // Only a session that asked for servers loads the MCP extension; it reads the
  // list from the environment and deletes it before anything can inherit it.
  if (mcpServers.length > 0) args.push('-e', deps.mcpExtensionPath)
  if (mode.kind === 'open') args.push(PI_SESSION_ARG, mode.sessionFile)
  const piClient = createPiClient({
    launch: deps.launch,
    cwd: request.cwd,
    args,
    ...(mcpServers.length > 0 ? { env: { [ENV_MCP_SERVERS]: JSON.stringify(mcpServers) } } : {}),
    timeoutMs: deps.rpcTimeoutMs,
    onEvent: (event) => {
      connection.routeEvent(event)
    },
    onExit: (error) => {
      connection.handleExit(error)
    },
    onExtensionUiRequest: (uiRequest) => connection.handleExtensionUiRequest(uiRequest),
    onNotify: (notifyRequest) => {
      connection.handleNotify(notifyRequest)
    },
  })

  // start() self-cleans a failure inside itself; a failure in the follow-up
  // fetches would otherwise leave a live subprocess nobody holds.
  const state = await piClient.start()
  if (mode.kind === 'open' && state.sessionId !== mode.expectedSessionId) {
    // Pi opened something other than the requested session (a stale path, or an
    // id the file no longer carries): nothing downstream can be trusted.
    await piClient.stop()
    throw new acp.RequestError(
      JSONRPC_INTERNAL_ERROR,
      `Pi opened session "${state.sessionId}" from ${mode.sessionFile}, expected "${mode.expectedSessionId}"`,
    )
  }
  try {
    const [models, levels, commands] = await Promise.all([
      piClient.request({ type: 'get_available_models' }),
      piClient.request({ type: 'get_available_thinking_levels' }),
      piClient.request({ type: 'get_commands' }),
    ])
    const modelChoices: ModelChoice[] = models.data.models.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
    }))
    const availableCommands = await mapCommands(commands.data.commands, deps.hiddenCommands)
    connection.attach({
      piClient,
      sessionId: state.sessionId,
      state,
      models: modelChoices,
      levels: levels.data.levels,
    })
    return {
      connection,
      sessionId: state.sessionId,
      configOptions: connection.configOptions,
      availableCommands,
    }
  } catch (error) {
    await piClient.stop()
    throw error
  }
}

/** Shared by `session/new`, `session/resume`, `session/load` and `session/fork`;
 * the store-reading methods run it before touching the store so a bad request
 * never reads the filesystem. Returns the request's MCP servers translated for
 * the extension; an absent list means none. */
export function validateSessionRequest(request: SessionSetupRequest): McpServerSpec[] {
  if (!isAbsolute(request.cwd)) throw invalidParams(`cwd must be an absolute path, got "${request.cwd}"`)
  if (request.additionalDirectories !== undefined && request.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories are not supported')
  }
  return translateMcpServers(request.mcpServers)
}

interface PiCommand {
  readonly name: string
  readonly description?: string | undefined
  readonly source: string
  readonly sourceInfo: { readonly path: string }
}

// A command named like a built-in is dropped, before any template is read: the
// built-in runs in its place on submit, so advertising both would offer one name twice.
// A hidden command, built-in or Pi's, is dropped the same way; a client that
// sends one anyway still runs it.
async function mapCommands(commands: readonly PiCommand[], hidden: ReadonlySet<string>): Promise<AvailableCommand[]> {
  const builtinNames = new Set(BUILTIN_COMMANDS.map((command) => command.name))
  const mapped = await Promise.all(
    commands.filter((command) => !builtinNames.has(command.name) && !hidden.has(command.name)).map(mapCommand),
  )
  return [...BUILTIN_COMMANDS.filter((command) => !hidden.has(command.name)), ...mapped]
}

async function mapCommand(command: PiCommand): Promise<AvailableCommand> {
  const hint = command.source === COMMAND_SOURCE_PROMPT ? await readArgumentHint(command.sourceInfo.path) : undefined
  return { name: command.name, description: command.description ?? '', ...(hint === undefined ? {} : { input: { hint } }) }
}

// Pi's `get_commands` drops a template's `argument-hint`, so it is re-read from
// the file Pi loaded. A failed read costs the command its hint, never the session.
async function readArgumentHint(path: string): Promise<string | undefined> {
  try {
    return parseArgumentHint(await readFile(path, 'utf8'))
  } catch (error) {
    console.error(`[${AGENT_NAME}] command mapping: failed to read the argument hint of prompt template ${path}: ${asMessage(error)}`)
    return undefined
  }
}

/** Pi's own frontmatter parse of a template's `argument-hint`; throws on malformed YAML. */
export function parseArgumentHint(content: string): string | undefined {
  const text = stripBom(content).replace(CARRIAGE_RETURN_LINE_BREAK, LINE_FEED)
  if (!text.startsWith(FRONTMATTER_DELIMITER)) return undefined
  const endIndex = text.indexOf(`${LINE_FEED}${FRONTMATTER_DELIMITER}`, FRONTMATTER_DELIMITER.length)
  if (endIndex === -1) return undefined
  const yamlText = text.slice(FRONTMATTER_DELIMITER.length + LINE_FEED.length, endIndex)
  if (yamlText === '') return undefined
  const frontmatter: unknown = parseYaml(yamlText, FRONTMATTER_YAML_OPTIONS)
  if (typeof frontmatter !== 'object' || frontmatter === null) return undefined
  const hint = (frontmatter as Record<string, unknown>)[FRONTMATTER_KEY_ARGUMENT_HINT]
  return typeof hint === 'string' && hint !== '' ? hint : undefined
}

function invalidParams(message: string): acp.RequestError {
  return new acp.RequestError(JSONRPC_INVALID_PARAMS, message)
}
