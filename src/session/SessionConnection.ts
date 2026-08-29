import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext, AvailableCommand, SessionConfigOption, StopReason } from '@agentclientprotocol/sdk'

import {
  AGENT_NAME,
  CONFIG_ID_MODEL,
  CONFIG_ID_THOUGHT_LEVEL,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
} from '../constants.js'
import type { PiRpcClient, PiRpcClientOptions } from '../pi/PiRpcClient.js'
import type { JsonAgentSessionEvent, RpcCommand, RpcSessionState } from '../pi/types.js'
import { asMessage } from '../server/errors.js'
import { buildConfigOptions, type ModelChoice, resolveModelSelection } from '../turn/configOptions.js'
import type { FlattenedPrompt } from '../turn/promptContent.js'
import { type TurnEventSink, TurnHandler } from '../turn/TurnHandler.js'

// The exact `set_thinking_level` payload type, without importing the Pi package's
// `ThinkingLevel` name (it is not re-exported from the package root).
type ThinkingLevelValue = Extract<RpcCommand, { type: 'set_thinking_level' }>['level']

/** The subset of `PiRpcClient` the session layer drives. `request` keeps the
 * client's per-command typing so responses narrow by command type. */
export interface PiClientLike {
  start(): Promise<RpcSessionState>
  request: PiRpcClient['request']
  stop(): Promise<void>
}

export type CreatePiClient = (options: PiRpcClientOptions) => PiClientLike

interface ConfigState {
  readonly models: readonly ModelChoice[]
  readonly levels: readonly ThinkingLevelValue[]
  readonly options: SessionConfigOption[]
}

export interface SessionConnectionInit {
  readonly piClient: PiClientLike
  readonly sessionId: string
  readonly state: RpcSessionState
  readonly models: readonly ModelChoice[]
  readonly levels: readonly ThinkingLevelValue[]
}

/** Persistent per-session object, created at `session/new` and living until the
 * client connection closes. It owns the single exhaustive router over
 * `JsonAgentSessionEvent`: session-level arms it handles itself; turn-scoped arms
 * it forwards to the active turn. Subscribing here once (rather than per turn)
 * keeps session-level updates that fire between turns from being lost. */
export class SessionConnection {
  private readonly notifier: AgentContext
  readonly cwd: string
  private piClient: PiClientLike | null = null
  private sessionId = ''
  private config: ConfigState | null = null
  /** A `set_*` may apply before its follow-up re-read lands; when that read
   * fails the cache no longer reflects Pi, so the next change re-reads first. */
  private configStale = false
  private activeTurn: TurnEventSink | null = null
  /** Set once the subprocess dies; a later request answers with this cause. */
  private exitError: Error | null = null

  constructor(init: { notifier: AgentContext; cwd: string }) {
    this.notifier = init.notifier
    this.cwd = init.cwd
  }

  attach(init: SessionConnectionInit): void {
    this.piClient = init.piClient
    this.sessionId = init.sessionId
    this.config = this.buildConfig(init.state, init.models, init.levels)
  }

  get configOptions(): SessionConfigOption[] {
    return this.requireConfig().options
  }

  get dead(): Error | null {
    return this.exitError
  }

  /** Sends the command snapshot after `session/new` has returned. It is deferred
   * a macrotask because the SDK client only attaches its session-update queue
   * inside the `session/new` response callback (acp.js SessionUpdateRouter), so an
   * update sent before that response lands is dropped for an unknown session. */
  announceCommands(commands: readonly AvailableCommand[]): void {
    setTimeout(() => {
      if (this.exitError) return
      void this.notifier
        .notify(acp.methods.client.session.update, {
          sessionId: this.sessionId,
          update: { sessionUpdate: 'available_commands_update', availableCommands: [...commands] },
        })
        .catch((error: unknown) => {
          console.error(`[${AGENT_NAME}] [${this.sessionId}] failed to send available_commands_update: ${asMessage(error)}`)
        })
    }, 0)
  }

  async applyConfigOption(configId: string, value: string): Promise<SessionConfigOption[]> {
    if (this.exitError) throw this.exitError
    const client = this.requireClient()
    if (this.configStale) await this.refresh(client)
    const config = this.requireConfig()

    if (configId === CONFIG_ID_MODEL) {
      const selection = resolveModelSelection(value, config.models)
      if (selection === undefined) throw invalidParams(`no model matches "${value}"`)
      // The set may apply even if the re-read fails, so the cache is marked
      // stale until the rebuild confirms the new current values.
      this.configStale = true
      await client.request({ type: 'set_model', provider: selection.provider, modelId: selection.modelId })
      // Levels are per-model, so both are re-read after a model switch.
      const [levels, state] = await Promise.all([
        client.request({ type: 'get_available_thinking_levels' }),
        client.request({ type: 'get_state' }),
      ])
      this.config = this.buildConfig(state.data, config.models, levels.data.levels)
      this.configStale = false
      return this.config.options
    }

    if (configId === CONFIG_ID_THOUGHT_LEVEL) {
      const level = config.levels.find((candidate) => candidate === value)
      if (level === undefined) throw invalidParams(`no thinking level matches "${value}"`)
      this.configStale = true
      await client.request({ type: 'set_thinking_level', level })
      const state = await client.request({ type: 'get_state' })
      this.config = this.buildConfig(state.data, config.models, config.levels)
      this.configStale = false
      return this.config.options
    }

    throw invalidParams(`unknown config option "${configId}"`)
  }

