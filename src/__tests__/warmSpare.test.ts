import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { AGENT_NAME, BUILTIN_COMMANDS, PI_SESSION_ARG, PROTOCOL_VERSION, warmSpareLogLine } from '../constants.js'
import type { CreatePiClient } from '../session/SessionConnection.js'
import { sessionDirForCwd } from '../session/sessionDirectory.js'
import { buildConfigOptions } from '../turn/configOptions.js'
import {
  type AcpTestFixture,
  type AcpTestFixtureOptions,
  createAcpTestFixture,
  defaultFakePiSpec,
  TEST_MODEL,
  TEST_THINKING_LEVEL,
} from './acpTestFixture.js'
import {
  DEFAULT_TURN_USAGE,
  type FakePiClient,
  type FakePiSpec,
  makeFakePiClient,
  UNREAD_SOURCE_INFO,
} from './fixtures/fakePiClient.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const CWD = '/workspace/project'
const OTHER_CWD = '/workspace/other'
const INIT_REQUEST = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }
const HELLO_TEXT = 'hi'
const SESSION_COMMAND_TEXT = '/session'
const MCP_SERVER: acp.McpServer = { name: 'probe', command: '/usr/bin/probe', args: [], env: [] }
const LATER_MODEL = { provider: TEST_MODEL.provider, id: 'claude-opus-5', name: 'Claude Opus 5' }
const HEADER_TIME = '2026-01-01T00:00:00.000Z'
const FILE_TIMESTAMP = '2026-01-01T00-00-00-000Z'
/** Long enough that a spare expires only in the test that means it to. */
const MAX_AGE_MS = 60_000
const SHORT_MAX_AGE_MS = 20
/** No prompt template, so a build reads no file and lands within one macrotask. */
const COMMANDS = [{ name: 'extcmd', description: 'ext', source: 'extension', sourceInfo: UNREAD_SOURCE_INFO }]
const COMMANDS_UPDATE = {
  sessionUpdate: 'available_commands_update',
  availableCommands: [...BUILTIN_COMMANDS, { name: 'extcmd', description: 'ext' }],
}
const WARM_SPARE_LOG_PREFIX = warmSpareLogLine('')

type Emit = Parameters<NonNullable<FakePiSpec['onPrompt']>>[0]

const settledTurn = (emit: Emit): void => {
  emit({ type: 'agent_start' } as never)
  emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } } as never)
  emit({ type: 'agent_settled', aborted: false } as never)
}

// ── One fake Pi per spawn ─────────────────────────────────────────────────────
//
// A single fake rewires itself to its latest spawn and shares one state across
// spawns, so it cannot be a held spare and a live session at once.

interface SpawnSetup {
  readonly spec?: Partial<FakePiSpec>
  /** Holds `start()` until it settles, keeping that spawn's build in flight. */
  readonly startGate?: Promise<void>
}

interface Spawner {
  readonly fakes: readonly FakePiClient[]
  readonly createPiClient: CreatePiClient
  spawned(): number
}

const sessionIdOf = (spawn: number): string => `sess-${spawn + 1}`

function makeSpawner(count: number, setupOf: (spawn: number) => SpawnSetup = () => ({})): Spawner {
  const setups = Array.from({ length: count }, (_, spawn) => setupOf(spawn))
  const fakes = setups.map((setup, spawn) =>
    makeFakePiClient({
      ...defaultFakePiSpec(),
      commands: COMMANDS,
      onPrompt: settledTurn,
      ...setup.spec,
      state: { ...defaultFakePiSpec().state, sessionId: sessionIdOf(spawn) },
    }),
  )
  let spawned = 0
  const createPiClient: CreatePiClient = (options) => {
    const spawn = spawned++
    const client = fakeAt(fakes, spawn).createPiClient(options)
    const gate = setups[spawn]?.startGate
    if (gate === undefined) return client
    return {
      ...client,
      start: async () => {
        await gate
        return await client.start()
      },
    }
  }
  return { fakes, createPiClient, spawned: () => spawned }
}

