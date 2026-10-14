import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext, SessionUpdate } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, type Mock, type MockInstance, vi } from 'vitest'

import {
  AGENT_NAME,
  BUILTIN_COMMANDS,
  CONFIG_ID_MODEL,
  CONFIG_ID_THOUGHT_LEVEL,
  idleTeardownLogLine,
  PI_SESSION_ARG,
  PI_SESSION_ID_ARG,
  PROTOCOL_VERSION,
} from '../constants.js'
import { encodeSentinelTitle } from '../permissions/gate.js'
import type { RpcExtensionUIRequest } from '../pi/types.js'
import type { CreatePiClient, PiClientLike, SessionConnection } from '../session/SessionConnection.js'
import { establishSession } from '../session/sessionSetup.js'
import { buildConfigOptions } from '../turn/configOptions.js'
import type { FlattenedPrompt } from '../turn/promptContent.js'
import { type AcpTestFixture, createAcpTestFixture } from './acpTestFixture.js'
import { type FakePiClient, type FakePiSpec, type FakeState, makeFakePiClient, UNREAD_SOURCE_INFO } from './fixtures/fakePiClient.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const LAUNCH = { command: 'pi', args: ['--mode', 'rpc'], source: 'test' }
const CWD = '/workspace/project'
const MCP_EXTENSION_PATH = '/tmp/pi-acp-idle-mcp-extension.mjs'
const RPC_TIMEOUT_MS = 1_000
const TEMP_PREFIX = 'pi-acp-idle-'
const IDLE_MS = 60_000
/** Far past every idle wait a test makes, so a held spare never ages out. */
const SPARE_MAX_AGE_MS = IDLE_MS * 10
const SESSION_ID = 'sess-1'
const SPARE_SESSION_ID = 'sess-2'
const SONNET = { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }
const OPUS = { provider: 'anthropic', id: 'claude-opus-5', name: 'Claude Opus 5' }
const HAIKU = { provider: 'anthropic', id: 'claude-haiku-5', name: 'Claude Haiku 5' }
const LEVELS = ['off', 'low', 'high']
const DEFAULT_LEVEL = 'low'
const SET_LEVEL = 'high'
const SESSION_NAME = 'Parser work'
const COMMANDS = [{ name: 'extcmd', description: 'ext', source: 'extension', sourceInfo: UNREAD_SOURCE_INFO }]
const LATER_COMMAND = { name: 'latercmd', description: 'later', source: 'extension', sourceInfo: UNREAD_SOURCE_INFO }
const GO: FlattenedPrompt = { message: 'go', images: [], firstText: 'go' }
const NAME_PROMPT: FlattenedPrompt = { message: `/name ${SESSION_NAME}`, images: [], firstText: `/name ${SESSION_NAME}` }
const INIT_REQUEST = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }
const SET_COMMANDS = ['set_model', 'set_thinking_level', 'set_session_name']
const IDLE_LOG_PREFIX = idleTeardownLogLine(SESSION_ID, '')
const WAKE_EXIT_MESSAGE = 'Pi exited during the wake'
const START_FAILURE_MESSAGE = 'Pi failed to start'

type Emit = Parameters<NonNullable<FakePiSpec['onPrompt']>>[0]

const settledTurn = (emit: Emit): void => {
  emit({ type: 'agent_start' } as never)
  emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } } as never)
  emit({ type: 'agent_settled', aborted: false } as never)
}

const startOnly = (emit: Emit): void => emit({ type: 'agent_start' } as never)

function finishTurn(fake: FakePiClient): void {
  fake.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } } as never)
  fake.emit({ type: 'agent_settled', aborted: false } as never)
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return { sessionId: SESSION_ID, thinkingLevel: DEFAULT_LEVEL, model: SONNET, ...overrides }
}

function baseSpec(): FakePiSpec {
  return { state: baseState(), models: [SONNET, OPUS], levels: LEVELS, commands: COMMANDS, onPrompt: settledTurn }
}

// ── One fake Pi per spawn ─────────────────────────────────────────────────────
//
// A wake spawns a new subprocess, so each spawn gets its own fake: its own
// state, its own calls, and its own stop.

interface SpawnSetup {
  readonly spec?: Partial<FakePiSpec>
  /** Holds `start()`, keeping a wake in flight. */
  readonly startGate?: Promise<void>
  /** Rejects `start()` once `startGate` settles. */
  readonly startError?: Error
  /** Holds `stop()`, keeping a teardown in flight. */
  readonly stopGate?: Promise<void>
  /** Holds one command type until the gate settles. */
  readonly hold?: { readonly type: string; readonly gate: Promise<void> }
}

