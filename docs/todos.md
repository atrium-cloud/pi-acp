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
    - The release bundle ships without `node_modules`, so `PI_ACP_PI_BIN` is required there.
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
    - `initialize`: returns pi-acp's own version and capabilities synchronously.
    - Provider auth failures surface as turn errors carrying Pi's message; wired with the turn layer (`session/prompt`).
- [x] `session/new`
    - Validate an absolute `cwd`, spawn the child, read `get_state` for the session id and file.
    - Build `configOptions`; send `available_commands_update`.
    - `mcpServers` are translated and handed to the built-in MCP extension (section 4); only `type: "acp"`, duplicate names and unparseable urls are rejected.
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
- [x] Streaming translation
    - Stateful per-turn `src/turn/TurnHandler.ts`; a pure `src/turn/mappers.ts` holds the tool/usage/session mappers.
    - `message_update` sub-events distinguish text from thinking by their own type (`text_delta` vs `thinking_delta`), not a `contentIndex → kind` map (done)
        - `text_*` → `agent_message_chunk`
        - `thinking_*` → `agent_thought_chunk`
        - `contentIndex` is only tracked so a `*_end` re-emits the full content when no delta streamed for that index; reset on `message_start`.
    - `tool_execution_start/update/end` → `tool_call` / `tool_call_update`
        - Kinds for `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls` (closed `ToolKind` union; unknown → `other`).
        - `locations` from `path` args; `rawInput` / `rawOutput` carried; args cached at start (the end event omits them).
        - `edit` rendered as one `diff` content block per `edits[]` entry, built from the INPUT `{oldText,newText}` (ACP's `Diff` doesn't decompose `details.patch`).
        - `bash` partial results replace the row content via `tool_execution_update.partialResult`; `bash_execution_update` is ignored as redundant (UNVERIFIED against live Pi).
    - Pi's default tool set is `read`, `bash`, `edit`, `write`; `grep` / `find` / `ls` are opt-in and `powershell` is Windows-only. The kind map covers all eight.
- [x] Session-level wire events not in the RPC docs' event table
    - `session_info_changed { name }` → `session_info_update`
    - `thinking_level_changed { level }` → `config_option_update` (full set, rebuilt from the cached current model — no round-trip; the client tolerates the idempotent echo of a client-initiated set)
    - `entry_appended`, `queue_update`: ignored
    - Exhaustive switch over `JsonAgentSessionEvent` with no `default` keeps the list honest.