function fakeAt(fakes: readonly FakePiClient[], spawn: number): FakePiClient {
  const fake = fakes[spawn]
  if (fake === undefined) throw new Error(`warm spare test: no fake Pi for spawn ${spawn + 1}`)
  return fake
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let fixture: AcpTestFixture | null = null
let errorLog: MockInstance<typeof console.error>

beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await fixture?.close()
  fixture = null
  vi.restoreAllMocks()
})

async function open(
  spawner: Spawner,
  options: Omit<AcpTestFixtureOptions, 'createPiClient'> = { warmSpareMaxAgeMs: MAX_AGE_MS },
): Promise<AcpTestFixture> {
  fixture = createAcpTestFixture({}, { ...options, createPiClient: spawner.createPiClient })
  await fixture.client.request(acp.methods.agent.initialize, INIT_REQUEST)
  return fixture
}

function newSession(scenario: AcpTestFixture, cwd = CWD, mcpServers: acp.McpServer[] = []): Promise<acp.NewSessionResponse> {
  return scenario.client.request(acp.methods.agent.session.new, { cwd, mcpServers })
}

function prompt(scenario: AcpTestFixture, sessionId: string, text = HELLO_TEXT): Promise<acp.PromptResponse> {
  return scenario.client.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] })
}

/** Lets a refill the last prompt started land. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** A cold session and one prompt on it, after which spawn 1 is the held spare. */
async function holdSpare(scenario: AcpTestFixture, cwd = CWD, mcpServers: acp.McpServer[] = []): Promise<void> {
  const created = await newSession(scenario, cwd, mcpServers)
  await prompt(scenario, created.sessionId)
  await settle()
}

function writeStoredSession(root: string, sessionId: string): void {
  const dir = sessionDirForCwd(root, CWD)
  mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version: 3, id: sessionId, timestamp: HEADER_TIME, cwd: CWD }
  writeFileSync(join(dir, `${FILE_TIMESTAMP}_${sessionId}.jsonl`), `${JSON.stringify(header)}\n`)
}

function loggedLines(): string[] {
  return errorLog.mock.calls.map(([line]) => String(line))
}

// ── Take ──────────────────────────────────────────────────────────────────────

