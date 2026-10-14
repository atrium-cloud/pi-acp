import { existsSync } from 'node:fs'

import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext, AvailableCommand, SessionConfigOption, SessionUpdate, StopReason, Usage } from '@agentclientprotocol/sdk'

import {
  AGENT_NAME,
  BUILTIN_COMMAND_COMPACT,
  BUILTIN_COMMAND_NAME,
  BUILTIN_COMMAND_SESSION,
  BUILTIN_TEXT_NAME_USAGE,
  BUILTIN_TEXT_PARAGRAPH_BREAK,
  builtinTextCompacted,
  builtinTextCompactionFailed,
  builtinTextName,
  builtinTextNameNormalized,
  builtinTextNameSet,
  COMPACT_TIMEOUT_MS,
  CONFIG_ID_MODEL,
  CONFIG_ID_THOUGHT_LEVEL,
  extensionNotifyLogLine,
  idleTeardownLogLine,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  NOTICE_SEVERITY_DEFAULT,
  PERMISSION_OPTION_ALLOW_ALWAYS,
  PERMISSION_OPTION_ALLOW_ONCE,
  PERMISSION_REQUEST_TIMEOUT_MS,
  PI_COMPACTION_CANCELLED,
  PROMPT_ACK_TIMEOUT_MS,
} from '../constants.js'
import { buildPermissionOptions, decodeSentinelTitle } from '../permissions/gate.js'
import { PiRpcError } from '../pi/errors.js'
import type { PiRpcClient, PiRpcClientOptions, RpcNotifyRequest, StartupTiming } from '../pi/PiRpcClient.js'
import type {
  JsonAgentSessionEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcSessionState,
  SessionStats,
} from '../pi/types.js'
import { asMessage } from '../server/errors.js'
import { buildConfigOptions, type ModelChoice, resolveModelSelection } from '../turn/configOptions.js'
import { configOptionUpdate, sessionInfoUpdate, toolKind, toolTitle, turnUsage, usageUpdate } from '../turn/mappers.js'
import type { FlattenedPrompt } from '../turn/promptContent.js'
import { type AnnouncedToolCall, type TurnEventSink, TurnHandler } from '../turn/TurnHandler.js'
import { type BuiltinCommand, BuiltinCommandRun, formatSessionInfo, parseBuiltinCommand } from './builtinCommands.js'
import { replayUpdates } from './replay.js'
import { isUserMessageEntry, messageMapPathFor, readMessageMap, type SessionFileEntry, writeMessageMap } from './sessionDirectory.js'
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
  readonly startupTiming: StartupTiming | undefined
  stderrTail(): string
}

export type CreatePiClient = (options: PiRpcClientOptions) => PiClientLike

/** A started Pi subprocess and what a session is built from. */
export interface LaunchedPi {
  readonly piClient: PiClientLike
  readonly state: RpcSessionState
  readonly models: readonly ModelChoice[]
  readonly levels: readonly ThinkingLevelValue[]
  readonly commands: readonly AvailableCommand[]
}

/** Where a wake points Pi: the session's file once Pi has written one, else its
 * exact id, since Pi files a session only once its tree holds a message. */
export type RelaunchTarget =
  | { readonly kind: 'file'; readonly sessionFile: string; readonly sessionId: string }
  | { readonly kind: 'id'; readonly sessionId: string }

/** Launches a fresh subprocess for this session, wired to it like the first. */
export type Relaunch = (target: RelaunchTarget) => Promise<LaunchedPi>

interface ConfigState {
  readonly models: readonly ModelChoice[]
  readonly levels: readonly ThinkingLevelValue[]
  readonly currentModel: { readonly provider: string; readonly id: string } | undefined
  readonly currentLevel: ThinkingLevelValue
  readonly options: SessionConfigOption[]
}

/** A prompt waiting on a wake: a cancel answers it `cancelled`, a stop fails it. */
interface WakeWaiter {
  readonly cancel: () => void
  readonly fail: (error: Error) => void
}

