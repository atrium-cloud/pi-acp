import * as acp from '@agentclientprotocol/sdk/unstable'
import type { AgentContext, SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AGENT_NAME, AGENT_START_GRACE_MS, CURSOR_ID_PREFIX } from '../constants.js'
import { PiAcpServer } from '../server/PiAcpServer.js'
import { establishSession } from '../session/sessionSetup.js'
import type { SessionConnection } from '../session/SessionConnection.js'
import type { FlattenedPrompt } from '../turn/promptContent.js'
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

async function connect(spec: FakePiSpec, clientSupportsCursors = false): Promise<{
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
    clientSupportsCursors,
    mcpExtensionPath: MCP_EXTENSION_PATH,
    hiddenCommands: new Set(),
    logStartupTiming: false,
    createPiClient: fake.createPiClient,
  })
  return { fake, connection: established.connection, notify }
}

const fullTurn = (emit: Emit): void => {
  emit({ type: 'agent_start' } as never)
  emit({ type: 'message_end', message: { role: 'user', content: 'hi' } } as never)
  emit({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' } } as never)
  emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } } as never)
  emit({ type: 'agent_settled', aborted: false } as never)
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
    expect(outcome).toEqual({ stopReason: 'end_turn', usage: undefined })
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
    expect(outcome).toEqual({ stopReason: 'end_turn', usage: undefined })
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
    fake.emit({ type: 'agent_settled', aborted: false } as never)
    await expect(first).resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it('resolves cancelled with the usage of the turn it cut short when the prompt signal aborts', async () => {
    const { fake, connection } = await connect(baseSpec((emit) => emit({ type: 'agent_start' } as never)))
    const controller = new AbortController()
    const turn = connection.runPrompt(HELLO, controller.signal)
    await Promise.resolve()
    controller.abort()
    fake.emit({ type: 'agent_settled', aborted: false } as never)
    await expect(turn).resolves.toEqual({ stopReason: 'cancelled', usage: DEFAULT_TURN_USAGE })
    expect(fake.calls.map((call) => call['type'])).toContain('abort')
  })

  it('resolves cancelled without sending when the signal is already aborted', async () => {
    const { fake, connection } = await connect(baseSpec(fullTurn))
    const controller = new AbortController()
    controller.abort()
    await expect(connection.runPrompt(HELLO, controller.signal)).resolves.toEqual({ stopReason: 'cancelled', usage: undefined })
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

// ── Prompt cursors ────────────────────────────────────────────────────────────

const SESSION_FILE = '/tmp/pi-acp-sessions/2026-01-01T00-00-00-000Z_sess-1.jsonl'
const userEntry = (id: string, parentId: string | null): unknown => ({
  type: 'message',
  id,
  parentId,
  message: { role: 'user', content: 'hi' },
})
const assistantEntry = (id: string, parentId: string): unknown => ({
  type: 'message',
  id,
  parentId,
  message: { role: 'assistant', content: 'Hello' },
})
const FIRST_TURN_ENTRIES = [userEntry('u1', null), assistantEntry('a1', 'u1')]
const SECOND_TURN_ENTRIES = [...FIRST_TURN_ENTRIES, userEntry('u2', 'a1'), assistantEntry('a2', 'u2')]

/** A reply with two anchorable messages: a thought, then the text after it. */
const thinkingTurn = (emit: Emit): void => {
  emit({ type: 'agent_start' } as never)
  emit({ type: 'message_end', message: { role: 'user', content: 'hi' } } as never)
  emit({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Hmm' } } as never)
  emit({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Hello' } } as never)
  emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } } as never)
  emit({ type: 'agent_settled', aborted: false } as never)
}

const withoutUserMessage = (emit: Emit): void => {
  emit({ type: 'agent_start' } as never)
  emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } } as never)
  emit({ type: 'agent_settled', aborted: false } as never)
}

function sentUpdates(notify: ReturnType<typeof vi.fn>): SessionUpdate[] {
  const calls = notify.mock.calls as [string, acp.SessionNotification][]
  return calls.filter(([method]) => method === acp.methods.client.session.update).map(([, params]) => params.update)
}

function cursorUpdates(notify: ReturnType<typeof vi.fn>): SessionUpdate[] {
  return sentUpdates(notify).filter((update) => update.sessionUpdate === 'cursor_update')
}