describe('taking the warm spare', () => {
  it('answers a matching session/new without a spawn, with the config re-read at the take', async () => {
    const spareModels = [TEST_MODEL]
    const spawner = makeSpawner(3, (spawn) => (spawn === 1 ? { spec: { models: spareModels } } : {}))
    const scenario = await open(spawner)
    await holdSpare(scenario)
    expect(spawner.spawned()).toBe(2)
    // Pi's background catalog refresh lands after the spare started.
    spareModels.push(LATER_MODEL)
    scenario.clearTranscript()

    const taken = await newSession(scenario)
    await scenario.flushAnnouncements()

    expect(spawner.spawned()).toBe(2)
    expect(taken).toEqual({
      sessionId: sessionIdOf(1),
      configOptions: buildConfigOptions({
        models: [TEST_MODEL, LATER_MODEL],
        currentModel: TEST_MODEL,
        levels: [TEST_THINKING_LEVEL],
        currentLevel: TEST_THINKING_LEVEL,
      }),
    })
    expect(scenario.transcript()).toEqual([
      {
        kind: 'notification',
        method: acp.methods.client.session.update,
        params: { sessionId: sessionIdOf(1), update: COMMANDS_UPDATE },
      },
    ])
    await expect(prompt(scenario, taken.sessionId)).resolves.toEqual({ stopReason: 'end_turn', usage: DEFAULT_TURN_USAGE })
  })

  it('gives the spare to only one of two concurrent session/new requests', async () => {
    const spawner = makeSpawner(3)
    const scenario = await open(spawner)
    await holdSpare(scenario)

    const created = await Promise.all([newSession(scenario), newSession(scenario)])

    expect(created.map((response) => response.sessionId).sort()).toEqual([sessionIdOf(1), sessionIdOf(2)])
    expect(spawner.spawned()).toBe(3)
  })

  it.each([
    { miss: 'cwd', cwd: OTHER_CWD, mcpServers: [] },
    { miss: 'MCP servers', cwd: CWD, mcpServers: [MCP_SERVER] },
  ])('starts cold for another $miss and leaves the spare for a later match', async ({ cwd, mcpServers }) => {
    const spawner = makeSpawner(3)
    const scenario = await open(spawner)
    await holdSpare(scenario)

    const cold = await newSession(scenario, cwd, mcpServers)
    expect(cold.sessionId).toBe(sessionIdOf(2))
    expect(fakeAt(spawner.fakes, 1).wasStopped()).toBe(false)

    const taken = await newSession(scenario)
    expect(taken.sessionId).toBe(sessionIdOf(1))
    expect(spawner.spawned()).toBe(3)
  })

  it('stops a dead spare and starts cold', async () => {
    const spawner = makeSpawner(3)
    const scenario = await open(spawner)
    await holdSpare(scenario)
    fakeAt(spawner.fakes, 1).exit(new Error('Pi exited'))

    const created = await newSession(scenario)

    expect(created.sessionId).toBe(sessionIdOf(2))
    expect(fakeAt(spawner.fakes, 1).wasStopped()).toBe(true)
  })

  it('stops a spare at its age cap, after which a session/new starts cold', async () => {
    const spawner = makeSpawner(3)
    const scenario = await open(spawner, { warmSpareMaxAgeMs: SHORT_MAX_AGE_MS })
    await holdSpare(scenario)

    await vi.waitFor(() => expect(fakeAt(spawner.fakes, 1).wasStopped()).toBe(true))
    const created = await newSession(scenario)

    expect(created.sessionId).toBe(sessionIdOf(2))
  })

  it('stops a spare whose config re-read fails, logs why, and starts cold', async () => {
    // The build never sends get_state (start() answers it); the take's re-read does.
    const spawner = makeSpawner(3, (spawn) => (spawn === 1 ? { spec: { failOn: 'get_state' } } : {}))
    const scenario = await open(spawner)
    await holdSpare(scenario)

    const created = await newSession(scenario)

    expect(created.sessionId).toBe(sessionIdOf(2))
    expect(fakeAt(spawner.fakes, 1).wasStopped()).toBe(true)
    const logged = loggedLines().filter((line) => line.startsWith(WARM_SPARE_LOG_PREFIX))
    expect(logged).toEqual([expect.stringContaining('fake pi: get_state failed')])
  })
})

// ── Refill ────────────────────────────────────────────────────────────────────

