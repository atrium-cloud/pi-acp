# References

## ACP v1

- Repo: https://github.com/agentclientprotocol/agent-client-protocol
- Schema (latest release): https://github.com/agentclientprotocol/agent-client-protocol/releases/latest/download/schema.json
- Protocol docs: https://agentclientprotocol.com/protocol
- TypeScript SDK: `@agentclientprotocol/sdk` 1.5.0
    - Generated types: `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`
    - Authoritative method list: `dist/acp.d.ts` `methods`
    - `session/fork` (experimental): head-only by default, or cut at an earlier prompt named by `_meta.acpStack.messageId`, a `_meta` extension (docs/todos.md, the Fork entry under Delivered)
    - `SessionConfigOptionCategory` includes `thought_level` (docs/todos.md, the Config options entry under Delivered)
    - `notice` session update (experimental): sent only to a client that advertises `clientCapabilities.session.notices` (docs/todos.md, the Other extension UI requests entry)
    - Session notices RFD: https://agentclientprotocol.com/rfds/session-notices
    - `ToolCall.name` (stable since 1.5.0): Pi's tool name, on the `tool_call` only
    - Draft ACP v2 under `@agentclientprotocol/sdk/experimental/v2`: not used

## Terminal entries (shell tool rendering)

Shell tools (`bash`, `powershell`) render as terminal entries via the Zed `_meta` convention claude-agent-acp uses, not the `terminal/*` client methods (those have the client own execution; Pi already runs the command in-session). Emitted unconditionally: a client that ignores `_meta` gets no shell output, so the web UI must implement the keys below. Mappers in `src/turn/mappers.ts`, constants in `src/constants.ts`.

- `tool_call`: titled by the verbatim command; carries `content: [{ type: 'terminal', terminalId: <toolCallId> }]` and `_meta.terminal_info { terminal_id, cwd }` (the session cwd, where Pi runs every command). Terminal id == tool call id.
- While running, per `tool_execution_update`: `_meta.terminal_output_delta { terminal_id, data }` — append; the new tail of Pi's cumulative snapshot, ANSI intact. Once the snapshot stops extending the previous one (Pi's accumulator drops scrolled-off lines), `_meta.terminal_output` is sent instead — replace.
- At the end: `_meta.terminal_output` (full snapshot, replace) and `_meta.terminal_exit { terminal_id, exit_code, signal }` (`signal` always null). Pi's appended `Command exited with code N` line is parsed into `exit_code` and removed from `data`; the `(no output)` placeholder becomes empty `data`; a failure without the line (denied, aborted, timed out) reports exit 1.
- Shell progress/end updates carry no `content` blocks (`rawInput`/`rawOutput` still carried). A client that skips deltas still converges on the closing `terminal_output` replace.

## Pi Agent

- Repo: https://github.com/earendil-works/pi
- Package: `@earendil-works/pi-coding-agent` (bin `pi`, Node >= 22.19.0)
- Dependency: `>=0.99.1`, a floor at the last verified version; `bun.lock` carries the exact one.
    - Moved from `>=0.87.1` on 2026-09-30 (0.99.0 is the first release with built-in MCP and the `prompt` disposition, both of which the adapter relies on), and from `^0.84.4` on 2026-09-24.
    - A caret on a 0.x version caps at its minor: the lockfile sat on 0.84.x while Pi shipped 0.85.0 through 0.87.1.
    - The adapter launches the installed package's `./rpc-entry` export by default (`src/pi/launch.ts`).
    - The drift check is the Upstream drift entry in docs/todos.md: typecheck, unit tests, and the live tier.
