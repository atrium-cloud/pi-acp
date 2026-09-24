import type { StopReason } from '@agentclientprotocol/sdk'

import {
  BUILTIN_COMMAND_COMPACT,
  BUILTIN_COMMAND_NAME,
  BUILTIN_COMMAND_SESSION,
  BUILTIN_TEXT_LINE_BREAK,
  BUILTIN_TEXT_PARAGRAPH_BREAK,
  COMMAND_ARG_SEPARATOR,
  COMMAND_PREFIX,
  SESSION_INFO_COST_DIGITS,
  SESSION_INFO_HIT_RATE_DIGITS,
  SESSION_INFO_IN_MEMORY,
  SESSION_INFO_INDENT,
  SESSION_INFO_LABELS,
} from '../constants.js'
import type { RpcResponse } from '../pi/types.js'
import { toRequestError } from '../server/errors.js'
import type { AnnouncedToolCall, TurnEventSink } from '../turn/TurnHandler.js'

type SessionStats = Extract<RpcResponse, { command: 'get_session_stats'; success: true }>['data']

export type BuiltinCommand =
  | { readonly kind: typeof BUILTIN_COMMAND_COMPACT; readonly customInstructions: string | undefined }
  | { readonly kind: typeof BUILTIN_COMMAND_NAME; readonly name: string }
  | { readonly kind: typeof BUILTIN_COMMAND_SESSION }

/** Pi's TUI submit handler, rule for rule: the message is trimmed, `/compact` and
 * `/name` take whatever follows a literal space, and `/session` takes nothing. */
export function parseBuiltinCommand(message: string): BuiltinCommand | undefined {
  const text = message.trim()
  const compact = invocation(BUILTIN_COMMAND_COMPACT)
  if (invokes(text, compact)) {
    const instructions = text.slice(compact.length).trim()
    return { kind: BUILTIN_COMMAND_COMPACT, customInstructions: instructions === '' ? undefined : instructions }
  }
  const name = invocation(BUILTIN_COMMAND_NAME)
  if (invokes(text, name)) return { kind: BUILTIN_COMMAND_NAME, name: text.slice(name.length).trim() }
  if (text === invocation(BUILTIN_COMMAND_SESSION)) return { kind: BUILTIN_COMMAND_SESSION }
  return undefined
}

function invocation(name: string): string {
  return `${COMMAND_PREFIX}${name}`
}

function invokes(text: string, command: string): boolean {
  return text === command || text.startsWith(`${command}${COMMAND_ARG_SEPARATOR}`)
}

/** Pi's TUI `/session` report, minus what RPC does not expose: cache warming, the
 * per-model cost breakdown, and cache re-billing. */
export function formatSessionInfo(stats: SessionStats, sessionName: string | undefined): string {
  const labels = SESSION_INFO_LABELS
  const { input, output, cacheRead, cacheWrite, total } = stats.tokens
  // "Input" is the whole prompt volume; Pi splits it only when the cache was used.
  const promptTokens = input + cacheRead + cacheWrite

  const identity = [
    ...(sessionName ? [`${labels.name} ${sessionName}`] : []),
    `${labels.file} ${stats.sessionFile ?? SESSION_INFO_IN_MEMORY}`,
    `${labels.id} ${stats.sessionId}`,
  ]
  const messages = [
    labels.messages,
    `${labels.total} ${stats.totalMessages}`,
    `${labels.user} ${stats.userMessages}`,
    `${labels.assistant} ${stats.assistantMessages}`,
    `${labels.tools} ${stats.toolCalls} ${labels.calls}, ${stats.toolResults} ${labels.results}`,
  ]
  const tokens = [labels.tokens, `${labels.input} ${promptTokens.toLocaleString()}`]
  if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
    const hitRate = ((cacheRead / promptTokens) * 100).toFixed(SESSION_INFO_HIT_RATE_DIGITS)
    tokens.push(`${SESSION_INFO_INDENT}${labels.cached} ${cacheRead.toLocaleString()} (${hitRate}%)`)
    const written = cacheWrite > 0 ? ` (${cacheWrite.toLocaleString()} ${labels.writtenToCache})` : ''
    tokens.push(`${SESSION_INFO_INDENT}${labels.uncached} ${(input + cacheWrite).toLocaleString()}${written}`)
  }
  tokens.push(`${labels.output} ${output.toLocaleString()}`, `${labels.total} ${total.toLocaleString()}`)

  const sections = [[labels.title], identity, messages, tokens]
  if (stats.cost > 0) sections.push([labels.cost, `${labels.total} $${stats.cost.toFixed(SESSION_INFO_COST_DIGITS)}`])
  return sections.map((lines) => lines.join(BUILTIN_TEXT_LINE_BREAK)).join(BUILTIN_TEXT_PARAGRAPH_BREAK)
}

/** A running built-in, registered as the session's active turn so that a second
 * prompt is refused and cancel, close and subprocess death reach it the way they
 * reach a turn. A cancel is sticky and wins over whatever Pi answers, as in
 * `TurnHandler`. */
export class BuiltinCommandRun implements TurnEventSink {
  readonly settled: Promise<StopReason>
  private resolve!: (reason: StopReason) => void
  private reject!: (error: Error) => void
  private done = false
  private cancelled = false

  constructor() {
    this.settled = new Promise<StopReason>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }

  get isCancelled(): boolean {
    return this.cancelled
  }

  /** Settles on the command's own outcome unless a close or a death got there first. */
  track(work: Promise<void>): void {
    work.then(
      () => this.finish(() => this.resolve(this.cancelled ? 'cancelled' : 'end_turn')),
      (error: unknown) => this.finish(() => (this.cancelled ? this.resolve('cancelled') : this.reject(toRequestError(error)))),
    )
  }

  // Pi runs no turn for a built-in; the compaction events it does emit carry
  // nothing the command's own response does not.
  handleEvent(): void {}

  fail(error: Error): void {
    this.finish(() => this.reject(toRequestError(error)))
  }

  cancel(): void {
    this.cancelled = true
  }

  abandon(): void {
    this.finish(() => this.resolve('cancelled'))
  }

  announcedToolCall(): AnnouncedToolCall | undefined {
    return undefined
  }

  private finish(settle: () => void): void {
    if (this.done) return
    this.done = true
    settle()
  }
}
