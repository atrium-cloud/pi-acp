import { once } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { attachJsonlLineReader, serializeJsonLine } from '../pi/jsonl.js'

// Built from code points so the fixtures stay visible in the source.
const LINE_SEPARATOR = String.fromCodePoint(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029)

async function readLines(chunks: readonly (Buffer | string)[]): Promise<string[]> {
  const stream = new PassThrough()
  const lines: string[] = []
  attachJsonlLineReader(stream, (line) => {
    lines.push(line)
  })
  for (const chunk of chunks) stream.write(chunk)
  stream.end()
  await once(stream, 'end')
  return lines
}

describe('serializeJsonLine', () => {
  it('round-trips a record through the reader', async () => {
    const value = { id: 'req-1', type: 'get_state' }
    const serialized = serializeJsonLine(value)
    expect(serialized.endsWith('\n')).toBe(true)

    const lines = await readLines([Buffer.from(serialized, 'utf8')])
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toEqual(value)
  })

  it('leaves U+2028/U+2029 raw in a string, and the reader keeps the record whole', async () => {
    const value = { text: `before${LINE_SEPARATOR}middle${PARAGRAPH_SEPARATOR}after` }
    const serialized = serializeJsonLine(value)
    // The reason for LF-only splitting: these survive JSON.stringify unescaped,
    // so a readline-style splitter would cut the record in half here.
    expect(serialized).toContain(LINE_SEPARATOR)
    expect(serialized).toContain(PARAGRAPH_SEPARATOR)

    const lines = await readLines([Buffer.from(serialized, 'utf8')])
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toEqual(value)
  })
})

describe('attachJsonlLineReader', () => {
  it('strips a trailing \\r from a CRLF-terminated line', async () => {
    expect(await readLines([Buffer.from('{"a":1}\r\n', 'utf8')])).toEqual(['{"a":1}'])
  })

  it('accepts string chunks from a stream with an encoding set', async () => {
    const stream = new PassThrough()
    stream.setEncoding('utf8')
    const lines: string[] = []
    attachJsonlLineReader(stream, (line) => {
      lines.push(line)
    })

    stream.write('{"a":1}\n')
    stream.end()
    await once(stream, 'end')

    expect(lines).toEqual(['{"a":1}'])
  })

  it('joins a record split across two data chunks', async () => {
    const value = { type: 'response', command: 'get_state' }
    const buffer = Buffer.from(serializeJsonLine(value), 'utf8')
    const lines = await readLines([buffer.subarray(0, 9), buffer.subarray(9)])
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toEqual(value)
  })

  it('joins a multibyte character split across two data chunks', async () => {
    const value = { text: String.fromCodePoint(0x65e5, 0x672c, 0x8a9e) }
    const buffer = Buffer.from(serializeJsonLine(value), 'utf8')
    const splitIndex = buffer.findIndex((byte) => byte > 0x7f) + 1
    // 0b10xxxxxx: the split really lands inside a UTF-8 sequence.
    expect((buffer[splitIndex] ?? 0) & 0b1100_0000).toBe(0b1000_0000)

    const lines = await readLines([buffer.subarray(0, splitIndex), buffer.subarray(splitIndex)])
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toEqual(value)
  })

  it('emits empty lines instead of swallowing them', async () => {
    expect(await readLines([Buffer.from('\n\n{"a":1}\n', 'utf8')])).toEqual(['', '', '{"a":1}'])
  })

  it('flushes an unterminated trailing line on end', async () => {
    expect(await readLines([Buffer.from('{"a":1}\n{"b":2}', 'utf8')])).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('does not emit an empty remainder on end', async () => {
    expect(await readLines([Buffer.from('{"a":1}\n', 'utf8')])).toEqual(['{"a":1}'])
  })

  it('stops delivering lines once detached', async () => {
    const stream = new PassThrough()
    const lines: string[] = []
    const detach = attachJsonlLineReader(stream, (line) => {
      lines.push(line)
    })

    stream.write('{"a":1}\n')
    await new Promise((resolve) => {
      setImmediate(resolve)
    })
    detach()
    stream.write('{"b":2}\n{"c":3}')
    stream.end()
    stream.resume()
    await once(stream, 'end')

    expect(lines).toEqual(['{"a":1}'])
  })
})
