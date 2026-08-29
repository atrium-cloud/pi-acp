// This module must stay import-free: `extension-entry.ts` is bundled into the
// self-contained Pi extension, so anything it reaches gets bundled too. In
// particular it must never import `src/constants.ts`, whose value import of the
// ACP SDK would end up inside the extension. Adapter-side code reads these
// through `src/constants.ts`, which re-exports this module.

export const ENV_MCP_SERVERS = 'PI_ACP_MCP_SERVERS'
export const MCP_EXTENSION_FILENAME = 'mcp-extension.mjs'

// `mcp__<server>__<tool>`: the prefix is also the gate's structural test for
// "third-party tool, always ask".
export const MCP_TOOL_PREFIX = 'mcp__'
export const MCP_TOOL_SEPARATOR = '__'

// Bounds connect plus tools/list per server, so one hung server cannot consume
// the whole session-spawn budget.
export const MCP_CONNECT_TIMEOUT_MS = 30_000

// Pi's own bash guard values, reused rather than invented.
export const MCP_OUTPUT_MAX_BYTES = 50 * 1024
export const MCP_OUTPUT_MAX_LINES = 2000

// A stdio server's stderr is the only diagnostic for one that fails to start,
// and an undrained pipe is a leak, so it is drained into a bounded tail.
export const MCP_STDERR_TAIL_BYTES = 4096

// MCP `clientInfo`. The version is informational and deliberately decoupled from
// the package version: reading the latter would drag the adapter's imports into
// the extension bundle.
export const MCP_CLIENT_NAME = 'pi-acp'
export const MCP_CLIENT_VERSION = '1.0.0'

// The client defaults to the legacy `initialize` handshake; `auto` probes with
// `server/discover` so a 2026-07-28 server is spoken to on its own revision and
// an older one still gets the handshake.
export const MCP_VERSION_NEGOTIATION_MODE = 'auto'