/** The result of one `session/prompt`. `acknowledgedMessageId` is the client's own
 * breakpoint message id, echoed back only once it is recorded against a Pi entry
 * id, so a client that sees no echo knows the prompt cannot be forked from.
 * `usage` is set only when a turn or compaction ran and both stats reads held. */
export interface PromptOutcome {
  readonly stopReason: StopReason
  readonly usage: Usage | undefined
  readonly acknowledgedMessageId: string | undefined
}

const CANCELLED_OUTCOME: PromptOutcome = { stopReason: 'cancelled', usage: undefined, acknowledgedMessageId: undefined }

/** Persistent per-session object, created at `session/new` and living until the
 * client closes it or the connection ends. It owns the single exhaustive router
 * over `JsonAgentSessionEvent`: session-level arms it handles itself; turn-scoped arms
 * it forwards to the active turn. Subscribing here once (rather than per turn)
 * keeps session-level updates that fire between turns from being lost. */
export class SessionConnection {
  private readonly notifier: AgentContext
  private readonly clientSupportsNotices: boolean
  private readonly relaunch: Relaunch
  readonly cwd: string
  private piClient: PiClientLike | null = null
  private sessionId = ''
  private config: ConfigState | null = null
  /** The advertised commands as last read from Pi; resume and load re-announce them. */
  private commands: readonly AvailableCommand[] = []
  /** Pi's name for the session, kept so a wake can give it back to a Pi that lost it. */
  private sessionName: string | undefined
  /** A `set_*` may apply before its follow-up re-read lands; when that read
   * fails the cache no longer reflects Pi, so the next change re-reads first. */
  private configStale = false
  private activeTurn: TurnEventSink | null = null
  /** Tool names the client allowed always. */
  private readonly grantedTools = new Set<string>()
  /** Set once the subprocess dies; a later request answers with this cause. */
  private exitError: Error | null = null
  /** Set by `close()`; a closed session is never used again, so every later
   * request is rejected rather than raced against the teardown. */
  private closing = false
  /** Set by `stop()`, the connection-close teardown. */
  private stopped = false
  private idleTimeoutMs: number | null = null
  private idleTimer: NodeJS.Timeout | null = null
  /** Prompts, config changes and replays in flight; idle teardown waits for none. */
  private busy = 0
  /** From an idle teardown until a wake attaches a new subprocess. */
  private dormant = false
  /** The idle teardown's stop. A wake awaits it, since two Pi processes on one
   * file would interleave appends. */
  private teardown: Promise<void> | null = null
  private waking: Promise<PiClientLike> | null = null
  /** An exit the wake's own subprocess reported before the wake attached it. */
  private relaunchExit: Error | null = null
  private readonly wakeWaiters = new Set<WakeWaiter>()
  /** True until this session gets a name; the first prompt derives one. */
  private needsTitle = false
  /** Pi's own file for this session, undefined when Pi persists nothing; without
   * it there is nowhere to put the sidecar, so nothing is ever recorded. */
  private sessionFile: string | undefined
  /** The breakpoint map, read from the sidecar at most once per connection (a
   * resumed or forked session inherits one) and rewritten whole after that. */
  private messageMap: Readonly<Record<string, string>> | null = null
  /** False until the first command snapshot goes out; a notice that arrives
   * before then waits in `pendingNotices`, since the client could not route it. */
  private announced = false
  private pendingNotices: SessionUpdate[] = []

  constructor(init: { notifier: AgentContext; cwd: string; clientSupportsNotices: boolean; relaunch: Relaunch }) {
    this.notifier = init.notifier
    this.cwd = init.cwd
    this.clientSupportsNotices = init.clientSupportsNotices
    this.relaunch = init.relaunch
  }