describe('refilling the warm spare', () => {
  it('starts none after a cold create, only once a prompt ends', async () => {
    const spawner = makeSpawner(2)
    const scenario = await open(spawner)

    const created = await newSession(scenario)
    await scenario.flushAnnouncements()
    expect(spawner.spawned()).toBe(1)

    await prompt(scenario, created.sessionId)
    await settle()
    expect(spawner.spawned()).toBe(2)
    expect(fakeAt(spawner.fakes, 1).spawns).toEqual([{ cwd: CWD, args: [] }])
  })

  it('starts none for a prompt refused mid-turn', async () => {
    let releaseStats!: () => void
    const statsGate = new Promise<void>((resolve) => {
      releaseStats = resolve
    })
    // Read 0 is the turn's baseline: holding it keeps the first prompt running.
    const spawner = makeSpawner(2, (spawn) =>
      spawn === 0 ? { spec: { onSessionStats: (read) => (read === 0 ? statsGate : Promise.resolve()) } } : {},
    )
    const scenario = await open(spawner)
    const created = await newSession(scenario)
    const running = prompt(scenario, created.sessionId)

    await expect(prompt(scenario, created.sessionId)).rejects.toThrow('a turn is already in progress')
    await settle()
    expect(spawner.spawned()).toBe(1)

    releaseStats()
    await running
    await settle()
    expect(spawner.spawned()).toBe(2)
  })

  it('refills after a built-in command too', async () => {
    const spawner = makeSpawner(2)
    const scenario = await open(spawner)
    const created = await newSession(scenario)

    await prompt(scenario, created.sessionId, SESSION_COMMAND_TEXT)
    await settle()

    expect(spawner.spawned()).toBe(2)
  })

  it('spawns the spare exactly as the prompted session was, cwd and MCP servers included', async () => {
    const spawner = makeSpawner(2)
    const scenario = await open(spawner)

    await holdSpare(scenario, OTHER_CWD, [MCP_SERVER])

    expect(fakeAt(spawner.fakes, 1).spawns).toEqual(fakeAt(spawner.fakes, 0).spawns)
    const taken = await newSession(scenario, OTHER_CWD, [MCP_SERVER])
    expect(taken.sessionId).toBe(sessionIdOf(1))
  })

  it('refills after a prompt on a resumed session, starting the spare without its file', async () => {
    const spawner = makeSpawner(2)
    const scenario = await open(spawner)
    writeStoredSession(scenario.sessionRoot, sessionIdOf(0))
    await scenario.client.request(acp.methods.agent.session.resume, { sessionId: sessionIdOf(0), cwd: CWD })

    await prompt(scenario, sessionIdOf(0))
    await settle()

    expect(fakeAt(spawner.fakes, 0).spawns[0]?.args).toContain(PI_SESSION_ARG)
    expect(fakeAt(spawner.fakes, 1).spawns).toEqual([{ cwd: CWD, args: [] }])
  })

  it('stays off without an age cap', async () => {
    const spawner = makeSpawner(1)
    const scenario = await open(spawner, {})
    const created = await newSession(scenario)

    await prompt(scenario, created.sessionId)
    await settle()

    expect(spawner.spawned()).toBe(1)
  })
})

// ── Teardown ──────────────────────────────────────────────────────────────────

describe('stopAllSessions with a warm spare', () => {
  it('stops a held spare', async () => {
    const spawner = makeSpawner(2)
    const scenario = await open(spawner)
    await holdSpare(scenario)

    await scenario.server.stopAllSessions()

    expect(fakeAt(spawner.fakes, 1).wasStopped()).toBe(true)
  })

  it('makes a build still in flight stop its own subprocess when it lands', async () => {
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const spawner = makeSpawner(2, (spawn) => (spawn === 1 ? { startGate } : {}))
    const scenario = await open(spawner)
    const created = await newSession(scenario)
    await prompt(scenario, created.sessionId)
    expect(spawner.spawned()).toBe(2)

    await scenario.server.stopAllSessions()
    expect(fakeAt(spawner.fakes, 1).wasStopped()).toBe(false)
    releaseStart()

    await vi.waitFor(() => expect(fakeAt(spawner.fakes, 1).wasStopped()).toBe(true))
  })
})

// ── Startup timing ────────────────────────────────────────────────────────────

describe('warm spare startup timing', () => {
  it('logs the build as a spare and the take with its age and total', async () => {
    const spawner = makeSpawner(2)
    const scenario = await open(spawner, { warmSpareMaxAgeMs: MAX_AGE_MS, logStartupTiming: true })
    await holdSpare(scenario)

    await newSession(scenario)

    const spareId = sessionIdOf(1)
    const lines = loggedLines().filter((line) => line.startsWith(`[${AGENT_NAME}] [${spareId}] startup timing `))
    expect(lines).toEqual([
      expect.stringMatching(/ startup timing \{"mode":"spare","spawnMs":/),
      expect.stringMatching(/ startup timing \{"mode":"take","ageMs":\d+,"totalMs":\d+\}$/),
    ])
  })
})
