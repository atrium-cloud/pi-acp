import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BUILTIN_COMMANDS,
  BUILTIN_TEXT_NAME_USAGE,
  BUILTIN_TEXT_PARAGRAPH_BREAK,
  builtinTextCompacted,
  builtinTextCompactionFailed,
  builtinTextName,
  builtinTextNameNormalized,
  builtinTextNameSet,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_REQUEST,
  META_KEY_BREAKPOINT_NAMESPACE,
  META_KEY_MESSAGE_ID,
  PI_COMPACTION_CANCELLED,
  PROTOCOL_VERSION,
  USAGE_COST_CURRENCY,
} from '../constants.js'
import { PiRpcError } from '../pi/errors.js'
import { type BuiltinCommand, formatSessionInfo, parseBuiltinCommand } from '../session/builtinCommands.js'
import { establishSession } from '../session/sessionSetup.js'
import {
  type AcpTestFixture,
  createAcpTestFixture,
  defaultFakePiSpec,
  TEST_COMMANDS,
  TEST_SESSION_ID,
} from './acpTestFixture.js'
import {
  DEFAULT_COMPACTION,
  DEFAULT_STATS,
  type FakeCompaction,
  type FakePiSpec,
  makeFakePiClient,
} from './fixtures/fakePiClient.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const CWD = '/workspace/project'
const INIT_REQUEST = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }
const SESSION_FILE = '/sessions/2026-01-01T00-00-00-000Z_sess-1.jsonl'
const SESSION_NAME = 'Login bug'
const MESSAGE_ID = 'msg-1'
const PI_NOTHING_TO_COMPACT = 'Nothing to compact (session too small)'
const MAX_WAIT_TICKS = 100
const LAUNCH = { command: 'pi', args: ['--mode', 'rpc'], source: 'test' }
const MCP_EXTENSION_PATH = '/tmp/mcp-extension.mjs'

/** Pi's TUI `/session` wording, pinned here rather than read back from the source. */
const HARD_BREAK = '  \n'
const SECTION_BREAK = '\n\n'

const EXPECTED_USAGE = {
  sessionUpdate: 'usage_update',
  used: 1234,
  size: 200_000,
  cost: { amount: 0.05, currency: USAGE_COST_CURRENCY },
}

// ── Parsing ───────────────────────────────────────────────────────────────────

const PARSE_TABLE: [message: string, parsed: BuiltinCommand | undefined][] = [
  ['/compact', { kind: 'compact', customInstructions: undefined }],
  ['/compact focus on the parser', { kind: 'compact', customInstructions: 'focus on the parser' }],
  ['  /compact   keep the API notes  ', { kind: 'compact', customInstructions: 'keep the API notes' }],
  ['/compact\nfocus', undefined],
  ['/compacted', undefined],
  ['/compact:1', undefined],
  ['/name', { kind: 'name', name: '' }],
  ['/name   ', { kind: 'name', name: '' }],
  ['/name Login bug', { kind: 'name', name: 'Login bug' }],
  ['/name   spaced out  ', { kind: 'name', name: 'spaced out' }],
  ['/name first\nsecond', { kind: 'name', name: 'first\nsecond' }],
  ['/names', undefined],
  ['/session', { kind: 'session' }],
  [' /session\n', { kind: 'session' }],
  ['/session extra', undefined],
  ['session', undefined],
  ['just text', undefined],
]

describe('parseBuiltinCommand', () => {
  it.each(PARSE_TABLE)('parses %j as %j', (message, parsed) => {
    expect(parseBuiltinCommand(message)).toEqual(parsed)
  })
})

// ── Session info ──────────────────────────────────────────────────────────────

const BASE_STATS = { ...DEFAULT_STATS, sessionFile: SESSION_FILE, sessionId: TEST_SESSION_ID }

