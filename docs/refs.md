# References

## ACP v1

- Repo: https://github.com/agentclientprotocol/agent-client-protocol
- Schema (latest release): https://github.com/agentclientprotocol/agent-client-protocol/releases/latest/download/schema.json
- Protocol docs: https://agentclientprotocol.com/protocol
- TypeScript SDK: `@agentclientprotocol/sdk` 1.4.0
    - Generated types: `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`
    - Authoritative method list: `dist/acp.d.ts` `methods`
    - `session/fork` (experimental): head-only by default, or cut at an earlier prompt named by `_meta.acpStack.messageId`, a `_meta` extension (docs/todos.md, the Fork entry under Delivered)
    - `SessionConfigOptionCategory` includes `thought_level` (docs/todos.md, the Config options entry under Delivered)
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
- Dependency: `^0.84.4` (moved from `^0.84.3` on 2026-08-29), the same caret policy as codex-acp on `@openai/codex`. The adapter launches the installed package's `./rpc-entry` export by default (`src/pi/launch.ts`); `bun run typecheck` against the installed version is the drift check.
- `PI_ACP_PI_BIN` launches a different `pi` binary instead.
- RPC mode docs: https://pi.dev/docs/latest/rpc (upstream `packages/coding-agent/docs/rpc.md`)
- Key upstream files, relative to `packages/coding-agent/`
    - RPC mode
        - `src/modes/rpc/rpc-types.ts`: `RpcCommand`, `RpcResponse`, `RpcSessionState`, `RpcExtensionUIRequest`, `RpcExtensionUIResponse`; all exported from the package root
        - `src/modes/rpc/rpc-mode.ts`, `src/modes/rpc/jsonl.ts`: server side and the strict LF-only JSONL framing
        - `src/modes/rpc/rpc-client.ts`: Pi's typed subprocess client
        - `src/modes/json-event.ts`: `JsonAgentSessionEvent`, the event union streamed on stdout
        - `src/core/agent-session.ts`: `AgentSessionEvent`, the session-level members the RPC docs' event table omits
        - `src/core/output-guard.ts`: stdout is reserved for protocol frames; stray writes go to stderr
    - Sessions
        - `src/core/session-manager.ts`: `SessionHeader` (`id`, `cwd`, `parentSession`), the `<sessions-dir>/<encoded-cwd>/<timestamp>_<id>.jsonl` layout, `SessionManager.list` / `listAll`
    - Extensions
        - `src/core/extensions/types.ts`, `docs/extensions.md` (Tool Events): `tool_call` handler contract (`{ block, reason, terminate }`), `ctx.ui.select/confirm/input/editor`
        - `examples/extensions/permission-gate.ts`: permission prompt from a `tool_call` handler
    - CLI
        - `src/cli/args.ts`: flags consumed at spawn: `--mode rpc`, `--session`, `--session-dir`, `--extension` / `-e`, `--no-extensions`, `--model`, `--thinking`, `--name`
        - `src/cli/auth-command.ts`: `pi auth check --provider`, the only non-interactive credential check
    - Tools
        - `src/core/tools/edit.ts`: `EditToolDetails` (`diff`, `patch`, `firstChangedLine`) behind the ACP `diff` content block

## MCP

- Specification, current revision 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28
    - Changelog versus 2025-11-25: https://modelcontextprotocol.io/specification/2026-07-28/changelog (stateless requests with the version in `_meta`, `server/discover`, no `initialize` handshake, no `Mcp-Session-Id`, `subscriptions/listen` instead of the GET stream, HTTP+SSE transport deprecated)
    - Versioning and negotiation: https://modelcontextprotocol.io/specification/versioning
- TypeScript SDK v2 (implements 2026-07-28): https://github.com/modelcontextprotocol/typescript-sdk, docs https://ts.sdk.modelcontextprotocol.io/v2/
    - The 2026-07-28 support guide: https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html
- Packages: `@modelcontextprotocol/client` 2.0.0 (pulls `@modelcontextprotocol/core`), bundled into the adapter's own Pi extension (`src/mcp/extension-entry.ts`, docs/todos.md, the Built-in MCP entry under Delivered); `@modelcontextprotocol/server` 2.0.0 is a dev dependency for the in-process probe server in tests
    - Client transports: `StdioClientTransport` (`@modelcontextprotocol/client/stdio`), `StreamableHTTPClientTransport`, `SSEClientTransport`
    - `Client` defaults to the legacy `initialize` handshake; the adapter passes `versionNegotiation: { mode: 'auto' }` so a `server/discover` probe selects 2026-07-28 where the server offers it and falls back to the handshake otherwise

## Reference adapters

- codex-acp: https://github.com/agentclientprotocol/codex-acp
- claude-agent-acp: https://github.com/agentclientprotocol/claude-agent-acp
