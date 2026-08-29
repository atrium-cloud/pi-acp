import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext, SessionUpdate, StopReason } from '@agentclientprotocol/sdk'

import { AGENT_NAME, AGENT_START_GRACE_MS, JSONRPC_INTERNAL_ERROR } from '../constants.js'
import type { JsonAgentSessionEvent } from '../pi/types.js'
import { asMessage, toRequestError } from '../server/errors.js'
import { toolCallEnded, toolCallProgress, toolCallStarted } from './mappers.js'

export interface AnnouncedToolCall {
  readonly toolName: string
  readonly args: unknown
}

/** A live turn consuming the turn-scoped Pi events the session router forwards.
 * `SessionConnection` registers exactly one at a time as its `activeTurn`. */
export interface TurnEventSink {
  handleEvent(event: JsonAgentSessionEvent): void
  /** The subprocess died mid-turn; fail the turn with its cause. */
  fail(error: Error): void
  /** A cancel was requested; the turn resolves `cancelled` once it settles. */
  cancel(): void
  /** The input cached at `tool_execution_start` for a tool still running, so a
   * permission request can carry it without the gate re-sending it. Pi emits
   * the start event before it runs the `tool_call` hook, so a miss means the id
   * was never announced this turn. */
  announcedToolCall(toolCallId: string): AnnouncedToolCall | undefined
}

type MessageUpdate = Extract<JsonAgentSessionEvent, { type: 'message_update' }>['assistantMessageEvent']

export interface TurnHandlerOptions {
  readonly notifier: AgentContext
  readonly sessionId: string
  readonly graceMs?: number
  /** Re-issues Pi's `abort` when a cancel landed before the turn was running:
   * `session.abort` is a no-op while Pi is still in preflight, so an early cancel
   * has to be re-sent once `agent_start` proves the run is active. */
  readonly requestAbort?: () => void
}

/** Translates one Pi turn into ACP `session/update`s and a final `StopReason`.
 * Text/thinking deltas stream as chunks; the turn settles on `agent_settled`
 * (bare), resolving the stop reason captured from the last assistant message —
 * or throwing a `RequestError`, since ACP has no errored `StopReason`. */
export class TurnHandler implements TurnEventSink {
  readonly settled: Promise<StopReason>
  private resolve!: (reason: StopReason) => void
  private reject!: (error: Error) => void

  private readonly notifier: AgentContext
  private readonly sessionId: string
  private readonly graceMs: number
  private readonly requestAbort: (() => void) | undefined

  private done = false
  private startSeen = false
  private startTimer: NodeJS.Timeout | null = null
  private cancelled = false
  private lastStopReason: string | null = null
  private lastErrorMessage: string | undefined
  /** Content indices already streamed via deltas, so `*_end` doesn't re-emit;
   * cleared on each `message_start` because `contentIndex` restarts at 0 per
   * message (a tool loop emits several assistant messages in one turn). */
  private readonly streamedIndices = new Set<number>()
  /** Announced tool calls → the input cached at `tool_execution_start`, since the
   * end event carries no args and an edit diff is built from the input. */
  private readonly announcedToolCalls = new Map<string, AnnouncedToolCall>()

  constructor(options: TurnHandlerOptions) {
    this.notifier = options.notifier
    this.sessionId = options.sessionId
    this.graceMs = options.graceMs ?? AGENT_START_GRACE_MS
    this.requestAbort = options.requestAbort
    this.settled = new Promise<StopReason>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    // The grace timer or fail() can settle before the caller reaches
    // `await settled` (the ack throws first, or the subprocess dies early); this
    // keeps that from surfacing as an unhandled rejection. The real await still
    // receives the outcome.
    void this.settled.catch(() => undefined)
  }

  /** Arms the bounded wait for `agent_start`, called once the prompt ack lands.
   * A no-`agent_start` window means the prompt started no turn — a protocol
   * error, not a silent empty `end_turn`. */
  armStartTimer(): void {
    if (this.startSeen || this.done || this.startTimer !== null) return
    this.startTimer = setTimeout(() => {
      this.startTimer = null
      if (this.startSeen || this.done) return
      if (this.cancelled) {
        this.finish(() => this.resolve('cancelled'))
        return
      }
      this.finish(() =>
        this.reject(
          new acp.RequestError(
            JSONRPC_INTERNAL_ERROR,
            'the prompt was accepted but started no turn (an unadvertised extension command?)',
          ),
        ),
      )
    }, this.graceMs)
    this.startTimer.unref()
  }

