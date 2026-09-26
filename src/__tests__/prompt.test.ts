import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext, StopReason } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_NAME,
  AGENT_START_GRACE_MS,
  EXTENSION_COMMAND_QUIET_MS,
  MESSAGE_MAP_KEY_MESSAGES,
  MESSAGE_MAP_KEY_VERSION,
  MESSAGE_MAP_VERSION,
  META_KEY_BREAKPOINT_NAMESPACE,
  META_KEY_MESSAGE_ID,
} from '../constants.js'
import { PiAcpServer } from '../server/PiAcpServer.js'
import { messageMapPathFor } from '../session/sessionDirectory.js'
import { establishSession } from '../session/sessionSetup.js'
import type { SessionConnection } from '../session/SessionConnection.js'
import { type FlattenedPrompt, flattenPromptContent } from '../turn/promptContent.js'
import { DEFAULT_TURN_USAGE, type FakePiSpec, makeFakePiClient } from './fixtures/fakePiClient.js'

const LAUNCH = { command: 'pi', args: ['--mode', 'rpc'], source: 'test' }
const ABS_CWD = '/tmp/pi-acp-session'
const MCP_EXTENSION_PATH = '/tmp/mcp-extension.mjs'
const HELLO: FlattenedPrompt = { message: 'hi', images: [], firstText: 'hi' }
/** Pi's session totals either side of a turn; `total` is the sum, as Pi reports it. */
const TOKENS_BEFORE_TURN = { input: 1_200, output: 300, cacheRead: 8_000, cacheWrite: 2_000, total: 11_500 }
const TOKENS_AFTER_TURN = { input: 1_450, output: 380, cacheRead: 14_500, cacheWrite: 2_600, total: 18_930 }
const TURN_USAGE = { inputTokens: 250, outputTokens: 80, cachedReadTokens: 6_500, cachedWriteTokens: 600, totalTokens: 7_430 }
const USAGE_UPDATE = { sessionUpdate: 'usage_update', used: 1234, size: 200_000, cost: { amount: 0.05, currency: 'USD' } }
type Emit = Parameters<NonNullable<FakePiSpec['onPrompt']>>[0]

function baseSpec(onPrompt?: FakePiSpec['onPrompt']): FakePiSpec {
  return {
    state: { sessionId: 'sess-1', thinkingLevel: 'low', model: { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' } },
    models: [{ provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }],
    levels: ['low'],
    commands: [],
    ...(onPrompt ? { onPrompt } : {}),
  }
}

async function connect(spec: FakePiSpec): Promise<{
  fake: ReturnType<typeof makeFakePiClient>
  connection: SessionConnection
  notify: ReturnType<typeof vi.fn>
}> {
  const fake = makeFakePiClient(spec)
  const notify = vi.fn(async () => {})
  const notifier = { notify } as unknown as AgentContext
  const established = await establishSession({ cwd: ABS_CWD, mcpServers: [] }, {
    launch: LAUNCH,
    rpcTimeoutMs: 1_000,
    notifier,
    clientSupportsNotices: false,
    mcpExtensionPath: MCP_EXTENSION_PATH,
    createPiClient: fake.createPiClient,
  })
  return { fake, connection: established.connection, notify }
}

const fullTurn = (emit: Emit): void => {
  emit({ type: 'agent_start' } as never)
  emit({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' } } as never)
  emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } } as never)
  emit({ type: 'agent_settled' } as never)
}

const ANY_USAGE_UPDATE = expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: 'usage_update' }) })

/** The stats reads and the prompt, in the order they reached Pi. */
function meteringOrder(fake: ReturnType<typeof makeFakePiClient>): unknown[] {
  return fake.calls.map((call) => call['type']).filter((type) => type === 'get_session_stats' || type === 'prompt')
}

