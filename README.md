# pi-acp

`pi-acp` is an [Agent Client Protocol](https://agentclientprotocol.com/) v1 adapter for [Pi Agent](https://pi.dev). It uses Pi's [RPC Mode](https://pi.dev/docs/latest/rpc) and presents an ACP surface that is compliant with the latest stable ACP v1 schema.

## Requirements

- Node 22.19 or newer, the same requirement as Pi Agent.
- An installed and configured Pi Agent, named by `PI_ACP_PI_BIN` (the path to its `pi` executable). From a checkout, Pi is a dependency of this package and is launched directly when `PI_ACP_PI_BIN` is unset.

The release is a single executable, `pi-acp`; put it on PATH or point your ACP client at it. On Windows run it as `node pi-acp`.

## ACP support

The adapter supports rich prompts, streamed message and tool updates, permissions, model and thinking-level configuration, slash commands, MCP servers (stdio, streamable HTTP, SSE), session list/resume/load/close/delete, and forks from the last settled turn.

Audio prompts, session modes, breakpoint forks, and Pi interactions that need its own terminal UI are not exposed. See [docs/caveats.md](docs/caveats.md) for the gaps that stay open by design and [docs/todos.md](docs/todos.md) for the roadmap.

This project will be deprecated when Pi ships a complete and current ACP implementation as part of its package. Until then, this project tracks the latest stable ACP v1 schema and the latest Pi release.

## Contributing

External pull requests are not accepted. Issues and security reports remain welcome, and forks are permitted under the Apache 2.0 license. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licensing

`pi-acp` is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE). Attribution notices are in [NOTICE](NOTICE), and brand-use guidance is in [TRADEMARKS.md](TRADEMARKS.md).
