import type { SessionConfigOption, SessionUpdate, ToolCallContent, ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'

import {
  SHELL_EMPTY_OUTPUT_PLACEHOLDER,
  SHELL_EXIT_STATUS_PATTERN,
  SHELL_FAILURE_EXIT_CODE,
  SHELL_SUCCESS_EXIT_CODE,
  SHELL_TOOL_NAMES,
  TOOL_KIND_DEFAULT,
  TOOL_KIND_MAP,
  TOOL_NAME_EDIT,
  USAGE_COST_CURRENCY,
} from '../constants.js'

// Pi tool events carry `args`/`result`/`partialResult` as `any` (emitted before
// schema validation), so every field is read defensively.

export interface ToolStart {
  readonly toolCallId: string
  readonly toolName: string
  readonly args: unknown
}

export interface ToolEnd {
  readonly toolCallId: string
  readonly toolName: string
  readonly result: unknown
  readonly isError: boolean
  /** The input cached from `tool_execution_start`; `tool_execution_end` omits it. */
  readonly args: unknown
}

/** The result of folding one shell partial into the streamed output so far. */
export interface ShellProgress {
  readonly update: SessionUpdate | undefined
  /** The snapshot text the next partial is diffed against. */
  readonly text: string
}

export function isShellTool(toolName: string): boolean {
  return SHELL_TOOL_NAMES.includes(toolName)
}

/** The `tool_call` sent when a tool first appears. A shell tool is announced as a
 * terminal entry rooted at the session cwd, where Pi runs every command. */
export function toolCallStarted(start: ToolStart, cwd: string): SessionUpdate {
  const locations = toolLocations(start.args)
  const base: SessionUpdate = {
    sessionUpdate: 'tool_call',
    toolCallId: start.toolCallId,
    title: toolTitle(start.toolName, start.args),
    kind: toolKind(start.toolName),
    status: 'in_progress',
    rawInput: start.args,
    ...(locations ? { locations } : {}),
  }
  if (!isShellTool(start.toolName)) return base
  return {
    ...base,
    content: [{ type: 'terminal', terminalId: start.toolCallId }],
    _meta: { terminal_info: { terminal_id: start.toolCallId, cwd } },
  }
}

/** A mid-run `tool_call_update` carrying the accumulated result snapshot; returns
 * undefined when the partial has no renderable content (nothing to send). */
export function toolCallProgress(toolCallId: string, partialResult: unknown): SessionUpdate | undefined {
  const content = resultContent(partialResult)
  if (content === undefined) return undefined
  return { sessionUpdate: 'tool_call_update', toolCallId, content }
}

/** A shell partial is a cumulative snapshot, not a chunk: the new tail is sent
 * as a `terminal_output_delta`. Pi's accumulator keeps only the last N lines, so
 * once the snapshot stops extending the previous one it is sent whole as a
 * `terminal_output`, which the client applies as a replace. */
export function shellProgress(toolCallId: string, partialResult: unknown, previousText: string): ShellProgress {
  const text = resultText(partialResult)
  if (text === undefined || text === previousText) return { update: undefined, text: previousText }
  const meta = text.startsWith(previousText)
    ? { terminal_output_delta: { terminal_id: toolCallId, data: text.slice(previousText.length) } }
    : { terminal_output: { terminal_id: toolCallId, data: text } }
  return { update: { sessionUpdate: 'tool_call_update', toolCallId, _meta: meta }, text }
}

/** The terminal `tool_call_update`: status, raw output, and content (an edit's
 * diff blocks from its input, otherwise the result's text). A shell tool sends no
 * content at all, so the terminal item from its `tool_call` persists; its full
 * output snapshot and exit ride `_meta`. */
export function toolCallEnded(end: ToolEnd): SessionUpdate {
  if (isShellTool(end.toolName)) return shellEnded(end)
  const content =
    end.toolName === TOOL_NAME_EDIT && !end.isError
      ? (editDiffContent(end.args) ?? resultContent(end.result))
      : resultContent(end.result)
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: end.toolCallId,
    status: end.isError ? 'failed' : 'completed',
    rawOutput: end.result,
    ...(content ? { content } : {}),
  }
}