  attach(launched: LaunchedPi): void {
    const { state } = launched
    this.piClient = launched.piClient
    this.sessionId = state.sessionId
    this.config = this.buildConfig(state, launched.models, launched.levels)
    this.configStale = false
    this.commands = launched.commands
    this.sessionName = state.sessionName
    this.needsTitle = isUnnamed(state.sessionName)
    this.sessionFile = state.sessionFile
  }

  /** Stops the subprocess once the session has been idle `ms`; the next prompt,
   * config change or load relaunches it. Only a registered session is armed: a
   * held warm spare has its own age cap. */
  enableIdleTeardown(ms: number): void {
    this.idleTimeoutMs = ms
    this.armIdleTimer()
  }

  get configOptions(): SessionConfigOption[] {
    return this.requireConfig().options
  }

  get dead(): Error | null {
    return this.exitError
  }

  /** True while the store's tail is a turn Pi is still appending: from its report
   * of the turn's user message until the turn settles. A built-in never counts,
   * since its writes each land whole. */
  get hasUnsettledTurnInStore(): boolean {
    return this.activeTurn instanceof TurnHandler && this.activeTurn.reportedUserMessage && !this.activeTurn.isSettled
  }

  /** Sends the command snapshot after `session/new` has returned. It is deferred
   * a macrotask because the SDK client only attaches its session-update queue
   * inside the `session/new` response callback (acp.js SessionUpdateRouter), so an
   * update sent before that response lands is dropped for an unknown session.
   * Notices held back during setup follow it, in arrival order. */
  announceCommands(): void {
    setTimeout(() => {
      if (this.exitError || this.closing) return
      void this.notifier
        .notify(acp.methods.client.session.update, {
          sessionId: this.sessionId,
          update: { sessionUpdate: 'available_commands_update', availableCommands: [...this.commands] },
        })
        .catch((error: unknown) => {
          console.error(`[${AGENT_NAME}] [${this.sessionId}] failed to send available_commands_update: ${asMessage(error)}`)
        })
      this.announced = true
      const notices = this.pendingNotices
      this.pendingNotices = []
      for (const notice of notices) this.emit(notice)
    }, 0)
  }

  /** Replays the stored transcript for `session/load`. ACP puts the history
   * before the response, so unlike `emit` these are awaited in order rather than
   * fired and forgotten, and a failure fails the load. */
  async replayHistory(): Promise<void> {
    await this.whileBusy(async () => {
      const client = await this.awakeClient()
      const history = await client.request({ type: 'get_messages' })
      for (const update of replayUpdates(history.data.messages, this.cwd)) {
        await this.notifier.notify(acp.methods.client.session.update, { sessionId: this.sessionId, update })
      }
    })
  }

  async applyConfigOption(configId: string, value: string): Promise<SessionConfigOption[]> {
    return await this.whileBusy(() => this.applyConfigOptionAwake(configId, value))
  }

