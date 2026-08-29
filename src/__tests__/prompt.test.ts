import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import { AGENT_NAME } from '../constants.js'
import { PiAcpServer } from '../server/PiAcpServer.js'
import { establishSession } from '../session/sessionSetup.js'
import type { SessionConnection } from '../session/SessionConnection.js'
import type { FlattenedPrompt } from '../turn/promptContent.js'
import { type FakePiSpec, makeFakePiClient } from './fixtures/fakePiClient.js'

const LAUNCH = { command: 'pi', args: ['--mode', 'rpc'], source: 'test' }
const ABS_CWD = '/tmp/pi-acp-session'
const HELLO: FlattenedPrompt = { message: 'hi', images: [] }
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

describe('SessionConnection.runPrompt', () => {
  it('registers the turn before sending, so a synchronous agent_start is not missed', async () => {
    const { connection, notify } = await connect(baseSpec(fullTurn))
    const stopReason = await connection.runPrompt(HELLO, new AbortController().signal)
    expect(stopReason).toBe('end_turn')
    expect(notify).toHaveBeenCalledWith(acp.methods.client.session.update, {
      sessionId: 'sess-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
    })
  })

  it('refuses a second concurrent turn', async () => {
    const { fake, connection } = await connect(baseSpec((emit) => emit({ type: 'agent_start' } as never)))
    const first = connection.runPrompt(HELLO, new AbortController().signal)
    await Promise.resolve()
    await expect(connection.runPrompt(HELLO, new AbortController().signal)).rejects.toMatchObject({ code: -32_600 })
    fake.emit({ type: 'agent_settled' } as never)
    await expect(first).resolves.toBe('end_turn')
  })

  it('resolves cancelled when the prompt signal aborts', async () => {
    const { fake, connection } = await connect(baseSpec((emit) => emit({ type: 'agent_start' } as never)))
    const controller = new AbortController()
    const turn = connection.runPrompt(HELLO, controller.signal)
    await Promise.resolve()
    controller.abort()
    fake.emit({ type: 'agent_settled' } as never)
    await expect(turn).resolves.toBe('cancelled')
    expect(fake.calls.map((call) => call['type'])).toContain('abort')
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

describe('session/prompt over the wire', () => {
  it('streams a chunk and returns end_turn', async () => {
    const fake = makeFakePiClient(baseSpec(fullTurn))
    const server = new PiAcpServer({
      launch: LAUNCH,
      rpcTimeoutMs: 1_000,
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
    expect(chunks).toContainEqual({
      sessionId: 'sess-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
    })
  })
})
