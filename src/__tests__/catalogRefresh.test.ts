import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import {
  CATALOG_REFRESH_COMMAND,
  CATALOG_REFRESH_EXTENSION_FILENAME,
  CATALOG_REFRESH_TIMEOUT_MS,
  catalogRefreshLogLine,
  COMMAND_PREFIX,
} from '../constants.js'
import type { PiLaunch } from '../pi/errors.js'
import { PiRpcClient } from '../pi/PiRpcClient.js'
import { PiAcpServer } from '../server/PiAcpServer.js'
import { CATALOG_REFRESH_EXTENSION_SOURCE, CatalogRefresher } from '../session/catalogRefresh.js'
import type { CreatePiClient } from '../session/SessionConnection.js'
import { defaultFakePiSpec } from './acpTestFixture.js'
import { type FakePiClient, makeFakePiClient } from './fixtures/fakePiClient.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url))
const MISSING_PI = '/pi-acp-test/missing/pi'
const RPC_MODE_ARGS = ['--mode', 'rpc']
const GATE_PATH = '/pi-acp-test/extensions/permission-gate.mjs'
const OVERRIDES_PATH = '/pi-acp-test/extensions/origin-overrides.mjs'
const REFRESH_PATH = '/pi-acp-test/extensions/catalog-refresh.mjs'
const MCP_PATH = '/pi-acp-test/extensions/mcp.mjs'
const SESSION_ROOT = '/pi-acp-test/sessions'
const STARTUP_DELAY_MS = 1_000
const INTERVAL_MS = 10_000
const RPC_TIMEOUT_MS = 5_000
const REFRESH_PROMPT = { type: 'prompt', message: `${COMMAND_PREFIX}${CATALOG_REFRESH_COMMAND}` }
const PROVIDER_FAILURE = 'OpenRouter model list request failed: 500'

type CommandHandler = (args: string, ctx: unknown) => Promise<void>
type RefreshExtension = (pi: {
  registerCommand: (name: string, options: { handler: CommandHandler }) => void
}) => void

// ── Helpers ───────────────────────────────────────────────────────────────────

let errorLog: MockInstance<typeof console.error>
let server: PiAcpServer | null = null

beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await server?.stopAllSessions()
  server = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function loggedLines(): string[] {
  return errorLog.mock.calls.map(([line]) => String(line))
}

/** Lets a refresh driven by a fake Pi, all microtasks, run to its end. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function startServer(createPiClient: CreatePiClient): PiAcpServer {
  return new PiAcpServer({
    launch: { command: 'pi', args: RPC_MODE_ARGS, source: 'test' },
    rpcTimeoutMs: RPC_TIMEOUT_MS,
    sessionDirs: { mode: 'perCwd', root: SESSION_ROOT },
    gateExtensionPath: GATE_PATH,
    originOverridesExtensionPath: OVERRIDES_PATH,
    mcpExtensionPath: MCP_PATH,
    hiddenCommands: new Set(),
    logStartupTiming: false,
    createPiClient,
    catalogRefreshExtensionPath: REFRESH_PATH,
    catalogRefreshStartupDelayMs: STARTUP_DELAY_MS,
    catalogRefreshIntervalMs: INTERVAL_MS,
  })
}

function handledFake(): FakePiClient {
  return makeFakePiClient({ ...defaultFakePiSpec(), promptDisposition: 'handled' })
}

/** A refresher over the real RPC transport, spawning `launch`. */
function transportRefresher(launch: PiLaunch, launches: string[][] = []): CatalogRefresher {
  return new CatalogRefresher({
    launch,
    rpcTimeoutMs: RPC_TIMEOUT_MS,
    cwd: process.cwd(),
    sessionExtensionArgs: [],
    extensionPath: REFRESH_PATH,
    startupDelayMs: STARTUP_DELAY_MS,
    intervalMs: INTERVAL_MS,
    createPiClient: (options) => {
      launches.push([...(options.args ?? [])])
      return new PiRpcClient(options)
    },
  })
}

// ── The schedule ──────────────────────────────────────────────────────────────