  private async applyConfigOptionAwake(configId: string, value: string): Promise<SessionConfigOption[]> {
    const client = await this.awakeClient()
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

  /** Re-reads the whole option set for a warm spare as it is taken: Pi refreshes
   * its model catalog in the background after startup, so the list read at
   * build time can be stale. */
  async refreshConfig(): Promise<SessionConfigOption[]> {
    await this.refresh(this.requireClient())
    return this.requireConfig().options
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
    // Until a wake attaches, events are its restore `set_*` echoes (an id wake's
    // `set_model` passes through Pi's default level); the wake reports the outcome.
    if (this.dormant) return
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
    this.sessionName = event.name
    this.needsTitle = isUnnamed(event.name)
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

  /** Wakes a dormant session first. A cancel, the prompt's abort signal or a
   * close during the wake answers `cancelled` without sending the prompt; the
   * turn checks run only once the wake lands, so two prompts racing one wake
   * cannot both start a turn. */
  async runPrompt(prompt: FlattenedPrompt, signal: AbortSignal, messageId?: string): Promise<PromptOutcome> {
    return await this.whileBusy(async () => {
      if (this.dormant && (signal.aborted || !(await this.awaitWake(signal)))) return CANCELLED_OUTCOME
      return await this.runLivePrompt(prompt, signal, messageId)
    })
  }

  /** Runs one turn: register the turn BEFORE sending the prompt, because the ack
   * and a synchronously-dispatched `agent_start` can arrive in one stdout chunk,
   * ahead of the `await request` continuation — subscribing after would miss it.
   * Both cancel paths (`session/cancel` and the prompt's own `$/cancel_request`
   * abort signal) converge on `cancel()`. */
  private async runLivePrompt(prompt: FlattenedPrompt, signal: AbortSignal, messageId?: string): Promise<PromptOutcome> {
    const client = this.liveClient()
    if (this.activeTurn !== null) {
      throw new acp.RequestError(JSONRPC_INVALID_REQUEST, 'a turn is already in progress for this session')
    }
    // Already cancelled before anything was sent: no turn runs, nothing to abort.
    if (signal.aborted) return CANCELLED_OUTCOME
    // Checked before anything reaches Pi, so a built-in shadows a same-named
    // extension command the way it does in Pi's own TUI.
    const builtin = parseBuiltinCommand(prompt.message)
    if (builtin !== undefined) return await this.runBuiltinCommand(client, builtin, signal)

    const turn = new TurnHandler({
      notifier: this.notifier,
      sessionId: this.sessionId,
      cwd: this.cwd,
      requestAbort: () => this.requestAbort(),
    })
    this.activeTurn = turn
    const onAbort = (): void => this.cancel()
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      const before = this.readSessionTokens(client)
      try {
        // The ack returns only after preflight (which can run a compaction), so it
        // gets a far more generous bound than a metadata round-trip. Its
        // disposition says whether a run started or an extension command handled
        // the prompt without one.
        const ack = await client.request(
          { type: 'prompt', message: prompt.message, images: prompt.images },
          { timeoutMs: PROMPT_ACK_TIMEOUT_MS },
        )
        turn.acknowledge(ack.data.disposition)
      } catch (ackFailure) {
        // A close during preflight rejects the in-flight ack through the
        // transport. The turn was abandoned in the same breath, so it already
        // holds `cancelled`; reporting the teardown as a prompt failure would
        // turn the client's own close into an error.
        if (!this.closing) throw ackFailure
      }
      const reason = await turn.settled
      // Nothing left to name or meter on a session whose subprocess is stopping,
      // nor on a prompt an extension command handled without running a turn:
      // its text is the command line, not a title, and no tokens were spent.
      if (this.closing || !turn.startedTurn) return { stopReason: reason, usage: undefined, acknowledgedMessageId: undefined }
      await this.maybeSetTitle(client, prompt.firstText)
      const usage = await this.reportEndOfTurnUsage(client, await before)
      // Only a reported user message is in Pi's tree; before that report the last
      // user entry is the previous prompt's.
      const acknowledgedMessageId =
        messageId === undefined || !turn.reportedUserMessage ? undefined : await this.recordMessageId(client, messageId)
      return { stopReason: reason, usage, acknowledgedMessageId }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.activeTurn = null
    }
  }

  /** Runs one of Pi's TUI built-ins through its RPC equivalent. It holds the
   * session like a turn does, but Pi appends no user entry for it, so nothing is
   * titled or recorded. */
  private async runBuiltinCommand(client: PiClientLike, command: BuiltinCommand, signal: AbortSignal): Promise<PromptOutcome> {
    const run = new BuiltinCommandRun()
    this.activeTurn = run
    const onAbort = (): void => this.cancel()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      run.track(this.executeBuiltinCommand(client, command, run))
      const stopReason = await run.settled
      return { stopReason, usage: run.usage, acknowledgedMessageId: undefined }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.activeTurn = null
    }
  }

