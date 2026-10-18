# Caveats

Known gaps that are not on the roadmap, each with the reason it stays open. Verified against Pi 1.2.0 and ACP SDK 1.5.1 on 2026-10-15.

## MCP startup status

Pi connects a session's MCP servers after `session_start` and reports a server that failed to connect once, through `ctx.ui.notify`, after the startup connections settle. The client is told in band only through the experimental `notice` update, which ACP v1 allows only for a client that advertises `session.notices`; any other client is not told, and the session proceeds without that server's tools. Pi's own diagnostics stay available through the `/mcp` command it advertises, whose output arrives as a `notify` too. The first prompt waits up to 10 s for servers whose tools are declared directly, which every client-supplied server is; a user's `mcp.json` servers, behind `codemode` by default, are not waited for. A server still connecting after the wait gets a second `notify`, and its tools appear once it connects.

## MCP servers from the user's own Pi configuration

Pi reads `~/.pi/agent/mcp.json` in every session, RPC mode included, so a user's own servers connect into every pi-acp session alongside the ones the client sent. A `.pi/mcp.json` in the cwd needs project trust (see below). An `mcp.json` entry with the same name as a client-supplied server takes precedence, and names are compared as Pi's tool namespaces, so one differing only in `-` against `_` also overrides. Nothing reports the override at startup; only the `/mcp` status lists it. The adapter does not disable Pi's file-configured servers: which servers a Pi install loads is Pi's own configuration, and `"extensions": ["-builtin:mcp"]` in Pi's settings, or Pi's `--no-mcp`, turns the built-in support off entirely, client servers included.

## MCP OAuth sign-in

Pi authenticates an HTTP server without an `Authorization` header through OAuth when the server answers 401. Outside its own terminal UI, `/mcp login` opens a browser on the Pi host and then waits on an `input` dialog, which the adapter answers `cancelled` like every other interactive dialog, so the sign-in never completes. `pi mcp login` sees only file-configured servers, not the ones a client sent. A client-supplied HTTP server therefore has to carry its credentials in `headers`.

## MCP server environment

Pi spawns a stdio server with the whole Pi process environment plus the entry's own `env`, so every client-supplied server sees everything Pi itself sees. Each server's `env` reaches only its own subprocess, and the adapter deletes its `PI_ACP_MCP_SERVERS` payload from the environment before any server starts, which is what keeps one server's headers and env out of another's subprocess. The safe-list environment the adapter's own client used to give each server is gone with that client.

## Extension notifications need client notice support

`ctx.ui.notify` from an extension arrives as an `extension_ui_request`, is logged to stderr, and reaches the client only as a `notice`, which ACP v1 allows only for a client that advertises `session.notices`. It is not forwarded as `agent_message_chunk`, so for any other client an informational extension command ends as an empty `end_turn`. Forwarding it as agent text would change every session's output, not only command prompts, so it stays off.

## Built-in extension commands are advertised

Pi loads its built-in extensions in RPC mode, and `get_commands` lists their commands (`/mcp`, `/llama`), so they reach the client's command menu. `PI_ACP_HIDE_COMMANDS` (a comma-separated list of names) leaves named commands out of `available_commands_update`; a client that sends a hidden command anyway still runs it. Disabling the extension itself is Pi's own setting (`"extensions": ["-builtin:llama.cpp"]`), which the adapter does not touch.

## Project-local Pi resources need a prior trust decision

Pi loads a cwd's `.pi/` resources (settings, `mcp.json`, extensions, skills, prompt templates, themes, system prompt files) only for a trusted project, and its RPC mode never asks: without a saved decision in `<agent-dir>/trust.json`, or an answer from one of the user's own extensions, it follows `defaultProjectTrust` (`ask`, the default, skips them). The adapter passes no `--approve`, so a project never trusted from Pi's own UI runs without its `.pi/` resources, silently. ACP v1 has no prompt to map the decision onto.

## Extension commands that replace the session

An extension command whose handler calls `ctx.newSession`, `switchSession` or `fork` rebinds the session inside the Pi subprocess; the adapter's session id no longer matches Pi's. One that calls `navigateTree` keeps the session but moves it to another branch, which the adapter does not report to the client. Interactive extension commands run with every dialog auto-cancelled. There is no metadata to detect either kind ahead of time, so they are not filtered.

## Nested tool calls

A tool that calls other tools through Pi's `ctx.executeTool` (the `codemode` tool, when a Pi setting or a user's `mcp.json` activates it) emits nested `tool_execution_*` events with ids of the form `<parent>/<n>` and a `parentToolCallId`. ACP v1 has no parent field, so a client sees them as flat sibling tool calls, and since Pi keeps nested calls only as a bounded `nestedCalls` record on the parent's result, with no entries or results of their own, `session/load` replays the parent call only. The permission gate prompts for a nested mutating or MCP call as for a top-level one, never for the orchestrating tool itself.

## Warm spare sessions start early

With `PI_ACP_WARM_SPARE_MAX_AGE_MS` set, a `session/new` that matches the spare's cwd and MCP servers gets a Pi subprocess started up to that long before. Until it is taken or reaches that age, the spare is one more Pi subprocess (about 120 MB resident) with its MCP servers connected. Its session header timestamp is the spare's start, and Pi's settings, `AGENTS.md`, skills and prompt templates are as Pi read them then; only the models and thinking levels are re-read at the take. There is one spare, refilled after a prompt with that session's cwd and MCP servers, so a host that alternates between cwds mostly misses it. A spare that is never taken leaves no session file, since Pi writes the file on the first prompt.

## Origin overrides start at the first provider call

With `PI_ACP_ORIGIN_OVERRIDES` set, the override covers every provider call a session makes. Pi installs a fresh HTTP dispatcher after extensions load, and the extension wraps it again right before each provider call, so requests Pi sends between its startup and a session's first provider call, such as a provider's model catalog refresh, go to the provider's own host. The wrap targets the global dispatcher slot of undici 8, which Pi bundles; an empty slot fails the extension load, which stops Pi at session start, and a Pi release on a later undici major needs the slot re-verified.

## Idle sessions stop their Pi subprocess

With `PI_ACP_IDLE_TIMEOUT_MS` set, a session with no request in flight for that long has its Pi subprocess stopped, and its next prompt, config change or `session/load` relaunches one on the same session; a `session/resume` answers from what the adapter kept and relaunches nothing. The first such request pays a cold start. While the subprocess is stopped, extension background work stops and the session's MCP servers are disconnected; the woken subprocess connects them again, and a server that fails to connect is reported again on each wake. Pi's opt-in `cacheWarming: "idle"` stops with the subprocess. A woken Pi re-reads its settings, `AGENTS.md`, skills, prompt templates and models, so commands or options that changed meanwhile reach the client as `available_commands_update` or `config_option_update`. Where the woken Pi's model, thinking level or session name differs from the session's, the adapter re-applies it, and `allow_always` grants live in the adapter, so they are kept. A session woken before its first prompt is filed under the wake's timestamp, not its creation's.
