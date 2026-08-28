# References

## ACP v1

- Repo: https://github.com/agentclientprotocol/agent-client-protocol
- Schema (latest release): https://github.com/agentclientprotocol/agent-client-protocol/releases/latest/download/schema.json
- Protocol docs: https://agentclientprotocol.com/protocol
- TypeScript SDK: `@agentclientprotocol/sdk` 1.4.0
    - Generated types: `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`
    - Authoritative method list: `dist/acp.d.ts` `methods`
    - `session/fork` (experimental): head-only fork, no breakpoint marker (docs/todos.md section 4)
    - `SessionConfigOptionCategory` includes `thought_level` (docs/todos.md section 2)
    - Draft ACP v2 under `@agentclientprotocol/sdk/experimental/v2`: not used

## Pi Agent

- Repo: https://github.com/earendil-works/pi
- Package: `@earendil-works/pi-coding-agent` (bin `pi`, Node >= 22.19.0)
- Pinned reference: Pi 0.84.3 (2026-08-24), the version the consumed RPC subset is verified against. Every bump re-verifies the subset, then moves this pin.
- RPC mode docs: https://pi.dev/docs/latest/rpc (upstream `packages/coding-agent/docs/rpc.md`)
- Runtime floor: `SUPPORTED_PI_MIN` in `src/constants.ts`; `PI_ACP_SKIP_VERSION_CHECK=1|true` disarms.
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

## pi-mcp-adapter

- Package page: https://pi.dev/packages/pi-mcp-adapter
- Repo: https://github.com/nicobailon/pi-mcp-adapter
- Seams for the opt-in MCP passthrough (docs/todos.md section 4)
    - Runtime registration event `pi-mcp-adapter:runtime-register:v1`
    - Approval event `MCP_TOOL_APPROVAL_REQUEST_EVENT`

## Reference adapters

- codex-acp: https://github.com/agentclientprotocol/codex-acp
- claude-agent-acp: https://github.com/agentclientprotocol/claude-agent-acp
