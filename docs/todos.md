# pi-acp roadmap

## Overview

- Purpose: expose Pi Agent as an ACP v1 agent by wrapping its RPC mode (`pi --mode rpc`). Retire once Pi adopts a current ACP schema upstream.
- Layering
    - `index.ts`: stdio transport
    - `PiAcpServer`: ACP semantics; `src/session/sessionSetup.ts` handles establishment
    - `src/pi/PiRpcClient.ts`: one Pi child per session
    - JSONL commands and events over the child's stdio
- Process model
    - Pi RPC mode serves exactly one session per process (`get_state` has one `sessionId`; `switch_session` replaces it in place).
    - One `pi --mode rpc` child per ACP session, spawned at `session/new`, `session/resume`, `session/load`, and `session/fork`, with `cwd` set to the ACP `cwd`.
    - Nothing is multiplexed; event routing is per child.
- Requirements
    - `session/resume` and `session/list` are served from Pi's own session store; no adapter-side session map.
    - The thinking level is a `thought_level` config option.
    - A failed or never-started turn is a protocol error, not `end_turn`.
    - Every RPC round-trip is bounded by a timeout.

## 1. Transport and child lifecycle

- [x] Pi RPC client (`src/pi/PiRpcClient.ts`)
    - Strict LF-only JSONL framing in both directions; Pi's `docs/rpc.md` forbids `readline`.
    - `id` correlation for every command.
    - Typed wrappers for each consumed command; event dispatch.
    - `success: false` responses surface as typed errors.
- [x] Spawn
    - The `@earendil-works/pi-coding-agent` dependency's `rpc-entry` under the current Node, or `PI_ACP_PI_BIN --mode rpc` when set (`src/pi/launch.ts`, the codex-acp `CODEX_PATH` shape).
    - `bun --compile` binaries have no `node_modules`, so `PI_ACP_PI_BIN` is required there.
    - Child `cwd` = ACP `cwd`; stdio piped.
    - Bounded stderr tail attached to startup and death errors.
    - Startup readiness is the first `get_state` response, not a sleep.
- [x] Per-command timeout (`PI_ACP_RPC_TIMEOUT_MS`)
    - Metadata commands are bounded.
    - `prompt` is bounded up to its response only; the response returns after preflight and the turn streams as events, so a stalled preflight fails the request instead of hanging it.
- [x] Clean teardown
    - Close the child's stdin first; Pi's RPC mode shuts down on stdin `end`.
    - Then SIGTERM→SIGKILL grace.
    - `stop()` mechanism done and tested; the triggers (`session/close`, `session/delete`, connection close, adapter exit) are wired in §2/§3.
- [x] Child death mid-turn
    - Fails the in-flight prompt with the exit code and stderr tail.
    - Client rejects in-flight work and fires `onExit` with the exit code + stderr tail; a dead child never crashes the adapter (EPIPE handled). Session teardown off `onExit` is wired in §3.
- [x] Types for the consumed RPC subset
    - Type-only imports from the `@earendil-works/pi-coding-agent` dependency: `RpcCommand`, `RpcResponse`, `RpcSessionState`, `RpcExtensionUIRequest`, `RpcExtensionUIResponse`, `JsonAgentSessionEvent`.
    - No Pi code in the adapter bundle: `import type` only, and the package is `external` in `build.mjs`; Pi runs as a subprocess.
    - Exhaustive switches over event types with no `default` are the compile-time tripwire.

## 2. Stable ACP v1 baseline

- [x] `initialize`
    - Honest capabilities only, each advertised in the change that implements it; pinned by `initialize.test.ts`. Text-only prompt caps here; image/embeddedContext turn on with `session/prompt`.
    - No `authMethods`: Pi resolves credentials from its own `auth.json` and environment, and there is no non-interactive login to expose.
    - Provider auth failures surface as turn errors carrying Pi's message; wired with the turn layer (`session/prompt`).
- [x] `session/new`
    - Validate an absolute `cwd`, spawn the child, read `get_state` for the session id and file.
    - Build `configOptions`; send `available_commands_update`.
    - `mcpServers` rejected with invalid_params unless the section 4 seam is enabled.
    - `additionalDirectories` rejected.
    - `available_commands_update` is deferred a macrotask past the response: the SDK client only attaches its per-session update queue inside the `session/new` response callback, so an update sent before that lands is dropped.