describe('formatSessionInfo', () => {
  it('renders an uncached, free, nameless in-memory session', () => {
    const stats = {
      ...BASE_STATS,
      sessionFile: undefined,
      userMessages: 2,
      assistantMessages: 3,
      toolCalls: 4,
      toolResults: 4,
      totalMessages: 9,
      tokens: { input: 300, output: 50, cacheRead: 0, cacheWrite: 0, total: 350 },
      cost: 0,
    }

    expect(formatSessionInfo(stats, undefined)).toBe(
      [
        'Session Info',
        ['File: In-memory', `ID: ${TEST_SESSION_ID}`].join(HARD_BREAK),
        ['Messages', 'Total: 9', 'User: 2', 'Assistant: 3', 'Tools: 4 calls, 4 results'].join(HARD_BREAK),
        ['Tokens', 'Input: 300', 'Output: 50', 'Total: 350'].join(HARD_BREAK),
      ].join(SECTION_BREAK),
    )
  })

  it('names the session, splits cached input, and totals the cost', () => {
    const tokens = { input: 1_000, output: 500, cacheRead: 3_000, cacheWrite: 1_000, total: 5_500 }
    const stats = { ...BASE_STATS, tokens, cost: 0.12345 }

    expect(formatSessionInfo(stats, SESSION_NAME)).toBe(
      [
        'Session Info',
        [`Name: ${SESSION_NAME}`, `File: ${SESSION_FILE}`, `ID: ${TEST_SESSION_ID}`].join(HARD_BREAK),
        ['Messages', 'Total: 2', 'User: 1', 'Assistant: 1', 'Tools: 0 calls, 0 results'].join(HARD_BREAK),
        [
          'Tokens',
          `Input: ${(5_000).toLocaleString()}`,
          `  Cached: ${(3_000).toLocaleString()} (60.0%)`,
          `  Uncached: ${(2_000).toLocaleString()} (${(1_000).toLocaleString()} written to cache)`,
          'Output: 500',
          `Total: ${(5_500).toLocaleString()}`,
        ].join(HARD_BREAK),
        ['Cost', 'Total: $0.123'].join(HARD_BREAK),
      ].join(SECTION_BREAK),
    )
  })

  it('leaves the cache-write note off when only cache reads happened', () => {
    const stats = { ...BASE_STATS, tokens: { input: 50, output: 10, cacheRead: 150, cacheWrite: 0, total: 210 } }

    const info = formatSessionInfo(stats, undefined)

    expect(info).toContain(`  Cached: 150 (75.0%)${HARD_BREAK}  Uncached: 50${HARD_BREAK}`)
    expect(info).not.toContain('written to cache')
  })
})

// ── Over the wire ─────────────────────────────────────────────────────────────

let fixture: AcpTestFixture | null = null

afterEach(async () => {
  await fixture?.close()
  fixture = null
})

async function startSession(spec: Partial<FakePiSpec> = {}): Promise<AcpTestFixture> {
  fixture = createAcpTestFixture(spec)
  await fixture.client.request(acp.methods.agent.initialize, INIT_REQUEST)
  await fixture.client.request(acp.methods.agent.session.new, { cwd: CWD, mcpServers: [] })
  await fixture.flushAnnouncements()
  fixture.clearTranscript()
  return fixture
}

function prompt(scenario: AcpTestFixture, text: string, messageId?: string): Promise<acp.PromptResponse> {
  return scenario.client.request(acp.methods.agent.session.prompt, {
    sessionId: TEST_SESSION_ID,
    prompt: [{ type: 'text', text }],
    ...(messageId === undefined ? {} : { _meta: { [META_KEY_BREAKPOINT_NAMESPACE]: { [META_KEY_MESSAGE_ID]: messageId } } }),
  })
}

function notification(update: unknown): { kind: string; method: string; params: unknown } {
  return { kind: 'notification', method: acp.methods.client.session.update, params: { sessionId: TEST_SESSION_ID, update } }
}

function agentText(text: string): { kind: string; method: string; params: unknown } {
  return notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
}

