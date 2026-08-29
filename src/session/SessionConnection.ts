import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext, AvailableCommand, SessionConfigOption, SessionUpdate, StopReason } from '@agentclientprotocol/sdk'

import {
  AGENT_NAME,
  CONFIG_ID_MODEL,
  CONFIG_ID_THOUGHT_LEVEL,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  PERMISSION_OPTION_ALLOW_ALWAYS,
  PERMISSION_OPTION_ALLOW_ONCE,
  PERMISSION_REQUEST_TIMEOUT_MS,
  PROMPT_ACK_TIMEOUT_MS,
} from '../constants.js'
import { buildPermissionOptions, decodeSentinelTitle } from '../permissions/gate.js'
import type { PiRpcClient, PiRpcClientOptions } from '../pi/PiRpcClient.js'
import type { JsonAgentSessionEvent, RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcSessionState } from '../pi/types.js'
import { asMessage } from '../server/errors.js'
import { buildConfigOptions, type ModelChoice, resolveModelSelection } from '../turn/configOptions.js'
import { configOptionUpdate, sessionInfoUpdate, toolKind, toolTitle, usageUpdate } from '../turn/mappers.js'
import type { FlattenedPrompt } from '../turn/promptContent.js'
import { type AnnouncedToolCall, type TurnEventSink, TurnHandler } from '../turn/TurnHandler.js'
import { replayUpdates } from './replay.js'
import { deriveTitle } from './title.js'

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
  readonly currentModel: { readonly provider: string; readonly id: string } | undefined
  readonly currentLevel: string
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
 * client closes it or the connection ends. It owns the single exhaustive router
 * over `JsonAgentSessionEvent`: session-level arms it handles itself; turn-scoped arms
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
  /** Set by `close()`; a closed session is never used again, so every later
   * request is rejected rather than raced against the teardown. */
  private closing = false
  /** True until this session gets a name; the first prompt derives one. */
  private needsTitle = false

  constructor(init: { notifier: AgentContext; cwd: string }) {
    this.notifier = init.notifier
    this.cwd = init.cwd
  }

  attach(init: SessionConnectionInit): void {
    this.piClient = init.piClient
    this.sessionId = init.sessionId
    this.config = this.buildConfig(init.state, init.models, init.levels)
    this.needsTitle = (init.state.sessionName ?? '').trim() === ''
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
      if (this.exitError || this.closing) return
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

  /** Replays the stored transcript for `session/load`. ACP puts the history
   * before the response, so unlike `emit` these are awaited in order rather than
   * fired and forgotten, and a failure fails the load. */
  async replayHistory(): Promise<void> {
    if (this.closing) throw closingError()
    if (this.exitError) throw this.exitError
    const client = this.requireClient()
    const history = await client.request({ type: 'get_messages' })
    for (const update of replayUpdates(history.data.messages)) {
      await this.notifier.notify(acp.methods.client.session.update, { sessionId: this.sessionId, update })
    }
  }

  async applyConfigOption(configId: string, value: string): Promise<SessionConfigOption[]> {
    if (this.closing) throw closingError()
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
      // Session-level arms handled here, not by the turn (they can fire between
      // turns, which is why the router — not a per-turn handler — subscribes).
      case 'session_info_changed':
        this.handleSessionInfoChanged(event)
        return
      case 'thinking_level_changed':
        this.handleThinkingLevelChanged(event)
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

  private handleSessionInfoChanged(event: Extract<JsonAgentSessionEvent, { type: 'session_info_changed' }>): void {
    if (typeof event.name !== 'string') return
    this.emit(sessionInfoUpdate(event.name))
  }

  /** Rebuilds the option set with the new level (no round-trip; the current model
   * is cached) and pushes the full set. A client-initiated set already returned
   * the same set, so the client tolerates this idempotent echo. */
  private handleThinkingLevelChanged(event: Extract<JsonAgentSessionEvent, { type: 'thinking_level_changed' }>): void {
    const config = this.config
    if (config === null) return
    const options = buildConfigOptions({
      models: config.models,
      currentModel: config.currentModel,
      levels: config.levels,
      currentLevel: event.level,
    })
    this.config = { ...config, currentLevel: event.level, options }
    this.emit(configOptionUpdate(options))
  }

  private emit(update: SessionUpdate): void {
    if (this.exitError || this.closing) return
    void this.notifier
      .notify(acp.methods.client.session.update, { sessionId: this.sessionId, update })
      .catch((error: unknown) => {
        console.error(`[${AGENT_NAME}] [${this.sessionId}] failed to send ${update.sessionUpdate}: ${asMessage(error)}`)
      })
  }

  /** Runs one turn: register the turn BEFORE sending the prompt, because the ack
   * and a synchronously-dispatched `agent_start` can arrive in one stdout chunk,
   * ahead of the `await request` continuation — subscribing after would miss it.
   * Both cancel paths (`session/cancel` and the prompt's own `$/cancel_request`
   * abort signal) converge on `cancel()`. */
  async runPrompt(prompt: FlattenedPrompt, signal: AbortSignal): Promise<StopReason> {
    if (this.closing) throw closingError()
    if (this.exitError) throw this.exitError
    const client = this.requireClient()
    if (this.activeTurn !== null) {
      throw new acp.RequestError(JSONRPC_INVALID_REQUEST, 'a turn is already in progress for this session')
    }
    // Already cancelled before anything was sent: no turn runs, nothing to abort.
    if (signal.aborted) return 'cancelled'

    const turn = new TurnHandler({
      notifier: this.notifier,
      sessionId: this.sessionId,
      requestAbort: () => this.requestAbort(),
    })
    this.activeTurn = turn
    const onAbort = (): void => this.cancel()
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      try {
        // The ack returns only after preflight (which can run a compaction), so it
        // gets a far more generous bound than a metadata round-trip.
        await client.request({ type: 'prompt', message: prompt.message, images: prompt.images }, { timeoutMs: PROMPT_ACK_TIMEOUT_MS })
        turn.armStartTimer()
      } catch (ackFailure) {
        // A close during preflight rejects the in-flight ack through the
        // transport. The turn was abandoned in the same breath, so it already
        // holds `cancelled`; reporting the teardown as a prompt failure would
        // turn the client's own close into an error.
        if (!this.closing) throw ackFailure
      }
      const reason = await turn.settled
      // Nothing left to name or meter on a session whose subprocess is stopping.
      if (this.closing) return reason
      await this.maybeSetTitle(client, prompt.firstText)
      await this.emitEndOfTurnUsage(client)
      return reason
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.activeTurn = null
    }
  }

  /** Synthesizes `usage_update` from the authoritative post-turn context stats.
   * Best-effort: usage never fails a turn, and `null` tokens (right after a
   * compaction, before the next response) are skipped and self-heal next turn. */
  private async emitEndOfTurnUsage(client: PiClientLike): Promise<void> {
    try {
      const stats = await client.request({ type: 'get_session_stats' })
      const usage = stats.data.contextUsage
      if (usage === undefined || usage.tokens === null) return
      this.emit(usageUpdate(usage.tokens, usage.contextWindow, stats.data.cost))
    } catch (error) {
      console.error(`[${AGENT_NAME}] [${this.sessionId}] failed to report end-of-turn usage: ${asMessage(error)}`)
    }
  }

  /** Answers a Pi extension dialog. Only a sentinel `select` from the permission
   * gate is mapped to `session/request_permission`; every other dialog fails
   * closed (the gate reads a cancel as deny). Never throws — a rejection here
   * would escape the transport's sync stdout handler. */
  async handleExtensionUiRequest(request: RpcExtensionUIRequest): Promise<RpcExtensionUIResponse> {
    const cancelled: RpcExtensionUIResponse = { type: 'extension_ui_response', id: request.id, cancelled: true }
    if (request.method !== 'select') return cancelled
    const decoded = decodeSentinelTitle(request.title)
    if (decoded === null) return cancelled
    // Pi emits `tool_execution_start` before running the `tool_call` hook, so the
    // turn already announced this id and cached its input. A miss is a sentinel
    // from outside a live tool call (no turn, or a forged title): deny silently.
    const announced = this.activeTurn?.announcedToolCall(decoded.toolCallId)
    if (announced === undefined) {
      console.error(`[${AGENT_NAME}] [${this.sessionId}] permission sentinel for unannounced tool call ${decoded.toolCallId}, denying`)
      return cancelled
    }
    const optionId = await this.requestPermission(decoded.toolCallId, announced)
    // Mirror the gate's default-deny: only an explicit allow runs the tool. A
    // blocked tool still gets a failed `tool_execution_end` from Pi, which
    // closes the announced row.
    if (optionId === PERMISSION_OPTION_ALLOW_ONCE || optionId === PERMISSION_OPTION_ALLOW_ALWAYS) {
      return { type: 'extension_ui_response', id: request.id, value: optionId }
    }
    return cancelled
  }

  /** The selected option id (echoed verbatim to the gate) or null on
   * cancel/timeout/closed — all of which the gate treats as deny. On timeout the
   * client is sent `$/cancel_request` so its dialog closes too; cancellation is
   * cooperative, so the timer stays the hard bound. */
  private async requestPermission(toolCallId: string, tool: AnnouncedToolCall): Promise<string | null> {
    const cancellation = new AbortController()
    try {
      const response = await withTimeout(
        this.notifier.request(
          acp.methods.client.session.requestPermission,
          {
            sessionId: this.sessionId,
            toolCall: {
              toolCallId,
              title: toolTitle(tool.toolName, tool.args),
              kind: toolKind(tool.toolName),
              rawInput: tool.args,
            },
            options: buildPermissionOptions(),
          },
          { cancellationSignal: cancellation.signal },
        ),
        PERMISSION_REQUEST_TIMEOUT_MS,
        () => cancellation.abort(),
      )
      return response.outcome.outcome === 'selected' ? response.outcome.optionId : null
    } catch (error) {
      console.error(`[${AGENT_NAME}] [${this.sessionId}] permission request failed, denying: ${asMessage(error)}`)
      return null
    }
  }

  /** Titles a nameless session from the first line of the prompt's first text
   * block (never an inlined resource's `uri:` header). Skipped when that trims
   * empty (an image- or resource-only prompt), since Pi rejects an empty name.
   * Fire-and-forget: the resulting `session_info_changed` drives the update. */
  private async maybeSetTitle(client: PiClientLike, firstText: string): Promise<void> {
    if (!this.needsTitle) return
    const title = deriveTitle(firstText)
    if (title === '') return
    this.needsTitle = false
    try {
      await client.request({ type: 'set_session_name', name: title })
    } catch (error) {
      console.error(`[${AGENT_NAME}] [${this.sessionId}] failed to set the session name: ${asMessage(error)}`)
    }
  }

  /** Sticky-cancels the active turn and asks Pi to abort. The abort is fire and
   * forget: Pi defers it until the run is idle, so its ack can lag `agent_settled`
   * or race teardown; the turn resolves off `agent_settled`/the sticky flag. */
  cancel(): void {
    if (this.activeTurn === null) return
    this.activeTurn.cancel()
    this.requestAbort()
  }

  private requestAbort(): void {
    void this.piClient?.request({ type: 'abort' }).catch(() => undefined)
  }

  handleExit(error: Error): void {
    if (this.exitError === null) this.exitError = error
    this.activeTurn?.fail(error)
  }

  /** Ends the session at the client's request (`session/close`). The abort goes
   * out before the teardown so Pi stops the run while its stdin is still open,
   * and the turn is abandoned rather than failed: the client asked for this, so
   * its pending `session/prompt` answers `cancelled` instead of erroring. */
  async close(): Promise<void> {
    this.closing = true
    this.cancel()
    this.activeTurn?.abandon()
    await this.piClient?.stop()
  }

  async stop(): Promise<void> {
    // An intentional stop suppresses the client's onExit, so handleExit won't
    // fire; fail the active turn here or runPrompt hangs on a promise nobody
    // resolves. This is connection-close teardown, not `session/close` — the
    // client is gone, so the turn ends as an error rather than a cancel.
    this.activeTurn?.fail(new Error('the session was closed while a turn was in progress'))
    await this.piClient?.stop()
  }

  private buildConfig(
    state: RpcSessionState,
    models: readonly ModelChoice[],
    levels: readonly ThinkingLevelValue[],
  ): ConfigState {
    const currentModel = state.model === undefined ? undefined : { provider: state.model.provider, id: state.model.id }
    const options = buildConfigOptions({ models, currentModel, levels, currentLevel: state.thinkingLevel })
    return { models, levels, currentModel, currentLevel: state.thinkingLevel, options }
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

function closingError(): acp.RequestError {
  return new acp.RequestError(JSONRPC_INVALID_REQUEST, 'the session is closing')
}

/** Rejects if the promise has not settled within `ms`, running `onTimeout` first
 * so the caller can cancel the underlying request; a late settle is ignored. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error(`timed out after ${ms}ms`))
    }, ms)
    timer.unref()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