interface Spawner {
  readonly createPiClient: CreatePiClient
  fake(spawn: number): FakePiClient
  spawned(): number
  /** `stop()` calls on one spawn, counted as they are made. */
  stops(spawn: number): number
  /** The fake's `exit` alone leaves its requests answering; the transport
   * rejects the one in flight and every later one first. */
  exit(spawn: number, error: Error): void
}

interface SpawnExit {
  error: Error | undefined
  readonly exited: Promise<never>
  kill(error: Error): void
}

function spawnExit(): SpawnExit {
  let reject!: (error: Error) => void
  const exited = new Promise<never>((_resolve, rejectExited) => {
    reject = rejectExited
  })
  exited.catch(() => undefined)
  const exit: SpawnExit = {
    error: undefined,
    exited,
    kill: (error) => {
      exit.error = error
      reject(error)
    },
  }
  return exit
}

function makeSpawner(setups: readonly SpawnSetup[]): Spawner {
  const fakes = setups.map((setup) => makeFakePiClient({ ...baseSpec(), ...setup.spec }))
  const exits = setups.map(() => spawnExit())
  const stopCounts = new Map<number, number>()
  const fake = (spawn: number): FakePiClient => {
    const found = fakes[spawn]
    if (found === undefined) throw new Error(`idle teardown test: no fake Pi for spawn ${spawn + 1}`)
    return found
  }
  const exitOf = (spawn: number): SpawnExit => {
    const found = exits[spawn]
    if (found === undefined) throw new Error(`idle teardown test: no fake Pi for spawn ${spawn + 1}`)
    return found
  }
  let spawned = 0
  const createPiClient: CreatePiClient = (options) => {
    const spawn = spawned++
    const setup = setups[spawn] ?? {}
    const client = fake(spawn).createPiClient(options)
    const exit = exitOf(spawn)
    const request = (async (command: { type: string }, requestOptions?: unknown) => {
      if (command.type === setup.hold?.type) await Promise.race([setup.hold.gate, exit.exited])
      if (exit.error !== undefined) throw exit.error
      return await (client.request as (c: unknown, o?: unknown) => Promise<unknown>)(command, requestOptions)
    }) as unknown as PiClientLike['request']
    return {
      start: async () => {
        await setup.startGate
        if (setup.startError !== undefined) throw setup.startError
        return await client.start()
      },
      request,
      stop: async () => {
        stopCounts.set(spawn, (stopCounts.get(spawn) ?? 0) + 1)
        await setup.stopGate
        await client.stop()
      },
      startupTiming: client.startupTiming,
      stderrTail: () => client.stderrTail(),
    }
  }
  return {
    createPiClient,
    fake,
    spawned: () => spawned,
    stops: (spawn) => stopCounts.get(spawn) ?? 0,
    exit: (spawn, error) => {
      exitOf(spawn).kill(error)
      fake(spawn).exit(error)
    },
  }
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let errorLog: MockInstance<typeof console.error>
let tempDir: string

beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  tempDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(tempDir, { recursive: true, force: true })
})

interface Notifier {
  readonly context: AgentContext
  readonly notify: Mock
  readonly request: Mock
}

function makeNotifier(permission = 'allow_always'): Notifier {
  const notify = vi.fn(async () => {})
  const request = vi.fn(async () => ({ outcome: { outcome: 'selected', optionId: permission } }))
  return { context: { notify, request } as unknown as AgentContext, notify, request }
}

async function connect(
  spawner: Spawner,
  notifier: Notifier = makeNotifier(),
  logStartupTiming = false,
): Promise<SessionConnection> {
  const established = await establishSession(
    { cwd: CWD, mcpServers: [] },
    {
      launch: LAUNCH,
      rpcTimeoutMs: RPC_TIMEOUT_MS,
      notifier: notifier.context,
      clientSupportsNotices: false,
      mcpExtensionPath: MCP_EXTENSION_PATH,
      hiddenCommands: new Set(),
      logStartupTiming,
      createPiClient: spawner.createPiClient,
    },
  )
  established.connection.enableIdleTeardown(IDLE_MS)
  return established.connection
}

function prompt(connection: SessionConnection, text: FlattenedPrompt = GO, signal = new AbortController().signal) {
  return connection.runPrompt(text, signal)
}

