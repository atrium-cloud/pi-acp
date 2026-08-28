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

// ── Pi child ────────────────────────────────────────────────────────────────
//
// One `pi --mode rpc` child per ACP session (docs/todos.md, process model).

export const ENV_PI_BIN = 'PI_ACP_PI_BIN'
export const DEFAULT_PI_BIN = 'pi'
export const PI_RPC_MODE_ARGS: readonly string[] = ['--mode', 'rpc']

// ── Pi compatibility ────────────────────────────────────────────────────────
//
// Floor only: a newer Pi is untested, not known-broken, and pinning an upper
// bound would make this adapter the thing that breaks on every Pi release.
// Drift against newer releases is caught by the pinned devDependency and
// typecheck (docs/refs.md), not at runtime.

export const SUPPORTED_PI_MIN = '0.84.3'
export const ENV_SKIP_VERSION_CHECK = 'PI_ACP_SKIP_VERSION_CHECK'
export const SKIP_VERSION_CHECK_VALUES: readonly string[] = ['1', 'true']
export const KEEP_VERSION_CHECK_VALUES: readonly string[] = ['0', 'false']