- `PI_ACP_PI_BIN` launches a different `pi` binary instead.
- RPC mode docs: https://pi.dev/docs/latest/rpc (upstream `packages/coding-agent/docs/rpc.md`)
- Key upstream files, relative to `packages/coding-agent/`
    - RPC mode
        - `src/modes/rpc/rpc-types.ts`: `RpcCommand`, `RpcResponse`, `RpcSessionState`, `RpcExtensionUIRequest`, `RpcExtensionUIResponse`; all exported from the package root
        - `src/modes/rpc/rpc-mode.ts`, `src/modes/rpc/jsonl.ts`: server side and the strict LF-only JSONL framing
        - `rpc-mode.ts` `get_commands`: omits a prompt template's `argument-hint`
        - `docs/rpc-commands.md` `prompt`: the ack's `data.disposition` (`started`, `handled`, `queued`), since 0.99.0
        - `src/modes/rpc/rpc-client.ts`: Pi's typed subprocess client
        - `src/modes/json-event.ts`: `JsonAgentSessionEvent`, the event union streamed on stdout
        - `src/core/agent-session.ts`: `AgentSessionEvent`, the session-level members the RPC docs' event table omits
        - `src/core/output-guard.ts`: stdout is reserved for protocol frames; stray writes go to stderr
    - Sessions
        - `src/core/session-manager.ts`: `SessionHeader` (`id`, `cwd`, `parentSession`), the `<sessions-dir>/<encoded-cwd>/<timestamp>_<id>.jsonl` layout, `SessionManager.list` / `listAll`; `_hasConversation` is the rule that creates the file at the first user message (since 0.99.0)
    - Extensions
        - `src/core/extensions/types.ts`, `docs/extensions.md` (Tool Events): `tool_call` handler contract (`{ block, reason, terminate }`), `ctx.ui.select/confirm/input/editor`
        - `examples/extensions/permission-gate.ts`: permission prompt from a `tool_call` handler
        - `src/core/source-info.ts`: `builtin:<name>` extension paths (`builtin:mcp`, `builtin:llama.cpp`), whose commands `get_commands` reports with `sourceInfo.source` `builtin`
    - MCP (built in since 0.99.0)
        - `docs/mcp.md`: configuration (`mcp.json`), exposure (`codemode` default, `direct`, `deferred`, `hidden`), OAuth, resources, permissions
        - `src/core/mcp-servers.ts`: `McpServerConfig` (the shape `pi.registerMcpServer` takes), the `^[A-Za-z0-9_-]+$` server-name rule
        - `src/core/resolve-config-value.ts`: `${NAME}` / `$NAME` / leading `!cmd` interpolation of `env` and `headers` values, with `$$` and `$!` as the literal escapes
        - `src/extensions/mcp/`: the built-in extension (`index.ts` connects on `session_start`, `runtime.ts` spawns stdio servers with the full `process.env`, `tools.ts` names tools `mcp__<server>__<tool>`)
        - `packages/mcp`: Pi's own MCP client (stdio and streamable HTTP; no SSE)
    - CLI
        - `src/cli/args.ts`: flags consumed at spawn: `--mode rpc`, `--session`, `--session-dir`, `--extension` / `-e`, `--no-extensions`, `--model`, `--thinking`, `--name`
        - `src/cli/auth-command.ts`: `pi auth check --provider`, the only non-interactive credential check
    - Prompt templates
        - `src/core/prompt-templates.ts`, `src/utils/frontmatter.ts`: the `argument-hint` parse the adapter mirrors
    - Tools
        - `src/core/tools/edit.ts`: `EditToolDetails` (`diff`, `patch`, `firstChangedLine`) behind the ACP `diff` content block
- `yaml` 2.9.1: parses a prompt template's frontmatter, as Pi does (Pi pins 2.9.0)

## MCP

- The adapter speaks no MCP itself since Pi 0.99.0: it hands the ACP `mcpServers` to Pi's built-in support through `pi.registerMcpServer` (docs/todos.md, the MCP entry under Delivered; the upstream files are listed under Pi Agent above).
- Specification: https://modelcontextprotocol.io/specification
- `@modelcontextprotocol/server` 2.1.0, a dev dependency for the stdio probe server the e2e tier spawns (`src/__tests__/fixtures/mcp-probe-server.mjs`)

## Reference adapters

- codex-acp: https://github.com/agentclientprotocol/codex-acp
- claude-agent-acp: https://github.com/agentclientprotocol/claude-agent-acp