  private async executeBuiltinCommand(
    client: PiClientLike,
    command: BuiltinCommand,
    run: BuiltinCommandRun,
  ): Promise<Usage | undefined> {
    switch (command.kind) {
      case BUILTIN_COMMAND_COMPACT: {
        const { customInstructions } = command
        const before = this.readSessionTokens(client)
        let compaction
        try {
          compaction = await client.request(
            { type: 'compact', ...(customInstructions === undefined ? {} : { customInstructions }) },
            { timeoutMs: COMPACT_TIMEOUT_MS },
          )
        } catch (error) {
          // Pi refuses before it writes anything, so the session carries on unchanged.
          if (!(error instanceof PiRpcError) || run.isCancelled) throw error
          const reason = error.piMessage
          this.emitAgentText(reason === PI_COMPACTION_CANCELLED ? reason : builtinTextCompactionFailed(reason))
          return undefined
        }
        this.emitAgentText(builtinTextCompacted(compaction.data.tokensBefore.toLocaleString()))
        return await this.reportEndOfTurnUsage(client, await before)
      }
      case BUILTIN_COMMAND_NAME: {
        if (command.name === '') {
          const state = await client.request({ type: 'get_state' })
          const current = state.data.sessionName
          this.emitAgentText(current ? builtinTextName(current) : BUILTIN_TEXT_NAME_USAGE)
          return undefined
        }
        await client.request({ type: 'set_session_name', name: command.name })
        this.needsTitle = false
        // Pi normalizes the name it stores (a newline becomes a space), so the
        // reply reads back what it kept.
        const stored = (await client.request({ type: 'get_state' })).data.sessionName
        this.sessionName = stored
        const set = builtinTextNameSet(stored ?? command.name)
        this.emitAgentText(
          stored === command.name ? set : `${builtinTextNameNormalized(command.name, stored)}${BUILTIN_TEXT_PARAGRAPH_BREAK}${set}`,
        )
        return undefined
      }
      case BUILTIN_COMMAND_SESSION: {
        const [stats, state] = await Promise.all([
          client.request({ type: 'get_session_stats' }),
          client.request({ type: 'get_state' }),
        ])
        this.emitAgentText(formatSessionInfo(stats.data, state.data.sessionName))
        return undefined
      }
    }
  }

  private emitAgentText(text: string): void {
    this.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  }

  /** Pi's session token totals, read just before the command that runs a turn,
   * with no await in between: Pi answers in arrival order, so the read predates
   * the turn, and a cancel cannot slip in before that command is sent. */
  private readSessionTokens(client: PiClientLike): Promise<SessionStats['tokens'] | undefined> {
    return client.request({ type: 'get_session_stats' }).then(
      (stats) => stats.data.tokens,
      (error: unknown) => {
        console.error(`[${AGENT_NAME}] [${this.sessionId}] failed to read session tokens before the turn: ${asMessage(error)}`)
        return undefined
      },
    )
  }

  /** Synthesizes `usage_update` from the authoritative post-turn context stats and
   * returns the turn's token usage. Best-effort: usage never fails a turn, and
   * `null` context tokens (right after a compaction, before the next response)
   * skip the update and self-heal next turn. */
  private async reportEndOfTurnUsage(client: PiClientLike, before: SessionStats['tokens'] | undefined): Promise<Usage | undefined> {
    try {
      const stats = await client.request({ type: 'get_session_stats' })
      const context = stats.data.contextUsage
      if (context !== undefined && context.tokens !== null) {
        this.emit(usageUpdate(context.tokens, context.contextWindow, stats.data.cost))
      }
      return before === undefined ? undefined : turnUsage(before, stats.data.tokens)
    } catch (error) {
      console.error(`[${AGENT_NAME}] [${this.sessionId}] failed to report end-of-turn usage: ${asMessage(error)}`)
      return undefined
    }
  }

