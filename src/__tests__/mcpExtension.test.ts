import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, expect, it } from 'vitest'

import {
  boundOutput,
  buildToolName,
  createTransport,
  mapCallToolResult,
  McpSetupError,
  normalizeInputSchema,
  sanitizeToolPart,
  startupFailureLog,
  startupFailureNotice,
  unwrapJsonStringParams,
} from '../mcp/extension-entry.js'
import { MCP_OUTPUT_MAX_BYTES, MCP_OUTPUT_MAX_LINES } from '../mcp/mcpConstants.js'

const TOOL = 'mcp__probe__echo'
const LOOPBACK = '127.0.0.1'
const SSE_ENDPOINT_EVENT = 'event: endpoint\ndata: /messages\n\n'

function textOf(result: { content: { type: string }[] }): string {
  const block = result.content.find((entry) => entry.type === 'text')
  return (block as { text?: string } | undefined)?.text ?? ''
}

/** Every value sent under `name`: `rawHeaders` keeps repeated names apart,
 * where `headers` would join them into one string. */
function rawHeaderValues(rawHeaders: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name.toLowerCase()) values.push(rawHeaders[index + 1] ?? '')
  }
  return values
}

describe('tool naming', () => {
  it('replaces every character outside [A-Za-z0-9_]', () => {
    expect(sanitizeToolPart('search.files')).toBe('search_files')
    expect(sanitizeToolPart('my server-1')).toBe('my_server_1')
    expect(sanitizeToolPart('naïve/tool')).toBe('na_ve_tool')
    expect(sanitizeToolPart('already_ok9')).toBe('already_ok9')
  })

  it('builds mcp__<server>__<tool> from the sanitized halves', () => {
    expect(buildToolName('probe', 'echo')).toBe('mcp__probe__echo')
    expect(buildToolName('my server', 'search.files')).toBe('mcp__my_server__search_files')
  })

  it('collides when two tool names sanitize alike, which is what the dedup skip catches', () => {
    expect(buildToolName('probe', 'a.b')).toBe(buildToolName('probe', 'a-b'))
  })
})

describe('createTransport for an sse server', () => {
  it('sends each client header exactly once on the stream GET and on the POST', async () => {
    const requests: { method: string | undefined; rawHeaders: string[] }[] = []
    const server = createServer((request, response) => {
      requests.push({ method: request.method, rawHeaders: request.rawHeaders })
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(SSE_ENDPOINT_EVENT)
        return
      }
      response.writeHead(202).end()
    })
    await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve))
    const { port } = server.address() as AddressInfo
    const headers = { Authorization: 'Bearer probe-token', 'X-Probe-Key': 'probe-key' }
    const { transport } = createTransport({ kind: 'sse', name: 'legacy', url: `http://${LOOPBACK}:${port}/sse`, headers })
    try {
      await transport.start()
      await transport.send({ jsonrpc: '2.0', id: 0, method: 'ping' })
    } finally {
      await transport.close()
      server.closeAllConnections()
      server.close()
    }

    expect(requests.map((request) => request.method)).toEqual(['GET', 'POST'])
    for (const request of requests) {
      for (const [name, value] of Object.entries(headers)) expect(rawHeaderValues(request.rawHeaders, name)).toEqual([value])
    }
  })
})

describe('startup failure text', () => {
  const withTail = new McpSetupError(new Error('MCP error -32000: Connection closed'), 'boot failed: missing token\nexiting')

  it('names the server and the error in the notice, without the stderr tail', () => {
    expect(startupFailureNotice('dead', withTail)).toBe('MCP server dead failed: MCP error -32000: Connection closed')
    expect(startupFailureNotice('dead', new Error('spawn /nowhere ENOENT'))).toBe('MCP server dead failed: spawn /nowhere ENOENT')
    expect(startupFailureNotice('dead', 'plain reason')).toBe('MCP server dead failed: plain reason')
  })

  it('folds a multi-line error message onto one line in the notice', () => {
    expect(startupFailureNotice('dead', new Error('first line\n  second line\n\n  third line'))).toBe('MCP server dead failed: first line second line third line')
  })

  it('keeps the stderr tail on the lines after the message in the log', () => {
    expect(startupFailureLog('dead', withTail)).toBe('server dead failed: MCP error -32000: Connection closed\nboot failed: missing token\nexiting')
    expect(startupFailureLog('dead', new McpSetupError(new Error('spawn /nowhere ENOENT'), ''))).toBe('server dead failed: spawn /nowhere ENOENT')
  })
})