describe('SessionConnection.runPrompt', () => {
  it('registers the turn before sending, so a synchronous agent_start is not missed', async () => {
    const { connection, notify } = await connect(baseSpec(fullTurn))
    const outcome = await connection.runPrompt(HELLO, new AbortController().signal)
    expect(outcome.stopReason).toBe('end_turn')
    expect(notify).toHaveBeenCalledWith(acp.methods.client.session.update, {
      sessionId: 'sess-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
    })
  })

  it('emits a usage_update from end-of-turn context stats', async () => {
    const { connection, notify } = await connect(baseSpec(fullTurn))
    await connection.runPrompt(HELLO, new AbortController().signal)
    expect(notify).toHaveBeenCalledWith(acp.methods.client.session.update, { sessionId: 'sess-1', update: USAGE_UPDATE })
  })

  it("returns the growth of Pi's session totals across the turn as its usage", async () => {
    const spec: FakePiSpec = {
      ...baseSpec(fullTurn),
      stats: (read) => ({ tokens: read === 0 ? TOKENS_BEFORE_TURN : TOKENS_AFTER_TURN }),
    }
    const { connection } = await connect(spec)
    const outcome = await connection.runPrompt(HELLO, new AbortController().signal)
    expect(outcome.usage).toEqual(TURN_USAGE)
  })

  it('reads the baseline totals before the prompt reaches Pi', async () => {
    const { fake, connection } = await connect(baseSpec(fullTurn))
    await connection.runPrompt(HELLO, new AbortController().signal)
    expect(meteringOrder(fake)).toEqual(['get_session_stats', 'prompt', 'get_session_stats'])
  })

  it('keeps the stop reason and the usage_update but reports no usage when the baseline read fails', async () => {
    const { connection, notify } = await connect({ ...baseSpec(fullTurn), failOnce: 'get_session_stats' })
    const outcome = await connection.runPrompt(HELLO, new AbortController().signal)
    expect(outcome).toEqual({ stopReason: 'end_turn', usage: undefined, acknowledgedMessageId: undefined })
    expect(notify).toHaveBeenCalledWith(acp.methods.client.session.update, { sessionId: 'sess-1', update: USAGE_UPDATE })
  })

  it('keeps the stop reason but reports no usage when the end-of-turn read fails', async () => {
    const spec: FakePiSpec = {
      ...baseSpec(fullTurn),
      onSessionStats: async (read) => {
        if (read === 1) throw new Error('fake pi: get_session_stats failed')
      },
    }
    const { connection, notify } = await connect(spec)
    const outcome = await connection.runPrompt(HELLO, new AbortController().signal)
    expect(outcome).toEqual({ stopReason: 'end_turn', usage: undefined, acknowledgedMessageId: undefined })
    expect(notify).not.toHaveBeenCalledWith(acp.methods.client.session.update, ANY_USAGE_UPDATE)
  })

  it('returns usage but skips the usage_update when post-compaction context tokens are null', async () => {
    const spec: FakePiSpec = { ...baseSpec(fullTurn), stats: { cost: 0.1, contextUsage: { tokens: null, contextWindow: 1_000, percent: null } } }
    const { connection, notify } = await connect(spec)
    const outcome = await connection.runPrompt(HELLO, new AbortController().signal)
    expect(outcome.usage).toEqual(DEFAULT_TURN_USAGE)
    expect(notify).not.toHaveBeenCalledWith(acp.methods.client.session.update, ANY_USAGE_UPDATE)
  })

  it('titles a nameless session from the first prompt', async () => {
    const { fake, connection } = await connect(baseSpec(fullTurn))
    await connection.runPrompt({ message: 'Fix the login bug', images: [], firstText: 'Fix the login bug' }, new AbortController().signal)
    expect(fake.calls.find((call) => call['type'] === 'set_session_name')).toMatchObject({ name: 'Fix the login bug' })
  })

  it('titles from the first text block, not a leading resource header', async () => {
    const { fake, connection } = await connect(baseSpec(fullTurn))
    await connection.runPrompt(
      { message: 'file:///repo/notes.md:\nnotes\nSummarize this', images: [], firstText: 'Summarize this' },
      new AbortController().signal,
    )
    expect(fake.calls.find((call) => call['type'] === 'set_session_name')).toMatchObject({ name: 'Summarize this' })
  })

  it('does not title a resource-only prompt', async () => {
    const { fake, connection } = await connect(baseSpec(fullTurn))
    await connection.runPrompt({ message: 'file:///repo/notes.md:\nnotes', images: [], firstText: '' }, new AbortController().signal)
    expect(fake.calls.some((call) => call['type'] === 'set_session_name')).toBe(false)
  })

  it('does not title a session that already has a name', async () => {
    const spec = baseSpec(fullTurn)
    spec.state.sessionName = 'Existing name'
    const { fake, connection } = await connect(spec)
    await connection.runPrompt(HELLO, new AbortController().signal)
    expect(fake.calls.some((call) => call['type'] === 'set_session_name')).toBe(false)
  })

  it('does not title from an image-only prompt with an empty message', async () => {
    const { fake, connection } = await connect(baseSpec(fullTurn))
    await connection.runPrompt({ message: '', images: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }], firstText: '' }, new AbortController().signal)
    expect(fake.calls.some((call) => call['type'] === 'set_session_name')).toBe(false)
  })

  it('refuses a second concurrent turn', async () => {
    const { fake, connection } = await connect(baseSpec((emit) => emit({ type: 'agent_start' } as never)))
    const first = connection.runPrompt(HELLO, new AbortController().signal)
    await Promise.resolve()
    await expect(connection.runPrompt(HELLO, new AbortController().signal)).rejects.toMatchObject({ code: -32_600 })
    fake.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } } as never)
    fake.emit({ type: 'agent_settled' } as never)
    await expect(first).resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it('resolves cancelled with the usage of the turn it cut short when the prompt signal aborts', async () => {
    const { fake, connection } = await connect(baseSpec((emit) => emit({ type: 'agent_start' } as never)))
    const controller = new AbortController()
    const turn = connection.runPrompt(HELLO, controller.signal)
    await Promise.resolve()
    controller.abort()
    fake.emit({ type: 'agent_settled' } as never)
    await expect(turn).resolves.toEqual({ stopReason: 'cancelled', usage: DEFAULT_TURN_USAGE, acknowledgedMessageId: undefined })
    expect(fake.calls.map((call) => call['type'])).toContain('abort')
  })

  it('resolves cancelled without sending when the signal is already aborted', async () => {
    const { fake, connection } = await connect(baseSpec(fullTurn))
    const controller = new AbortController()
    controller.abort()
    await expect(connection.runPrompt(HELLO, controller.signal)).resolves.toEqual({
      stopReason: 'cancelled',
      usage: undefined,
      acknowledgedMessageId: undefined,
    })
    expect(meteringOrder(fake)).toEqual([])
  })

  it('fails the in-flight turn when the subprocess dies', async () => {
    const { fake, connection } = await connect(baseSpec((emit) => emit({ type: 'agent_start' } as never)))
    const turn = connection.runPrompt(HELLO, new AbortController().signal)
    await Promise.resolve()
    fake.exit(new Error('pi exited: code 2, signal null'))
    await expect(turn).rejects.toThrow(/pi exited: code 2/)
  })

  it('rejects a failed preflight and clears the active turn', async () => {
    const { connection } = await connect({ ...baseSpec(fullTurn), preflightFails: true })
    await expect(connection.runPrompt(HELLO, new AbortController().signal)).rejects.toThrow(/preflight/)
    // The turn was deregistered on the throw: the retry hits the preflight error
    // again, not "a turn is already in progress" (-32600).
    await expect(connection.runPrompt(HELLO, new AbortController().signal)).rejects.toThrow(/preflight/)
  })

  it('rejects once the session is dead', async () => {
    const { connection } = await connect(baseSpec())
    connection.handleExit(new Error('pi exited: code 1'))
    await expect(connection.runPrompt(HELLO, new AbortController().signal)).rejects.toThrow(/pi exited: code 1/)
  })
})