  /** Binds the client's breakpoint message id to the Pi entry id of the prompt
   * this turn just ran, so a later fork can cut the tree there. Called once Pi
   * has reported the turn's user message, which it appends to the file (creating
   * it on a first turn) before the report reaches stdout, so the turn's prompt is
   * the last user message entry in file order. Returns the id only once the
   * sidecar holds it: an unrecorded prompt must not be echoed as forkable, so
   * every failure here degrades to no echo rather than failing the turn. */
  private async recordMessageId(client: PiClientLike, messageId: string): Promise<string | undefined> {
    const sessionFile = this.sessionFile
    if (sessionFile === undefined) return undefined
    const sidecarPath = messageMapPathFor(sessionFile)
    try {
      const entries = await client.request({ type: 'get_entries' })
      const entryId = lastUserEntryId(entries.data.entries)
      if (entryId === undefined) throw new Error('the session tree holds no user message entry')
      const loaded = this.messageMap ?? readMessageMap(sidecarPath) ?? {}
      this.messageMap = loaded
      const messages = { ...loaded, [messageId]: entryId }
      writeMessageMap(sidecarPath, messages)
      this.messageMap = messages
      return messageId
    } catch (error) {
      console.error(
        `[${AGENT_NAME}] [${this.sessionId}] failed to record breakpoint message id "${messageId}": ${asMessage(error)}`,
      )
      return undefined
    }
  }

  /** Logs an extension's `ctx.ui.notify` and forwards it as a `notice` too. The
   * line stays either way, so a server log keeps it whatever the client shows;
   * a blank message is never forwarded, since a notice needs a title. */
  handleNotify(request: RpcNotifyRequest): void {
    console.error(extensionNotifyLogLine(request.message))
    if (!this.clientSupportsNotices || request.message.trim() === '') return
    const notice: SessionUpdate = {
      sessionUpdate: 'notice',
      severity: request.notifyType ?? NOTICE_SEVERITY_DEFAULT,
      title: request.message,
    }
    if (this.announced) this.emit(notice)
    else this.pendingNotices.push(notice)
  }

  /** Answers a Pi extension dialog. Only a sentinel `select` from the permission
   * gate is mapped to `session/request_permission` (or answered from this
   * session's grants); every other dialog fails closed (the gate reads a cancel
   * as deny). Never throws — a rejection here would escape the transport's sync
   * stdout handler. */
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
    // Keyed on the name Pi announced, never `decoded.toolName`: the sentinel's
    // claim can be forged by another extension.
    if (this.grantedTools.has(announced.toolName)) {
      return { type: 'extension_ui_response', id: request.id, value: PERMISSION_OPTION_ALLOW_ONCE }
    }
    const optionId = await this.requestPermission(decoded.toolCallId, announced)
    if (optionId === PERMISSION_OPTION_ALLOW_ALWAYS) this.grantedTools.add(announced.toolName)
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
   * or race teardown; the turn resolves off `agent_settled`/the sticky flag. A
   * prompt still waiting on a wake answers `cancelled` at once. */
  cancel(): void {
    for (const waiter of [...this.wakeWaiters]) waiter.cancel()
    if (this.activeTurn === null) return
    this.activeTurn.cancel()
    this.requestAbort()
  }

  private requestAbort(): void {
    void this.piClient?.request({ type: 'abort' }).catch(() => undefined)
  }

  handleExit(error: Error): void {
    // While dormant only a wake's own subprocess can exit (an intentional stop
    // is silent); that fails the wake alone, and the next request retries.
    if (this.dormant) {
      this.relaunchExit = error
      return
    }
    if (this.exitError === null) this.exitError = error
    this.activeTurn?.fail(error)
  }

