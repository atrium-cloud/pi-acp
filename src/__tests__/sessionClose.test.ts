import type { AgentContext } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { CreatePiClient, PiClientLike, SessionConnection } from '../session/SessionConnection.js'
import { establishSession } from '../session/sessionSetup.js'
import type { FlattenedPrompt } from '../turn/promptContent.js'
import { type FakePiSpec, makeFakePiClient } from './fixtures/fakePiClient.js'

const LAUNCH = { command: 'pi', args: ['--mode', 'rpc'], source: 'test' }
const ABS_CWD = '/tmp/pi-acp-session'
const HELLO: FlattenedPrompt = { message: 'hi', images: [], firstText: 'hi' }
const MODELS = [{ provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }]
const LEVELS = ['low']
const STATE = { sessionId: 'sess-1', thinkingLevel: 'low', model: MODELS[0] }

function baseSpec(onPrompt?: FakePiSpec['onPrompt']): FakePiSpec {
  return {
    state: { ...STATE },
    models: MODELS,
    levels: LEVELS,
    commands: [],
    ...(onPrompt ? { onPrompt } : {}),
  }
}

/** Records every command and the teardown on one timeline, so "abort reached Pi
 * before its stdin was closed" is an assertion rather than an inference. */
function withTimeline(createPiClient: CreatePiClient): { createPiClient: CreatePiClient; timeline: string[] } {
  const timeline: string[] = []
  const wrapped: CreatePiClient = (options) => {
    const client = createPiClient(options)
    return {
      start: () => client.start(),
      request: ((command: { type: string }, requestOptions?: { timeoutMs?: number }) => {
        timeline.push(command.type)
        return (client.request as (c: unknown, o?: unknown) => Promise<unknown>)(command, requestOptions)
      }) as unknown as PiClientLike['request'],
      stop: async () => {
        timeline.push('stop')
        await client.stop()
      },
    }
  }
  return { createPiClient: wrapped, timeline }
}

/** A client whose `prompt` ack never lands on its own, standing in for a real
 * preflight that outlives the close; `stop()` rejects it the way the transport
 * rejects everything still pending. */
function makeHangingAckClient(): CreatePiClient {
  const pendingAck: { reject: ((error: Error) => void) | null } = { reject: null }
  const respond = async (command: { type: string }): Promise<unknown> => {
    switch (command.type) {
      case 'get_state':
        return { type: 'response', command: 'get_state', success: true, data: STATE }
      case 'get_available_models':
        return { type: 'response', command: 'get_available_models', success: true, data: { models: MODELS } }
      case 'get_available_thinking_levels':
        return { type: 'response', command: 'get_available_thinking_levels', success: true, data: { levels: LEVELS } }
      case 'get_commands':
        return { type: 'response', command: 'get_commands', success: true, data: { commands: [] } }
      case 'abort':
        return { type: 'response', command: 'abort', success: true }
      case 'prompt':
        return new Promise((_resolve, reject) => {
          pendingAck.reject = reject
        })
      default:
        throw new Error(`hanging fake pi: unexpected command ${command.type}`)
    }
  }
  const client: PiClientLike = {
    start: (async () => STATE) as unknown as PiClientLike['start'],
    request: respond as unknown as PiClientLike['request'],
    stop: async () => {
      pendingAck.reject?.(new Error('the client was stopped before the command completed'))
    },
  }
  return () => client
}

async function connect(createPiClient: CreatePiClient): Promise<{
  connection: SessionConnection
  notify: ReturnType<typeof vi.fn>
}> {
  const notify = vi.fn(async () => {})
  const established = await establishSession({ cwd: ABS_CWD, mcpServers: [] }, {
    launch: LAUNCH,
    rpcTimeoutMs: 1_000,
    notifier: { notify } as unknown as AgentContext,
    createPiClient,
  })
  return { connection: established.connection, notify }
}

const startOnly: FakePiSpec['onPrompt'] = (emit) => emit({ type: 'agent_start' } as never)

describe('SessionConnection.close', () => {
  it('resolves a pending prompt as cancelled and aborts before stopping', async () => {
    const fake = makeFakePiClient(baseSpec(startOnly))
    const { createPiClient, timeline } = withTimeline(fake.createPiClient)
    const { connection } = await connect(createPiClient)

    const turn = connection.runPrompt(HELLO, new AbortController().signal)
    await Promise.resolve()
    await connection.close()

    await expect(turn).resolves.toBe('cancelled')
    expect(timeline.indexOf('abort')).toBeGreaterThan(-1)
    expect(timeline.indexOf('abort')).toBeLessThan(timeline.indexOf('stop'))
    // A cancelled turn on a stopping subprocess has nothing left to name or meter.
    expect(timeline).not.toContain('set_session_name')
    expect(timeline).not.toContain('get_session_stats')
  })

  it('cancels a turn whose prompt ack is still in flight', async () => {
    const { connection } = await connect(makeHangingAckClient())
    const turn = connection.runPrompt(HELLO, new AbortController().signal)
    await Promise.resolve()
    await connection.close()
    await expect(turn).resolves.toBe('cancelled')
  })

  it('stops without aborting when no turn is running', async () => {
    const fake = makeFakePiClient(baseSpec())
    const { createPiClient, timeline } = withTimeline(fake.createPiClient)
    const { connection } = await connect(createPiClient)

    await connection.close()

    expect(fake.wasStopped()).toBe(true)
    expect(timeline).not.toContain('abort')
    expect(timeline.at(-1)).toBe('stop')
  })

  it('rejects a prompt issued after close', async () => {
    const { connection } = await connect(makeFakePiClient(baseSpec()).createPiClient)
    await connection.close()
    await expect(connection.runPrompt(HELLO, new AbortController().signal)).rejects.toMatchObject({
      code: -32_600,
      message: 'the session is closing',
    })
  })

  it('rejects a config change after close', async () => {
    const { connection } = await connect(makeFakePiClient(baseSpec()).createPiClient)
    await connection.close()
    await expect(connection.applyConfigOption('thought_level', 'low')).rejects.toMatchObject({
      code: -32_600,
      message: 'the session is closing',
    })
  })

  it('sends no session update after close', async () => {
    const { connection, notify } = await connect(makeFakePiClient(baseSpec()).createPiClient)
    await connection.close()
    connection.announceCommands([{ name: 'plan', description: '' }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('SessionConnection.stop', () => {
  it('fails an in-flight turn on connection-close teardown', async () => {
    const fake = makeFakePiClient(baseSpec(startOnly))
    const { connection } = await connect(fake.createPiClient)
    const turn = connection.runPrompt(HELLO, new AbortController().signal)
    await Promise.resolve()
    await connection.stop()
    await expect(turn).rejects.toThrow(/closed while a turn was in progress/)
    expect(fake.wasStopped()).toBe(true)
  })
})