describe('normalizeInputSchema', () => {
  it('drops the root $schema and additionalProperties and keeps the rest', () => {
    expect(
      normalizeInputSchema({
        $schema: 'http://json-schema.org/draft-07/schema#',
        additionalProperties: false,
        type: 'object',
        properties: { text: { type: 'string', additionalProperties: false } },
        required: ['text'],
      }),
    ).toEqual({
      type: 'object',
      properties: { text: { type: 'string', additionalProperties: false } },
      required: ['text'],
    })
  })

  it('substitutes an empty object schema when the server sends none', () => {
    const empty = { type: 'object', properties: {} }
    expect(normalizeInputSchema(undefined)).toEqual(empty)
    expect(normalizeInputSchema(null)).toEqual(empty)
    expect(normalizeInputSchema('nope')).toEqual(empty)
    expect(normalizeInputSchema([1, 2])).toEqual(empty)
  })
})

describe('unwrapJsonStringParams', () => {
  const schema = {
    type: 'object',
    properties: {
      payload: { type: 'object' },
      items: { type: 'array' },
      label: { type: 'string' },
      count: { type: 'number' },
    },
  }

  it('unwraps one layer of JSON string for object and array properties only', () => {
    expect(
      unwrapJsonStringParams(schema, {
        payload: '{"a":1}',
        items: '[1,2]',
        label: '{"a":1}',
        count: 3,
      }),
    ).toEqual({ payload: { a: 1 }, items: [1, 2], label: '{"a":1}', count: 3 })
  })

  it('leaves an already-structured value and an unparseable string alone', () => {
    expect(unwrapJsonStringParams(schema, { payload: { a: 1 }, items: 'not json' })).toEqual({ payload: { a: 1 }, items: 'not json' })
  })

  it('leaves params untouched when the schema declares no properties', () => {
    expect(unwrapJsonStringParams({ type: 'object' }, { payload: '{"a":1}' })).toEqual({ payload: '{"a":1}' })
  })

  it('ignores params the schema does not declare', () => {
    expect(unwrapJsonStringParams(schema, { extra: '{"a":1}' })).toEqual({ extra: '{"a":1}' })
  })
})

