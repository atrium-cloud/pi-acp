import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PiRpcClient } from '../pi/PiRpcClient.js'
import type { PiRpcClientOptions } from '../pi/PiRpcClient.js'
import { PI_RPC_MODE_ARGS } from '../constants.js'
import { PiExitError, PiProtocolError, PiRpcError, PiRpcTimeoutError, PiSpawnError } from '../pi/errors.js'
import type { JsonAgentSessionEvent } from '../pi/types.js'

const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const DEFAULT_TIMEOUT_MS = 4_000
const DEFAULT_STDIN_END_GRACE_MS = 500
const DEFAULT_SIGTERM_GRACE_MS = 300
const EVENT_WAIT_MS = 2_000
const QUIET_WINDOW_MS = 200

// Built from code points so the separators stay visible in the source; the raw
// characters render as ordinary spaces.
const U2028 = String.fromCodePoint(0x2028)
const U2029 = String.fromCodePoint(0x2029)

interface FixtureClientOptions {
  readonly command?: string
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly stdinEndGraceMs?: number
  readonly sigtermGraceMs?: number
  readonly onEvent?: (event: JsonAgentSessionEvent) => void
  readonly onExit?: (error: Error) => void
}

const openClients: PiRpcClient[] = []

// Assembled property by property: `exactOptionalPropertyTypes` rejects spreading
// an override whose value may be undefined into a required option.
function createClient(overrides: FixtureClientOptions = {}): PiRpcClient {
  const options: PiRpcClientOptions = {
    launch: { command: overrides.command ?? FAKE_PI, args: PI_RPC_MODE_ARGS, source: 'test fixture' },
    cwd: REPO_ROOT,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    stdinEndGraceMs: overrides.stdinEndGraceMs ?? DEFAULT_STDIN_END_GRACE_MS,
    sigtermGraceMs: overrides.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS,
    ...(overrides.env ? { env: overrides.env } : {}),
    ...(overrides.onEvent ? { onEvent: overrides.onEvent } : {}),
    ...(overrides.onExit ? { onExit: overrides.onExit } : {}),
  }
  const client = new PiRpcClient(options)
  openClients.push(client)
  return client
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function markerPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'pi-acp-fake-pi-')), 'marker.log')
}

function readMarker(path: string): string {
  return readFileSync(path, 'utf8')
}

function sessionName(event: JsonAgentSessionEvent): string {
  if (event.type !== 'session_info_changed' || event.name === undefined) {
    throw new Error(`expected a named session_info_changed event, got ${JSON.stringify(event)}`)
  }
  return event.name
}

function waitForEvent(
  client: PiRpcClient,
  predicate: (event: JsonAgentSessionEvent) => boolean,
): Promise<JsonAgentSessionEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('timed out waiting for a matching Pi event'))
    }, EVENT_WAIT_MS)
    const unsubscribe = client.onEvent((event) => {
      if (!predicate(event)) return
      clearTimeout(timer)
      unsubscribe()
      resolve(event)
    })
  })
}

function loggedLines(spy: { readonly mock: { readonly calls: readonly unknown[][] } }): string {
  return spy.mock.calls.map((call) => call.map((argument) => String(argument)).join(' ')).join('\n')
}

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.stop()
  vi.restoreAllMocks()
})