  handleEvent(event: JsonAgentSessionEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.startSeen = true
        this.clearStartTimer()
        // A cancel during preflight couldn't reach a running turn; now that one is
        // active, re-issue the abort so it actually stops.
        if (this.cancelled) this.requestAbort?.()
        return
      case 'message_start':
        // The real per-message boundary on the wire: the stream's `start`
        // sub-event is hoisted to this top-level event, never a `message_update`.
        this.streamedIndices.clear()
        return
      case 'message_update':
        this.handleMessageUpdate(event.assistantMessageEvent)
        return
      case 'tool_execution_start':
        this.announcedToolCalls.set(event.toolCallId, { toolName: event.toolName, args: event.args })
        this.emitUpdate(toolCallStarted({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }))
        return
      case 'tool_execution_update': {
        const update = toolCallProgress(event.toolCallId, event.partialResult)
        if (update !== undefined) this.emitUpdate(update)
        return
      }
      // A gate-blocked tool also ends here: Pi finalizes a blocked call as an
      // immediate error result, so the denial reason arrives as a failed end.
      case 'tool_execution_end': {
        const cached = this.announcedToolCalls.get(event.toolCallId)
        this.emitUpdate(
          toolCallEnded({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
            args: cached?.args,
          }),
        )
        this.announcedToolCalls.delete(event.toolCallId)
        return
      }
      case 'message_end':
        if ('role' in event.message && event.message.role === 'assistant') {
          this.captureStop(event.message.stopReason, event.message.errorMessage)
        }
        return
      case 'auto_retry_end':
        if (!event.success && event.finalError !== undefined) this.lastErrorMessage = event.finalError
        return
      case 'compaction_end':
        if (event.errorMessage !== undefined) this.lastErrorMessage = event.errorMessage
        return
      case 'agent_settled':
        this.settle()
        return
      default:
        return
    }
  }

  fail(error: Error): void {
    this.finish(() => this.reject(toRequestError(error)))
  }

  cancel(): void {
    this.cancelled = true
  }

  announcedToolCall(toolCallId: string): AnnouncedToolCall | undefined {
    return this.announcedToolCalls.get(toolCallId)
  }

  /** Only `text_*`/`thinking_*`/`toolcall_*` sub-events ride a `message_update`;
   * the union's `start`/`done`/`error` are hoisted to `message_start`/`message_end`
   * by the agent loop and never reach here (hence no arms for them). */
  private handleMessageUpdate(sub: MessageUpdate): void {
    switch (sub.type) {
      case 'text_delta':
        this.streamedIndices.add(sub.contentIndex)
        this.emitChunk('agent_message_chunk', sub.delta)
        return
      case 'thinking_delta':
        this.streamedIndices.add(sub.contentIndex)
        this.emitChunk('agent_thought_chunk', sub.delta)
        return
      case 'text_end':
        if (!this.streamedIndices.has(sub.contentIndex)) this.emitChunk('agent_message_chunk', sub.content)
        return
      case 'thinking_end':
        if (!this.streamedIndices.has(sub.contentIndex)) this.emitChunk('agent_thought_chunk', sub.content)
        return
      default:
        return
    }
  }

  private emitChunk(sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk', text: string): void {
    this.emitUpdate({ sessionUpdate, content: { type: 'text', text } })
  }

  private emitUpdate(update: SessionUpdate): void {
    if (this.done) return
    void this.notifier
      .notify(acp.methods.client.session.update, { sessionId: this.sessionId, update })
      .catch((error: unknown) => {
        console.error(`[${AGENT_NAME}] [${this.sessionId}] failed to send ${update.sessionUpdate}: ${asMessage(error)}`)
      })
  }

  private captureStop(stopReason: string, errorMessage: string | undefined): void {
    this.lastStopReason = stopReason
    if (errorMessage !== undefined) this.lastErrorMessage = errorMessage
  }

  private settle(): void {
    if (this.done) return
    if (this.cancelled) {
      this.finish(() => this.resolve('cancelled'))
      return
    }
    if (this.lastStopReason === null) {
      // Every real turn emits an assistant `message_end` before `agent_settled`;
      // a null reason means a Pi-internal failure slipped past without an error
      // frame, and reporting it as `end_turn` would surface a failed turn as a
      // clean one (a failed turn never ends `end_turn`).
      this.finish(() =>
        this.reject(new acp.RequestError(JSONRPC_INTERNAL_ERROR, 'the turn settled without a stop reason')),
      )
      return
    }
    switch (this.lastStopReason) {
      case 'error':
        this.finish(() =>
          this.reject(new acp.RequestError(JSONRPC_INTERNAL_ERROR, this.lastErrorMessage ?? 'the turn failed')),
        )
        return
      case 'aborted':
        this.finish(() => this.resolve('cancelled'))
        return
      case 'length':
        this.finish(() => this.resolve('max_tokens'))
        return
      default:
        this.finish(() => this.resolve('end_turn'))
    }
  }

  private finish(settle: () => void): void {
    if (this.done) return
    this.done = true
    this.clearStartTimer()
    settle()
  }

  private clearStartTimer(): void {
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }
  }
}