- [x] `session/prompt`
    - Content blocks
        - Text.
        - Image, via `images` on the `prompt` command.
        - Embedded resource, inlined as text with a path header.
    - `prompt` response `success: false` is a JSON-RPC error.
    - The turn ends on `agent_settled`, not `agent_end`; `agent_end` can be followed by retry, overflow compaction, or queued continuations.
    - A second prompt while the child is streaming is refused; ACP v1 has no steering surface.
    - A prompt accepted (preflight passed) that starts no turn within a bounded window is a protocol error, not a silent `end_turn`.
- [x] Stop reasons
    - JSON-RPC errors carrying Pi's message
        - Assistant `stopReason: "error"` with `errorMessage`.
        - `auto_retry_end` with `success: false` and `compaction_end` `errorMessage` are captured as fallback error text.
    - `stopReason: "aborted"` after `session/cancel` → `cancelled`.
    - `length` → `max_tokens`.
    - A failed turn never ends with `end_turn`.
- [x] `session/cancel`
    - `abort` with a sticky cancel flag, fire and forget (Pi defers the ack past `agent_settled`).
    - `$/cancel_request` on the prompt routes through the same path.
- [ ] Streaming translation
    - Stateful per-turn `src/turn/TurnHandler.ts`; a pure `src/turn/mappers.ts` lands with the tool arm.
    - `message_update` sub-events distinguish text from thinking by their own type (`text_delta` vs `thinking_delta`), not a `contentIndex → kind` map (done)
        - `text_*` → `agent_message_chunk`
        - `thinking_*` → `agent_thought_chunk`
        - `contentIndex` is only tracked so a `*_end` re-emits the full content when no delta streamed for that index
    - `tool_execution_start/update/end` → `tool_call` / `tool_call_update`
        - Kinds for `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`.
        - `locations` from `path` args; `rawInput` / `rawOutput` carried.
        - `edit` results rendered as a `diff` content block from `details.patch` (a unified patch; `details.diff` is display-oriented).
        - `bash` partial results replace the row content; Pi sends accumulated output, not deltas.
    - Pi's default tool set is `read`, `bash`, `edit`, `write`; `grep` / `find` / `ls` are opt-in and `powershell` is Windows-only. The kind map covers all eight; tests exercise the default four first.
- [ ] Session-level wire events not in the RPC docs' event table
    - `session_info_changed { name }` → `session_info_update`
    - `thinking_level_changed { level }` → `config_option_update`
    - `entry_appended`, `queue_update`: ignored
    - Exhaustive switch over `JsonAgentSessionEvent` with no `default` keeps the list honest.
- [ ] Usage
    - `usage_update` from `message_update.usage` during the turn.
    - `usage_update` from `get_session_stats.contextUsage` at turn end; `contextWindow` is the gauge size.
    - `null` tokens right after compaction are skipped.
- [ ] Permissions via a pi-acp-owned Pi extension loaded with `-e`
    - Extension side
        - `tool_call` handler asks through `ctx.ui.select` for every mutating built-in tool: `bash`, `powershell`, `edit`, `write`.
        - The `select` title is sentinel JSON carrying `toolCallId`, `toolName`, and the input.
        - `allow_always` is remembered per session per tool name inside the extension.
    - Adapter side
        - Recognizes the sentinel and maps it to `session/request_permission` with `allow_once`, `allow_always`, `reject_once`.
        - Answers with `extension_ui_response`.
        - Always a bounded `timeout`; `undefined`, `cancelled`, timeout, and a closed session all resolve to deny.
    - Packaging
        - Extension source is embedded in the bundle and materialized to a temp file at startup so `bun --compile` binaries work.
        - The child is spawned without `--no-extensions` so the user's own extensions (pi-mcp-adapter among them) keep loading alongside the gate.
- [x] No session modes
    - Pi has no native permission policy to map onto.
    - `modes` is omitted from `session/new`; `session/set_mode` is not handled.
    - The client's own auto-approval is the only policy layer.
- [x] Config options (`src/turn/configOptions.ts`)
    - `model`: category `model`, values `provider/id` from `get_available_models`, applied with `set_model`.
    - `thought_level`: category `thought_level`, values from `get_available_thinking_levels`, applied with `set_thinking_level`.
    - Both are re-read after a model switch because the level set is per model; the full set is returned in `SetSessionConfigOptionResponse`.
    - `initialize` is static; options are built per session at `session/new` from `get_state`.
    - Pi persists both as `thinking_level_change` and `model_change` session entries, so a resumed session reports the level and model it last ran with.
    - Deferred to the streaming layer (`thinking_level_changed`): a client-initiated set already returns the full set, and the resulting Pi event will also push a `config_option_update`, so the event-driven push must suppress or tolerate that echo.
