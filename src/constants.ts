import { PROTOCOL_VERSION as ACP_PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

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
// PI_ACP_RPC_TIMEOUT_MS overrides this; the env resolver lands in §2 batch B,
// where session setup passes the timeout into the spawned client.
export const DEFAULT_RPC_TIMEOUT_MS = 30_000

// Teardown: stdin-close is Pi's lossless exit (flush then exit 0); SIGTERM skips
// the flush. Stdin grace is generous — on Windows SIGTERM is effectively a kill.
export const STDIN_END_GRACE_MS = 5_000
export const SIGTERM_GRACE_MS = 1_000

export const STDERR_TAIL_MAX_BYTES = 16_384

// ── ACP / JSON-RPC ────────────────────────────────────────────────────────────
//
// The SDK's RequestError statics bury the message as literal "Internal error",
// so errors are thrown with `new RequestError(code, message)` and these codes.
export const JSONRPC_INVALID_PARAMS = -32_602
export const JSONRPC_INTERNAL_ERROR = -32_603
