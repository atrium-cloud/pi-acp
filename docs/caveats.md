# Caveats

Known gaps that are not on the roadmap, each with the reason it stays open. Verified against Pi 0.87.1 and ACP SDK 1.5.0 on 2026-09-25.

## MCP tool list changes

`tools/list_changed` notifications from an MCP server are ignored for the life of a session. Pi can add or replace a tool after startup (`registerTool` refreshes the registry immediately), but it has no `unregisterTool`; a removed tool can only be deactivated with `setActiveTools`, its definition stays registered. ACP v1 also has no surface to tell the client the tool set changed. A new session picks up the server's current list.

## MCP startup status

A server that fails to connect or to list its tools is logged to the adapter's stderr and skipped, and the session proceeds without its tools. The client is told in band only through the experimental `notice` update, which ACP v1 allows only for a client that advertises `session.notices`; any other client is not told. Skipping rather than failing `session/new` is deliberate, since a client can send every configured server unconditionally and a dead one should not block the session.

## Extension commands wait out a window

A prompt that invokes an advertised extension command which starts no turn resolves `end_turn` only after `EXTENSION_COMMAND_QUIET_MS` (10 s). Pi's `prompt` ack is the same for accepted, queued and handled prompts, there is no second response, and nothing is emitted on the no-turn path, so the adapter has no signal short of waiting for `agent_start`. Polling `get_state.isStreaming` could finish early but races a preflight compaction (no turn active yet, one coming), so it is not used. An upstream ack that distinguishes handled-without-turn would remove the window.

## Extension notifications need client notice support

`ctx.ui.notify` from an extension arrives as an `extension_ui_request`, is logged to stderr, and reaches the client only as a `notice`, which ACP v1 allows only for a client that advertises `session.notices`. It is not forwarded as `agent_message_chunk`, so for any other client an informational extension command ends as an empty `end_turn`. Forwarding it as agent text would change every session's output, not only command prompts, so it stays off.

## Project-local Pi resources need a prior trust decision

Pi loads a cwd's `.pi/` resources (settings, extensions, packages) only for a trusted project, and its RPC mode never asks: without a saved decision in `<agent-dir>/trust.json` it follows `defaultProjectTrust` (`ask`, the default, skips them). The adapter passes no `--approve`, so a project never trusted from Pi's own UI runs without its `.pi/` resources, silently. ACP v1 has no prompt to map the decision onto.

## Extension commands that replace the session

An extension command whose handler calls `ctx.newSession`, `switchSession`, `fork` or `navigateTree` rebinds the session inside the Pi subprocess; the adapter's session id no longer matches Pi's. Interactive extension commands run with every dialog auto-cancelled. There is no metadata to detect either kind ahead of time, so they are not filtered.
