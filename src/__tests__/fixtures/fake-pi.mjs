#!/usr/bin/env node

// Spawned directly as the launch command, so it relies on the shebang — POSIX only. On a
// future Windows CI runner the piRpcClient suite would need a node-prefixed
// spawn or a describe.skipIf(process.platform === 'win32').
//
// Stand-in for `pi --mode rpc`. Lifecycle behaviour comes from FAKE_PI_MODE
// (it must be decided before the first line arrives); everything else is driven
// per-request through the `name` of a `set_session_name` command, so one child
// can serve many scenarios without argv juggling.

import { appendFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

const MODE = process.env.FAKE_PI_MODE ?? 'normal'
const MARKER_PATH = process.env.FAKE_PI_MARKER
const SIGTERM_TRAP = 'sigterm-trap'
const STARTUP_HANG = 'startup-hang'

// Built from code points so the separators stay visible in the source; the raw
// characters render as ordinary spaces.
const U2028 = String.fromCodePoint(0x2028)
const U2029 = String.fromCodePoint(0x2029)

const SESSION_STATE = {
  thinkingLevel: 'off',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'all',
  sessionId: 'fake-pi-session',
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
}

// Proves the client actually passes PI_RPC_MODE_ARGS through to the binary.
if (!process.argv.includes('--mode') || !process.argv.includes('rpc')) {
  process.stderr.write(`fake-pi: expected "--mode rpc", got ${JSON.stringify(process.argv.slice(2))}\n`)
  process.exit(2)
}

let dying = false

function mark(text) {
  if (MARKER_PATH) appendFileSync(MARKER_PATH, `${text}\n`)
}

function writeLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function respond(id, command, data) {
  writeLine(data === undefined ? { id, type: 'response', command, success: true } : { id, type: 'response', command, success: true, data })
}

function emitEvent(name) {
  writeLine({ type: 'session_info_changed', name })
}

function writeChunked(id) {
  const payload = Buffer.concat([
    Buffer.from(`${JSON.stringify({ type: 'session_info_changed', name: 'chunk-日本語-😀-end' })}\n`, 'utf8'),
    Buffer.from(`${JSON.stringify({ id, type: 'response', command: 'set_session_name', success: true })}\n`, 'utf8'),
  ])
  const cuts = [
    payload.indexOf(Buffer.from('日', 'utf8')) + 1, // inside a multibyte character
    payload.indexOf(0x0a) + 5, // inside the second line
    payload.length,
  ]
  let start = 0
  let delay = 0
  for (const cut of cuts) {
    const slice = payload.subarray(start, cut)
    start = cut
    delay += 10
    setTimeout(() => process.stdout.write(slice), delay)
  }
}

function handleTrigger(id, name) {
  if (name.startsWith('delay:')) {
    setTimeout(() => respond(id, 'set_session_name'), Number(name.slice('delay:'.length)))
    return
  }
  if (name.startsWith('die:')) {
    const code = Number(name.slice('die:'.length))
    // Flushing stderr is async, so commands already buffered on stdin would
    // still get answered; going silent keeps "died with work in flight" exact.
    dying = true
    process.stderr.write(`fake-pi: exiting with code ${code} without answering\n`, () => process.exit(code))
    return
  }

  switch (name) {
    case 'never':
      return
    case 'parse-frame':
      writeLine({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command: Unexpected token }' })
      return
    case 'no-error-key':
      writeLine({ id, type: 'response', command: 'set_session_name', success: false })
      return
    case 'wrong-command':
      writeLine({ id, type: 'response', command: 'get_state', success: true })
      return
    case 'unknown-id':
      writeLine({ id: 'fake-pi-stale-id', type: 'response', command: 'set_session_name', success: true })
      respond(id, 'set_session_name')
      return
    case 'extension-error':
      writeLine({ type: 'extension_error', extensionPath: '/fake/extensions/broken.ts', event: 'tool_call', error: 'extension threw' })
      respond(id, 'set_session_name')
      return
    case 'editor-request':
      writeLine({ type: 'extension_ui_request', id: 'ui-editor', method: 'editor', title: 'Edit the plan', prefill: 'draft' })
      respond(id, 'set_session_name')
      return
    case 'notify-request':
      writeLine({ type: 'extension_ui_request', id: 'ui-notify', method: 'notify', message: 'heads up', notifyType: 'info' })
      respond(id, 'set_session_name')
      return
    case 'new-ui-method':
      // A UI method no Pi version has; deliberately left unanswered so
      // the pending request settles from the transport failure, not a response.
      writeLine({ type: 'extension_ui_request', id: 'ui-x', method: 'multiSelect', title: 'x', options: [] })
      return
    case 'separators':
      // JSON.stringify leaves U+2028/U+2029 raw inside strings; a readline-style
      // splitter on the parent side tears this frame in half.
      emitEvent(`before${U2028}between${U2029}after`)
      respond(id, 'set_session_name')
      return
    case 'chunked':
      writeChunked(id)
      return
    case 'garbage':
      process.stdout.write('this line is not json\n')
      return
    case 'truncated':
      // No trailing newline: the parent can only surface this frame from the
      // end-of-stream flush, i.e. strictly after the child has exited.
      process.stdout.write(JSON.stringify({ id, type: 'response', command: 'set_session_name', success: true }), () => process.exit(0))
      return
    default:
      respond(id, 'set_session_name')
  }
}

function handleLine(line) {
  const parsed = JSON.parse(line)
  if (parsed.type === 'extension_ui_response') {
    emitEvent(`ui-response:${JSON.stringify(parsed)}`)
    return
  }
  switch (parsed.type) {
    case 'get_state':
      if (MODE === STARTUP_HANG) return
      respond(parsed.id, 'get_state', SESSION_STATE)
      return
    case 'set_session_name':
      handleTrigger(parsed.id, parsed.name)
      return
    default:
      respond(parsed.id, parsed.type)
  }
}

process.on('SIGTERM', () => {
  mark('sigterm')
  if (MODE === SIGTERM_TRAP) return
  process.exit(143)
})

const decoder = new StringDecoder('utf8')
let buffer = ''

process.stdin.on('data', (chunk) => {
  buffer += decoder.write(chunk)
  for (;;) {
    const newlineIndex = buffer.indexOf('\n')
    if (newlineIndex === -1) return
    const line = buffer.slice(0, newlineIndex)
    buffer = buffer.slice(newlineIndex + 1)
    if (line.length > 0 && !dying) handleLine(line)
  }
})

process.stdin.on('end', () => {
  mark('stdin-end')
  if (MODE === SIGTERM_TRAP) return
  process.exit(0)
})

// A trapped SIGTERM must not let the event loop drain on its own, or the test
// would see a clean exit instead of the SIGKILL fallback.
if (MODE === SIGTERM_TRAP) setInterval(() => {}, 1_000)
