import type { CreatePiClient, PiClientLike } from '../../session/SessionConnection.js'
import type { JsonAgentSessionEvent } from '../../pi/types.js'

// The subset of RpcSessionState the session layer reads; the rest is never
// touched, so the fake omits it and casts on the way out.
export interface FakeState {
  sessionId: string
  thinkingLevel: string
  model?: { provider: string; id: string; name: string } | undefined
}

export interface FakePiSpec {
  state: FakeState
  models: { provider: string; id: string; name: string }[]
  levels: string[]
  commands: { name: string; description?: string; source: string }[]
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
  wasStopped: () => boolean
  /** Feeds an event through the transport's `onEvent` (the session router). */
  emit: (event: JsonAgentSessionEvent) => void
  /** Fires the transport's `onExit`. */
  exit: (error: Error) => void
}

export function makeFakePiClient(spec: FakePiSpec): FakePiClient {
  const calls: Array<Record<string, unknown>> = []
  const failedOnce = new Set<string>()
  let state = spec.state
  let stopped = false
  let onEvent: ((event: JsonAgentSessionEvent) => void) | undefined
  let onExit: ((error: Error) => void) | undefined
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
      case 'set_model': {
        const model = spec.models.find((m) => m.provider === command['provider'] && m.id === command['modelId'])
        state = { ...state, model: model ?? state.model }
        return { type: 'response', command: 'set_model', success: true, data: model }
      }
      case 'set_thinking_level':
        state = { ...state, thinkingLevel: command['level'] as string }
        return { type: 'response', command: 'set_thinking_level', success: true }
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

  const createPiClient: CreatePiClient = (options) => {
    onEvent = options.onEvent
    onExit = options.onExit
    return client
  }

  return {
    createPiClient,
    calls,
    wasStopped: () => stopped,
    emit,
    exit: (error) => onExit?.(error),
  }
}