describe('prompt cursors', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Two prompts on a persisted session; Pi's tree grows by one exchange between them. */
  async function runTwoPrompts(options: {
    clientSupportsCursors: boolean
    secondTurn?: (emit: Emit) => void
    thirdTurn?: (emit: Emit) => void
    failOn?: string
  }) {
    let entries: readonly unknown[] = FIRST_TURN_ENTRIES
    const turns = [thinkingTurn, options.secondTurn ?? fullTurn, options.thirdTurn ?? fullTurn]
    let prompts = 0
    const spec = baseSpec((emit) => turns[prompts++]?.(emit))
    spec.state.sessionFile = SESSION_FILE
    const session = await connect(
      { ...spec, entries: () => entries, ...(options.failOn === undefined ? {} : { failOn: options.failOn }) },
      options.clientSupportsCursors,
    )
    await session.connection.runPrompt(HELLO, new AbortController().signal)
    const afterFirst = sentUpdates(session.notify)
    entries = SECOND_TURN_ENTRIES
    const second = await session.connection.runPrompt(HELLO, new AbortController().signal)
    return { ...session, afterFirst, second }
  }

  it("announces no cursor for the first prompt and one after its reply's last message for the second", async () => {
    const { notify, afterFirst } = await runTwoPrompts({ clientSupportsCursors: true })

    const firstReply = afterFirst.find((update) => update.sessionUpdate === 'agent_message_chunk')
    expect(firstReply).toMatchObject({ messageId: expect.any(String) })
    expect(afterFirst.filter((update) => update.sessionUpdate === 'cursor_update')).toEqual([])
    expect(cursorUpdates(notify)).toEqual([
      {
        sessionUpdate: 'cursor_update',
        cursorId: `${CURSOR_ID_PREFIX}u2`,
        capabilities: { fork: {} },
        anchor: { type: 'agent_message', messageId: (firstReply as { messageId: string }).messageId, position: 'after' },
      },
    ])
  })

  it('sends no message ids or cursors and reads no entries for a client without cursors', async () => {
    const { fake, notify } = await runTwoPrompts({ clientSupportsCursors: false })

    expect(cursorUpdates(notify)).toEqual([])
    expect(sentUpdates(notify).filter((update) => 'messageId' in update)).toEqual([])
    expect(fake.calls.map((call) => call['type'])).not.toContain('get_entries')
  })

  it('announces no cursor for a prompt cancelled before Pi reported its user message', async () => {
    const { fake, notify, second } = await runTwoPrompts({ clientSupportsCursors: true, secondTurn: withoutUserMessage })

    expect(second.stopReason).toBe('cancelled')
    expect(cursorUpdates(notify)).toEqual([])
    expect(fake.calls.map((call) => call['type'])).not.toContain('get_entries')
  })

  it('withholds the cursor of a prompt that follows one cancelled before any output', async () => {
    const outputlessTurn = (emit: Emit): void => {
      emit({ type: 'agent_start' } as never)
      emit({ type: 'message_end', message: { role: 'user', content: 'hi' } } as never)
      emit({ type: 'agent_settled', aborted: true } as never)
    }
    const { connection, notify, afterFirst, second } = await runTwoPrompts({
      clientSupportsCursors: true,
      secondTurn: outputlessTurn,
      thirdTurn: fullTurn,
    })
    expect(second.stopReason).toBe('cancelled')

    await connection.runPrompt(HELLO, new AbortController().signal)

    // The third prompt lies after the unseen second, not after the first reply.
    const firstReply = afterFirst.find((update) => update.sessionUpdate === 'agent_message_chunk')
    expect(cursorUpdates(notify)).toEqual([
      {
        sessionUpdate: 'cursor_update',
        cursorId: `${CURSOR_ID_PREFIX}u2`,
        capabilities: { fork: {} },
        anchor: { type: 'agent_message', messageId: (firstReply as { messageId: string }).messageId, position: 'after' },
      },
    ])
  })

  it('resolves the turn without a cursor when get_entries fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { notify, second } = await runTwoPrompts({ clientSupportsCursors: true, failOn: 'get_entries' })

    expect(second).toEqual({ stopReason: 'end_turn', usage: DEFAULT_TURN_USAGE })
    expect(cursorUpdates(notify)).toEqual([])
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(String(errorLog.mock.calls[0]?.[0])).toMatch(/failed to announce the prompt's cursor: fake pi: get_entries failed/)
  })
})

const COMMAND_PROMPT: FlattenedPrompt = { message: '/extcmd', images: [], firstText: '/extcmd' }

describe('prompt dispositions', () => {
  it('resolves end_turn at once for a prompt Pi handled, with no title or usage', async () => {
    const { fake, connection } = await connect({ ...baseSpec(), promptDisposition: 'handled' })

    const outcome = await connection.runPrompt(COMMAND_PROMPT, new AbortController().signal)

    expect(outcome).toEqual({ stopReason: 'end_turn', usage: undefined })
    expect(fake.calls.map((call) => call['type'])).not.toContain('set_session_name')
    // The baseline goes out before Pi says whether a run starts; nothing is read after.
    expect(meteringOrder(fake)).toEqual(['get_session_stats', 'prompt'])
  })

  it('resolves cancelled for a handled prompt cancelled while its ack was in flight', async () => {
    const controller = new AbortController()
    const { fake, connection } = await connect({
      ...baseSpec(() => controller.abort()),
      promptDisposition: 'handled',
    })

    const outcome = await connection.runPrompt(COMMAND_PROMPT, controller.signal)

    expect(outcome).toEqual({ stopReason: 'cancelled', usage: undefined })
    expect(fake.calls.map((call) => call['type'])).toContain('abort')
  })

  it('rejects a prompt Pi queued with an internal error and frees the session', async () => {
    const { connection } = await connect({ ...baseSpec(), promptDisposition: 'queued' })
    const queued = { code: -32_603, message: expect.stringMatching(/queued/) }
    await expect(connection.runPrompt(HELLO, new AbortController().signal)).rejects.toMatchObject(queued)
    // Not "a turn is already in progress" (-32600): the failed turn was released.
    await expect(connection.runPrompt(HELLO, new AbortController().signal)).rejects.toMatchObject(queued)
  })

  describe('with a started prompt that stays silent', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('fails it with a protocol error once the grace window passes', async () => {
      const { connection } = await connect(baseSpec())
      const settled = connection.runPrompt(HELLO, new AbortController().signal).then(
        () => undefined,
        (error: unknown) => error,
      )
      // Zero first, so the ack resolves and arms the timer before the clock moves.
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS)
      expect(await settled).toMatchObject({ code: -32_603, message: expect.stringMatching(/no turn/) })
    })
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
      hiddenCommands: new Set(),
      logStartupTiming: false,
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

    expect(result).toEqual({ stopReason: 'end_turn', usage: DEFAULT_TURN_USAGE })
    expect(chunks).toContainEqual({
      sessionId: 'sess-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
    })
  })
})
