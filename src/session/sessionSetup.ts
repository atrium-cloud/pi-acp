import { isAbsolute } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext, AvailableCommand } from '@agentclientprotocol/sdk'

import { JSONRPC_INTERNAL_ERROR, JSONRPC_INVALID_PARAMS, PI_SESSION_ARG } from '../constants.js'
import type { PiLaunch } from '../pi/errors.js'
import { PiRpcClient } from '../pi/PiRpcClient.js'
import type { ModelChoice } from '../turn/configOptions.js'
import { type CreatePiClient, SessionConnection } from './SessionConnection.js'

const defaultCreatePiClient: CreatePiClient = (options) => new PiRpcClient(options)

export interface SessionSetupDeps {
  readonly launch: PiLaunch
  readonly rpcTimeoutMs: number
  readonly notifier: AgentContext
  /** Absolute path to the materialized permission gate, loaded with `-e`. Absent
   * in tests (the fake client ignores args), so no temp file is written. */
  readonly gateExtensionPath?: string | undefined
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
  readonly mcpServers?: readonly unknown[] | undefined
  readonly additionalDirectories?: readonly string[] | undefined
}

export async function establishSession(
  request: SessionSetupRequest,
  deps: SessionSetupDeps,
  mode: SessionSetupMode = { kind: 'new' },
): Promise<EstablishedSession> {
  validateSessionRequest(request)

  const connection = new SessionConnection({ notifier: deps.notifier, cwd: request.cwd })
  const createPiClient = deps.createPiClient ?? defaultCreatePiClient
  // The gate loads alongside the user's own extensions (no --no-extensions).
  const args = deps.gateExtensionPath !== undefined ? ['-e', deps.gateExtensionPath] : []
  if (mode.kind === 'open') args.push(PI_SESSION_ARG, mode.sessionFile)
  const piClient = createPiClient({
    launch: deps.launch,
    cwd: request.cwd,
    args,
    timeoutMs: deps.rpcTimeoutMs,
    onEvent: (event) => {
      connection.routeEvent(event)
    },
    onExit: (error) => {
      connection.handleExit(error)
    },
    onExtensionUiRequest: (uiRequest) => connection.handleExtensionUiRequest(uiRequest),
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
      availableCommands: mapCommands(commands.data.commands),
    }
  } catch (error) {
    await piClient.stop()
    throw error
  }
}

/** Shared by `session/new`, `session/resume` and `session/load`; resume and load
 * run it before touching the store so a bad request never reads the filesystem. */
export function validateSessionRequest(request: SessionSetupRequest): void {
  if (!isAbsolute(request.cwd)) throw invalidParams(`cwd must be an absolute path, got "${request.cwd}"`)
  if (request.mcpServers !== undefined && request.mcpServers.length > 0) {
    throw invalidParams('mcpServers are not supported in this baseline')
  }
  if (request.additionalDirectories !== undefined && request.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories are not supported')
  }
}

// Only prompt and skill commands run an agent turn; extension commands may not,
// so a `session/prompt` awaiting agent_settled could hang on one.
function mapCommands(commands: readonly { name: string; description?: string; source: string }[]): AvailableCommand[] {
  return commands
    .filter((command) => command.source === 'prompt' || command.source === 'skill')
    .map((command) => ({ name: command.name, description: command.description ?? '' }))
}

function invalidParams(message: string): acp.RequestError {
  return new acp.RequestError(JSONRPC_INVALID_PARAMS, message)
}
