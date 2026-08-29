import type { McpServer } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { JSONRPC_INVALID_PARAMS } from '../constants.js'
import { translateMcpServers } from '../mcp/servers.js'

function translateOne(server: unknown): ReturnType<typeof translateMcpServers>[number] {
  const [spec] = translateMcpServers([server as McpServer])
  if (spec === undefined) throw new Error('translateMcpServers returned nothing')
  return spec
}

function codeOf(run: () => unknown): number {
  try {
    run()
  } catch (error) {
    return (error as { code: number }).code
  }
  throw new Error('expected a rejection')
}

describe('translateMcpServers', () => {
  it('returns nothing for an absent or empty list', () => {
    expect(translateMcpServers(undefined)).toEqual([])
    expect(translateMcpServers([])).toEqual([])
  })

  it('treats an untagged server as stdio and records env as a record', () => {
    expect(
      translateOne({
        name: 'probe',
        command: '/usr/bin/probe',
        args: ['--serve'],
        env: [{ name: 'TOKEN', value: 's3cret' }],
      }),
    ).toEqual({ kind: 'stdio', name: 'probe', command: '/usr/bin/probe', args: ['--serve'], env: { TOKEN: 's3cret' } })
  })

  it('accepts an explicit stdio tag the schema leaves untagged', () => {
    expect(translateOne({ type: 'stdio', name: 'probe', command: '/usr/bin/probe', args: [], env: [] })).toEqual({
      kind: 'stdio',
      name: 'probe',
      command: '/usr/bin/probe',
      args: [],
      env: {},
    })
  })

  it('maps http and sse with headers as a record', () => {
    const headers = [{ name: 'Authorization', value: 'Bearer t' }]
    expect(translateOne({ type: 'http', name: 'remote', url: 'https://example.test/mcp', headers })).toEqual({
      kind: 'http',
      name: 'remote',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer t' },
    })
    expect(translateOne({ type: 'sse', name: 'legacy', url: 'https://example.test/sse', headers })).toEqual({
      kind: 'sse',
      name: 'legacy',
      url: 'https://example.test/sse',
      headers: { Authorization: 'Bearer t' },
    })
  })

  it('rejects the acp transport with invalid params naming the server', () => {
    const servers = [{ type: 'acp', name: 'inproc', serverId: 'x' }] as unknown as McpServer[]
    expect(codeOf(() => translateMcpServers(servers))).toBe(JSONRPC_INVALID_PARAMS)
    expect(codeOf(() => translateMcpServers(servers))).toBe(-32_602)
    expect(() => translateMcpServers(servers)).toThrow(/"inproc".*"acp"/)
  })

  it('rejects an unknown transport rather than falling back to stdio', () => {
    const servers = [{ type: 'carrier-pigeon', name: 'odd' }] as unknown as McpServer[]
    expect(codeOf(() => translateMcpServers(servers))).toBe(JSONRPC_INVALID_PARAMS)
    expect(() => translateMcpServers(servers)).toThrow(/unknown transport "carrier-pigeon"/)
  })

  it('rejects duplicate server names', () => {
    const servers = [
      { name: 'dup', command: '/a', args: [], env: [] },
      { name: 'dup', command: '/b', args: [], env: [] },
    ] as unknown as McpServer[]
    expect(codeOf(() => translateMcpServers(servers))).toBe(JSONRPC_INVALID_PARAMS)
    expect(() => translateMcpServers(servers)).toThrow(/more than one server named "dup"/)
  })

  it('rejects an unparseable url', () => {
    const servers = [{ type: 'http', name: 'bad', url: 'not a url', headers: [] }] as unknown as McpServer[]
    expect(codeOf(() => translateMcpServers(servers))).toBe(JSONRPC_INVALID_PARAMS)
    expect(() => translateMcpServers(servers)).toThrow(/unparseable url/)
  })

  it('passes the url through verbatim rather than normalizing it', () => {
    const spec = translateOne({ type: 'http', name: 'remote', url: 'https://example.test', headers: [] })
    expect(spec).toMatchObject({ url: 'https://example.test' })
  })
})