function sentTypes(scenario: AcpTestFixture): unknown[] {
  return scenario.fake.calls.map((call) => call['type'])
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_WAIT_TICKS; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${description}`)
}

/** A compaction the test finishes (or fails) itself, the way a long summarization
 * call stays open inside Pi. */
function heldCompaction(): {
  onCompact: NonNullable<FakePiSpec['onCompact']>
  finish: (result: FakeCompaction) => void
  fail: (error: Error) => void
} {
  let finish!: (result: FakeCompaction) => void
  let fail!: (error: Error) => void
  const pending = new Promise<FakeCompaction>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  return { onCompact: () => pending, finish, fail }
}

describe('built-in commands over the wire', () => {
  it('advertises the built-ins ahead of Pi commands, dropping a same-named extension command', async () => {
    const scenario = createAcpTestFixture({
      commands: [...TEST_COMMANDS, { name: 'compact', description: 'ext', source: 'extension' }],
    })
    fixture = scenario
    await scenario.client.request(acp.methods.agent.initialize, INIT_REQUEST)
    await scenario.client.request(acp.methods.agent.session.new, { cwd: CWD, mcpServers: [] })
    await scenario.flushAnnouncements()

    expect(scenario.transcript()).toEqual([
      notification({
        sessionUpdate: 'available_commands_update',
        availableCommands: [...BUILTIN_COMMANDS, { name: 'review', description: 'Review code' }],
      }),
    ])

    // The built-in shadows the extension on submit too: nothing reaches Pi as a prompt.
    await expect(prompt(scenario, '/compact')).resolves.toEqual({ stopReason: 'end_turn' })
    expect(sentTypes(scenario)).not.toContain('prompt')
  })

  it('reports session info without a turn, a title, or a breakpoint echo', async () => {
    const scenario = await startSession({ state: { ...defaultFakePiSpec().state, sessionFile: SESSION_FILE } })

    const response = await prompt(scenario, '/session', MESSAGE_ID)
    await scenario.flushAnnouncements()

    // No `_meta`: Pi appends no user entry for a built-in, so there is nothing to fork from.
    expect(response).toEqual({ stopReason: 'end_turn' })
    expect(scenario.transcript()).toEqual([
      agentText(formatSessionInfo({ ...DEFAULT_STATS, sessionFile: SESSION_FILE, sessionId: TEST_SESSION_ID }, undefined)),
    ])
    expect(sentTypes(scenario)).not.toContain('prompt')
    expect(sentTypes(scenario)).not.toContain('set_session_name')
    expect(sentTypes(scenario)).not.toContain('get_entries')
  })

  it('answers a bare /name with the usage line on a nameless session', async () => {
    const scenario = await startSession()

    await expect(prompt(scenario, '/name')).resolves.toEqual({ stopReason: 'end_turn' })
    await scenario.flushAnnouncements()

    expect(scenario.transcript()).toEqual([agentText(BUILTIN_TEXT_NAME_USAGE)])
  })

  it('answers a bare /name with the current name', async () => {
    const scenario = await startSession({ state: { ...defaultFakePiSpec().state, sessionName: SESSION_NAME } })

    await prompt(scenario, '/name')
    await scenario.flushAnnouncements()

    expect(scenario.transcript()).toEqual([agentText(builtinTextName(SESSION_NAME))])
    expect(sentTypes(scenario)).not.toContain('set_session_name')
  })

  it('sets a name Pi keeps as typed without a normalization note', async () => {
    const scenario = await startSession()

    await prompt(scenario, `/name ${SESSION_NAME}`)
    await scenario.flushAnnouncements()

    expect(scenario.transcript()).toEqual([agentText(builtinTextNameSet(SESSION_NAME))])
  })

  it('sets the name, notes how Pi normalized it, and stops the first prompt from retitling', async () => {
    const scenario = await startSession({
      onPrompt: (emit) => {
        emit({ type: 'agent_start' } as never)
        emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } } as never)
        emit({ type: 'agent_settled' } as never)
      },
    })

    await expect(prompt(scenario, '/name first\nsecond')).resolves.toEqual({ stopReason: 'end_turn' })
    await scenario.flushAnnouncements()

    expect(scenario.fake.calls.find((call) => call['type'] === 'set_session_name')).toEqual({
      type: 'set_session_name',
      name: 'first\nsecond',
    })
    expect(scenario.transcript()).toEqual([
      agentText(
        `${builtinTextNameNormalized('first\nsecond', 'first second')}${BUILTIN_TEXT_PARAGRAPH_BREAK}${builtinTextNameSet('first second')}`,
      ),
    ])

    await prompt(scenario, 'fix the parser')
    expect(scenario.fake.calls.filter((call) => call['type'] === 'set_session_name')).toHaveLength(1)
  })

  it('compacts with the custom instructions and reports the tokens it compacted from', async () => {
    const onCompact = vi.fn(async (_customInstructions: string | undefined) => DEFAULT_COMPACTION)
    const scenario = await startSession({ onCompact })

    await expect(prompt(scenario, '/compact keep the API notes')).resolves.toEqual({ stopReason: 'end_turn' })
    await scenario.flushAnnouncements()

    expect(onCompact).toHaveBeenCalledWith('keep the API notes')
    expect(scenario.transcript()).toEqual([
      agentText(builtinTextCompacted(DEFAULT_COMPACTION.tokensBefore.toLocaleString())),
      notification(EXPECTED_USAGE),
    ])
    expect(sentTypes(scenario)).not.toContain('set_session_name')
  })

  it('sends no custom instructions for a bare /compact', async () => {
    const scenario = await startSession()

    await prompt(scenario, '/compact')

    expect(scenario.fake.calls.find((call) => call['type'] === 'compact')).toEqual({ type: 'compact' })
  })

  it('reports Pi refusing the compaction as text and ends the turn', async () => {
    const scenario = await startSession({
      onCompact: async () => {
        throw new PiRpcError('compact', PI_NOTHING_TO_COMPACT)
      },
    })

    await expect(prompt(scenario, '/compact')).resolves.toEqual({ stopReason: 'end_turn' })
    await scenario.flushAnnouncements()

    expect(scenario.transcript()).toEqual([agentText(builtinTextCompactionFailed(PI_NOTHING_TO_COMPACT))])
  })

  it('reports an extension vetoing the compaction in Pi\'s own words', async () => {
    const scenario = await startSession({
      onCompact: async () => {
        throw new PiRpcError('compact', PI_COMPACTION_CANCELLED)
      },
    })

    await expect(prompt(scenario, '/compact')).resolves.toEqual({ stopReason: 'end_turn' })
    await scenario.flushAnnouncements()

    expect(scenario.transcript()).toEqual([agentText(PI_COMPACTION_CANCELLED)])
  })

  it('fails the prompt when the compaction fails outside Pi\'s own answer', async () => {
    const scenario = await startSession({
      onCompact: async () => {
        throw new Error('stdout desynced')
      },
    })

    await expect(prompt(scenario, '/compact')).rejects.toMatchObject({
      code: JSONRPC_INTERNAL_ERROR,
      message: expect.stringContaining('stdout desynced'),
    })
    await scenario.flushAnnouncements()
    expect(scenario.transcript()).toEqual([])
  })

  it('holds a cancelled compaction until Pi answers, then resolves cancelled', async () => {
    const compaction = heldCompaction()
    const scenario = await startSession({ onCompact: compaction.onCompact })

    let settled = false
    const pending = prompt(scenario, '/compact').finally(() => {
      settled = true
    })
    await waitFor(() => sentTypes(scenario).includes('compact'), 'the compact to reach Pi')
    await scenario.client.notify(acp.methods.agent.session.cancel, { sessionId: TEST_SESSION_ID })
    await waitFor(() => sentTypes(scenario).includes('abort'), 'the abort to reach Pi')

    // The session stays occupied while Pi is still compacting.
    await expect(prompt(scenario, 'hi')).rejects.toMatchObject({ code: JSONRPC_INVALID_REQUEST })
    expect(settled).toBe(false)

    // A Pi whose abort cannot stop a manual compaction finishes it anyway.
    compaction.finish(DEFAULT_COMPACTION)
    await expect(pending).resolves.toEqual({ stopReason: 'cancelled' })
    await scenario.flushAnnouncements()
    expect(scenario.transcript()).toContainEqual(
      agentText(builtinTextCompacted(DEFAULT_COMPACTION.tokensBefore.toLocaleString())),
    )
  })

  it('resolves cancelled when the cancel makes Pi fail the compaction', async () => {
    const compaction = heldCompaction()
    const scenario = await startSession({ onCompact: compaction.onCompact })

    const pending = prompt(scenario, '/compact')
    await waitFor(() => sentTypes(scenario).includes('compact'), 'the compact to reach Pi')
    await scenario.client.notify(acp.methods.agent.session.cancel, { sessionId: TEST_SESSION_ID })
    await waitFor(() => sentTypes(scenario).includes('abort'), 'the abort to reach Pi')
    compaction.fail(new PiRpcError('compact', PI_COMPACTION_CANCELLED))

    await expect(pending).resolves.toEqual({ stopReason: 'cancelled' })
    await scenario.flushAnnouncements()
    expect(scenario.transcript()).toEqual([])
  })

  it('resolves a compaction in flight as cancelled on session/close', async () => {
    const compaction = heldCompaction()
    const scenario = await startSession({ onCompact: compaction.onCompact })

    const pending = prompt(scenario, '/compact')
    await waitFor(() => sentTypes(scenario).includes('compact'), 'the compact to reach Pi')
    await scenario.client.request(acp.methods.agent.session.close, { sessionId: TEST_SESSION_ID })

    await expect(pending).resolves.toEqual({ stopReason: 'cancelled' })
    expect(scenario.fake.wasStopped()).toBe(true)
  })

  it('fails a compaction in flight when the subprocess dies', async () => {
    const compaction = heldCompaction()
    const scenario = await startSession({ onCompact: compaction.onCompact })

    const pending = prompt(scenario, '/compact')
    await waitFor(() => sentTypes(scenario).includes('compact'), 'the compact to reach Pi')
    scenario.fake.exit(new Error('pi exited: code 2, signal null'))

    await expect(pending).rejects.toMatchObject({ message: expect.stringContaining('pi exited: code 2') })
  })
})

// ── Session occupancy ─────────────────────────────────────────────────────────

describe('a running built-in', () => {
  async function connect(spec: Partial<FakePiSpec>) {
    const fake = makeFakePiClient({ ...defaultFakePiSpec(), ...spec })
    const notifier = { notify: vi.fn(async () => {}) } as unknown as AgentContext
    const established = await establishSession({ cwd: CWD, mcpServers: [] }, {
      launch: LAUNCH,
      rpcTimeoutMs: 1_000,
      notifier,
      mcpExtensionPath: MCP_EXTENSION_PATH,
      createPiClient: fake.createPiClient,
    })
    return { fake, connection: established.connection }
  }

  const COMPACT = { message: '/compact', images: [], firstText: '/compact' }

  it('holds the session until Pi answers without reading as a turn to a fork', async () => {
    const compaction = heldCompaction()
    const { fake, connection } = await connect({ onCompact: compaction.onCompact })

    const pending = connection.runPrompt(COMPACT, new AbortController().signal)
    await waitFor(() => fake.calls.some((call) => call['type'] === 'compact'), 'the compact to reach Pi')
    expect(connection.hasActiveTurn).toBe(false)
    await expect(connection.runPrompt(COMPACT, new AbortController().signal)).rejects.toMatchObject({ code: -32600 })

    compaction.finish(DEFAULT_COMPACTION)
    await expect(pending).resolves.toEqual({ stopReason: 'end_turn', acknowledgedMessageId: undefined })
  })

  it('cancels through the prompt signal', async () => {
    const compaction = heldCompaction()
    const { fake, connection } = await connect({ onCompact: compaction.onCompact })
    const controller = new AbortController()

    const pending = connection.runPrompt(COMPACT, controller.signal, MESSAGE_ID)
    await waitFor(() => fake.calls.some((call) => call['type'] === 'compact'), 'the compact to reach Pi')
    controller.abort()
    compaction.finish(DEFAULT_COMPACTION)

    await expect(pending).resolves.toEqual({ stopReason: 'cancelled', acknowledgedMessageId: undefined })
    expect(fake.calls.map((call) => call['type'])).toContain('abort')
  })

  it('fails a compaction in flight on connection teardown', async () => {
    const compaction = heldCompaction()
    const { fake, connection } = await connect({ onCompact: compaction.onCompact })

    const pending = connection.runPrompt(COMPACT, new AbortController().signal)
    await waitFor(() => fake.calls.some((call) => call['type'] === 'compact'), 'the compact to reach Pi')
    await connection.stop()

    await expect(pending).rejects.toThrow(/closed while a turn was in progress/)
  })
})
