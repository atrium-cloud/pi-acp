import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { McpServer } from '@agentclientprotocol/sdk'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { ENV_MCP_SERVERS, MCP_EXTENSION_FILENAME } from '../constants.js'
import { MCP_EXTENSION_SOURCE, materializeMcpExtension } from '../mcp/extension.js'
import { translateMcpServers } from '../mcp/servers.js'

interface Registration {
  readonly name: string
  readonly config: unknown
  /** The payload variable as the extension left it when this call arrived. */
  readonly payloadAtCall: string | undefined
}

type ExtensionFactory = (pi: { registerMcpServer: (name: string, config: unknown) => void }) => void

const SERVERS: McpServer[] = [
  { name: 'probe', command: '/usr/bin/probe', args: ['--serve'], env: [{ name: 'TOKEN', value: '$s3cret' }] },
  { type: 'http', name: 'remote', url: 'https://example.test/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] },
]
const SPECS = translateMcpServers(SERVERS)

let dir: string
let factory: ExtensionFactory

// Imported from a real file, the way Pi loads it, so the shipped source runs
// rather than a reimplementation.
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-'))
  const path = join(dir, MCP_EXTENSION_FILENAME)
  writeFileSync(path, MCP_EXTENSION_SOURCE, 'utf8')
  factory = ((await import(/* @vite-ignore */ pathToFileURL(path).href)) as { default: ExtensionFactory }).default
})

afterEach(() => {
  delete process.env[ENV_MCP_SERVERS]
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function load(): Registration[] {
  const registrations: Registration[] = []
  factory({
    registerMcpServer: (name, config) => {
      registrations.push({ name, config, payloadAtCall: process.env[ENV_MCP_SERVERS] })
    },
  })
  return registrations
}

describe('the MCP extension source', () => {
  it('registers every server from the payload with its exact config, in order', () => {
    process.env[ENV_MCP_SERVERS] = JSON.stringify(SPECS)
    expect(load().map(({ name, config }) => ({ name, config }))).toEqual(SPECS)
  })

  it('deletes the payload from the environment before the first registration', () => {
    process.env[ENV_MCP_SERVERS] = JSON.stringify(SPECS)
    expect(load().map((registration) => registration.payloadAtCall)).toEqual([undefined, undefined])
    expect(process.env[ENV_MCP_SERVERS]).toBeUndefined()
  })

  it('registers nothing when the variable is unset', () => {
    expect(load()).toEqual([])
  })

  it('registers nothing and still deletes the variable when it is empty', () => {
    process.env[ENV_MCP_SERVERS] = ''
    expect(load()).toEqual([])
    expect(ENV_MCP_SERVERS in process.env).toBe(false)
  })
})

describe('materializeMcpExtension', () => {
  it('writes a file whose contents match the source', () => {
    const path = materializeMcpExtension()
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(MCP_EXTENSION_SOURCE)
    // The build purity guard greps the bundle for the dev-only Pi package.
    expect(MCP_EXTENSION_SOURCE).not.toContain('pi-coding-agent')
    rmSync(path, { force: true })
  })
})