async function idleOut(): Promise<void> {
  await vi.advanceTimersByTimeAsync(IDLE_MS)
}

/** Lets a held start, stop or request land, and everything queued behind it. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

function commandTypes(fake: FakePiClient): unknown[] {
  return fake.calls.map((call) => call['type'])
}

function updates(notifier: Notifier, kind: SessionUpdate['sessionUpdate']): SessionUpdate[] {
  return notifier.notify.mock.calls
    .map((call: unknown[]) => (call[1] as { update: SessionUpdate }).update)
    .filter((update) => update.sessionUpdate === kind)
}

function sentinelSelect(toolCallId: string, toolName: string): RpcExtensionUIRequest {
  return {
    type: 'extension_ui_request',
    id: `ui-${toolCallId}`,
    method: 'select',
    title: encodeSentinelTitle({ toolCallId, toolName }),
    options: ['allow_once', 'allow_always', 'reject_once'],
  } as RpcExtensionUIRequest
}

function loggedLines(): string[] {
  return errorLog.mock.calls.map(([line]) => String(line))
}

// ── Teardown ──────────────────────────────────────────────────────────────────

describe('idle teardown', () => {
  it('stops the subprocess once the session has been idle for the timeout, and not before', async () => {
    const spawner = makeSpawner([{}])
    const connection = await connect(spawner)

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(spawner.fake(0).wasStopped()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(spawner.fake(0).wasStopped()).toBe(true)
    expect(connection.dead).toBeNull()
  })

  it.each([
    { request: 'a turn', hold: 'get_session_stats', run: (connection: SessionConnection) => prompt(connection) },
    {
      request: 'a config change',
      hold: 'set_thinking_level',
      run: (connection: SessionConnection) => connection.applyConfigOption(CONFIG_ID_THOUGHT_LEVEL, SET_LEVEL),
    },
    { request: 'a replay', hold: 'get_messages', run: (connection: SessionConnection) => connection.replayHistory() },
  ])('is not armed during $request, and counts from its end', async ({ hold, run }) => {
    const held = gate()
    const spawner = makeSpawner([{ hold: { type: hold, gate: held.promise } }])
    const connection = await connect(spawner)

    const running = run(connection)
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2)
    expect(spawner.fake(0).wasStopped()).toBe(false)

    held.release()
    await running
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(spawner.fake(0).wasStopped()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(spawner.fake(0).wasStopped()).toBe(true)
  })

  it('never tears down a dead session, whose death stays sticky', async () => {
    const spawner = makeSpawner([{}, {}])
    const connection = await connect(spawner)
    spawner.fake(0).exit(new Error('Pi exited'))

    await idleOut()

    expect(spawner.fake(0).wasStopped()).toBe(false)
    await expect(prompt(connection)).rejects.toThrow('Pi exited')
    expect(spawner.spawned()).toBe(1)
  })

  it('disarms the idle timer on close, so only the close stops the subprocess', async () => {
    const spawner = makeSpawner([{}])
    const connection = await connect(spawner)
    expect(vi.getTimerCount()).toBe(1)

    await connection.close()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2)

    expect(spawner.stops(0)).toBe(1)
    expect(spawner.spawned()).toBe(1)
  })
})

// ── Wake ──────────────────────────────────────────────────────────────────────

describe('waking a dormant session', () => {
  it('relaunches a filed session from its file and runs the prompt on the new subprocess', async () => {
    const sessionFile = join(tempDir, 'filed.jsonl')
    writeFileSync(sessionFile, '')
    const state = baseState({ sessionFile })
    const spawner = makeSpawner([{ spec: { state } }, { spec: { state } }])
    const connection = await connect(spawner)
    await idleOut()

    await expect(prompt(connection)).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(spawner.fake(1).spawns).toEqual([{ cwd: CWD, args: [PI_SESSION_ARG, sessionFile] }])
    expect(commandTypes(spawner.fake(1))).toContain('prompt')
    expect(commandTypes(spawner.fake(0))).not.toContain('prompt')
  })

  it('relaunches a never-prompted session by id, then from the file the woken Pi wrote', async () => {
    const writtenFile = join(tempDir, 'written.jsonl')
    const spawner = makeSpawner([
      { spec: { state: baseState({ sessionFile: join(tempDir, 'never-written.jsonl') }) } },
      { spec: { state: baseState({ sessionFile: writtenFile }) } },
      { spec: { state: baseState({ sessionFile: writtenFile }) } },
    ])
    const connection = await connect(spawner)
    await idleOut()

    await prompt(connection)
    expect(spawner.fake(1).spawns).toEqual([{ cwd: CWD, args: [PI_SESSION_ID_ARG, SESSION_ID] }])

    // Pi files the session once its tree holds the prompt.
    writeFileSync(writtenFile, '')
    await idleOut()
    await prompt(connection)
    expect(spawner.fake(2).spawns).toEqual([{ cwd: CWD, args: [PI_SESSION_ARG, writtenFile] }])
  })

  it('relaunches by id once the session file is gone', async () => {
    const sessionFile = join(tempDir, 'removed.jsonl')
    writeFileSync(sessionFile, '')
    const state = baseState({ sessionFile })
    const spawner = makeSpawner([{ spec: { state } }, { spec: { state } }])
    const connection = await connect(spawner)
    await idleOut()
    rmSync(sessionFile)

    await expect(prompt(connection)).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(spawner.fake(1).spawns).toEqual([{ cwd: CWD, args: [PI_SESSION_ID_ARG, SESSION_ID] }])
  })

  it('relaunches only once the idle stop has landed', async () => {
    const stopping = gate()
    const spawner = makeSpawner([{ stopGate: stopping.promise }, {}])
    const connection = await connect(spawner)
    await idleOut()

    const woken = prompt(connection)
    await flush()
    expect(spawner.spawned()).toBe(1)

    stopping.release()
    await expect(woken).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(spawner.spawned()).toBe(2)
  })

  it('logs the relaunch as a wake', async () => {
    const spawner = makeSpawner([{}, {}])
    const connection = await connect(spawner, makeNotifier(), true)
    await idleOut()

    await prompt(connection)

    const lines = loggedLines().filter((line) => line.startsWith(`[${AGENT_NAME}] [${SESSION_ID}] startup timing `))
    expect(lines).toEqual([
      expect.stringMatching(/ startup timing \{"mode":"new","spawnMs":/),
      expect.stringMatching(/ startup timing \{"mode":"wake","spawnMs":null,"readyMs":null,"metadataMs":\d+,"totalMs":\d+,"pi":null\}$/),
    ])
  })

  it('starts one turn when two prompts race one wake', async () => {
    const spawner = makeSpawner([{}, {}])
    const connection = await connect(spawner)
    await idleOut()

    const outcomes = await Promise.allSettled([prompt(connection), prompt(connection)])

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: 'a turn is already in progress for this session' }),
    })
    expect(spawner.spawned()).toBe(2)
    expect(commandTypes(spawner.fake(1)).filter((type) => type === 'prompt')).toHaveLength(1)
  })

  it('wakes for a config change too', async () => {
    const spawner = makeSpawner([{}, {}])
    const connection = await connect(spawner)
    await idleOut()

    const options = await connection.applyConfigOption(CONFIG_ID_THOUGHT_LEVEL, SET_LEVEL)

    expect(options).toEqual(
      buildConfigOptions({ models: [SONNET, OPUS], currentModel: SONNET, levels: LEVELS, currentLevel: SET_LEVEL }),
    )
    expect(commandTypes(spawner.fake(1))).toContain('set_thinking_level')
  })
})

// ── Restore ───────────────────────────────────────────────────────────────────

describe('restoring a woken session', () => {
  it('re-applies the model, then the level, then the name a Pi opened by id lost', async () => {
    const spawner = makeSpawner([{}, {}])
    const connection = await connect(spawner)
    await connection.applyConfigOption(CONFIG_ID_MODEL, OPUS.id)
    await connection.applyConfigOption(CONFIG_ID_THOUGHT_LEVEL, SET_LEVEL)
    await prompt(connection, NAME_PROMPT)
    await idleOut()

    await prompt(connection)

    const woken = spawner.fake(1)
    expect(woken.calls.filter((call) => SET_COMMANDS.includes(call['type'] as string))).toEqual([
      { type: 'set_model', provider: OPUS.provider, modelId: OPUS.id },
      { type: 'set_thinking_level', level: SET_LEVEL },
      { type: 'set_session_name', name: SESSION_NAME },
    ])
    const types = commandTypes(woken)
    expect(types.indexOf('set_session_name')).toBeLessThan(types.indexOf('prompt'))
    expect(connection.configOptions).toEqual(
      buildConfigOptions({ models: [SONNET, OPUS], currentModel: OPUS, levels: LEVELS, currentLevel: SET_LEVEL }),
    )
  })

  it('re-applies nothing when the woken Pi already matches', async () => {
    const sessionFile = join(tempDir, 'filed.jsonl')
    writeFileSync(sessionFile, '')
    const state = baseState({ sessionFile, sessionName: SESSION_NAME })
    const spawner = makeSpawner([{ spec: { state } }, { spec: { state } }])
    const connection = await connect(spawner)
    await idleOut()

    await prompt(connection)

    expect(commandTypes(spawner.fake(1)).slice(0, 4)).toEqual([
      'get_available_models',
      'get_available_thinking_levels',
      'get_commands',
      'get_session_stats',
    ])
    expect(commandTypes(spawner.fake(1)).filter((type) => SET_COMMANDS.includes(type as string))).toEqual([])
  })

  it('logs a failed re-apply and carries on with what Pi reports, telling the client', async () => {
    const notifier = makeNotifier()
    const spawner = makeSpawner([{}, { spec: { failOn: 'set_model' } }])
    const connection = await connect(spawner, notifier)
    await connection.applyConfigOption(CONFIG_ID_MODEL, OPUS.id)
    await idleOut()
    notifier.notify.mockClear()

    await expect(prompt(connection)).resolves.toMatchObject({ stopReason: 'end_turn' })

    const options = buildConfigOptions({ models: [SONNET, OPUS], currentModel: SONNET, levels: LEVELS, currentLevel: DEFAULT_LEVEL })
    expect(connection.configOptions).toEqual(options)
    expect(updates(notifier, 'config_option_update')).toEqual([{ sessionUpdate: 'config_option_update', configOptions: options }])
    expect(loggedLines().filter((line) => line.startsWith(IDLE_LOG_PREFIX))).toEqual([
      expect.stringContaining('failed to re-apply the model on wake: fake pi: set_model failed'),
    ])
  })

  it('keeps allow_always grants across a wake', async () => {
    const notifier = makeNotifier('allow_always')
    const spawner = makeSpawner([{ spec: { onPrompt: startOnly } }, { spec: { onPrompt: startOnly } }])
    const connection = await connect(spawner, notifier)

    const first = prompt(connection)
    await flush()
    spawner.fake(0).emit({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'edit', args: { path: '/a' } } as never)
    await spawner.fake(0).requestUi(sentinelSelect('tc1', 'edit'))
    finishTurn(spawner.fake(0))
    await first
    await idleOut()

    const second = prompt(connection)
    await vi.waitFor(() => expect(commandTypes(spawner.fake(1))).toContain('prompt'))
    spawner.fake(1).emit({ type: 'tool_execution_start', toolCallId: 'tc2', toolName: 'edit', args: { path: '/b' } } as never)
    const response = await spawner.fake(1).requestUi(sentinelSelect('tc2', 'edit'))
    finishTurn(spawner.fake(1))
    await second

    expect(response).toEqual({ type: 'extension_ui_response', id: 'ui-tc2', value: 'allow_once' })
    expect(notifier.request).toHaveBeenCalledOnce()
  })

  it('forwards nothing a woken Pi emits before the wake attaches it', async () => {
    const notifier = makeNotifier()
    const start = gate()
    const spawner = makeSpawner([{}, { startGate: start.promise }])
    const connection = await connect(spawner, notifier)
    await connection.applyConfigOption(CONFIG_ID_THOUGHT_LEVEL, SET_LEVEL)
    await idleOut()
    notifier.notify.mockClear()

    const woken = prompt(connection)
    await flush()
    spawner.fake(1).emit({ type: 'thinking_level_changed', level: DEFAULT_LEVEL } as never)
    start.release()
    await woken

    expect(updates(notifier, 'config_option_update')).toEqual([])
    expect(connection.configOptions).toEqual(
      buildConfigOptions({ models: [SONNET, OPUS], currentModel: SONNET, levels: LEVELS, currentLevel: SET_LEVEL }),
    )
  })

  it('sends config and command updates only when the woken Pi differs', async () => {
    const notifier = makeNotifier()
    const spawner = makeSpawner([
      {},
      {},
      { spec: { models: [SONNET, OPUS, HAIKU], commands: [...COMMANDS, LATER_COMMAND] } },
    ])
    const connection = await connect(spawner, notifier)
    await idleOut()
    notifier.notify.mockClear()

    await prompt(connection)
    expect(updates(notifier, 'config_option_update')).toEqual([])
    expect(updates(notifier, 'available_commands_update')).toEqual([])

    await idleOut()
    await prompt(connection)
    expect(updates(notifier, 'config_option_update')).toEqual([
      {
        sessionUpdate: 'config_option_update',
        configOptions: buildConfigOptions({
          models: [SONNET, OPUS, HAIKU],
          currentModel: SONNET,
          levels: LEVELS,
          currentLevel: DEFAULT_LEVEL,
        }),
      },
    ])
    expect(updates(notifier, 'available_commands_update')).toEqual([
      {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          ...BUILTIN_COMMANDS,
          { name: 'extcmd', description: 'ext' },
          { name: 'latercmd', description: 'later' },
        ],
      },
    ])
  })
})

// ── Failure ───────────────────────────────────────────────────────────────────

describe('a failed wake', () => {
  it.each([
    { failure: 'a metadata read fails', spec: { failOn: 'get_commands' }, error: /get_commands/ },
    {
      failure: 'Pi opens another session',
      spec: { state: baseState({ sessionId: 'sess-other' }) },
      error: `Pi opened session "sess-other" from ${PI_SESSION_ID_ARG} ${SESSION_ID}, expected "${SESSION_ID}"`,
    },
  ])('answers with its error when $failure, and the next request retries', async ({ spec, error }) => {
    const spawner = makeSpawner([{}, { spec }, {}])
    const connection = await connect(spawner)
    await idleOut()

    await expect(prompt(connection)).rejects.toThrow(error)
    expect(spawner.fake(1).wasStopped()).toBe(true)
    expect(connection.dead).toBeNull()

    await expect(prompt(connection)).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(spawner.spawned()).toBe(3)
  })

  it('answers every prompt racing it with its error, and the next request retries', async () => {
    const spawner = makeSpawner([{}, { spec: { failOn: 'get_commands' } }, {}])
    const connection = await connect(spawner)
    await idleOut()

    const outcomes = await Promise.allSettled([prompt(connection), prompt(connection)])

    const wakeFailure = { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('get_commands') }) }
    expect(outcomes).toEqual([wakeFailure, wakeFailure])
    expect(spawner.spawned()).toBe(2)
    expect(connection.dead).toBeNull()
    await expect(prompt(connection)).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(spawner.spawned()).toBe(3)
  })

  it('answers with the start failure when the relaunched Pi fails to start, and the next request retries', async () => {
    const spawner = makeSpawner([{}, { startError: new Error(START_FAILURE_MESSAGE) }, {}])
    const connection = await connect(spawner)
    await idleOut()

    await expect(prompt(connection)).rejects.toThrow(START_FAILURE_MESSAGE)
    expect(connection.dead).toBeNull()

    await expect(prompt(connection)).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(spawner.spawned()).toBe(3)
  })

  it('leaves no sticky death when the relaunched Pi exits before it is attached, and the next request retries', async () => {
    const metadata = gate()
    const spawner = makeSpawner([{}, { hold: { type: 'get_commands', gate: metadata.promise } }, {}])
    const connection = await connect(spawner)
    await idleOut()

    const waking = prompt(connection)
    await flush()
    expect(commandTypes(spawner.fake(1))).toContain('get_available_models')
    spawner.exit(1, new Error(WAKE_EXIT_MESSAGE))

    await expect(waking).rejects.toThrow(WAKE_EXIT_MESSAGE)
    expect(connection.dead).toBeNull()
    expect(spawner.fake(1).wasStopped()).toBe(true)
    await expect(prompt(connection)).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(spawner.spawned()).toBe(3)
  })

  it('fails the wake when the relaunched Pi exits during a restore re-apply, never attaching it', async () => {
    const setting = gate()
    const spawner = makeSpawner([{}, { hold: { type: 'set_thinking_level', gate: setting.promise } }, {}])
    const connection = await connect(spawner)
    await connection.applyConfigOption(CONFIG_ID_THOUGHT_LEVEL, SET_LEVEL)
    await idleOut()

    const waking = prompt(connection)
    await flush()
    spawner.exit(1, new Error(WAKE_EXIT_MESSAGE))

    await expect(waking).rejects.toThrow(WAKE_EXIT_MESSAGE)
    expect(connection.dead).toBeNull()
    await expect(prompt(connection)).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(spawner.spawned()).toBe(3)
  })

  it('stops the relaunched subprocess when the restore read after a re-apply fails, and the next request retries', async () => {
    const spawner = makeSpawner([{}, { spec: { failOn: 'get_state' } }, {}])
    const connection = await connect(spawner)
    await connection.applyConfigOption(CONFIG_ID_THOUGHT_LEVEL, SET_LEVEL)
    await idleOut()

    await expect(prompt(connection)).rejects.toThrow(/get_state/)
    expect(commandTypes(spawner.fake(1)).slice(-2)).toEqual(['set_thinking_level', 'get_state'])
    expect(spawner.fake(1).wasStopped()).toBe(true)
    expect(connection.dead).toBeNull()

    await expect(prompt(connection)).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(spawner.spawned()).toBe(3)
    expect(connection.configOptions).toEqual(
      buildConfigOptions({ models: [SONNET, OPUS], currentModel: SONNET, levels: LEVELS, currentLevel: SET_LEVEL }),
    )
  })
})

// ── Cancel, close and stop around a wake ─────────────────────────────────────

describe('cancel, close and stop on a dormant session', () => {
  it.each([
    { path: 'session/cancel', cancel: (connection: SessionConnection) => connection.cancel() },
    { path: 'the abort signal', cancel: (_connection: SessionConnection, controller: AbortController) => controller.abort() },
  ])('answers a prompt cancelled during the wake via $path without sending it', async ({ cancel }) => {
    const starting = gate()
    const spawner = makeSpawner([{}, { startGate: starting.promise }])
    const connection = await connect(spawner)
    await idleOut()
    const controller = new AbortController()

    const cancelled = prompt(connection, GO, controller.signal)
    await flush()
    cancel(connection, controller)

    await expect(cancelled).resolves.toMatchObject({ stopReason: 'cancelled' })
    starting.release()
    await flush()
    expect(commandTypes(spawner.fake(1))).not.toContain('prompt')
    // The wake still lands, so the next prompt reuses it.
    await expect(prompt(connection)).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(spawner.spawned()).toBe(2)
  })

  it('cancels only the prompt whose abort signal fires while two wait on one wake', async () => {
    const starting = gate()
    const spawner = makeSpawner([{}, { startGate: starting.promise }])
    const connection = await connect(spawner)
    await idleOut()
    const controller = new AbortController()

    const cancelled = prompt(connection, GO, controller.signal)
    const kept = prompt(connection)
    await flush()
    controller.abort()

    await expect(cancelled).resolves.toMatchObject({ stopReason: 'cancelled' })
    starting.release()
    await expect(kept).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(spawner.spawned()).toBe(2)
    expect(commandTypes(spawner.fake(1)).filter((type) => type === 'prompt')).toHaveLength(1)
  })

  it('answers a prompt already aborted without waking', async () => {
    const spawner = makeSpawner([{}, {}])
    const connection = await connect(spawner)
    await idleOut()
    const controller = new AbortController()
    controller.abort()

    await expect(prompt(connection, GO, controller.signal)).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(spawner.spawned()).toBe(1)
  })

  it('waits out a teardown still stopping before close resolves', async () => {
    const stopping = gate()
    const spawner = makeSpawner([{ stopGate: stopping.promise }])
    const connection = await connect(spawner)
    await idleOut()
    let closed = false

    const closing = connection.close().then(() => {
      closed = true
    })
    await flush()
    expect(closed).toBe(false)

    stopping.release()
    await closing
    expect(spawner.fake(0).wasStopped()).toBe(true)
    expect(spawner.spawned()).toBe(1)
  })

  it('answers a prompt waiting on the wake cancelled on close, and stops the woken subprocess', async () => {
    const starting = gate()
    const spawner = makeSpawner([{}, { startGate: starting.promise }])
    const connection = await connect(spawner)
    await idleOut()

    const waiting = prompt(connection)
    await flush()
    const closing = connection.close()

    await expect(waiting).resolves.toMatchObject({ stopReason: 'cancelled' })
    starting.release()
    await closing
    expect(spawner.fake(1).wasStopped()).toBe(true)
    expect(commandTypes(spawner.fake(1))).not.toContain('prompt')
  })

  it('fails a prompt waiting on the wake on connection-close teardown, and stops the woken subprocess', async () => {
    const starting = gate()
    const spawner = makeSpawner([{}, { startGate: starting.promise }])
    const connection = await connect(spawner)
    await idleOut()

    const waiting = prompt(connection)
    await flush()
    const stopping = connection.stop()

    await expect(waiting).rejects.toThrow(/closed while a turn was in progress/)
    starting.release()
    await stopping
    expect(spawner.fake(1).wasStopped()).toBe(true)
  })

  it('fails a config change waiting on the wake with the closing error', async () => {
    const starting = gate()
    const spawner = makeSpawner([{}, { startGate: starting.promise }])
    const connection = await connect(spawner)
    await idleOut()

    const waiting = connection.applyConfigOption(CONFIG_ID_THOUGHT_LEVEL, SET_LEVEL)
    await flush()
    const closing = connection.close()
    starting.release()

    await expect(waiting).rejects.toMatchObject({ code: -32_600, message: 'the session is closing' })
    await closing
    expect(spawner.fake(1).wasStopped()).toBe(true)
  })
})

// ── Server ────────────────────────────────────────────────────────────────────

describe('idle teardown through the server', () => {
  let fixture: AcpTestFixture | null = null

  afterEach(async () => {
    await fixture?.close()
    fixture = null
  })

  async function open(spawner: Spawner, options: { warmSpareMaxAgeMs?: number; idleTimeoutMs?: number }): Promise<AcpTestFixture> {
    fixture = createAcpTestFixture({}, { ...options, createPiClient: spawner.createPiClient })
    await fixture.client.request(acp.methods.agent.initialize, INIT_REQUEST)
    return fixture
  }

  function newSession(scenario: AcpTestFixture): Promise<acp.NewSessionResponse> {
    return scenario.client.request(acp.methods.agent.session.new, { cwd: CWD, mcpServers: [] })
  }

  it('stays off without the setting', async () => {
    const spawner = makeSpawner([{}])
    const scenario = await open(spawner, {})
    await newSession(scenario)

    await vi.advanceTimersByTimeAsync(IDLE_MS * 2)

    expect(spawner.fake(0).wasStopped()).toBe(false)
  })

  it('arms a warm spare only once it is taken', async () => {
    const spawner = makeSpawner([{}, { spec: { state: baseState({ sessionId: SPARE_SESSION_ID }) } }])
    const scenario = await open(spawner, { warmSpareMaxAgeMs: SPARE_MAX_AGE_MS, idleTimeoutMs: IDLE_MS })
    const created = await newSession(scenario)
    await scenario.client.request(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: GO.message }],
    })
    await flush()
    expect(spawner.spawned()).toBe(2)

    await vi.advanceTimersByTimeAsync(IDLE_MS * 2)
    expect(spawner.fake(0).wasStopped()).toBe(true)
    expect(spawner.fake(1).wasStopped()).toBe(false)

    const taken = await newSession(scenario)
    expect(taken.sessionId).toBe(SPARE_SESSION_ID)
    await idleOut()
    expect(spawner.fake(1).wasStopped()).toBe(true)
  })

  it('re-announces cached commands on resume without waking, and wakes on load', async () => {
    const spawner = makeSpawner([{}, {}])
    const scenario = await open(spawner, { idleTimeoutMs: IDLE_MS })
    const created = await newSession(scenario)
    await idleOut()
    scenario.clearTranscript()

    const resumed = await scenario.client.request(acp.methods.agent.session.resume, { sessionId: created.sessionId, cwd: CWD })
    await flush()

    expect(resumed.configOptions).toEqual(
      buildConfigOptions({ models: [SONNET, OPUS], currentModel: SONNET, levels: LEVELS, currentLevel: DEFAULT_LEVEL }),
    )
    expect(scenario.transcript()).toEqual([
      {
        kind: 'notification',
        method: acp.methods.client.session.update,
        params: {
          sessionId: SESSION_ID,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [...BUILTIN_COMMANDS, { name: 'extcmd', description: 'ext' }],
          },
        },
      },
    ])
    expect(spawner.spawned()).toBe(1)

    await scenario.client.request(acp.methods.agent.session.load, { sessionId: created.sessionId, cwd: CWD, mcpServers: [] })

    expect(spawner.spawned()).toBe(2)
    expect(commandTypes(spawner.fake(1))).toContain('get_messages')
  })

  it('stops a dormant session on close without waking it', async () => {
    const spawner = makeSpawner([{}])
    const scenario = await open(spawner, { idleTimeoutMs: IDLE_MS })
    const created = await newSession(scenario)
    await idleOut()

    await scenario.client.request(acp.methods.agent.session.close, { sessionId: created.sessionId })

    expect(spawner.spawned()).toBe(1)
  })
})
