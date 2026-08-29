import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext, StopReason } from '@agentclientprotocol/sdk'

import { AGENT_NAME, AGENT_START_GRACE_MS, JSONRPC_INTERNAL_ERROR } from '../constants.js'
import type { JsonAgentSessionEvent } from '../pi/types.js'
import { asMessage, toRequestError } from '../server/errors.js'

/** A live turn consuming the turn-scoped Pi events the session router forwards.
 * `SessionConnection` registers exactly one at a time as its `activeTurn`. */
export interface TurnEventSink {
  handleEvent(event: JsonAgentSessionEvent): void
  /** The subprocess died mid-turn; fail the turn with its cause. */
  fail(error: Error): void
  /** A cancel was requested; the turn resolves `cancelled` once it settles. */
  cancel(): void
}

type MessageUpdate = Extract<JsonAgentSessionEvent, { type: 'message_update' }>['assistantMessageEvent']

export interface TurnHandlerOptions {
  readonly notifier: AgentContext
  readonly sessionId: string
  readonly graceMs?: number
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

  constructor(options: TurnHandlerOptions) {
    this.notifier = options.notifier
    this.sessionId = options.sessionId
    this.graceMs = options.graceMs ?? AGENT_START_GRACE_MS
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
        return
      case 'message_start':
        // The real per-message boundary on the wire: the stream's `start`
        // sub-event is hoisted to this top-level event, never a `message_update`.
        this.streamedIndices.clear()
        return
      case 'message_update':
        this.handleMessageUpdate(event.assistantMessageEvent)
        return
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
    if (this.done) return
    void this.notifier
      .notify(acp.methods.client.session.update, {
        sessionId: this.sessionId,
        update: { sessionUpdate, content: { type: 'text', text } },
      })
      .catch((error: unknown) => {
        console.error(`[${AGENT_NAME}] [${this.sessionId}] failed to send ${sessionUpdate}: ${asMessage(error)}`)
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