// ── Breakpoint message ids ────────────────────────────────────────────────────

const TEMP_PREFIX = 'pi-acp-prompt-'
const SESSION_FILE_NAME = '2026-01-01T00-00-00-000Z_sess-1.jsonl'
const MESSAGE_ID = 'msg-1'
const SECOND_MESSAGE_ID = 'msg-2'
const userEntry = (id: string, content: string): unknown => ({
  type: 'message',
  id,
  parentId: null,
  message: { role: 'user', content },
})
const assistantEntry = (id: string): unknown => ({
  type: 'message',
  id,
  parentId: null,
  message: { role: 'assistant', content: 'ok' },
})

describe('breakpoint message id recording', () => {
  let store: string
  let sessionFile: string

  beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), TEMP_PREFIX))
    sessionFile = join(store, SESSION_FILE_NAME)
    // Pi has flushed the session by the time a turn settles with assistant output.
    writeFileSync(sessionFile, '')
  })

  afterEach(() => {
    rmSync(store, { recursive: true, force: true })
  })

  function specWithEntries(entries: FakePiSpec['entries'], overrides: Partial<FakePiSpec> = {}): FakePiSpec {
    const spec = baseSpec(fullTurn)
    spec.state.sessionFile = sessionFile
    return { ...spec, ...(entries === undefined ? {} : { entries }), ...overrides }
  }

  function readSidecar(): unknown {
    return JSON.parse(readFileSync(messageMapPathFor(sessionFile), 'utf8'))
  }

  it('records the last user entry of the turn and echoes the message id', async () => {
    const { connection } = await connect(
      specWithEntries([userEntry('u1', 'earlier'), assistantEntry('a1'), userEntry('u2', 'hi')]),
    )

    const outcome = await connection.runPrompt(HELLO, new AbortController().signal, MESSAGE_ID)

    expect(outcome).toEqual({ stopReason: 'end_turn', usage: DEFAULT_TURN_USAGE, acknowledgedMessageId: MESSAGE_ID })
    expect(readSidecar()).toEqual({
      [MESSAGE_MAP_KEY_VERSION]: MESSAGE_MAP_VERSION,
      [MESSAGE_MAP_KEY_MESSAGES]: { [MESSAGE_ID]: 'u2' },
    })
  })

  it('extends the map on a later prompt without re-reading the sidecar', async () => {
    let entries: unknown[] = [userEntry('u1', 'hi')]
    const { connection } = await connect(specWithEntries(() => entries))

    await connection.runPrompt(HELLO, new AbortController().signal, MESSAGE_ID)
    entries = [...entries, assistantEntry('a1'), userEntry('u2', 'again')]
    const second = await connection.runPrompt(HELLO, new AbortController().signal, SECOND_MESSAGE_ID)

    expect(second.acknowledgedMessageId).toBe(SECOND_MESSAGE_ID)
    expect(readSidecar()).toEqual({
      [MESSAGE_MAP_KEY_VERSION]: MESSAGE_MAP_VERSION,
      [MESSAGE_MAP_KEY_MESSAGES]: { [MESSAGE_ID]: 'u1', [SECOND_MESSAGE_ID]: 'u2' },
    })
  })

  it('reads no entries and writes no sidecar for a prompt with no message id', async () => {
    const { fake, connection } = await connect(specWithEntries([userEntry('u1', 'hi')]))

    const outcome = await connection.runPrompt(HELLO, new AbortController().signal)

    expect(outcome.acknowledgedMessageId).toBeUndefined()
    expect(fake.calls.map((call) => call['type'])).not.toContain('get_entries')
    expect(existsSync(messageMapPathFor(sessionFile))).toBe(false)
  })

  it('records nothing for a session Pi persists no file for', async () => {
    const spec = baseSpec(fullTurn)
    const { fake, connection } = await connect({ ...spec, entries: [userEntry('u1', 'hi')] })

    const outcome = await connection.runPrompt(HELLO, new AbortController().signal, MESSAGE_ID)

    expect(outcome).toEqual({ stopReason: 'end_turn', usage: DEFAULT_TURN_USAGE, acknowledgedMessageId: undefined })
    expect(fake.calls.map((call) => call['type'])).not.toContain('get_entries')
  })

  it('records nothing before Pi has written the session file', async () => {
    rmSync(sessionFile)
    const { fake, connection } = await connect(specWithEntries([userEntry('u1', 'hi')]))

    const outcome = await connection.runPrompt(HELLO, new AbortController().signal, MESSAGE_ID)

    expect(outcome).toEqual({ stopReason: 'end_turn', usage: DEFAULT_TURN_USAGE, acknowledgedMessageId: undefined })
    expect(fake.calls.map((call) => call['type'])).not.toContain('get_entries')
    expect(existsSync(messageMapPathFor(sessionFile))).toBe(false)
  })

  it('returns the stop reason without an echo when get_entries fails', async () => {
    const { connection } = await connect(specWithEntries([userEntry('u1', 'hi')], { failOn: 'get_entries' }))

    const outcome = await connection.runPrompt(HELLO, new AbortController().signal, MESSAGE_ID)

    expect(outcome).toEqual({ stopReason: 'end_turn', usage: DEFAULT_TURN_USAGE, acknowledgedMessageId: undefined })
    expect(existsSync(messageMapPathFor(sessionFile))).toBe(false)
  })

  it('returns no echo when the session tree holds no user entry', async () => {
    const { connection } = await connect(specWithEntries([assistantEntry('a1')]))

    const outcome = await connection.runPrompt(HELLO, new AbortController().signal, MESSAGE_ID)

    expect(outcome.acknowledgedMessageId).toBeUndefined()
    expect(existsSync(messageMapPathFor(sessionFile))).toBe(false)
  })
})