describe('PiRpcClient startup', () => {
  it('becomes ready by round-tripping get_state through the request path', async () => {
    const client = createClient()
    const state = await client.start()
    expect(state.sessionId).toBe('fake-pi-session')
    expect(state.isStreaming).toBe(false)
  })

  it('refuses a second start', async () => {
    const client = createClient()
    await client.start()
    await expect(client.start()).rejects.toThrow(/already been started/)
  })

  it('reports a missing binary as a spawn failure rather than a timeout', async () => {
    const client = createClient({ command: join(REPO_ROOT, 'no-such-pi-binary'), timeoutMs: 30_000 })
    const startedAt = Date.now()
    const failure = client.start()
    await expect(failure).rejects.toBeInstanceOf(PiSpawnError)
    await expect(failure).rejects.toThrow(/from test fixture.*ENOENT/)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('reaps the child when the readiness probe is never answered', async () => {
    const marker = markerPath()
    const deaths: Error[] = []
    const client = createClient({
      env: { FAKE_PI_MODE: 'startup-hang', FAKE_PI_MARKER: marker },
      timeoutMs: 500,
      onExit: (error) => deaths.push(error),
    })

    await expect(client.start()).rejects.toBeInstanceOf(PiRpcTimeoutError)

    expect(readMarker(marker)).toContain('stdin-end')
    expect(deaths).toHaveLength(0)
  })

  it('refuses to start after stop', async () => {
    const client = createClient()
    await client.stop()
    await expect(client.start()).rejects.toThrow(/after stop/)
  })
})

describe('PiRpcClient correlation', () => {
  it('matches responses that come back out of order', async () => {
    const client = createClient()
    await client.start()

    const settled: string[] = []
    const slow = client.request({ type: 'set_session_name', name: 'delay:150' }).then(() => settled.push('slow'))
    const fast = client.request({ type: 'set_session_name', name: 'delay:0' }).then(() => settled.push('fast'))
    await Promise.all([slow, fast])

    expect(settled).toEqual(['fast', 'slow'])
  })

  it('resolves a response that only reaches the reader after the child exits', async () => {
    const client = createClient()
    await client.start()
    const response = await client.request({ type: 'set_session_name', name: 'truncated' })
    expect(response.command).toBe('set_session_name')
  })

  it('drops a response no request is waiting on and keeps going', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = createClient()
    await client.start()

    const response = await client.request({ type: 'set_session_name', name: 'unknown-id' })

    expect(response.success).toBe(true)
    expect(loggedLines(errorLog)).toMatch(/fake-pi-stale-id/)
  })

  it('turns success:false into PiRpcError even when Pi omits the message', async () => {
    const client = createClient()
    await client.start()
    const failing = client.request({ type: 'set_session_name', name: 'no-error-key' })
    await expect(failing).rejects.toBeInstanceOf(PiRpcError)
    await expect(failing).rejects.toThrow(/<pi reported no error message>/)
  })

  it('times out a command Pi never answers', async () => {
    const client = createClient({ timeoutMs: 800 })
    await client.start()
    await expect(client.request({ type: 'set_session_name', name: 'never' })).rejects.toBeInstanceOf(PiRpcTimeoutError)
  })
})

describe('PiRpcClient stdout framing', () => {
  it('keeps U+2028 and U+2029 inside a frame instead of splitting on them', async () => {
    const client = createClient()
    await client.start()

    const arrived = waitForEvent(client, (event) => event.type === 'session_info_changed')
    await client.request({ type: 'set_session_name', name: 'separators' })

    expect(sessionName(await arrived)).toBe(`before${U2028}between${U2029}after`)
  })

  it('reassembles frames split mid-line and mid-character', async () => {
    const client = createClient()
    await client.start()

    const arrived = waitForEvent(client, (event) => event.type === 'session_info_changed')
    const response = await client.request({ type: 'set_session_name', name: 'chunked' })

    expect(sessionName(await arrived)).toBe('chunk-日本語-😀-end')
    expect(response.success).toBe(true)
  })

  it('treats a non-JSON stdout line as a fatal protocol violation', async () => {
    const deaths: Error[] = []
    const client = createClient({ onExit: (error) => deaths.push(error) })
    await client.start()

    await expect(client.request({ type: 'set_session_name', name: 'garbage' })).rejects.toBeInstanceOf(PiProtocolError)
    expect(deaths[0]).toBeInstanceOf(PiProtocolError)
  })

  it('treats an id-less parse response as an adapter bug, loudly', async () => {
    const deaths: Error[] = []
    const client = createClient({ onExit: (error) => deaths.push(error) })
    await client.start()

    const rejected = client.request({ type: 'set_session_name', name: 'parse-frame' })
    await expect(rejected).rejects.toBeInstanceOf(PiProtocolError)
    await expect(rejected).rejects.toThrow(/rejected an outbound command line/)
    expect(deaths[0]).toBeInstanceOf(PiProtocolError)
  })

  it('fails the transport when a response answers the wrong command', async () => {
    const deaths: Error[] = []
    const client = createClient({ onExit: (error) => deaths.push(error) })
    await client.start()

    const rejected = client.request({ type: 'set_session_name', name: 'wrong-command' })
    await expect(rejected).rejects.toBeInstanceOf(PiProtocolError)
    await expect(rejected).rejects.toThrow(/answered command "get_state" but "set_session_name" was sent/)
    expect(deaths[0]).toBeInstanceOf(PiProtocolError)
    await expect(client.request({ type: 'abort' })).rejects.toBeInstanceOf(PiProtocolError)
  })
})

describe('PiRpcClient event and extension frames', () => {
  it('logs extension_error to stderr and keeps it out of the event stream', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const events: JsonAgentSessionEvent[] = []
    const client = createClient({ onEvent: (event) => events.push(event) })
    await client.start()

    await client.request({ type: 'set_session_name', name: 'extension-error' })

    expect(events).toHaveLength(0)
    expect(loggedLines(errorLog)).toMatch(/Pi extension error in \/fake\/extensions\/broken\.ts/)
  })

  it('fails an editor dialog closed and never answers fire-and-forget UI', async () => {
    const echoes: string[] = []
    const client = createClient({
      onEvent: (event) => {
        if (event.type === 'session_info_changed' && event.name?.startsWith('ui-response:') === true) {
          echoes.push(event.name)
        }
      },
    })
    await client.start()

    const answered = waitForEvent(
      client,
      (event) => event.type === 'session_info_changed' && event.name?.startsWith('ui-response:') === true,
    )
    await client.request({ type: 'set_session_name', name: 'editor-request' })
    const payload: unknown = JSON.parse(sessionName(await answered).slice('ui-response:'.length))
    expect(payload).toEqual({ type: 'extension_ui_response', id: 'ui-editor', cancelled: true })

    await client.request({ type: 'set_session_name', name: 'notify-request' })
    await delay(QUIET_WINDOW_MS)
    expect(echoes).toHaveLength(1)
  })

  it('fails the transport on an extension UI method it does not know', async () => {
    const deaths: Error[] = []
    const client = createClient({ onExit: (error) => deaths.push(error) })
    await client.start()

    const uncaught: unknown[] = []
    const record = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', record)
    try {
      const rejected = client.request({ type: 'set_session_name', name: 'new-ui-method' })
      await expect(rejected).rejects.toBeInstanceOf(PiProtocolError)
      await expect(rejected).rejects.toThrow(/unhandled extension UI method/)
      await delay(QUIET_WINDOW_MS)
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', record)
    }

    expect(deaths[0]).toBeInstanceOf(PiProtocolError)
    await expect(client.request({ type: 'abort' })).rejects.toBeInstanceOf(PiProtocolError)
  })
})

