import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'

// LF-delimited JSONL framing, reimplemented from Pi's dist/modes/rpc/jsonl.js
// (the package is dev-only and must not enter the bundle). Records split on `\n`
// only, with an optional trailing `\r` stripped (per docs/rpc.md). Splitting on
// `\n` only is mandatory: JSON.stringify leaves U+2028/U+2029 raw inside strings,
// and a readline-style splitter would break records there.

export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

/** Returns a detach function. Emits every line up to each `\n`, including empty
 * ones (an empty line on Pi's stdout is a framing violation for the caller to
 * reject); only the final flush is guarded to drop a trailing empty remainder. */
export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
  const decoder = new StringDecoder('utf8')
  let buffer = ''

  const emitLine = (line: string): void => {
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
  }

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    for (;;) {
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) return
      emitLine(buffer.slice(0, newlineIndex))
      buffer = buffer.slice(newlineIndex + 1)
    }
  }

  const onEnd = (): void => {
    buffer += decoder.end()
    if (buffer.length > 0) {
      emitLine(buffer)
      buffer = ''
    }
  }

  stream.on('data', onData)
  stream.on('end', onEnd)
  return () => {
    stream.off('data', onData)
    stream.off('end', onEnd)
  }
}
