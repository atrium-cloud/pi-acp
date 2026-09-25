// A real MCP server over stdio, spawned as a subprocess by mcpIntegration.test.ts.
// `serveStdio` serves the 2026-07-28 era when the client probes for it and the
// `initialize` handshake otherwise, so the client's negotiation is exercised.
// With PROBE_STARTUP_FAILURE set it writes that to stderr and exits instead: a
// server that fails to start and leaves a stderr tail.
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const startupFailure = process.env['PROBE_STARTUP_FAILURE']
if (startupFailure !== undefined) {
  // A pipe write can still be pending at exit on macOS.
  await new Promise((resolve) => process.stderr.write(`${startupFailure}\n`, resolve))
  process.exit(1)
}

serveStdio(() => {
  const server = new McpServer({ name: 'probe-server', version: '1.0.0' })

  server.registerTool(
    'echo',
    { description: 'Echoes text back and returns an image block too', inputSchema: z.object({ text: z.string() }) },
    async ({ text }) => ({
      content: [
        { type: 'text', text },
        { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', mimeType: 'image/png' },
      ],
    }),
  )

  server.registerTool('boom', { description: 'Always fails', inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'deliberate failure' }],
    isError: true,
  }))

  server.registerTool(
    'shape',
    { description: 'Echoes back a structured payload', inputSchema: z.object({ payload: z.object({ a: z.string() }) }) },
    async ({ payload }) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
  )

  server.registerTool('env', { description: 'Returns this process environment', inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: JSON.stringify(process.env) }],
  }))

  return server
})