describe('PiRpcClient teardown', () => {
  it('stops through stdin end without escalating to a signal', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const marker = markerPath()
    const deaths: Error[] = []
    const client = createClient({ env: { FAKE_PI_MARKER: marker }, onExit: (error) => deaths.push(error) })
    await client.start()

    await Promise.all([client.stop(), client.stop()])

    expect(readMarker(marker)).toContain('stdin-end')
    expect(readMarker(marker)).not.toContain('sigterm')
    expect(deaths).toHaveLength(0)
    expect(loggedLines(errorLog)).not.toMatch(/teardown/)
  })

  it.skipIf(process.platform === 'win32')('escalates to SIGKILL when the child traps SIGTERM', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const marker = markerPath()
    const deaths: Error[] = []
    const client = createClient({
      env: { FAKE_PI_MODE: 'sigterm-trap', FAKE_PI_MARKER: marker },
      stdinEndGraceMs: 200,
      sigtermGraceMs: 200,
      onExit: (error) => deaths.push(error),
    })
    await client.start()

    await client.stop()

    expect(readMarker(marker)).toContain('sigterm')
    expect(deaths).toHaveLength(0)
    expect(loggedLines(errorLog)).toMatch(/teardown did not exit cleanly.*SIGKILL/s)
  })

  it.skipIf(process.platform === 'win32')(
    'stays quiet about teardown after a diagnosed fault forces a kill',
    async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      const deaths: Error[] = []
      const client = createClient({
        env: { FAKE_PI_MODE: 'sigterm-trap' },
        stdinEndGraceMs: 200,
        sigtermGraceMs: 200,
        onExit: (error) => deaths.push(error),
      })
      await client.start()

      await expect(client.request({ type: 'set_session_name', name: 'garbage' })).rejects.toBeInstanceOf(
        PiProtocolError,
      )
      await client.stop()

      expect(deaths[0]).toBeInstanceOf(PiProtocolError)
      // The fault was already reported through onExit; the kill teardown completes
      // must not masquerade as an unclean teardown.
      expect(loggedLines(errorLog)).not.toMatch(/teardown did not exit cleanly/)
    },
  )

  it('rejects in-flight work and reports an unexpected death through onExit', async () => {
    const deaths: Error[] = []
    const client = createClient({ onExit: (error) => deaths.push(error) })
    await client.start()

    await expect(client.request({ type: 'set_session_name', name: 'die:7' })).rejects.toBeInstanceOf(PiExitError)

    const death = deaths[0]
    expect(death).toBeInstanceOf(PiExitError)
    expect((death as PiExitError).code).toBe(7)
    expect(death?.message).toMatch(/exiting with code 7 without answering/)

    // `exit` and `close` both reach the death path; only one may be reported.
    await delay(QUIET_WINDOW_MS)
    expect(deaths).toHaveLength(1)
  })

  it('rejects in-flight work when the child dies mid-write, with no uncaught exception', async () => {
    const client = createClient({ onExit: () => {} })
    await client.start()

    // The client's stdin `error` listener is the defensive half of this: a write
    // that reaches an already-closed pipe raises EPIPE with no caller to hand it
    // to, and that timing is not reproducible on demand.
    const uncaught: unknown[] = []
    const record = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', record)
    try {
      const results = await Promise.allSettled([
        client.request({ type: 'set_session_name', name: 'die:9' }),
        client.request({ type: 'abort' }),
        client.request({ type: 'abort' }),
      ])
      expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected'])
      await delay(QUIET_WINDOW_MS)
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', record)
    }

    await expect(client.request({ type: 'abort' })).rejects.toThrow(/Pi RPC transport/)
  })
})
