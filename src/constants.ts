import { PROTOCOL_VERSION as ACP_PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { ToolKind } from '@agentclientprotocol/sdk'

// Static JSON import (not createRequire): `bun build --compile` produces a
// filesystem-less binary, so a runtime `require('../package.json')` dies on
// startup. esbuild and Bun both inline this import at build time.
import { name as packageName, version as packageVersion } from '../package.json'

export const AGENT_NAME = packageName
export const AGENT_VERSION = packageVersion
/** `agentInfo.title`: the user-facing name (ACP's `name` is the package id). */
export const AGENT_TITLE = 'Pi Agent'

// The only ACP protocol version this adapter speaks. Pinned as a literal; the
// assertion below fails the build if the SDK's default PROTOCOL_VERSION leaves 1
// (e.g. a v2 upgrade), forcing a human to confirm real v2 support first.
export const PROTOCOL_VERSION = 1
const _acpProtocolVersionPin: 1 = ACP_PROTOCOL_VERSION
void _acpProtocolVersionPin

// ── Pi subprocess ───────────────────────────────────────────────────────────
//
// One Pi RPC subprocess per ACP session (docs/todos.md, process model).

export const ENV_PI_BIN = 'PI_ACP_PI_BIN'
export const PI_RPC_ENTRY_SPECIFIER = '@earendil-works/pi-coding-agent/rpc-entry'
export const PI_RPC_MODE_ARGS: readonly string[] = ['--mode', 'rpc']

// ── RPC transport ─────────────────────────────────────────────────────────────

// Bounds every round-trip including the readiness get_state; Pi's cold start can
// take ~15s before it answers, so readiness gets no shorter timeout of its own.
// PI_ACP_RPC_TIMEOUT_MS overrides it; session setup passes the resolved value
// into each spawned client.
export const DEFAULT_RPC_TIMEOUT_MS = 30_000
export const ENV_RPC_TIMEOUT_MS = 'PI_ACP_RPC_TIMEOUT_MS'

// Teardown: stdin-close is Pi's lossless exit (flush then exit 0); SIGTERM skips
// the flush. Stdin grace is generous — on Windows SIGTERM is effectively a kill.
export const STDIN_END_GRACE_MS = 5_000
export const SIGTERM_GRACE_MS = 1_000

// Bounded wait for `agent_start` after the prompt ack. The child is already warm
// from session/new, so this only catches a prompt that started no turn at all
// (a user-typed unadvertised extension command).
export const AGENT_START_GRACE_MS = 10_000

// The prompt ack returns only after preflight, which can run an overflow
// compaction (a full summarization LLM call) on a long session. That legitimately
// outlasts the metadata timeout, so the prompt command gets its own generous
// bound: wide enough for compaction, still finite so a wedged preflight fails.
export const PROMPT_ACK_TIMEOUT_MS = 300_000

export const STDERR_TAIL_MAX_BYTES = 16_384

// ── Session config options ────────────────────────────────────────────────────
//
// The `id` doubles as the ACP config category ("model", "thought_level"). A model
// value is `<provider>/<id>`; the id itself can contain slashes, so a value is
// resolved back to a model by matching the whole string, never by splitting it.

export const CONFIG_ID_MODEL = 'model'
export const CONFIG_ID_THOUGHT_LEVEL = 'thought_level'
export const CONFIG_NAME_MODEL = 'Model'
export const CONFIG_NAME_THOUGHT_LEVEL = 'Thinking level'
export const MODEL_VALUE_SEPARATOR = '/'

// ── Prompt content ─────────────────────────────────────────────────────────────
//
// ACP prompt content is a block array; Pi's prompt takes one message string.
// Blocks are joined with this separator, and non-text blocks are inlined as a
// header line so Pi sees the referenced path.
export const PROMPT_BLOCK_SEPARATOR = '\n'

// ── Tool calls ────────────────────────────────────────────────────────────────
//
// Pi tool names → ACP ToolKind (a closed union; an unknown tool maps to `other`).
// The edit tool's diff is built from its INPUT (`{path, edits:[{oldText,newText}]}`),
// not `result.details.patch` (a unified string that doesn't decompose into ACP's
// oldText/newText).

export const TOOL_KIND_DEFAULT: ToolKind = 'other'
export const TOOL_KIND_MAP: Readonly<Record<string, ToolKind>> = {
  read: 'read',
  ls: 'read',
  bash: 'execute',
  powershell: 'execute',
  edit: 'edit',
  write: 'edit',
  grep: 'search',
  find: 'search',
}
export const TOOL_NAME_EDIT = 'edit'

// ── Usage ─────────────────────────────────────────────────────────────────────
//
// `usage_update` is synthesized at turn end from `get_session_stats.contextUsage`
// (authoritative context occupancy); Pi has no `usage_update` event. ACP's cost is
// an amount + ISO-4217 currency; Pi reports a bare number, taken as USD.
export const USAGE_COST_CURRENCY = 'USD'

// ── Permissions (pi-acp-owned Pi extension loaded with `-e`) ───────────────────
//
// The gate's `ctx.ui.select` title carries a sentinel JSON payload; the adapter
// decodes it and maps to `session/request_permission`. The three option ids are
// shared by the gate's select options, the ACP PermissionOption.optionId, AND the
// PermissionOptionKind (they coincide), so a selected outcome echoes straight back.
export const SENTINEL_PREFIX = 'pi-acp-permission:'
export const PERMISSION_OPTION_ALLOW_ONCE = 'allow_once'
export const PERMISSION_OPTION_ALLOW_ALWAYS = 'allow_always'
export const PERMISSION_OPTION_REJECT_ONCE = 'reject_once'
export const PERMISSION_DENIED_REASON = 'Denied by the ACP client'
// Mutating built-ins the gate intercepts; everything else runs ungated.
export const MUTATING_TOOL_NAMES: readonly string[] = ['bash', 'powershell', 'edit', 'write']
// A real user answers, so the window is generous; a timeout fails closed (deny).
export const PERMISSION_REQUEST_TIMEOUT_MS = 300_000
export const GATE_DIR_PREFIX = 'pi-acp-'
export const GATE_FILENAME = 'permission-gate.ts'

// ── Session title ──────────────────────────────────────────────────────────────
//
// A nameless session is titled from the first user message's first line, so Pi's
// own session picker shows the same name. Pi rejects an empty-trim name.
export const SESSION_TITLE_MAX_CHARS = 80

// ── ACP / JSON-RPC ────────────────────────────────────────────────────────────
//
// The SDK's RequestError statics bury the message as literal "Internal error",
// so errors are thrown with `new RequestError(code, message)` and these codes.
export const JSONRPC_INVALID_REQUEST = -32_600
export const JSONRPC_INVALID_PARAMS = -32_602
export const JSONRPC_INTERNAL_ERROR = -32_603

// ── Composition edge (env → resolved config) ──────────────────────────────────
//
// With `resolvePiLaunch` (src/pi/launch.ts), the only places env is read;
// handlers and session setup take resolved values.

// Above this, Node's setTimeout overflows its 32-bit delay and fires after ~1ms,
// turning a "very patient" timeout into "instant".
const MAX_RPC_TIMEOUT_MS = 2_147_483_647

export function resolveRpcTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env[ENV_RPC_TIMEOUT_MS]?.trim()
  if (raw === undefined || raw === '') return DEFAULT_RPC_TIMEOUT_MS
  if (!/^\d+$/.test(raw)) throw new Error(`${ENV_RPC_TIMEOUT_MS}="${raw}" must be a whole number of milliseconds`)
  const ms = Number(raw)
  if (ms <= 0) throw new Error(`${ENV_RPC_TIMEOUT_MS}="${raw}" must be greater than zero`)
  if (ms > MAX_RPC_TIMEOUT_MS) throw new Error(`${ENV_RPC_TIMEOUT_MS}="${raw}" exceeds the maximum ${MAX_RPC_TIMEOUT_MS}`)
  return ms
}
