import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PermissionOption } from '@agentclientprotocol/sdk'

import {
  GATE_DIR_PREFIX,
  GATE_FILENAME,
  MCP_TOOL_PREFIX,
  MUTATING_TOOL_NAMES,
  PERMISSION_DENIED_REASON,
  PERMISSION_OPTION_ALLOW_ALWAYS,
  PERMISSION_OPTION_ALLOW_ONCE,
  PERMISSION_OPTION_REJECT_ONCE,
  SENTINEL_PREFIX,
} from '../constants.js'

/** Ids only: the tool input is never put on the wire twice. Pi emits
 * `tool_execution_start` (which carries the args) before it runs the `tool_call`
 * hook, so the adapter already holds the input by the time the sentinel arrives. */
export interface SentinelPayload {
  readonly toolCallId: string
  readonly toolName: string
}

export function encodeSentinelTitle(payload: SentinelPayload): string {
  return `${SENTINEL_PREFIX}${JSON.stringify(payload)}`
}

/** The prefix is a trust boundary, not a security one: any extension loaded into
 * the same Pi process can emit a sentinel-titled select. A forged one can only
 * name a toolCallId; an unannounced id is denied without a prompt. */
export function decodeSentinelTitle(title: string): SentinelPayload | null {
  if (!title.startsWith(SENTINEL_PREFIX)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(title.slice(SENTINEL_PREFIX.length))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { toolCallId, toolName } = parsed as Record<string, unknown>
  if (typeof toolCallId !== 'string' || typeof toolName !== 'string') return null
  return { toolCallId, toolName }
}

export function buildPermissionOptions(): PermissionOption[] {
  return [
    { optionId: PERMISSION_OPTION_ALLOW_ONCE, name: 'Allow once', kind: 'allow_once' },
    { optionId: PERMISSION_OPTION_ALLOW_ALWAYS, name: 'Allow always', kind: 'allow_always' },
    { optionId: PERMISSION_OPTION_REJECT_ONCE, name: 'Reject', kind: 'reject_once' },
  ]
}

// The gate extension source, materialized to a temp file and loaded with `-e`.
// Built from the shared constants so the gate and adapter agree on the sentinel
// and option ids. Plain (untyped) TS so jiti loads it and — critically — so the
// bundled string never mentions the dev-only Pi package (the build purity guard
// greps `dist/index.js` for it). Default-deny: only an explicit allow id runs the
// tool; undefined/cancelled/any foreign value blocks. Gated tools are the
// mutating built-ins plus every MCP tool, which is third-party code the adapter
// cannot classify.
export const PERMISSION_GATE_SOURCE = [
  `const SENTINEL_PREFIX = ${JSON.stringify(SENTINEL_PREFIX)}`,
  `const MCP_PREFIX = ${JSON.stringify(MCP_TOOL_PREFIX)}`,
  `const ALLOW_ONCE = ${JSON.stringify(PERMISSION_OPTION_ALLOW_ONCE)}`,
  `const ALLOW_ALWAYS = ${JSON.stringify(PERMISSION_OPTION_ALLOW_ALWAYS)}`,
  `const DENIED_REASON = ${JSON.stringify(PERMISSION_DENIED_REASON)}`,
  `const MUTATING = new Set(${JSON.stringify([...MUTATING_TOOL_NAMES])})`,
  `export default function (pi) {`,
  `  const alwaysAllowed = new Set()`,
  `  pi.on('tool_call', async (event, ctx) => {`,
  `    if (!MUTATING.has(event.toolName) && !event.toolName.startsWith(MCP_PREFIX)) return undefined`,
  `    if (alwaysAllowed.has(event.toolName)) return undefined`,
  `    if (!ctx.hasUI) return { block: true, reason: DENIED_REASON }`,
  `    const title = SENTINEL_PREFIX + JSON.stringify({ toolCallId: event.toolCallId, toolName: event.toolName })`,
  `    const choice = await ctx.ui.select(title, [ALLOW_ONCE, ALLOW_ALWAYS, ${JSON.stringify(PERMISSION_OPTION_REJECT_ONCE)}])`,
  `    if (choice === ALLOW_ALWAYS) { alwaysAllowed.add(event.toolName); return undefined }`,
  `    if (choice === ALLOW_ONCE) return undefined`,
  `    return { block: true, reason: DENIED_REASON }`,
  `  })`,
  `}`,
  '',
].join('\n')

/** Writes the gate to a per-process temp file and returns its absolute path; the
 * directory is removed on process exit. Called once at startup and reused for
 * every session's `-e`. */
export function materializeGate(): string {
  const dir = join(tmpdir(), `${GATE_DIR_PREFIX}${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, GATE_FILENAME)
  writeFileSync(path, PERMISSION_GATE_SOURCE, 'utf8')
  process.once('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort on exit; the OS reclaims the temp dir regardless.
    }
  })
  return path
}
