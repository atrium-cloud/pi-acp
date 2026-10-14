import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'

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
  PI_SESSION_ID_ARG,
} from '../constants.js'
import type { McpServerSpec } from '../mcp/servers.js'
import { translateMcpServers } from '../mcp/servers.js'
import type { PiLaunch } from '../pi/errors.js'
import { PiRpcClient } from '../pi/PiRpcClient.js'
import { parsePiStartupTimings, startupTimingLogLine } from '../pi/startupTimings.js'
import { asMessage } from '../server/errors.js'
import type { ModelChoice } from '../turn/configOptions.js'
import { type CreatePiClient, type LaunchedPi, type RelaunchTarget, SessionConnection } from './SessionConnection.js'
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
  readonly logStartupTiming: boolean
  /** Injectable for tests; defaults to spawning a real Pi RPC subprocess. */
  readonly createPiClient?: CreatePiClient | undefined
}

export interface EstablishedSession {
  readonly connection: SessionConnection
  readonly sessionId: string
  readonly configOptions: acp.SessionConfigOption[]
  readonly availableCommands: readonly AvailableCommand[]
}

/** `new` starts an empty session; `spare` starts one the same way, held as a
 * warm spare, and differs only in its timing line; `open` reopens a stored one
 * from its file. Pi's RPC mode has no id resolution, so `sessionFile` is always
 * an absolute path. */
export type SessionSetupMode =
  | { readonly kind: 'new' }
  | { readonly kind: 'spare' }
  | { readonly kind: 'open'; readonly sessionFile: string; readonly expectedSessionId: string }

/** The shape shared by `session/new`, `session/resume` and `session/load`;
 * structural so all three SDK request types satisfy it. */
export interface SessionSetupRequest {
  readonly cwd: string
  readonly mcpServers?: McpServer[] | undefined
  readonly additionalDirectories?: readonly string[] | undefined
}

/** An empty session, or a known one by its file or exact id. */
type LaunchTarget = { readonly kind: 'empty' } | RelaunchTarget

/** What every launch of one session shares, fixed at setup. */
interface LaunchPlan {
  readonly deps: SessionSetupDeps
  readonly cwd: string
  readonly mcpServers: readonly McpServerSpec[]
}

export async function establishSession(
  request: SessionSetupRequest,
  deps: SessionSetupDeps,
  mode: SessionSetupMode = { kind: 'new' },
): Promise<EstablishedSession> {
  const plan: LaunchPlan = { deps, cwd: request.cwd, mcpServers: validateSessionRequest(request) }
  const connection: SessionConnection = new SessionConnection({
    notifier: deps.notifier,
    cwd: request.cwd,
    clientSupportsNotices: deps.clientSupportsNotices,
    relaunch: (target) => launchPi(connection, plan, target, 'wake'),
  })
  const target: LaunchTarget =
    mode.kind === 'open'
      ? { kind: 'file', sessionFile: mode.sessionFile, sessionId: mode.expectedSessionId }
      : { kind: 'empty' }
  const launched = await launchPi(connection, plan, target, mode.kind)
  connection.attach(launched)
  return {
    connection,
    sessionId: launched.state.sessionId,
    configOptions: connection.configOptions,
    availableCommands: launched.commands,
  }
}

/** Spawns and starts one Pi subprocess wired to `connection`, then reads what
 * the session is built from. Setup and a wake both launch through here, so a
 * woken session runs the same extensions and MCP servers as before. */
async function launchPi(
  connection: SessionConnection,
  plan: LaunchPlan,
  target: LaunchTarget,
  timingMode: SessionSetupMode['kind'] | 'wake',
): Promise<LaunchedPi> {
  const startedAt = performance.now()
  const { deps, mcpServers } = plan
  const createPiClient = deps.createPiClient ?? defaultCreatePiClient
  // The gate loads alongside the user's own extensions (no --no-extensions).
  const args = deps.gateExtensionPath !== undefined ? ['-e', deps.gateExtensionPath] : []
  // Only a session that asked for servers loads the MCP extension; it reads the
  // list from the environment and deletes it before anything can inherit it.
  if (mcpServers.length > 0) args.push('-e', deps.mcpExtensionPath)
  if (target.kind === 'file') args.push(PI_SESSION_ARG, target.sessionFile)
  if (target.kind === 'id') args.push(PI_SESSION_ID_ARG, target.sessionId)
  const piClient = createPiClient({
    launch: deps.launch,
    cwd: plan.cwd,
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
  const readyAt = performance.now()
  if (target.kind !== 'empty' && state.sessionId !== target.sessionId) {
    // Pi opened something other than the requested session (a stale path, or an
    // id the file no longer carries): nothing downstream can be trusted.
    await piClient.stop()
    const source = target.kind === 'file' ? target.sessionFile : `${PI_SESSION_ID_ARG} ${target.sessionId}`
    throw new acp.RequestError(
      JSONRPC_INTERNAL_ERROR,
      `Pi opened session "${state.sessionId}" from ${source}, expected "${target.sessionId}"`,
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
    const metadataDoneAt = performance.now()
    // Pi prints its blocks before it answers get_state, but on stderr, a separate
    // pipe that can lag stdout, so the tail is read only after these round-trips.
    if (deps.logStartupTiming) {
      const startup = piClient.startupTiming
      console.error(
        startupTimingLogLine(state.sessionId, {
          mode: timingMode,
          spawnMs: startup?.spawnMs ?? null,
          readyMs: startup?.readyMs ?? null,
          metadataMs: Math.round(metadataDoneAt - readyAt),
          totalMs: Math.round(metadataDoneAt - startedAt),
          pi: parsePiStartupTimings(piClient.stderrTail()),
        }),
      )
    }
    return { piClient, state, models: modelChoices, levels: levels.data.levels, commands: availableCommands }
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