  /** Ends the session at the client's request (`session/close`). The abort goes
   * out before the teardown so Pi stops the run while its stdin is still open,
   * and the turn is abandoned rather than failed: the client asked for this, so
   * its pending `session/prompt` answers `cancelled` instead of erroring. */
  async close(): Promise<void> {
    this.closing = true
    this.clearIdleTimer()
    this.cancel()
    this.activeTurn?.abandon()
    await this.settleIdleWork()
    await this.piClient?.stop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearIdleTimer()
    // An intentional stop suppresses the client's onExit, so handleExit won't
    // fire; fail the active turn here or runPrompt hangs on a promise nobody
    // resolves. This is connection-close teardown, not `session/close` — the
    // client is gone, so the turn ends as an error rather than a cancel.
    const error = new Error('the session was closed while a turn was in progress')
    for (const waiter of [...this.wakeWaiters]) waiter.fail(error)
    this.activeTurn?.fail(error)
    await this.settleIdleWork()
    await this.piClient?.stop()
  }

  // ── Idle teardown and wake ──────────────────────────────────────────────────

  private async whileBusy<T>(work: () => Promise<T>): Promise<T> {
    this.clearIdleTimer()
    this.busy++
    try {
      return await work()
    } finally {
      this.busy--
      this.armIdleTimer()
    }
  }

  private get isIdle(): boolean {
    return this.busy === 0 && !this.dormant && !this.closing && !this.stopped && this.exitError === null
  }

