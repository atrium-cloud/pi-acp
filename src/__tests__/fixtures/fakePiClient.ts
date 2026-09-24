import { readFileSync } from 'node:fs'

import { PI_SESSION_ARG } from '../../constants.js'
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
  /** Pi's own file for the session; a session without one records no breakpoints. */
  sessionFile?: string
}

/** `SessionStats` minus the file and id, which the fake reads from its state as
 * Pi does. */
export interface FakeStats {
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  cost: number
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }
}

export const DEFAULT_STATS: FakeStats = {
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 2,
  tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
  cost: 0.05,
  contextUsage: { tokens: 1234, contextWindow: 200_000, percent: 1 },
}

/** The `CompactionResult` subset the adapter reads. */
export interface FakeCompaction {
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
}

export const DEFAULT_COMPACTION: FakeCompaction = { summary: 'summary', firstKeptEntryId: 'entry-1', tokensBefore: 12_345 }

export interface FakePiSpec {
  state: FakeState
  models: { provider: string; id: string; name: string }[]
  levels: string[]
  commands: { name: string; description?: string; source: string }[]
  /** `get_session_stats` fields laid over DEFAULT_STATS. */
  stats?: Partial<FakeStats>
  /** The `get_messages` history a `session/load` replays. */
  messages?: readonly unknown[]
  /** The `get_entries` session tree; a function is called per request, so a test
   * can grow the tree between turns. */
  entries?: readonly unknown[] | (() => readonly unknown[])
  /** A command type that should reject, to exercise error paths. */
  failOn?: string
  /** A command type that should reject only on its first call, then succeed. */
  failOnce?: string
  /** Makes a `prompt` command reject as a failed preflight. */
  preflightFails?: boolean
  /** Emits events synchronously while the `prompt` request is in flight (before
   * the ack resolves), to exercise subscribe-before-send ordering. */
  onPrompt?: (emit: (event: JsonAgentSessionEvent) => void) => void
  /** Reports the id in the header of the file a spawn opens with `--session`, the
   * way Pi adopts the id of the session it opened. Off by default, so a spawn
   * keeps reporting `state.sessionId` and an id mismatch stays exercisable. */
  sessionIdFromSessionFile?: boolean
  /** Answers `compact` (DEFAULT_COMPACTION when unset). A test holds the
   * compaction open by returning a promise it settles itself; `abort` never
   * settles it, since Pi's `abort` does not stop a manual compaction. */
  onCompact?: (customInstructions: string | undefined) => Promise<FakeCompaction>
}

export interface FakePiClient {
  createPiClient: CreatePiClient
  calls: Array<Record<string, unknown>>
  /** One entry per spawn, so a test can assert the `--session` args, the MCP
   * environment, and that a reused session spawned nothing new. */
  spawns: Array<{ cwd: string; args: readonly string[]; env?: NodeJS.ProcessEnv | undefined }>
  wasStopped: () => boolean
  /** Feeds an event through the transport's `onEvent` (the session router). */
  emit: (event: JsonAgentSessionEvent) => void
  /** Fires the transport's `onExit`. */
  exit: (error: Error) => void
  /** Drives an extension UI request through the wired `onExtensionUiRequest`. */
  requestUi: (request: RpcExtensionUIRequest) => Promise<RpcExtensionUIResponse>
}

function readHeaderSessionId(sessionFile: string | undefined): string {
  if (sessionFile === undefined) throw new Error(`fake pi: ${PI_SESSION_ARG} carries no path`)
  const [firstLine] = readFileSync(sessionFile, 'utf8').split('\n')
  const header = JSON.parse(firstLine ?? '') as { id?: unknown }
  if (typeof header.id !== 'string') throw new Error(`fake pi: no session id in the header of ${sessionFile}`)
  return header.id
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
      case 'get_entries': {
        const entries = typeof spec.entries === 'function' ? spec.entries() : (spec.entries ?? [])
        const last = entries.at(-1) as { id?: unknown } | undefined
        const leafId = typeof last?.id === 'string' ? last.id : null
        return { type: 'response', command: 'get_entries', success: true, data: { entries, leafId } }
      }
      case 'set_model': {
        const model = spec.models.find((m) => m.provider === command['provider'] && m.id === command['modelId'])
        state = { ...state, model: model ?? state.model }
        return { type: 'response', command: 'set_model', success: true, data: model }
      }
      case 'set_thinking_level':
        state = { ...state, thinkingLevel: command['level'] as string }
        return { type: 'response', command: 'set_thinking_level', success: true }
      case 'set_session_name': {
        // Pi's own rules: the RPC handler trims and refuses an empty name, and
        // the session store turns line breaks into spaces.
        const name = (command['name'] as string).trim()
        if (name === '') throw new Error('fake pi: Session name cannot be empty')
        state = { ...state, sessionName: name.replace(/[\r\n]+/g, ' ').trim() }
        return { type: 'response', command: 'set_session_name', success: true }
      }
      case 'get_session_stats': {
        const data = { sessionFile: state.sessionFile, sessionId: state.sessionId, ...DEFAULT_STATS, ...spec.stats }
        return { type: 'response', command: 'get_session_stats', success: true, data }
      }
      case 'compact': {
        const customInstructions = command['customInstructions'] as string | undefined
        const data = await (spec.onCompact?.(customInstructions) ?? DEFAULT_COMPACTION)
        return { type: 'response', command: 'compact', success: true, data }
      }
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

  const spawns: Array<{ cwd: string; args: readonly string[]; env?: NodeJS.ProcessEnv | undefined }> = []
  const createPiClient: CreatePiClient = (options) => {
    const args = options.args ?? []
    spawns.push({ cwd: options.cwd, args, env: options.env })
    const sessionArgIndex = args.indexOf(PI_SESSION_ARG)
    if (spec.sessionIdFromSessionFile && sessionArgIndex !== -1) {
      const sessionFile = args[sessionArgIndex + 1]
      const sessionId = readHeaderSessionId(sessionFile)
      // Pi reports the file it opened, so the session finds its own sidecar.
      state = { ...state, sessionId, ...(sessionFile === undefined ? {} : { sessionFile }) }
    }
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
