# Caveats

Known gaps that are not on the roadmap, each with the reason it stays open. Verified against Pi 0.99.1 and ACP SDK 1.5.1 on 2026-09-30.

## MCP startup status

Pi connects a session's MCP servers after `session_start` and reports a server that failed to connect once, through `ctx.ui.notify`, after the startup connections settle. The client is told in band only through the experimental `notice` update, which ACP v1 allows only for a client that advertises `session.notices`; any other client is not told, and the session proceeds without that server's tools. Pi's own diagnostics stay available through the `/mcp` command it advertises, whose output arrives as a `notify` too. The first prompt waits up to 10 s for servers still connecting; a slower server's tools appear once it connects.

## MCP servers from the user's own Pi configuration

Pi 0.99 reads `~/.pi/agent/mcp.json` in every session, RPC mode included, so a user's own servers connect into every pi-acp session alongside the ones the client sent. A `.pi/mcp.json` in the cwd needs project trust (see below). An `mcp.json` entry with the same name as a client-supplied server takes precedence, and nothing on the wire reports the override. The adapter does not disable Pi's file-configured servers: which servers a Pi install loads is Pi's own configuration, and `"extensions": ["-builtin:mcp"]` in Pi's settings turns the built-in support off entirely.

## MCP OAuth sign-in

Pi authenticates an HTTP server without an `Authorization` header through OAuth, and the sign-in runs from the `/mcp` dialog, which the adapter answers `cancelled` like every other interactive dialog. `pi mcp login` sees only file-configured servers, not the ones a client sent. A client-supplied HTTP server therefore has to carry its credentials in `headers`.

## MCP server environment

Pi spawns a stdio server with the whole Pi process environment plus the entry's own `env`, so every client-supplied server sees everything Pi itself sees. Each server's `env` reaches only its own subprocess, and the adapter deletes its `PI_ACP_MCP_SERVERS` payload from the environment before any server starts, which is what keeps one server's headers and env out of another's subprocess. The safe-list environment the adapter's own client used to give each server is gone with that client.

## Extension notifications need client notice support

`ctx.ui.notify` from an extension arrives as an `extension_ui_request`, is logged to stderr, and reaches the client only as a `notice`, which ACP v1 allows only for a client that advertises `session.notices`. It is not forwarded as `agent_message_chunk`, so for any other client an informational extension command ends as an empty `end_turn`. Forwarding it as agent text would change every session's output, not only command prompts, so it stays off.

## Built-in extension commands are advertised

Pi 0.99 loads its built-in extensions in RPC mode, and `get_commands` lists their commands (`/mcp`, `/llama`), so they reach the client's command menu. `PI_ACP_HIDE_COMMANDS` (a comma-separated list of names) leaves named commands out of `available_commands_update`; a client that sends a hidden command anyway still runs it. Disabling the extension itself is Pi's own setting (`"extensions": ["-builtin:llama.cpp"]`), which the adapter does not touch.

## Project-local Pi resources need a prior trust decision

Pi loads a cwd's `.pi/` resources (settings, extensions, packages, `mcp.json`) only for a trusted project, and its RPC mode never asks: without a saved decision in `<agent-dir>/trust.json` it follows `defaultProjectTrust` (`ask`, the default, skips them). The adapter passes no `--approve`, so a project never trusted from Pi's own UI runs without its `.pi/` resources, silently. ACP v1 has no prompt to map the decision onto.

## Extension commands that replace the session

An extension command whose handler calls `ctx.newSession`, `switchSession`, `fork` or `navigateTree` rebinds the session inside the Pi subprocess; the adapter's session id no longer matches Pi's. Interactive extension commands run with every dialog auto-cancelled. There is no metadata to detect either kind ahead of time, so they are not filtered.

## Nested tool calls

A tool that calls other tools through Pi's `ctx.executeTool` (the `codemode` tool, when a Pi setting or a user's `mcp.json` activates it) emits nested `tool_execution_*` events with ids of the form `<parent>/<n>` and a `parentToolCallId`. ACP v1 has no parent field, so a client sees them as flat sibling tool calls, and since Pi records nested calls in no transcript entry, `session/load` replays the parent call only. The permission gate prompts for a nested mutating or MCP call as for a top-level one, never for the orchestrating tool itself.
