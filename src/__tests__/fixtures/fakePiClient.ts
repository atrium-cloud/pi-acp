import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from '../../pi/types.js'
import type { CreatePiClient, PiClientLike } from '../../session/SessionConnection.js'
import type { JsonAgentSessionEvent } from '../../pi/types.js'

// The subset of RpcSessionState the session layer reads; the rest is never
// touched, so the fake omits it and casts on the way out.
export interface FakeState {
  sessionId: string
  thinkingLevel: string
  model?: { provider: string; id: string; name: string } | undefined
  sessionName?: string
}

/** The `SessionStats` subset the adapter reads for end-of-turn usage. */
export interface FakeStats {
  cost: number
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }
}

const DEFAULT_STATS: FakeStats = { cost: 0.05, contextUsage: { tokens: 1234, contextWindow: 200_000, percent: 1 } }

export interface FakePiSpec {
  state: FakeState
  models: { provider: string; id: string; name: string }[]
  levels: string[]
  commands: { name: string; description?: string; source: string }[]
  /** End-of-turn `get_session_stats` payload; defaults to DEFAULT_STATS. */
  stats?: FakeStats
  /** The `get_messages` history a `session/load` replays. */
  messages?: readonly unknown[]
  /** A command type that should reject, to exercise error paths. */
  failOn?: string
  /** A command type that should reject only on its first call, then succeed. */
  failOnce?: string
  /** Makes a `prompt` command reject as a failed preflight. */
  preflightFails?: boolean
  /** Emits events synchronously while the `prompt` request is in flight (before
   * the ack resolves), to exercise subscribe-before-send ordering. */
  onPrompt?: (emit: (event: JsonAgentSessionEvent) => void) => void
}

export interface FakePiClient {
  createPiClient: CreatePiClient
  calls: Array<Record<string, unknown>>
  /** One entry per spawn, so a test can assert the `--session` args and that a
   * reused session spawned nothing new. */
  spawns: Array<{ cwd: string; args: readonly string[] }>
  wasStopped: () => boolean
  /** Feeds an event through the transport's `onEvent` (the session router). */
  emit: (event: JsonAgentSessionEvent) => void
  /** Fires the transport's `onExit`. */
  exit: (error: Error) => void
  /** Drives an extension UI request through the wired `onExtensionUiRequest`. */
  requestUi: (request: RpcExtensionUIRequest) => Promise<RpcExtensionUIResponse>
}

export function makeFakePiClient(spec: FakePiSpec): FakePiClient {
  const calls: Array<Record<string, unknown>> = []
  const failedOnce = new Set<string>()
  let state = spec.state
  let stopped = false
  let onEvent: ((event: JsonAgentSessionEvent) => void) | undefined
  let onExit: ((error: Error) => void) | undefined
  let onExtensionUiRequest: ((request: RpcExtensionUIRequest) => Promise<RpcExtensionUIResponse>) | undefined
  const emit = (event: JsonAgentSessionEvent): void => onEvent?.(event)

  const respond = async (command: Record<string, unknown> & { type: string }): Promise<unknown> => {
    calls.push(command)
    if (spec.failOn === command.type) throw new Error(`fake pi: ${command.type} failed`)
    if (spec.failOnce === command.type && !failedOnce.has(command.type)) {
      failedOnce.add(command.type)
      throw new Error(`fake pi: ${command.type} failed once`)
    }
    switch (command.type) {
      case 'get_state':
        return { type: 'response', command: 'get_state', success: true, data: state }
      case 'get_available_models':
        return { type: 'response', command: 'get_available_models', success: true, data: { models: spec.models } }
      case 'get_available_thinking_levels':
        return { type: 'response', command: 'get_available_thinking_levels', success: true, data: { levels: spec.levels } }
      case 'get_commands':
        return { type: 'response', command: 'get_commands', success: true, data: { commands: spec.commands } }
      case 'get_messages':
        return { type: 'response', command: 'get_messages', success: true, data: { messages: spec.messages ?? [] } }
      case 'set_model': {
        const model = spec.models.find((m) => m.provider === command['provider'] && m.id === command['modelId'])
        state = { ...state, model: model ?? state.model }
        return { type: 'response', command: 'set_model', success: true, data: model }
      }
      case 'set_thinking_level':
        state = { ...state, thinkingLevel: command['level'] as string }
        return { type: 'response', command: 'set_thinking_level', success: true }
      case 'set_session_name':
        state = { ...state, sessionName: command['name'] as string }
        return { type: 'response', command: 'set_session_name', success: true }
      case 'get_session_stats':
        return { type: 'response', command: 'get_session_stats', success: true, data: spec.stats ?? DEFAULT_STATS }
      case 'prompt':
        if (spec.preflightFails) throw new Error('fake pi: prompt preflight failed')
        spec.onPrompt?.(emit)
        return { type: 'response', command: 'prompt', success: true }
      case 'abort':
        return { type: 'response', command: 'abort', success: true }
      default:
        throw new Error(`fake pi: unexpected command ${command.type}`)
    }
  }

  const client: PiClientLike = {
    start: (async () => state) as unknown as PiClientLike['start'],
    request: respond as unknown as PiClientLike['request'],
    stop: async () => {
      stopped = true
    },
  }

  const spawns: Array<{ cwd: string; args: readonly string[] }> = []
  const createPiClient: CreatePiClient = (options) => {
    spawns.push({ cwd: options.cwd, args: options.args ?? [] })
    onEvent = options.onEvent
    onExit = options.onExit
    onExtensionUiRequest = options.onExtensionUiRequest
    return client
  }

  return {
    createPiClient,
    calls,
    spawns,
    wasStopped: () => stopped,
    emit,
    exit: (error) => onExit?.(error),
    requestUi: (request) => {
      if (onExtensionUiRequest === undefined) throw new Error('fake pi: no onExtensionUiRequest handler wired')
      return onExtensionUiRequest(request)
    },
  }
}