- [x] Slash commands
    - `get_commands` snapshot sent as `available_commands_update`; invoked as `/name args` prompt text.
    - Command metadata comes from `sourceInfo` (`{ path, source, scope, origin }`).
    - Only `prompt` and `skill` sources are advertised.
    - `extension` commands are deferred: nothing signals whether one starts an agent loop, so a `session/prompt` waiting on `agent_settled` could never resolve.
- [ ] Other extension UI requests
    - `confirm`, `input`, `editor`, and non-sentinel `select`
        - Form elicitations when the client advertises `elicitation.form`.
        - Otherwise cancelled, never auto-answered.
    - `editor` carries no `timeout` and Pi never auto-resolves it, so the adapter always answers (`cancelled: true` on turn end or session close).
    - `notify` is logged to stderr.
    - `setStatus`, `setWidget`, `setTitle`, `set_editor_text` are dropped.
- [ ] Session title
    - After the first prompt of a session with no name, derive a title from the first user message excerpt.
    - Write it back with `set_session_name` so Pi's own session picker shows the same name.
    - `session_info_changed` then drives `session_info_update`; `session/list` reads the name from the session file.
- [ ] Turn-lifecycle fixes deferred from the Batch C review
    - Prompt-ack timeout is too tight: the ack is awaited under `PI_ACP_RPC_TIMEOUT_MS`, but Pi acks only after preflight, which can run a full compaction LLM call on a long session and exceed the bound; the request then rejects while Pi runs the turn unsubscribed. Exempt the `prompt` ack from the generic timeout, or race the ack against `agent_start`. This corrects the §1 line-35 claim that an over-bound preflight only ever means a genuine stall.
    - Cancel before `agent_start` is a no-op: `session.abort` does nothing while the run is not active, so an early cancel lets the turn run to completion before the sticky flag reports `cancelled`; return `cancelled` at entry when `signal.aborted`, and re-send `abort` on `agent_start` when already cancelled.
    - `stop()` mid-turn strands `runPrompt`: `notifyExit` returns early while stopping, so `handleExit` never fails the active turn and `settled` never resolves (dangling promise on connection-close teardown). Fail the active turn from `SessionConnection.stop()` before awaiting the client stop.
    - A `null` last stop reason settles as `end_turn`: a post-`agent_start` Pi-internal failure can reach the client as an empty successful turn. Reject `null` as an internal error (invariant: a failed turn never ends `end_turn`).
    - Empty prompt content (`[]`) is forwarded as an empty message instead of `invalid_params`; an embedded resource is inlined as `uri:\ntext` with no delimiter.

## 3. Capability-gated session lifecycle

