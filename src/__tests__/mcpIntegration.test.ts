import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MCP_EXTENSION_SOURCE } from '../mcp/extensionSource.generated.js'
import { ENV_MCP_SERVERS, MCP_EXTENSION_FILENAME } from '../mcp/mcpConstants.js'

// The generated bundle is driven, not the TypeScript source: loading it from a
// temp directory with no node_modules above it is what proves the extension is
// self-contained, which is the only shape jiti can load inside Pi.

const PROBE_SERVER = fileURLToPath(new URL('./fixtures/mcp-probe-server.mjs', import.meta.url))
const SHUTDOWN_EVENT = 'session_shutdown'
// Present in this process while the servers spawn; must not reach them.
const CANARY_ENV = 'PI_ACP_TEST_CANARY'

interface RegisteredTool {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: unknown[]; details: unknown }>
}

interface LoadedExtension {
  default: (pi: unknown) => Promise<void>
  connectServer: (spec: unknown) => Promise<{ client: { getProtocolEra: () => string | undefined; close: () => Promise<void> } }>
}

const tools: RegisteredTool[] = []
const handlers = new Map<string, () => Promise<void>>()
const stderrLines: string[] = []
let dir: string
let loaded: LoadedExtension

function toolNamed(name: string): RegisteredTool {
  const tool = tools.find((candidate) => candidate.name === name)
  if (tool === undefined) throw new Error(`no tool named ${name} among ${tools.map((candidate) => candidate.name).join(', ')}`)
  return tool
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-'))
  const extensionPath = join(dir, MCP_EXTENSION_FILENAME)
  writeFileSync(extensionPath, MCP_EXTENSION_SOURCE, 'utf8')

  const pi = {
    registerTool: (tool: unknown) => {
      tools.push(tool as RegisteredTool)
    },
    on: (event: string, handler: () => Promise<void>) => {
      handlers.set(event, handler)
    },
  }

  process.env[CANARY_ENV] = 'leaked'
  process.env[ENV_MCP_SERVERS] = JSON.stringify([
    { kind: 'stdio', name: 'probe', command: process.execPath, args: [PROBE_SERVER], env: { PROBE_SECRET: 'probe-only' } },
    { kind: 'stdio', name: 'dead', command: join(dir, 'not-an-executable'), args: [], env: {} },
  ])

  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrLines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    loaded = (await import(/* @vite-ignore */ pathToFileURL(extensionPath).href)) as LoadedExtension
    await loaded.default(pi)
  } finally {
    process.stderr.write = write
  }
}, 30_000)

afterAll(async () => {
  delete process.env[CANARY_ENV]
  await handlers.get(SHUTDOWN_EVENT)?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('the generated MCP extension against a real stdio server', () => {
  it('deletes the server payload from the environment before anything can inherit it', () => {
    expect(process.env[ENV_MCP_SERVERS]).toBeUndefined()
  })

  it('registers every tool of the reachable server under the mcp prefix', () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(['mcp__probe__boom', 'mcp__probe__echo', 'mcp__probe__env', 'mcp__probe__shape'])
  })

  it('skips the server that cannot start and says so on stderr', () => {
    expect(stderrLines.join('')).toMatch(/pi-acp mcp: server dead failed:/)
    expect(tools.some((tool) => tool.name.startsWith('mcp__dead__'))).toBe(false)
  })

  it('carries the label, description, and the server schema minus its $schema', () => {
    const echo = toolNamed('mcp__probe__echo')
    expect(echo.label).toBe('MCP: probe/echo')
    expect(echo.description).toBe('Echoes text back and returns an image block too')
    expect(echo.parameters).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } })
    expect(echo.parameters['$schema']).toBeUndefined()
  })

  it('returns mixed text and image content, with the raw result as details', async () => {
    const result = await toolNamed('mcp__probe__echo').execute('tc1', { text: 'hi' })
    expect(result.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', mimeType: 'image/png' },
    ])
    expect(result.details).toMatchObject({ content: [{ type: 'text', text: 'hi' }, { type: 'image', mimeType: 'image/png' }] })
  })

  it('throws the server text when the tool reports isError', async () => {
    await expect(toolNamed('mcp__probe__boom').execute('tc2', {})).rejects.toThrow('deliberate failure')
  })

  it('unwraps a JSON string the model emitted for an object parameter', async () => {
    const result = await toolNamed('mcp__probe__shape').execute('tc3', { payload: '{"a":"unwrapped"}' })
    expect(result.content).toEqual([{ type: 'text', text: '{"a":"unwrapped"}' }])
  })

  it('spawns the server with the SDK safe-list plus its own env entries, never the adapter payload or the rest of process.env', async () => {
    const result = await toolNamed('mcp__probe__env').execute('tc4', {})
    const block = result.content[0] as { text: string }
    const env = JSON.parse(block.text) as Record<string, string>
    expect(env['PATH']).toBe(process.env['PATH'])
    expect(env['PROBE_SECRET']).toBe('probe-only')
    expect(env[ENV_MCP_SERVERS]).toBeUndefined()
    expect(env[CANARY_ENV]).toBeUndefined()
  })

  it('negotiates the modern protocol era with a server that offers it', async () => {
    const connection = await loaded.connectServer({ kind: 'stdio', name: 'probe', command: process.execPath, args: [PROBE_SERVER], env: {} })
    try {
      expect(connection.client.getProtocolEra()).toBe('modern')
    } finally {
      await connection.client.close()
    }
  })

  it('closes every client on session shutdown', async () => {
    const shutdown = handlers.get(SHUTDOWN_EVENT)
    expect(shutdown).toBeTypeOf('function')
    await expect(shutdown?.()).resolves.toBeUndefined()
  })
})
