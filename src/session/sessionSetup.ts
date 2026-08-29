import { isAbsolute } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext, AvailableCommand, NewSessionRequest } from '@agentclientprotocol/sdk'

import { JSONRPC_INVALID_PARAMS } from '../constants.js'
import type { PiLaunch } from '../pi/errors.js'
import { PiRpcClient } from '../pi/PiRpcClient.js'
import type { ModelChoice } from '../turn/configOptions.js'
import { type CreatePiClient, SessionConnection } from './SessionConnection.js'

const defaultCreatePiClient: CreatePiClient = (options) => new PiRpcClient(options)

export interface SessionSetupDeps {
  readonly launch: PiLaunch
  readonly rpcTimeoutMs: number
  readonly notifier: AgentContext
  /** Injectable for tests; defaults to spawning a real Pi RPC subprocess. */
  readonly createPiClient?: CreatePiClient | undefined
}

export interface EstablishedSession {
  readonly connection: SessionConnection
  readonly sessionId: string
  readonly configOptions: acp.SessionConfigOption[]
  readonly availableCommands: AvailableCommand[]
}

export async function establishSession(
  request: NewSessionRequest,
  deps: SessionSetupDeps,
): Promise<EstablishedSession> {
  validateNewSession(request)

  const connection = new SessionConnection({ notifier: deps.notifier, cwd: request.cwd })
  const createPiClient = deps.createPiClient ?? defaultCreatePiClient
  const piClient = createPiClient({
    launch: deps.launch,
    cwd: request.cwd,
    timeoutMs: deps.rpcTimeoutMs,
    onEvent: (event) => {
      connection.routeEvent(event)
    },
    onExit: (error) => {
      connection.handleExit(error)
    },
  })

  // start() self-cleans a failure inside itself; a failure in the follow-up
  // fetches would otherwise leave a live subprocess nobody holds.
  const state = await piClient.start()
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

function validateNewSession(request: NewSessionRequest): void {
  if (!isAbsolute(request.cwd)) throw invalidParams(`cwd must be an absolute path, got "${request.cwd}"`)
  if (request.mcpServers.length > 0) throw invalidParams('mcpServers are not supported in this baseline')
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