describe('the catalog refresher schedule', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  it('launches Pi with --no-session --offline --no-mcp and the session and refresh extensions, sends the refresh command, and stops Pi', async () => {
    const fake = handledFake()
    server = startServer(fake.createPiClient)

    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS - 1)
    expect(fake.spawns).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await settle()

    expect(fake.spawns).toEqual([
      {
        cwd: process.cwd(),
        args: ['--no-session', '--offline', '--no-mcp', '-e', GATE_PATH, '-e', OVERRIDES_PATH, '-e', REFRESH_PATH],
        env: undefined,
      },
    ])
    expect(fake.calls).toEqual([REFRESH_PROMPT])
    expect(fake.wasStopped()).toBe(true)

    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    await settle()
    expect(fake.spawns).toHaveLength(2)
    expect(errorLog).not.toHaveBeenCalled()
  })

  it('starts no second Pi on a tick while a refresh runs, and stopAllSessions stops that Pi and the schedule', async () => {
    const fake = handledFake()
    server = startServer((options) => {
      const client = fake.createPiClient(options)
      let failStart!: (error: Error) => void
      const ready = new Promise<never>((_resolve, reject) => {
        failStart = reject
      })
      // Pi never answers readiness; the transport rejects the read once stopped.
      return {
        ...client,
        start: () => ready,
        stop: async () => {
          failStart(new Error('stopped before Pi was ready'))
          await client.stop()
        },
      }
    })

    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + INTERVAL_MS)
    expect(fake.spawns).toHaveLength(1)

    await server.stopAllSessions()
    expect(fake.wasStopped()).toBe(true)
    await vi.advanceTimersByTimeAsync(2 * INTERVAL_MS)

    expect(fake.spawns).toHaveLength(1)
    expect(errorLog).not.toHaveBeenCalled()
  })

  it('makes stopAllSessions wait for a refresh Pi that is still stopping', async () => {
    const fake = handledFake()
    let releaseStop!: () => void
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    server = startServer((options) => {
      const client = fake.createPiClient(options)
      return {
        ...client,
        stop: async () => {
          await stopGate
          await client.stop()
        },
      }
    })
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS)
    await settle()
    expect(fake.calls).toEqual([REFRESH_PROMPT])

    let stoppedAll = false
    const stopping = server.stopAllSessions().then(() => {
      stoppedAll = true
    })
    await settle()
    expect(stoppedAll).toBe(false)

    releaseStop()
    await stopping
    expect(fake.wasStopped()).toBe(true)
  })
})

// ── One refresh over the RPC transport ────────────────────────────────────────

describe('a catalog refresh over the RPC transport', () => {
  it('leaves an extension_error to the transport line, and the next refresh starts a fresh Pi', async () => {
    const launches: string[][] = []
    const refresher = transportRefresher(
      { command: FAKE_PI, args: RPC_MODE_ARGS, source: 'test', env: { FAKE_PI_MODE: 'command-error' } },
      launches,
    )

    await refresher.refreshOnce()
    expect(loggedLines()).toEqual([
      expect.stringContaining(
        `Pi extension error in command:${CATALOG_REFRESH_COMMAND} on event "command": model catalog refresh failed`,
      ),
    ])

    await refresher.refreshOnce()
    expect(launches).toHaveLength(2)
    expect(loggedLines()).toHaveLength(2)
  })

  it('logs one line for a refresh Pi that cannot be spawned', async () => {
    await transportRefresher({ command: MISSING_PI, args: RPC_MODE_ARGS, source: 'test' }).refreshOnce()

    const lines = loggedLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]?.startsWith(catalogRefreshLogLine('failed: '))).toBe(true)
    expect(lines[0]).toContain('could not be spawned (ENOENT)')
  })
})

// ── The refresh extension ─────────────────────────────────────────────────────

describe('the catalog refresh extension', () => {
  let dir: string
  let extension: RefreshExtension

  // Imported from a real file, the way Pi loads it, so the shipped source runs.
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pi-acp-catalog-refresh-'))
    const path = join(dir, CATALOG_REFRESH_EXTENSION_FILENAME)
    writeFileSync(path, CATALOG_REFRESH_EXTENSION_SOURCE, 'utf8')
    extension = ((await import(/* @vite-ignore */ pathToFileURL(path).href)) as { default: RefreshExtension }).default
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs a network refresh under its own timeout and throws naming each provider that failed', async () => {
    let handler: CommandHandler | undefined
    extension({
      registerCommand: (name, options) => {
        if (name === CATALOG_REFRESH_COMMAND) handler = options.handler
      },
    })
    if (handler === undefined) throw new Error(`extension registered no ${CATALOG_REFRESH_COMMAND} command`)
    const requested: unknown[] = []
    let result = { aborted: false, errors: new Map<string, Error>() }
    const ctx = {
      modelRegistry: {
        refresh: async (options: unknown) => {
          requested.push(options)
          return result
        },
      },
    }

    await handler('', ctx)
    expect(requested).toEqual([{ allowNetwork: true, signal: expect.any(AbortSignal) }])

    result = { aborted: false, errors: new Map([['openrouter', new Error(PROVIDER_FAILURE)]]) }
    await expect(handler('', ctx)).rejects.toThrow(`model catalog refresh failed: openrouter: ${PROVIDER_FAILURE}`)

    result = { aborted: true, errors: new Map() }
    await expect(handler('', ctx)).rejects.toThrow(`model catalog refresh timed out after ${CATALOG_REFRESH_TIMEOUT_MS}ms`)
  })
})