  private armIdleTimer(): void {
    if (this.idleTimeoutMs === null || this.idleTimer !== null || !this.isIdle) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.tearDownIfIdle()
    }, this.idleTimeoutMs)
    this.idleTimer.unref()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private tearDownIfIdle(): void {
    const client = this.piClient
    if (!this.isIdle || client === null) return
    this.dormant = true
    this.piClient = null
    this.teardown = client.stop().catch((error: unknown) => {
      console.error(idleTeardownLogLine(this.sessionId, `failed to stop the idle Pi subprocess: ${asMessage(error)}`))
    })
  }

  /** Lets a pending idle stop and any wake land first, so the client a wake
   * attached is the one stopped. A failed wake already answered its requests. */
  private async settleIdleWork(): Promise<void> {
    await this.teardown
    await this.waking?.catch(() => undefined)
  }

  private async awakeClient(): Promise<PiClientLike> {
    if (this.dormant) await this.ensureAwake()
    return this.liveClient()
  }

  private liveClient(): PiClientLike {
    if (this.closing) throw closingError()
    if (this.exitError) throw this.exitError
    return this.requireClient()
  }

  /** Resolves false when a cancel, the prompt's abort signal or a close lands
   * before the wake does, so the prompt answers without waiting on the spawn. */
  private awaitWake(signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const settle = (done: () => void): void => {
        this.wakeWaiters.delete(waiter)
        signal.removeEventListener('abort', waiter.cancel)
        done()
      }
      const waiter: WakeWaiter = {
        cancel: () => settle(() => resolve(false)),
        fail: (error) => settle(() => reject(error)),
      }
      this.wakeWaiters.add(waiter)
      signal.addEventListener('abort', waiter.cancel, { once: true })
      this.ensureAwake().then(
        () => settle(() => resolve(true)),
        (error: unknown) => settle(() => reject(error)),
      )
    })
  }

  /** One wake at a time: every request that finds the session dormant shares it.
   * A failure is logged too, since a cancelled prompt may leave nobody to receive it. */
  private ensureAwake(): Promise<PiClientLike> {
    if (this.waking === null) {
      this.waking = this.wake().finally(() => {
        this.waking = null
      })
      this.waking.catch((error: unknown) => {
        console.error(idleTeardownLogLine(this.sessionId, `wake failed: ${asMessage(error)}`))
      })
    }
    return this.waking
  }

  /** Relaunches the subprocess an idle teardown stopped. A failure goes to the
   * requests waiting on it and leaves the session dormant for the next to retry. */
  private async wake(): Promise<PiClientLike> {
    await this.teardown
    this.throwIfEnded()
    // Taken before the relaunch: a restore `set_*` echoes back into the cache.
    const wanted = { config: this.requireConfig(), name: this.sessionName }
    const sessionFile = this.sessionFile
    this.relaunchExit = null
    const launched = await this.relaunch(
      sessionFile !== undefined && existsSync(sessionFile)
        ? { kind: 'file', sessionFile, sessionId: this.sessionId }
        : { kind: 'id', sessionId: this.sessionId },
    )
    let restored: LaunchedPi
    try {
      this.throwIfEnded()
      restored = await this.restore(launched, wanted)
      this.throwIfEnded()
      // The restore swallows a failed `set_*`, so an exit it hit only shows here.
      if (this.relaunchExit !== null) throw this.relaunchExit
    } catch (error) {
      await launched.piClient.stop()
      throw error
    }
    const seen = { options: this.configOptions, commands: this.commands }
    this.attach(restored)
    this.dormant = false
    this.teardown = null
    if (!sameJson(this.configOptions, seen.options)) this.emit(configOptionUpdate(this.configOptions))
    if (!sameJson(this.commands, seen.commands)) {
      this.emit({ sessionUpdate: 'available_commands_update', availableCommands: [...this.commands] })
    }
    // A prompt cancelled during the wake has already left, so nothing else re-arms it.
    this.armIdleTimer()
    return launched.piClient
  }

  /** Gives a relaunched Pi back what it lost: one that opened by id (never
   * filed) starts on its defaults. Model before level, since `set_model`
   * re-resolves the level. Returns the launch with what Pi then reports. */
  private async restore(
    launched: LaunchedPi,
    wanted: { readonly config: ConfigState; readonly name: string | undefined },
  ): Promise<LaunchedPi> {
    const client = launched.piClient
    let { state, levels } = launched
    let reapplied = false
    const model = wanted.config.currentModel
    const modelDiffers = state.model?.provider !== model?.provider || state.model?.id !== model?.id
    if (model !== undefined && modelDiffers) {
      const set = () => client.request({ type: 'set_model', provider: model.provider, modelId: model.id })
      if (await this.reapply('model', set)) {
        reapplied = true
        const [after, levelsAfter] = await Promise.all([
          client.request({ type: 'get_state' }),
          client.request({ type: 'get_available_thinking_levels' }),
        ])
        state = after.data
        levels = levelsAfter.data.levels
      }
    }
    const level = wanted.config.currentLevel
    if (state.thinkingLevel !== level) {
      const set = () => client.request({ type: 'set_thinking_level', level })
      if (await this.reapply('thinking level', set)) reapplied = true
    }
    const name = wanted.name
    if (name !== undefined && !isUnnamed(name) && state.sessionName !== name) {
      const set = () => client.request({ type: 'set_session_name', name })
      if (await this.reapply('session name', set)) reapplied = true
    }
    if (reapplied) state = (await client.request({ type: 'get_state' })).data
    return { ...launched, state, levels }
  }

  /** Best effort: a failed re-apply is logged, and the wake carries on with what Pi reports. */
  private async reapply(what: string, apply: () => Promise<unknown>): Promise<boolean> {
    try {
      await apply()
      return true
    } catch (error) {
      console.error(idleTeardownLogLine(this.sessionId, `failed to re-apply the ${what} on wake: ${asMessage(error)}`))
      return false
    }
  }

  /** A wake that lands after `close()` or `stop()` attaches nothing. */
  private throwIfEnded(): void {
    if (this.closing) throw closingError()
    if (this.stopped) throw new Error('the client connection closed')
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

function lastUserEntryId(entries: readonly SessionFileEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry !== undefined && isUserMessageEntry(entry) && typeof entry.id === 'string') return entry.id
  }
  return undefined
}

function isUnnamed(name: string | undefined): boolean {
  return (name ?? '').trim() === ''
}

/** Both sides come from the same builders, so equal values serialize alike. */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
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