- [x] Usage
    - `usage_update` from `get_session_stats.contextUsage` at turn end; `contextWindow` is the gauge size; `null` tokens right after compaction are skipped.
    - Mid-turn `usage_update` from `message_update.usage` is DEFERRED: the occupancy formula can't be matched to Pi's own accounting without a live sprite run, so only the authoritative end-of-turn path ships (the plan's sanctioned fallback).
- [x] Permissions via a pi-acp-owned Pi extension loaded with `-e`
    - Extension side (`src/permissions/gate.ts`, source built from shared constants, materialized once at startup)
        - `tool_call` handler asks through `ctx.ui.select` for every mutating built-in tool: `bash`, `powershell`, `edit`, `write`.
        - The `select` title is sentinel JSON carrying `toolCallId` and `toolName` only; the input is never re-sent (a large `write` would otherwise cross the Pi wire twice).
        - `allow_always` is remembered per session per tool name inside the extension; default-deny on any unrecognized answer (Pi passes the value through unvalidated).
    - Adapter side (`SessionConnection.handleExtensionUiRequest`)
        - Recognizes the sentinel and maps it to `session/request_permission` with `allow_once`, `allow_always`, `reject_once`.
        - Reads the tool input from the turn's cache: Pi emits `tool_execution_start` before it runs the `tool_call` hook (Pi `docs/extensions.md`, and `beforeToolCall` is invoked from `prepareToolCall` after the start event in the agent loop), so the id is always announced by the time the sentinel arrives. An unannounced id (no turn, or a sentinel forged by another loaded extension) is denied without a prompt.
        - Bounded `PERMISSION_REQUEST_TIMEOUT_MS`; `undefined`, `cancelled`, timeout, and a request error all resolve to deny. A timeout also sends `$/cancel_request` so the client's dialog closes.
        - A blocked tool is finalized by Pi as an immediate error result, so it still gets a failed `tool_execution_end` carrying the denial reason; the adapter adds no synthetic terminal update.
    - Packaging
        - Extension source is embedded in the bundle (never naming the dev-only Pi package) and materialized to a temp file at startup so the single-file release bundle works.
        - The subprocess is spawned without `--no-extensions` so the user's own extensions keep loading alongside the gate.
    - The sentinel prefix is a trust boundary, not a security boundary: any extension in the same Pi process can emit one, but the worst case is a spurious prompt for an already-announced id.
    - The live permission round-trip is verified against Pi 0.84.3 on the sprite (§3 and §4 runs: allow once, allow always, reject, for built-ins and MCP tools).
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
    - All three sources are advertised (`prompt`, `skill`, `extension`); no `input` hint is emitted, since the snapshot carries no argument hint to map onto it.
    - Nothing in the RPC stream says whether an `extension` command starts an agent loop, so the bounded `agent_start` window decides: a quiet window resolves `end_turn` when the prompt invoked an advertised extension command, and stays a protocol error for every other prompt.
- [x] Other extension UI requests
    - `confirm`, `input`, `editor`, and non-sentinel `select` are answered `cancelled: true` immediately (fail closed, never auto-answered, never wedged) — `editor` too, since Pi never auto-resolves it.
        - Form-elicitation mapping when the client advertises `elicitation.form` is DEFERRED; the compliant fallback (cancelled) ships. The SDK surface exists (`AgentContext.createElicitation`, gated on `ClientCapabilities.elicitation`).
    - `notify` is logged to stderr.
    - `setStatus`, `setWidget`, `setTitle`, `set_editor_text` are dropped.
- [x] Session title
    - After the first prompt of a nameless session, derive a title from the first user message's first line (bounded), skipped when it trims empty (Pi rejects an empty name).
    - Write it back with `set_session_name` so Pi's own session picker shows the same name.
    - `session_info_changed` then drives `session_info_update`; `session/list` reads the name from the session file.
- [x] Turn-lifecycle fixes deferred from the Batch C review (all implemented in the D/E pass)
    - Prompt-ack timeout: the prompt command now awaits under a generous `PROMPT_ACK_TIMEOUT_MS` (a `PiRpcClient.request` per-call override), so a preflight compaction no longer strands the turn.
    - Cancel before `agent_start`: `runPrompt` returns `cancelled` at entry when `signal.aborted`, and the turn re-issues `abort` on `agent_start` when it was cancelled during preflight.
    - `stop()` mid-turn: `SessionConnection.stop()` fails the active turn before awaiting the client stop, so `runPrompt` no longer hangs on connection-close teardown.
    - A `null` last stop reason is rejected as an internal error, never reported as `end_turn`.
    - Empty prompt content (`[]` or an all-empty message with no images) is now `invalid_params`. The embedded-resource `uri:\ntext` inlining is intentionally retained (the pinned path-header format).

## 3. Capability-gated session lifecycle

- Id namespace
    - The ACP `sessionId` is the Pi session id from the session header.
    - The file is located by scanning for a name ending in `_<id>.jsonl` (never by splitting on the first underscore: a `--session-id` may contain underscores, a timestamp cannot); the `cwd` is in the header line. With a request `cwd` that cwd's directory is scanned first and a miss falls back to the whole store, so a session that belongs to another cwd is refused as such rather than reported missing; `session/delete` carries no cwd and scans every directory. A full id matching files in more than one directory is an error listing the candidates, never a pick.
    - The per-project directory name is the cwd with its leading separator stripped and every `/`, `\`, `:` replaced by `-`, wrapped in `--`. The encoding is lossy, so the header `cwd` is always checked too.
    - The session directory follows Pi's own precedence: `PI_CODING_AGENT_SESSION_DIR` (one flat directory, tilde-expanded), else the `sessionDir` in `<agent-dir>/settings.json`, else `<agent-dir>/sessions/<encoded-cwd>/`, where `<agent-dir>` is `PI_CODING_AGENT_DIR` else `~/.pi/agent`. The child inherits the environment, so both sides agree on the directory. Pi's app-name override (`piConfig`, which renames the env vars and the `.pi` directory) is not honored.
    - The adapter's scanner never writes; the one file it creates is a fork (§4), in Pi's own format. Pi's own reader repairs a missing trailing newline during a read; the adapter must not replicate that.
- Pi behaviors the adapter accounts for
    - Pi buffers a new session in memory and creates the file on the first assistant message, not at spawn; a session that never completed a turn has no file, is absent from `session/list`, and cannot be resumed, forked, or deleted (`resource_not_found`).
    - The session name is not a header field: it is the latest `session_info` entry, and an empty name clears it.
    - Pi does not check the process `cwd` against the header `cwd` on `--session` (it adopts the header cwd); the adapter enforces the equality before spawning and refuses a mismatch with `invalid_params`.
    - Pi's RPC mode has no id resolution; only an absolute path is ever passed. A bare id on the CLI can resolve as a "global" match and trigger Pi's interactive fork confirmation on stdin, which is why the path form is used.
    - A session whose header `cwd` no longer exists makes Pi exit 1 at open with a stderr message; the adapter reports it through the existing start-failure path (a missing request cwd fails at spawn the same way `session/new` does).
    - Pi has no delete API; its docs bless removing the `.jsonl`. Delete is a plain `unlink`.
- [x] `session/list` (`src/session/sessionDirectory.ts`)
    - Each file is streamed fully the way Pi's own session list reads it: `title` is the latest `session_info` name, else the first user message's first line (bounded by `SESSION_TITLE_MAX_CHARS`), else `null`; `updatedAt` is the latest message timestamp, else the header timestamp, else the file mtime. Reads are capped at Pi's concurrency (10). Malformed lines and header-less files are skipped as Pi skips them.
    - Filter by `cwd` (absolute, else `invalid_params`) on header equality; sorted by `updatedAt` descending.
    - Page by decimal-offset cursor over the freshly sorted list (`invalid_params` when not a whole number); `nextCursor` omitted on the last page.
- [x] `session/resume` and `session/load`
    - One shared flow (`establishSession` in an open mode) spawning a child with `--session <absolute .jsonl path>` and asserting the reported `sessionId` equals the requested one.
    - `mcpServers` (optional on resume) are translated and registered for the reopened session, as on `session/new`; `additionalDirectories` are refused non-empty.
    - An id already live in this adapter is reused rather than opened again (no lock upstream; a second child on one file forks the history, see Known limits): the request `cwd` must equal the live connection's cwd.
    - Load replays `get_messages` (the active-branch, post-compaction view) before responding: `user_message_chunk` per block (string content is one text block, images map to image content), `agent_message_chunk` / `agent_thought_chunk`, and completed tool calls as `tool_call` + `tool_call_update` built by the live mappers from the cached `toolCall` arguments (edit diffs identical to live). A `toolCall` with no `toolResult` is omitted entirely so no row is stranded; `bashExecution`, `custom`, `branchSummary`, `compactionSummary` are skipped (no ACP surface). Pure `src/session/replay.ts`.
    - Both respond `{ configOptions }` (no modes); `available_commands_update` lands after the response, as on `session/new`.
    - Load on an id that is already live replays the full history again from the live subprocess: the replay is unconditional by design, the client asked for a load, and `cwd` equality is checked the same way. Path equality everywhere is `path.resolve` on both sides with no case folding, which is Pi's own rule.
- [x] `session/close` and `session/delete`
    - Close cancels the in-flight turn so the pending `session/prompt` resolves `cancelled` (a new `TurnHandler.abandon` path; `fail` stays the error path for subprocess death), sends `abort` best-effort, stops the child, and drops the session. Unknown id is `invalid_params`.
    - A `closing` flag refuses mid-teardown work with `invalid_request`. A close during the prompt ack window (preflight) swallows the transport rejection of that ack, since the turn already holds `cancelled`; a closing turn skips the title and usage round-trips.
    - Delete locates the file first (`resource_not_found` before any side effect), closes the session if live, then unlinks.
- [x] Concurrent access to one session file characterized on the sprite against Pi 0.84.3 (a pi-acp child plus a `pi -p --session <file>` run); recorded under Known limits.
- [x] Verified live on the sprite: list (title, cwd, updatedAt, paging errors), close then resume with context continuity, load replay from both the live subprocess and disk (same tool call id as the live turn, `rawInput`/`rawOutput` present, `available_commands_update` after the response), delete, mid-turn close resolving `cancelled` in under 30 ms, never-flushed and other-cwd sessions.

## 4. Fork and extension seams

- [x] Fork
    - The adapter writes the fork's file itself, in Pi's own format — a fresh header (`version`, a minted UUIDv7 id, the request `cwd`, `parentSession` = the parent's absolute path) followed by every parent entry in file order, re-serialized from its parsed form (key order kept, number formatting and escapes normalized, a malformed line dropped as on read), written in one call — and then opens it like any stored session with `--session`. If Pi fails to open it, the file is removed so no session the client never heard of stays listable.
    - It is written rather than delegated because Pi's `--fork` copies the parent's file as it stands, in-flight turn included, and Pi's RPC `fork` replaces the session inside the parent's own subprocess and aborts its turn; neither can produce a second live session the parent survives.
    - A parent with a turn in flight in this adapter is forked from its last settled turn: Pi appends the user entry as a turn starts, so everything from the last user message on is dropped, and the adapter is the only writer of its own live sessions. A parent whose very first turn is in flight therefore forks to an empty session (header only).
    - The copy is the whole tree (abandoned branches, summaries, labels, the `session_info` name included), so the fork inherits the parent's title until it is renamed.
    - The fork's file exists before its first turn, so unlike a `session/new` session it is immediately listable, resumable and deletable.
    - Forking into another `cwd` is supported and lands the file under that cwd's session directory; the parent's own cwd is never checked, since cross-project forking is the point of the method.
    - A parent Pi never flushed has no file and is `resource_not_found`, the same reading `session/resume` and `session/delete` take.
    - The fork is returned live and promptable (`{ sessionId, configOptions }`, commands announced after the response, as on `session/new`); history is not replayed, since replay is `session/load`'s contract.
    - `sessionCapabilities.fork` is advertised even though the ACP SDK marks the method experimental.
    - A fork point stays out (see Known limits); the fork always starts from the parent's last file entry.
- [x] Built-in MCP
    - Pi has no native MCP, so the adapter brings its own: a second pi-acp-owned Pi extension with `@modelcontextprotocol/client` 2.0 bundled self-contained by `scripts/generate-mcp-extension.mjs`, materialized to a temp file at startup and loaded with a second `-e` by a session whose request carries servers.
    - The translated server list is handed over in `PI_ACP_MCP_SERVERS`, which the extension parses and deletes in its factory body before any tool or MCP subprocess can inherit it; the residue is the Pi process environment for its lifetime.
    - A stdio server gets the SDK's safe-list environment (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`; the Windows equivalents there) plus the ACP `env` entries, never a `process.env` spread, so one server's secrets stay out of another's subprocess; the integration test spawns a server that reports its environment to pin this.
    - Protocol negotiation is `auto`: a 2026-07-28 server is spoken to on its own revision via `server/discover`, an older one falls back to the `initialize` handshake.
    - Tools are registered in the async extension factory, which Pi awaits before `session_start`, so they exist before the first prompt.
    - `parameters` is the server's own JSON Schema (minus the root `$schema` and `additionalProperties`); Pi's validator handles raw JSON Schema natively, so the schema is not converted. At call time one layer of JSON string is unwrapped for an `object` or `array` parameter, since models emit that shape.
    - Tool names are `mcp__<server>__<tool>` with each part sanitized to `[A-Za-z0-9_]`; a name that collides after sanitization is skipped with a stderr line.
    - Every MCP tool goes through the permission gate: the gate asks for the mutating built-ins plus anything carrying the `mcp__` prefix, since third-party tool code cannot be classified.
    - Results are flattened onto Pi's text/image content: text and images are kept, embedded resources, resource links and audio become text, `structuredContent` is the fallback when a result carries no content blocks, and text is bounded to 50 KiB / 2000 lines with images exempt from the byte count.
    - `isError: true` throws, which Pi surfaces as a failed tool call.
    - A server that fails to connect or to list its tools is skipped with one stderr line and the session proceeds without its tools; the client is not told in band, since ACP has no MCP status surface.
    - `mcpCapabilities { http, sse }` is advertised at `initialize`; the experimental `acp` transport is rejected with invalid_params.
    - Nothing persists across sessions: each of `session/new`, `session/resume`, `session/load` and `session/fork` registers exactly what its own request carries, and an absent list means none.
    - `tools/list_changed` is ignored: Pi has no `unregisterTool`, and ACP has no tool-list surface to push a change to.
    - A client that can name a stdio `command` can run anything in the Pi environment; that is inherent to the ACP schema, and no env or header value is interpolated.
    - Image blocks are passed to the model unvalidated, as Pi does for its own tools; a server returning an image the provider rejects fails that turn and every later turn of the session, since the image stays in the transcript.
