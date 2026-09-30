import type { McpServer } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { JSONRPC_INVALID_PARAMS } from '../constants.js'
import { translateMcpServers } from '../mcp/servers.js'

function translateOne(server: unknown): ReturnType<typeof translateMcpServers>[number] {
  const [spec] = translateMcpServers([server as McpServer])
  if (spec === undefined) throw new Error('translateMcpServers returned nothing')
  return spec
}

function rejectionOf(servers: unknown[]): { code: number; message: string } {
  try {
    translateMcpServers(servers as McpServer[])
  } catch (error) {
    return error as { code: number; message: string }
  }
  throw new Error('expected a rejection')
}

function escapedEnvValue(value: string): string | undefined {
  const { config } = translateOne({ name: 'probe', command: '/usr/bin/probe', args: [], env: [{ name: 'VALUE', value }] })
  return 'env' in config ? config.env['VALUE'] : undefined
}

describe('translateMcpServers', () => {
  it('returns nothing for an absent or empty list', () => {
    expect(translateMcpServers(undefined)).toEqual([])
    expect(translateMcpServers([])).toEqual([])
  })

  it('maps an untagged server to a direct stdio config with env as a record', () => {
    expect(
      translateOne({
        name: 'probe',
        command: '/usr/bin/probe',
        args: ['--serve'],
        env: [{ name: 'TOKEN', value: 's3cret' }],
      }),
    ).toStrictEqual({
      name: 'probe',
      config: { type: 'stdio', command: '/usr/bin/probe', args: ['--serve'], env: { TOKEN: 's3cret' }, exposure: 'direct' },
    })
  })

  it('accepts an explicit stdio tag the schema leaves untagged', () => {
    expect(translateOne({ type: 'stdio', name: 'probe', command: '/usr/bin/probe', args: [], env: [] })).toStrictEqual({
      name: 'probe',
      config: { type: 'stdio', command: '/usr/bin/probe', args: [], env: {}, exposure: 'direct' },
    })
  })

  it('maps http to a direct http config with headers as a record and the url verbatim', () => {
    const headers = [{ name: 'Authorization', value: 'Bearer t' }]
    expect(translateOne({ type: 'http', name: 'remote', url: 'https://example.test', headers })).toStrictEqual({
      name: 'remote',
      config: { type: 'http', url: 'https://example.test', headers: { Authorization: 'Bearer t' }, exposure: 'direct' },
    })
  })

  it('escapes every env value so Pi reads it as a literal', () => {
    expect(escapedEnvValue('s3cret')).toBe('s3cret')
    expect(escapedEnvValue('$')).toBe('$$')
    expect(escapedEnvValue('a$b$$c')).toBe('a$$b$$$$c')
    expect(escapedEnvValue('${HOME}')).toBe('$${HOME}')
    expect(escapedEnvValue('$HOME/bin')).toBe('$$HOME/bin')
    expect(escapedEnvValue('!echo hi')).toBe('$!echo hi')
    expect(escapedEnvValue('!')).toBe('$!')
    expect(escapedEnvValue('!$X')).toBe('$!$$X')
    expect(escapedEnvValue('a!b')).toBe('a!b')
    expect(escapedEnvValue('')).toBe('')
  })

  it('escapes header values the same way', () => {
    const headers = [
      { name: 'Authorization', value: 'Bearer ${TOKEN}' },
      { name: 'X-Command', value: '!cat key' },
    ]
    expect(translateOne({ type: 'http', name: 'remote', url: 'https://example.test/mcp', headers }).config).toMatchObject({
      headers: { Authorization: 'Bearer $${TOKEN}', 'X-Command': '$!cat key' },
    })
  })

  it('leaves env keys, header names, command, args and url unescaped', () => {
    expect(
      translateOne({ name: 'probe', command: '/opt/$tool', args: ['$HOME', '!x'], env: [{ name: '$KEY', value: 'v' }] }).config,
    ).toStrictEqual({ type: 'stdio', command: '/opt/$tool', args: ['$HOME', '!x'], env: { $KEY: 'v' }, exposure: 'direct' })
    expect(
      translateOne({ type: 'http', name: 'remote', url: 'https://example.test/$path', headers: [{ name: '$Header', value: 'v' }] }).config,
    ).toStrictEqual({ type: 'http', url: 'https://example.test/$path', headers: { $Header: 'v' }, exposure: 'direct' })
  })

  it('rejects a server name Pi would refuse', () => {
    for (const name of ['my server', 'a.b', 'naïve', '']) {
      const rejection = rejectionOf([{ name, command: '/a', args: [], env: [] }])
      expect(rejection.code).toBe(JSONRPC_INVALID_PARAMS)
      expect(rejection.message).toMatch(/may contain only letters, digits/)
    }
  })

  it('accepts letters, digits, underscore and dash in a name', () => {
    expect(translateOne({ name: 'My_server-2', command: '/a', args: [], env: [] }).name).toBe('My_server-2')
  })

  it('rejects duplicate server names', () => {
    const rejection = rejectionOf([
      { name: 'dup', command: '/a', args: [], env: [] },
      { type: 'http', name: 'dup', url: 'https://example.test/mcp', headers: [] },
    ])
    expect(rejection.code).toBe(JSONRPC_INVALID_PARAMS)
    expect(rejection.message).toMatch(/more than one server named "dup"/)
  })

  it('rejects the sse transport and points at streamable HTTP', () => {
    const rejection = rejectionOf([{ type: 'sse', name: 'legacy', url: 'https://example.test/sse', headers: [] }])
    expect(rejection.code).toBe(JSONRPC_INVALID_PARAMS)
    expect(rejection.message).toMatch(/"legacy".*"sse".*streamable HTTP/)
  })

  it('rejects the acp transport with invalid params naming the server', () => {
    const rejection = rejectionOf([{ type: 'acp', name: 'inproc', serverId: 'x' }])
    expect(rejection.code).toBe(-32_602)
    expect(rejection.message).toMatch(/"inproc".*"acp"/)
  })

  it('rejects an unknown transport rather than falling back to stdio', () => {
    const rejection = rejectionOf([{ type: 'carrier-pigeon', name: 'odd' }])
    expect(rejection.code).toBe(JSONRPC_INVALID_PARAMS)
    expect(rejection.message).toMatch(/unknown transport "carrier-pigeon"/)
  })

  it('rejects an unparseable url', () => {
    const rejection = rejectionOf([{ type: 'http', name: 'bad', url: 'not a url', headers: [] }])
    expect(rejection.code).toBe(JSONRPC_INVALID_PARAMS)
    expect(rejection.message).toMatch(/unparseable url/)
  })

  it('rejects a url that is not http or https', () => {
    const rejection = rejectionOf([{ type: 'http', name: 'bad', url: 'ftp://example.test/mcp', headers: [] }])
    expect(rejection.code).toBe(JSONRPC_INVALID_PARAMS)
    expect(rejection.message).toMatch(/not http or https/)
  })
})