export function usageUpdate(used: number, size: number, cost: number): SessionUpdate {
  return { sessionUpdate: 'usage_update', used, size, cost: { amount: cost, currency: USAGE_COST_CURRENCY } }
}

export function sessionInfoUpdate(title: string): SessionUpdate {
  return { sessionUpdate: 'session_info_update', title }
}

export function configOptionUpdate(configOptions: SessionConfigOption[]): SessionUpdate {
  return { sessionUpdate: 'config_option_update', configOptions }
}

export function toolKind(toolName: string): ToolKind {
  return TOOL_KIND_MAP[toolName] ?? TOOL_KIND_DEFAULT
}

/** A shell call is titled by its command verbatim (the terminal entry's header);
 * other tools carry their name. */
export function toolTitle(toolName: string, args: unknown): string {
  const command = stringField(args, 'command')
  if (isShellTool(toolName) && command !== undefined) return command
  const path = stringField(args, 'path')
  if (path !== undefined) return `${toolName} ${path}`
  if (command !== undefined) return `${toolName}: ${firstLine(command)}`
  return toolName
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shellEnded(end: ToolEnd): SessionUpdate {
  const { data, exitCode } = shellOutcome(resultText(end.result) ?? '', end.isError)
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: end.toolCallId,
    status: end.isError ? 'failed' : 'completed',
    rawOutput: end.result,
    _meta: {
      terminal_output: { terminal_id: end.toolCallId, data },
      terminal_exit: { terminal_id: end.toolCallId, exit_code: exitCode, signal: null },
    },
  }
}

/** Pi reports a nonzero exit only as a status line appended to a failed result's
 * output; it is parsed into `exit_code` and dropped from the data since the client
 * renders the exit itself. The parse is gated on `isError` because a successful
 * command can print the same line itself. Signals are never reported, so a killed
 * command is a plain 1. */
function shellOutcome(text: string, isError: boolean): { data: string; exitCode: number } {
  const match = isError ? SHELL_EXIT_STATUS_PATTERN.exec(text) : null
  const output = match === null ? text : text.slice(0, match.index)
  const data = output === SHELL_EMPTY_OUTPUT_PLACEHOLDER ? '' : output
  if (match !== null) return { data, exitCode: Number(match[1]) }
  return { data, exitCode: isError ? SHELL_FAILURE_EXIT_CODE : SHELL_SUCCESS_EXIT_CODE }
}

function toolLocations(args: unknown): ToolCallLocation[] | undefined {
  const path = stringField(args, 'path')
  return path === undefined ? undefined : [{ path }]
}

function resultContent(result: unknown): ToolCallContent[] | undefined {
  const parts = resultTextParts(result)
  if (parts === undefined) return undefined
  const blocks: ToolCallContent[] = parts.map((text) => ({ type: 'content', content: { type: 'text', text } }))
  return blocks.length > 0 ? blocks : undefined
}

/** The result's text parts joined, or undefined when it holds none. */
function resultText(result: unknown): string | undefined {
  const parts = resultTextParts(result)
  if (parts === undefined || parts.length === 0) return undefined
  return parts.join('\n')
}

function resultTextParts(result: unknown): string[] | undefined {
  const parts = fieldOf(result, 'content')
  if (!Array.isArray(parts)) return undefined
  const texts: string[] = []
  for (const part of parts) {
    if (stringField(part, 'type') !== 'text') continue
    const text = stringField(part, 'text')
    if (text !== undefined) texts.push(text)
  }
  return texts
}

function editDiffContent(args: unknown): ToolCallContent[] | undefined {
  const path = stringField(args, 'path')
  const edits = fieldOf(args, 'edits')
  if (path === undefined || !Array.isArray(edits)) return undefined
  const blocks: ToolCallContent[] = []
  for (const edit of edits) {
    const newText = stringField(edit, 'newText')
    if (newText === undefined) continue
    const oldText = stringField(edit, 'oldText')
    blocks.push({ type: 'diff', path, ...(oldText !== undefined ? { oldText } : {}), newText })
  }
  return blocks.length > 0 ? blocks : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function fieldOf(value: unknown, key: string): unknown {
  return asRecord(value)?.[key]
}

function stringField(value: unknown, key: string): string | undefined {
  const field = fieldOf(value, key)
  return typeof field === 'string' ? field : undefined
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? text
  return line
}
