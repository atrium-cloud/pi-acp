// Adapter-side code reads these through `src/constants.ts`, which re-exports this module.

export const ENV_MCP_SERVERS = 'PI_ACP_MCP_SERVERS'
export const MCP_EXTENSION_FILENAME = 'mcp-extension.mjs'

// `mcp__<server>__<tool>`: the prefix is also the gate's structural test for
// "third-party tool, always ask".
export const MCP_TOOL_PREFIX = 'mcp__'
export const MCP_TOOL_SEPARATOR = '__'

// Pi's default, `codemode`, hides the tools behind its JS sandbox tool; `direct`
// declares them to the model like built-ins.
export const MCP_EXPOSURE = 'direct'

// Pi throws on any other server name.
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

// Pi resolves env and header values as templates: `$NAME` and `${NAME}` read the
// environment, and a leading `!` runs the value as a shell command. ACP values
// are literals, so each is escaped with Pi's own `$$` and `$!`.
export const PI_CONFIG_DOLLAR = '$'
export const PI_CONFIG_ESCAPED_DOLLAR = '$$'
export const PI_CONFIG_COMMAND_PREFIX = '!'
