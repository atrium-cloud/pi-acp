import type { SessionConfigOption, SessionUpdate, ToolCallContent, ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'

import { TOOL_KIND_DEFAULT, TOOL_KIND_MAP, TOOL_NAME_EDIT, USAGE_COST_CURRENCY } from '../constants.js'

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

/** The `tool_call` sent when a tool first appears. */
export function toolCallStarted(start: ToolStart): SessionUpdate {
  const locations = toolLocations(start.args)
  return {
    sessionUpdate: 'tool_call',
    toolCallId: start.toolCallId,
    title: toolTitle(start.toolName, start.args),
    kind: toolKind(start.toolName),
    status: 'in_progress',
    rawInput: start.args,
    ...(locations ? { locations } : {}),
  }
}

/** A mid-run `tool_call_update` carrying the accumulated result snapshot; returns
 * undefined when the partial has no renderable content (nothing to send). */
export function toolCallProgress(toolCallId: string, partialResult: unknown): SessionUpdate | undefined {
  const content = resultContent(partialResult)
  if (content === undefined) return undefined
  return { sessionUpdate: 'tool_call_update', toolCallId, content }
}

/** The terminal `tool_call_update`: status, raw output, and content (an edit's
 * diff blocks from its input, otherwise the result's text). */
export function toolCallEnded(end: ToolEnd): SessionUpdate {
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

export function toolTitle(toolName: string, args: unknown): string {
  const path = stringField(args, 'path')
  if (path !== undefined) return `${toolName} ${path}`
  const command = stringField(args, 'command')
  if (command !== undefined) return `${toolName}: ${firstLine(command)}`
  return toolName
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toolLocations(args: unknown): ToolCallLocation[] | undefined {
  const path = stringField(args, 'path')
  return path === undefined ? undefined : [{ path }]
}

function resultContent(result: unknown): ToolCallContent[] | undefined {
  const parts = fieldOf(result, 'content')
  if (!Array.isArray(parts)) return undefined
  const blocks: ToolCallContent[] = []
  for (const part of parts) {
    if (stringField(part, 'type') !== 'text') continue
    const text = stringField(part, 'text')
    if (text !== undefined) blocks.push({ type: 'content', content: { type: 'text', text } })
  }
  return blocks.length > 0 ? blocks : undefined
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