const EXT_COMMANDS = [
  { name: 'extcmd', description: 'ext', source: 'extension' },
  { name: 'skill:summarize', source: 'skill' },
  { name: 'review', description: 'Review code', source: 'prompt' },
]
const QUIET_WINDOW_MS = Math.max(EXTENSION_COMMAND_QUIET_MS, AGENT_START_GRACE_MS)
/** Pi's dispatch rule, message by message: leading `/` on the untrimmed text and
 * a name delimited by a literal space, matched against the advertised names. */
const PARSE_TABLE: [message: string, invokesCommand: boolean][] = [
  ['/extcmd', true],
  ['/extcmd args', true],
  ['/extcmd\nargs', false],
  [' /extcmd', false],
  ['/unknown', false],
  ['/skill:summarize', false],
  ['/review', false],
  ['just text', false],
]

describe('extension command prompts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Prompts a Pi that acks and then stays silent, and waits out both windows. */
  async function runQuiet(prompt: FlattenedPrompt, messageId?: string) {
    const { fake, connection } = await connect({ ...baseSpec(), commands: EXT_COMMANDS })
    const settled = connection.runPrompt(prompt, new AbortController().signal, messageId).then(
      (outcome) => ({
        reason: outcome.stopReason as StopReason | undefined,
        usage: outcome.usage,
        acknowledgedMessageId: outcome.acknowledgedMessageId,
        error: undefined as unknown,
      }),
      (error: unknown) => ({ reason: undefined, usage: undefined, acknowledgedMessageId: undefined, error }),
    )
    // Zero first, so the ack resolves and arms the timer before the clock moves.
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS)
    return { ...(await settled), fake }
  }

  const textPrompt = (message: string): FlattenedPrompt => ({ message, images: [], firstText: message })

  it.each(PARSE_TABLE)('reads %j as an advertised extension command: %s', async (message, invokesCommand) => {
    const { reason, error } = await runQuiet(textPrompt(message))
    if (invokesCommand) expect(reason).toBe('end_turn')
    else expect(error).toMatchObject({ code: -32_603, message: expect.stringMatching(/no turn/) })
  })

  it('matches a multi-block prompt whose joined message begins with the command', async () => {
    const prompt = flattenPromptContent([
      { type: 'text', text: '/extcmd go' },
      { type: 'text', text: 'second block' },
    ])
    expect(prompt.message).toBe('/extcmd go\nsecond block')
    const { reason } = await runQuiet(prompt)
    expect(reason).toBe('end_turn')
  })

  it('neither titles nor meters a command prompt that ran no turn', async () => {
    const { reason, usage, fake } = await runQuiet(textPrompt('/extcmd'))
    expect(reason).toBe('end_turn')
    expect(usage).toBeUndefined()
    expect(fake.calls.map((call) => call['type'])).not.toContain('set_session_name')
    // The baseline goes out before Pi says whether a turn runs; nothing is read after.
    expect(meteringOrder(fake)).toEqual(['get_session_stats', 'prompt'])
  })

  it('records no breakpoint for a command prompt that ran no turn', async () => {
    const { reason, acknowledgedMessageId, fake } = await runQuiet(textPrompt('/extcmd'), MESSAGE_ID)
    expect(reason).toBe('end_turn')
    expect(acknowledgedMessageId).toBeUndefined()
    expect(fake.calls.map((call) => call['type'])).not.toContain('get_entries')
  })
})