- [x] Extension-command slash commands
    - Advertised alongside `prompt` and `skill` commands, with their invocation names (Pi's `name:1` / `name:2` disambiguation included) threaded to the session connection.
    - `runPrompt` recognizes an invocation with Pi's own parse — a leading `/` on the untrimmed message and a name delimited by the first literal space — and arms the start window with that flag, so a quiet `EXTENSION_COMMAND_QUIET_MS` resolves `end_turn` instead of the protocol error; a cancel still wins, and a command that does start a turn is indistinguishable from an ordinary prompt.
    - A prompt that ran no turn skips the title and usage round-trips: its text is a command line, not a title, and no tokens were spent.
- [x] Verified on the sprite against Pi 0.84.3 (2026-08-29): extension commands, fork (cross-cwd and mid-turn), MCP over stdio, streamable HTTP and SSE, including through a single-file build with no `node_modules`.

## 5. Quality and integration

- [x] Snapshot test harness (`src/__tests__/acpTestFixture.ts`): scripted Pi RPC events in, recorded ACP transcript out, no real Pi. New adapter tests default to this style.
- [x] E2E harness (`src/__tests__/e2e/`): the built `dist/index.js` driven as a real ACP client against a real Pi.
    - Uses the host's own Pi credentials; only the session store is redirected to scratch (`PI_CODING_AGENT_SESSION_DIR`).
    - `RUN_PI_E2E=true` (`bun run test:e2e`); model `openrouter/deepseek/deepseek-v4-flash-0731`.
    - 18 cases across turns, config, lifecycle, fork, permissions, prompt content, MCP stdio, extension commands. 18/18 on the sprite against Pi 0.84.4 (2026-08-29).
- [x] Distribution: one `pi-acp.zip` (the `pi-acp` executable, a hashbang bundle, plus LICENSE and NOTICE) on GitHub Releases, no npm. Needs Node 22.19+ on PATH and `PI_ACP_PI_BIN`.
- [x] CI (`.github/workflows/ci.yml`): typecheck, unit tests, build, `--version` smoke, `bun run package`.
- [x] Release: `scripts/release.sh [patch|minor|major|X.Y.Z] [--dry-run] [--push]` bumps, tags and pushes; `release.yml` packages and attaches the zip with `docs/changelogs/<tag>.md` as the body.
- [x] Pre-commit hook (`.githooks/pre-commit`, installed via `core.hooksPath` by the `prepare` script): typecheck, unit tests, build, `--version` smoke.
- [x] Upstream drift: `bun update @earendil-works/pi-coding-agent`, then typecheck, unit tests, and the live tier on the sprite.
    - 0.84.3 → 0.84.4 on 2026-08-29, all three green; docs/refs.md carries the pin.
- [x] docs/caveats.md holds the gaps that stay open by design (fork point, MCP tool-list changes and startup status, the extension-command quiet window, unforwarded extension notifications, session-replacing commands), each with the reason.

## Known limits

- No fs proxying or ACP terminal methods: Pi does its own file IO and command execution in-process.
- No steering: ACP v1 has no steering method; Pi's `steer` / `follow_up` stay typed but unused until an ACP surface exists.
- Adapter shutdown is driven by stdin EOF / connection close; ACP v1 defines no `exit` notification, so a client that expects process death before closing stdin gets it only when it closes the pipe.
- The stdio transport has passed end-to-end against the ACP SDK client driving `dist/index.js` (the §5 live tier); no editor client has been exercised yet.
- Breakpoint fork: Pi's `fork` command takes an `entryId` from `get_fork_messages`, so it is feasible once ACP v1 carries a breakpoint marker; not offered until then.
- An extension command whose handler calls `ctx.newSession`, `ctx.switchSession`, `ctx.fork`, or `ctx.navigateTree` replaces the session inside the Pi subprocess, so the adapter's `sessionId` silently stops matching the session Pi is now running. Nothing on the wire reports it, and a command's metadata says nothing about what its handler does, so there is nothing to filter on.
- An interactive extension command runs with every one of its dialogs auto-cancelled: the adapter answers every non-sentinel `ctx.ui` request `cancelled: true`, so such a command completes as if the user dismissed each prompt.
- Two Pi processes on one session file (a pi-acp session alongside a Pi TUI or `pi -p --session` run) take no lock, and the adapter adds none. Observed on Pi 0.84.3:
    - Appends do not interleave mid-record; the file stays well-formed.
    - Each process keeps its own in-memory leaf, so the second writer's entries become a sibling branch off the entry that was last when it opened.
    - The pi-acp side never sees the other branch; a fresh open follows the last-written leaf and `session/load` replays only that branch.
    - Reuse of a live id inside one adapter prevents the adapter from doing this to itself; Pi's own tools on the same file are on their own.

## Exit criteria

Pi upstream ships an ACP agent on current schemas with session resume, thought-level passthrough, correct turn-error reporting, and event-time tool updates. Then archive this repo.