  /** Rebuilds the cache from a full fresh read, recovering from a set whose
   * follow-up re-read failed. */
  private async refresh(client: PiClientLike): Promise<void> {
    const [models, levels, state] = await Promise.all([
      client.request({ type: 'get_available_models' }),
      client.request({ type: 'get_available_thinking_levels' }),
      client.request({ type: 'get_state' }),
    ])
    const modelChoices: ModelChoice[] = models.data.models.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
    }))
    this.config = this.buildConfig(state.data, modelChoices, levels.data.levels)
    this.configStale = false
  }

  routeEvent(event: JsonAgentSessionEvent): void {
    switch (event.type) {
      // Session-level arms (handled here, filled in §2 batch D).
      case 'session_info_changed':
      case 'thinking_level_changed':
        return
      // Deliberately ignored.
      case 'entry_appended':
      case 'queue_update':
        return
      // Turn-scoped arms forwarded to the active turn (§2 batch C).
      case 'agent_start':
      case 'agent_end':
      case 'agent_settled':
      case 'turn_start':
      case 'turn_end':
      case 'message_start':
      case 'message_update':
      case 'message_end':
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
      case 'compaction_start':
      case 'compaction_end':
      case 'auto_retry_start':
      case 'auto_retry_end':
      case 'summarization_retry_scheduled':
      case 'summarization_retry_attempt_start':
      case 'summarization_retry_finished':
      case 'bash_execution_update':
        this.activeTurn?.handleEvent(event)
        return
    }
    // tsc enforces the switch is exhaustive: a Pi bump that adds an event type
    // stops compiling here. At runtime this runs inside the transport's stdout
    // handler, so it logs and drops rather than throwing (a throw would escape
    // to an uncaughtException and take down every session), and no caller is
    // waiting on an event the way one waits on an extension_ui_request.
    const unhandled: never = event
    console.error(`[${AGENT_NAME}] [${this.sessionId}] dropping unrecognized Pi session event: ${JSON.stringify(unhandled)}`)
  }

  /** Runs one turn: register the turn BEFORE sending the prompt, because the ack
   * and a synchronously-dispatched `agent_start` can arrive in one stdout chunk,
   * ahead of the `await request` continuation — subscribing after would miss it.
   * Both cancel paths (`session/cancel` and the prompt's own `$/cancel_request`
   * abort signal) converge on `cancel()`. */
  async runPrompt(prompt: FlattenedPrompt, signal: AbortSignal): Promise<StopReason> {
    if (this.exitError) throw this.exitError
    const client = this.requireClient()
    if (this.activeTurn !== null) {
      throw new acp.RequestError(JSONRPC_INVALID_REQUEST, 'a turn is already in progress for this session')
    }

    const turn = new TurnHandler({ notifier: this.notifier, sessionId: this.sessionId })
    this.activeTurn = turn
    const onAbort = (): void => this.cancel()
    if (signal.aborted) this.cancel()
    else signal.addEventListener('abort', onAbort, { once: true })

    try {
      await client.request({ type: 'prompt', message: prompt.message, images: prompt.images })
      turn.armStartTimer()
      return await turn.settled
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.activeTurn = null
    }
  }

  /** Sticky-cancels the active turn and asks Pi to abort. The abort is fire and
   * forget: Pi defers it until the run is idle, so its ack can lag `agent_settled`
   * or race teardown; the turn resolves off `agent_settled`/the sticky flag. */
  cancel(): void {
    if (this.activeTurn === null) return
    this.activeTurn.cancel()
    void this.piClient?.request({ type: 'abort' }).catch(() => undefined)
  }

  handleExit(error: Error): void {
    if (this.exitError === null) this.exitError = error
    this.activeTurn?.fail(error)
  }

  async stop(): Promise<void> {
    await this.piClient?.stop()
  }

  private buildConfig(
    state: RpcSessionState,
    models: readonly ModelChoice[],
    levels: readonly ThinkingLevelValue[],
  ): ConfigState {
    const currentModel = state.model === undefined ? undefined : { provider: state.model.provider, id: state.model.id }
    const options = buildConfigOptions({ models, currentModel, levels, currentLevel: state.thinkingLevel })
    return { models, levels, options }
  }

  private requireClient(): PiClientLike {
    if (this.piClient === null) throw new Error('session connection used before attach()')
    return this.piClient
  }

  private requireConfig(): ConfigState {
    if (this.config === null) throw new Error('session connection used before attach()')
    return this.config
  }
}

function invalidParams(message: string): acp.RequestError {
  return new acp.RequestError(JSONRPC_INVALID_PARAMS, message)
}