describe('session/prompt over the wire', () => {
  it("streams a chunk and returns end_turn with the turn's usage", async () => {
    const fake = makeFakePiClient(baseSpec(fullTurn))
    const server = new PiAcpServer({
      launch: LAUNCH,
      rpcTimeoutMs: 1_000,
      sessionDirs: { mode: 'flat', dir: '/tmp/pi-acp-sessions' },
      mcpExtensionPath: MCP_EXTENSION_PATH,
      createPiClient: fake.createPiClient,
    })
    const app = server.register(acp.agent({ name: AGENT_NAME }))

    const chunks: acp.SessionNotification[] = []
    const result = await acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, (context) => {
        chunks.push(context.params)
      })
      .connectWith(app, async (context) => {
        await context.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
        const created = await context.request(acp.methods.agent.session.new, { cwd: ABS_CWD, mcpServers: [] })
        return context.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'hi' }],
        })
      })

    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toEqual(DEFAULT_TURN_USAGE)
    expect(chunks).toContainEqual({
      sessionId: 'sess-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
    })
  })

  it('echoes the breakpoint message id back through the SDK', async () => {
    const store = mkdtempSync(join(tmpdir(), TEMP_PREFIX))
    const spec = baseSpec(fullTurn)
    spec.state.sessionFile = join(store, SESSION_FILE_NAME)
    writeFileSync(spec.state.sessionFile, '')
    const fake = makeFakePiClient({ ...spec, entries: [userEntry('u1', 'hi')] })
    const server = new PiAcpServer({
      launch: LAUNCH,
      rpcTimeoutMs: 1_000,
      sessionDirs: { mode: 'flat', dir: store },
      mcpExtensionPath: MCP_EXTENSION_PATH,
      createPiClient: fake.createPiClient,
    })
    const app = server.register(acp.agent({ name: AGENT_NAME }))

    try {
      const result = await acp.client({ name: 'test-client' }).connectWith(app, async (context) => {
        await context.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
        const created = await context.request(acp.methods.agent.session.new, { cwd: ABS_CWD, mcpServers: [] })
        return context.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'hi' }],
          _meta: { [META_KEY_BREAKPOINT_NAMESPACE]: { [META_KEY_MESSAGE_ID]: MESSAGE_ID } },
        })
      })

      expect(result.stopReason).toBe('end_turn')
      expect(result._meta).toEqual({ [META_KEY_BREAKPOINT_NAMESPACE]: { [META_KEY_MESSAGE_ID]: MESSAGE_ID } })
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })
})
