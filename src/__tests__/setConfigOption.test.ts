import type { AgentContext, NewSessionRequest } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import { CONFIG_ID_MODEL, CONFIG_ID_THOUGHT_LEVEL } from '../constants.js'
import { PiAcpServer } from '../server/PiAcpServer.js'
import { establishSession } from '../session/sessionSetup.js'
import { type FakePiSpec, makeFakePiClient } from './fixtures/fakePiClient.js'

const LAUNCH = { command: 'pi', args: ['--mode', 'rpc'], source: 'test' }
const ABS_CWD = '/tmp/pi-acp-session'
const DEEPSEEK_VALUE = 'openrouter/deepseek/deepseek-v4-flash-0731'
const stubNotifier = { notify: vi.fn(async () => {}) } as unknown as AgentContext

function makeSpec(): FakePiSpec {
  return {
    state: { sessionId: 'sess-1', thinkingLevel: 'low', model: { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' } },
    models: [
      { provider: 'openrouter', id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' },
      { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
    ],
    levels: ['off', 'low', 'high'],
    commands: [],
  }
}

async function connectionFor(spec: FakePiSpec) {
  const fake = makeFakePiClient(spec)
  const established = await establishSession({ cwd: ABS_CWD, mcpServers: [] }, {
    launch: LAUNCH,
    rpcTimeoutMs: 1_000,
    notifier: stubNotifier,
    createPiClient: () => fake.client,
  })
  return { fake, connection: established.connection }
}

describe('SessionConnection.applyConfigOption', () => {
  it('applies a model switch and returns the full set with the new current model', async () => {
    const { fake, connection } = await connectionFor(makeSpec())
    const options = await connection.applyConfigOption(CONFIG_ID_MODEL, DEEPSEEK_VALUE)

    expect(fake.calls).toContainEqual({ type: 'set_model', provider: 'openrouter', modelId: 'deepseek/deepseek-v4-flash-0731' })
    const modelOption = options.find((option) => option.id === CONFIG_ID_MODEL)
    expect(modelOption).toMatchObject({ currentValue: DEEPSEEK_VALUE })
  })

  it('applies a thinking-level switch', async () => {
    const { fake, connection } = await connectionFor(makeSpec())
    const options = await connection.applyConfigOption(CONFIG_ID_THOUGHT_LEVEL, 'high')

    expect(fake.calls).toContainEqual({ type: 'set_thinking_level', level: 'high' })
    const levelOption = options.find((option) => option.id === CONFIG_ID_THOUGHT_LEVEL)
    expect(levelOption).toMatchObject({ currentValue: 'high' })
  })

  it('rejects an unknown config id or an out-of-set value', async () => {
    const { connection } = await connectionFor(makeSpec())
    await expect(connection.applyConfigOption('nonsense', 'x')).rejects.toMatchObject({ code: -32_602 })
    await expect(connection.applyConfigOption(CONFIG_ID_MODEL, 'ghost/model')).rejects.toMatchObject({ code: -32_602 })
    await expect(connection.applyConfigOption(CONFIG_ID_THOUGHT_LEVEL, 'ludicrous')).rejects.toMatchObject({ code: -32_602 })
  })

  it('answers with the subprocess exit cause once the session is dead', async () => {
    const { connection } = await connectionFor(makeSpec())
    connection.handleExit(new Error('pi exited: code 1'))
    await expect(connection.applyConfigOption(CONFIG_ID_THOUGHT_LEVEL, 'high')).rejects.toThrow(/pi exited: code 1/)
  })

  it('re-reads a stale cache after a set whose follow-up read failed', async () => {
    // set_thinking_level applies, then the first get_state rejects; the retry
    // must re-read fresh state before applying, not trust the stale cache.
    const { connection } = await connectionFor({ ...makeSpec(), failOnce: 'get_state' })
    await expect(connection.applyConfigOption(CONFIG_ID_THOUGHT_LEVEL, 'high')).rejects.toThrow(/get_state/)
    const options = await connection.applyConfigOption(CONFIG_ID_THOUGHT_LEVEL, 'high')
    expect(options.find((option) => option.id === CONFIG_ID_THOUGHT_LEVEL)).toMatchObject({ currentValue: 'high' })
  })
})

describe('PiAcpServer.setConfigOption', () => {
  function makeServer(spec: FakePiSpec): PiAcpServer {
    const fake = makeFakePiClient(spec)
    return new PiAcpServer({
      launch: LAUNCH,
      rpcTimeoutMs: 1_000,
      createPiClient: () => fake.client,
    })
  }

  const NEW_SESSION: { params: NewSessionRequest; client: AgentContext } = {
    params: { cwd: ABS_CWD, mcpServers: [] },
    client: stubNotifier,
  }

  it('rejects an unknown session', async () => {
    const server = makeServer(makeSpec())
    await expect(
      server.setConfigOption({ params: { sessionId: 'ghost', configId: CONFIG_ID_MODEL, value: DEEPSEEK_VALUE } }),
    ).rejects.toMatchObject({ code: -32_602 })
  })

  it('rejects a boolean config request (none are offered)', async () => {
    const server = makeServer(makeSpec())
    await server.newSession(NEW_SESSION)
    await expect(
      server.setConfigOption({ params: { sessionId: 'sess-1', configId: CONFIG_ID_MODEL, type: 'boolean', value: true } }),
    ).rejects.toMatchObject({ code: -32_602 })
  })

  it('delegates a valid change and returns the full option set', async () => {
    const server = makeServer(makeSpec())
    await server.newSession(NEW_SESSION)
    const response = await server.setConfigOption({
      params: { sessionId: 'sess-1', configId: CONFIG_ID_THOUGHT_LEVEL, value: 'high' },
    })
    expect(response.configOptions.find((option) => option.id === CONFIG_ID_THOUGHT_LEVEL)).toMatchObject({
      currentValue: 'high',
    })
  })
})