- Id namespace
    - The ACP `sessionId` is the Pi session id from the session header.
    - The file is located by scanning `<sessions-dir>/*/<timestamp>_<id>.jsonl`; the id is in the file name, the `cwd` in the header line.
    - The per-project directory name is the cwd with `/`, `\`, and `:` replaced by `-`, wrapped in `--`.
    - `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` are honored the way Pi honors them; the child inherits both.
- Pi behaviors the adapter accounts for
    - Pi creates the session file on the first appended entry, not at spawn; a session that never received a prompt has no file, is absent from `session/list`, and cannot be resumed.
    - Pi does not check the process `cwd` against the header `cwd` on `--session`; the adapter enforces the equality.
    - A session whose header `cwd` no longer exists makes Pi exit 1 at open with a stderr message; the adapter reports it as the resume error.

- [ ] `session/list` (`src/session/sessionDirectory.ts`)
    - Read the header line and file mtime only.
    - Filter by `cwd`.
    - Page by decimal-offset cursor.
- [ ] `session/resume` and `session/load`
    - One shared flow spawning a child with `--session <absolute .jsonl path>`; a bare id can resolve as a "global" match and trigger Pi's interactive fork confirmation on stdin.
    - The request `cwd` must equal the header `cwd` or the request is refused.
    - Load replays `get_messages` synchronously before responding: user/agent/thought chunks, completed tool calls with `rawInput` / `rawOutput`.
- [ ] `session/close` and `session/delete`
    - Close abandons in-flight turns (`cancelled`, never hangs) and kills the child.
        - `SessionConnection.stop()` must fail or sticky-cancel `activeTurn` before killing the child: `notifyExit` suppresses `onExit` while `stopping`, so `handleExit → activeTurn.fail()` never fires during an intentional teardown and `runPrompt` would hang on an unresolved `settled` (the §2 "`stop()` mid-turn strands `runPrompt`" fix is load-bearing here).
    - Delete additionally removes the session file.
    - A `closing` flag refuses mid-teardown work.
- [ ] Concurrent access to one session file (a pi-acp child alongside an open Pi TUI) has no lock upstream; recorded under Known limits once the failure shape is characterized.

## 4. Fork and extension seams

- [ ] Fork, head-only
    - `session/fork` spawns a child with `--fork <absolute parent path>` and the requested `cwd`.
    - Pi writes a new session file under the target cwd's session directory with the full head history and `parentSession` set, so a fork into a different `cwd` is supported.
    - `--session-id` can pin the child id if the adapter wants to answer before the child reports it.
- [ ] Breakpoint fork: Pi's `fork` command takes an `entryId` from `get_fork_messages`, so it is feasible once ACP v1 carries a breakpoint marker; not offered until then.
- [ ] MCP seam, opt-in and off by default
    - Pi has no native MCP.
    - Enabled by `PI_ACP_MCP_PASSTHROUGH` with pi-mcp-adapter installed in the Pi environment.
    - ACP `mcpServers` (stdio and http; sse only if pi-mcp-adapter's SSE fallback counts) are handed to the pi-acp extension.
    - The extension registers them through pi-mcp-adapter's `pi-mcp-adapter:runtime-register:v1` event; session-scoped, never persisted.
    - `mcpCapabilities` is advertised only when the seam is enabled.
    - pi-mcp-adapter's `MCP_TOOL_APPROVAL_REQUEST_EVENT` routes MCP tool approvals through the same permission path.
- [ ] Extension-command slash commands: revisit once a reliable did-it-start-a-turn signal exists (`agent_start` within a bounded window, or an upstream change).

## 5. Quality and integration

- [ ] Snapshot test harness: scripted Pi RPC events in, recorded ACP transcript out, in-memory child double, no real Pi.
- [ ] E2E harness (`src/__tests__/e2e/`)
    - Drives the built `dist/index.js` as a real ACP client against a real `pi` with a scratch `PI_CODING_AGENT_DIR`.
    - Gated on `RUN_PI_E2E=true`.
    - Provider key via child environment only; `deepseek-v4-flash-0731` over OpenRouter per .rules.
- [ ] Distribution
    - GitHub Releases only, no npm; `package.json` stays `private`.
    - Release zips carry LICENSE and NOTICE alongside the binary.
    - `#!/usr/bin/env node` hashbang.
    - `package.json` via static import so `bun build --compile` binaries boot without a filesystem.
- [ ] CI (`.github/workflows/ci.yml`): typecheck, unit tests, esbuild bundle `--version` smoke, cross-compile of all six binaries on push/PR to main.
- [ ] Release: `scripts/release.sh` and the tag-triggered `.github/workflows/release.yml`; six `bun --compile` binaries (`{x64,arm64}-{linux,darwin,windows}`).
- [x] Pre-commit hook (`.githooks/pre-commit`, installed via `core.hooksPath` by the `prepare` script): typecheck, unit tests, build, `--version` smoke.
- [ ] Upstream drift: `bun update @earendil-works/pi-coding-agent` and run `bun run typecheck`.
- [ ] docs/caveats.md is created when the first caveat is verified against a real client, not before.

## Known limits

- No fs proxying or ACP terminal methods: Pi does its own file IO and command execution in-process.
- No steering: ACP v1 has no steering method; Pi's `steer` / `follow_up` stay typed but unused until an ACP surface exists.
- Adapter shutdown is driven by stdin EOF / connection close; ACP v1 defines no `exit` notification, so a client that expects process death before closing stdin gets it only when it closes the pipe.
- No transport mode has passed against a real client end-to-end yet; checkboxes track implementation plus unit coverage.

## Exit criteria

Pi upstream ships an ACP agent on current schemas with session resume, thought-level passthrough, correct turn-error reporting, and event-time tool updates. Then archive this repo.