describe('mapCallToolResult content mapping', () => {
  it('maps text verbatim and keeps the raw result as details', () => {
    const raw = { content: [{ type: 'text', text: 'hello' }] }
    const result = mapCallToolResult(raw, TOOL)
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.details).toBe(raw)
  })

  it('maps an image and defaults a missing mime type', () => {
    expect(mapCallToolResult({ content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/gif' }] }, TOOL).content).toEqual([
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/gif' },
    ])
    expect(mapCallToolResult({ content: [{ type: 'image', data: 'iVBORw0KGgo=' }] }, TOOL).content).toEqual([
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ])
  })

  it('flattens an embedded text resource under a uri header line', () => {
    const result = mapCallToolResult({ content: [{ type: 'resource', resource: { uri: 'file:///a.txt', text: 'body' } }] }, TOOL)
    expect(textOf(result)).toBe('uri: file:///a.txt\nbody')
  })

  it('keeps an embedded image blob as an image and describes any other blob', () => {
    expect(mapCallToolResult({ content: [{ type: 'resource', resource: { uri: 'file:///a.png', mimeType: 'image/png', blob: 'iVBORw0KGgo=' } }] }, TOOL).content).toEqual([
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ])
    const other = mapCallToolResult({ content: [{ type: 'resource', resource: { uri: 'file:///a.bin', mimeType: 'application/octet-stream', blob: 'AAAA' } }] }, TOOL)
    expect(textOf(other)).toBe('[Resource: file:///a.bin] application/octet-stream, 3 bytes')
  })

  it('renders a resource link as one line carrying the uri and the name', () => {
    const result = mapCallToolResult({ content: [{ type: 'resource_link', uri: 'https://example.test/doc', name: 'doc' }] }, TOOL)
    expect(textOf(result)).toBe('[Resource link: doc] uri: https://example.test/doc')
  })

  it('replaces audio with a placeholder naming the mime type', () => {
    expect(textOf(mapCallToolResult({ content: [{ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }] }, TOOL))).toBe('[Audio content: audio/wav]')
  })

  it('serializes an unknown block rather than dropping it', () => {
    expect(textOf(mapCallToolResult({ content: [{ type: 'hologram', frames: 3 }] }, TOOL))).toBe('{"type":"hologram","frames":3}')
  })

  it('falls back to pretty-printed structured content when there is no content', () => {
    expect(textOf(mapCallToolResult({ content: [], structuredContent: { ok: true } }, TOOL))).toBe('{\n  "ok": true\n}')
  })

  it('joins several text blocks and appends the images after them', () => {
    const result = mapCallToolResult(
      {
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: 'second' },
        ],
      },
      TOOL,
    )
    expect(result.content).toEqual([
      { type: 'text', text: 'first\nsecond' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ])
  })
})

describe('mapCallToolResult failures', () => {
  it('throws with the server text when isError is set', () => {
    expect(() => mapCallToolResult({ content: [{ type: 'text', text: 'deliberate failure' }], isError: true }, TOOL)).toThrow('deliberate failure')
  })

  it('throws naming the tool when the failed result carries no text', () => {
    expect(() => mapCallToolResult({ content: [], isError: true }, TOOL)).toThrow(`MCP tool ${TOOL} failed`)
  })
})

describe('boundOutput', () => {
  it('leaves output within both bounds untouched', () => {
    expect(boundOutput('small')).toBe('small')
    expect(boundOutput('')).toBe('')
  })

  it('keeps the head and names the truncation when the line bound is exceeded', () => {
    const bounded = boundOutput(Array.from({ length: MCP_OUTPUT_MAX_LINES + 100 }, (_, index) => `line ${index}`).join('\n'))
    const lines = bounded.split('\n')
    expect(lines).toHaveLength(MCP_OUTPUT_MAX_LINES + 1)
    expect(lines[0]).toBe('line 0')
    expect(lines[MCP_OUTPUT_MAX_LINES]).toMatch(/^\[truncated:/)
  })

  it('keeps the head and names the truncation when the byte bound is exceeded', () => {
    const bounded = boundOutput('a'.repeat(MCP_OUTPUT_MAX_BYTES + 1_000))
    expect(bounded.startsWith('a'.repeat(100))).toBe(true)
    expect(bounded).toMatch(/\[truncated: .* bounded to \d+ bytes and \d+ lines\]$/)
    expect(Buffer.byteLength(bounded.split('\n')[0] ?? '', 'utf8')).toBe(MCP_OUTPUT_MAX_BYTES)
  })

  it('bounds the text of an oversized result while the image passes through whole', () => {
    const data = 'A'.repeat(MCP_OUTPUT_MAX_BYTES * 2)
    const result = mapCallToolResult(
      {
        content: [
          { type: 'text', text: 'x'.repeat(MCP_OUTPUT_MAX_BYTES + 500) },
          { type: 'image', data, mimeType: 'image/png' },
        ],
      },
      TOOL,
    )
    expect(textOf(result)).toMatch(/\[truncated:/)
    expect(result.content[1]).toEqual({ type: 'image', data, mimeType: 'image/png' })
  })
})
