# pi-acp

`pi-acp` is an [Agent Client Protocol](https://agentclientprotocol.com/) v1 adapter for [Pi Agent](https://pi.dev). It uses Pi's [RPC Mode](https://pi.dev/docs/latest/rpc) and presents an ACP surface that is compliant with the latest stable ACP v1 schema.

## Requirements

- Node 22.19 or newer, the same requirement as Pi Agent.
- An installed and configured Pi Agent, named by `PI_ACP_PI_BIN` (the path to its `pi` executable). From a checkout, Pi is a dependency of this package and is launched directly when `PI_ACP_PI_BIN` is unset.

The release is a single executable, `pi-acp`; put it on PATH or point your ACP client at it. On Windows run it as `node pi-acp`.

## Environment

- `PI_ACP_PI_BIN`: the `pi` executable to launch; unset from a checkout.
- `PI_ACP_RPC_TIMEOUT_MS`: bound on each Pi RPC round-trip; default 30000.
- `PI_ACP_HIDE_COMMANDS`: comma-separated command names to leave out of the advertised slash commands, for example `llama`.
- `PI_ACP_WARM_SPARE_MAX_AGE_MS`: keeps one Pi subprocess started ahead for the next `session/new` with the same cwd and MCP servers, stopped at this age; off when unset.
- `PI_ACP_IDLE_TIMEOUT_MS`: stops a session's Pi subprocess once the session has had no request in flight for this long, and relaunches it on the session's next prompt, config change or load; off when unset.
- `PI_ACP_ORIGIN_OVERRIDES`: comma-separated `<authority>=<origin>` pairs, for example `opencode.ai=http://127.0.0.1:3129`; an https request Pi sends through its HTTP dispatcher to a listed authority goes to the paired origin instead, with its own path, query and headers. `<authority>` is the lowercase host, with a `:port` only for a port other than 443, and `<origin>` is `scheme://host[:port]` alone. Off when unset; a malformed or repeated entry fails startup.
- `PI_TIMING`: Pi's own startup profiling switch; with it set to `1`, pi-acp also logs the Pi launch and a startup timing line for each session start and each wake to stderr.

## ACP support

The adapter supports rich prompts, streamed message and tool updates, permissions, model and thinking-level configuration, slash commands, MCP servers (stdio, streamable HTTP) through Pi's own MCP support, session list/resume/load/close/delete, and forks either from the last settled turn or from an earlier prompt the client names.

The adapter refreshes Pi's model catalog in a Pi subprocess of its own, 60 s after it starts and hourly after that, so each session started afterward offers the models Pi saved from the latest refresh.

Audio prompts, session modes, and Pi interactions that need its own terminal UI are not exposed. See [docs/caveats.md](docs/caveats.md) for the gaps that stay open by design and [docs/todos.md](docs/todos.md) for the roadmap.

This project will be deprecated when Pi ships a complete and current ACP implementation as part of its package. Until then, this project tracks the latest stable ACP v1 schema and the latest Pi release.

## Contributing

External pull requests are not accepted. Issues and security reports remain welcome, and forks are permitted under the Apache 2.0 license. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licensing

`pi-acp` is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE). Attribution notices are in [NOTICE](NOTICE), and brand-use guidance is in [TRADEMARKS.md](TRADEMARKS.md).
