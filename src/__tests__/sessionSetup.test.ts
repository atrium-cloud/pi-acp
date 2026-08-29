import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import { AGENT_NAME, CONFIG_ID_MODEL, CONFIG_ID_THOUGHT_LEVEL, PI_SESSION_ARG } from '../constants.js'
import { PiAcpServer } from '../server/PiAcpServer.js'
import type { SessionDirs } from '../session/sessionDirectory.js'
import { establishSession } from '../session/sessionSetup.js'
import { type FakePiSpec, makeFakePiClient } from './fixtures/fakePiClient.js'

const LAUNCH = { command: 'pi', args: ['--mode', 'rpc'], source: 'test' }

function makeSpec(): FakePiSpec {
  return {
    state: { sessionId: 'sess-1', thinkingLevel: 'low', model: { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' } },
    models: [
      { provider: 'openrouter', id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' },
      { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
    ],
    levels: ['off', 'low', 'high'],
    commands: [
      { name: 'review', description: 'Review code', source: 'prompt' },
      { name: 'skill:summarize', source: 'skill' },
      { name: 'extcmd', description: 'ext', source: 'extension' },
      // Two extensions registering one name; Pi dispatches on the disambiguated form.
      { name: 'review:1', description: 'first', source: 'extension' },
      { name: 'review:2', source: 'extension' },
    ],
  }
}

const EXPECTED_OPTIONS = [
  {
    type: 'select',
    id: CONFIG_ID_MODEL,
    name: 'Model',
    category: CONFIG_ID_MODEL,
    currentValue: 'anthropic/claude-sonnet-5',
    options: [
      { value: 'openrouter/deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' },
      { value: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' },
    ],
  },
  {
    type: 'select',
    id: CONFIG_ID_THOUGHT_LEVEL,
    name: 'Thinking level',
    category: CONFIG_ID_THOUGHT_LEVEL,
    currentValue: 'low',
    options: [
      { value: 'off', name: 'off' },
      { value: 'low', name: 'low' },
      { value: 'high', name: 'high' },
    ],
  },
]

const EXPECTED_COMMANDS = [
  { name: 'review', description: 'Review code' },
  { name: 'skill:summarize', description: '' },
  { name: 'extcmd', description: 'ext' },
  { name: 'review:1', description: 'first' },
  { name: 'review:2', description: '' },
]

const stubNotifier = { notify: vi.fn(async () => {}) } as unknown as AgentContext

function makeDeps(fake: ReturnType<typeof makeFakePiClient>) {
  return { launch: LAUNCH, rpcTimeoutMs: 1_000, notifier: stubNotifier, createPiClient: fake.createPiClient }
}

const ABS_CWD = '/tmp/pi-acp-session'
const SESSION_DIRS: SessionDirs = { mode: 'flat', dir: '/tmp/pi-acp-sessions' }
const SESSION_FILE = '/tmp/pi-acp-sessions/2026-01-01T00-00-00-000Z_sess-1.jsonl'
const GATE_PATH = '/tmp/gate.ts'

describe('establishSession', () => {
  it('spawns, reads state, and builds config options + every advertised command', async () => {
    const fake = makeFakePiClient(makeSpec())
    const established = await establishSession(
      { cwd: ABS_CWD, mcpServers: [] },
      makeDeps(fake),
    )
    expect(established.sessionId).toBe('sess-1')
    expect(established.configOptions).toEqual(EXPECTED_OPTIONS)
    // Extension commands are advertised too; a missing description becomes empty.
    expect(established.availableCommands).toEqual(EXPECTED_COMMANDS)
    // Pi's snapshot carries no argument hint, so no command gets an `input`.
    expect(established.availableCommands.some((command) => 'input' in command)).toBe(false)
  })

  it('threads the extension invocation names through verbatim', async () => {
    const fake = makeFakePiClient(makeSpec())
    const established = await establishSession({ cwd: ABS_CWD, mcpServers: [] }, makeDeps(fake))
    expect(established.extensionCommandNames).toEqual(['extcmd', 'review:1', 'review:2'])
  })

  it('rejects a relative cwd with invalid params', async () => {
    const fake = makeFakePiClient(makeSpec())
    await expect(establishSession({ cwd: 'relative/path', mcpServers: [] }, makeDeps(fake))).rejects.toMatchObject({
      code: -32_602,
    })
  })

  it('rejects mcpServers and additionalDirectories', async () => {
    const fake = makeFakePiClient(makeSpec())
    await expect(
      establishSession({ cwd: ABS_CWD, mcpServers: [{ name: 'x', command: 'y', args: [], env: [] }] }, makeDeps(fake)),
    ).rejects.toThrow(/mcpServers/)
    await expect(
      establishSession({ cwd: ABS_CWD, mcpServers: [], additionalDirectories: ['/other'] }, makeDeps(fake)),
    ).rejects.toThrow(/additionalDirectories/)
  })

  it('stops the subprocess when a post-start fetch fails (no orphan)', async () => {
    const fake = makeFakePiClient({ ...makeSpec(), failOn: 'get_commands' })
    await expect(establishSession({ cwd: ABS_CWD, mcpServers: [] }, makeDeps(fake))).rejects.toThrow(
      /get_commands/,
    )
    expect(fake.wasStopped()).toBe(true)
  })

  it('opens a stored session with --session after the gate args', async () => {
    const fake = makeFakePiClient(makeSpec())
    const established = await establishSession(
      { cwd: ABS_CWD, mcpServers: [] },
      { ...makeDeps(fake), gateExtensionPath: GATE_PATH },
      { kind: 'open', sessionFile: SESSION_FILE, expectedSessionId: 'sess-1' },
    )
    expect(established.sessionId).toBe('sess-1')
    expect(fake.spawns).toEqual([{ cwd: ABS_CWD, args: ['-e', GATE_PATH, PI_SESSION_ARG, SESSION_FILE] }])
  })

  it('stops the subprocess when Pi reports a different session id than the file holds', async () => {
    const fake = makeFakePiClient(makeSpec())
    await expect(
      establishSession({ cwd: ABS_CWD, mcpServers: [] }, makeDeps(fake), {
        kind: 'open',
        sessionFile: SESSION_FILE,
        expectedSessionId: 'sess-other',
      }),
    ).rejects.toMatchObject({ code: -32_603, message: expect.stringContaining('sess-other') })
    expect(fake.wasStopped()).toBe(true)
    // Fail-fast: the metadata fetches never ran against the wrong session.
    expect(fake.calls.map((call) => call['type'])).not.toContain('get_commands')
  })

  it('translates a name change to session_info_update and a level change to config_option_update', async () => {
    const fake = makeFakePiClient(makeSpec())
    const established = await establishSession({ cwd: ABS_CWD, mcpServers: [] }, makeDeps(fake))
    const notify = vi.mocked(stubNotifier.notify)
    notify.mockClear()
    established.connection.routeEvent({ type: 'session_info_changed', name: 'renamed' } as never)
    expect(notify).toHaveBeenCalledWith(acp.methods.client.session.update, {
      sessionId: 'sess-1',
      update: { sessionUpdate: 'session_info_update', title: 'renamed' },
    })
    notify.mockClear()
    established.connection.routeEvent({ type: 'thinking_level_changed', level: 'high' } as never)
    expect(notify).toHaveBeenCalledWith(acp.methods.client.session.update, {
      sessionId: 'sess-1',
      update: expect.objectContaining({
        sessionUpdate: 'config_option_update',
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: CONFIG_ID_THOUGHT_LEVEL, currentValue: 'high' }),
        ]),
      }),
    })
  })

  it('ignores entry_appended and a turn-scoped event with no active turn', async () => {
    const fake = makeFakePiClient(makeSpec())
    const established = await establishSession({ cwd: ABS_CWD, mcpServers: [] }, makeDeps(fake))
    const notify = vi.mocked(stubNotifier.notify)
    notify.mockClear()
    established.connection.routeEvent({ type: 'entry_appended' } as never)
    established.connection.routeEvent({ type: 'agent_start' } as never)
    expect(notify).not.toHaveBeenCalled()
  })

  it('logs and drops an unrecognized event rather than throwing (it runs in the stdout handler)', async () => {
    const fake = makeFakePiClient(makeSpec())
    const established = await establishSession({ cwd: ABS_CWD, mcpServers: [] }, makeDeps(fake))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => established.connection.routeEvent({ type: 'brand_new_pi_event' } as never)).not.toThrow()
    expect(errorSpy).toHaveBeenCalledOnce()
    errorSpy.mockRestore()
  })
})

describe('session/new over the wire', () => {
  it('delivers available_commands_update after the response so the SDK client routes it', async () => {
    const fake = makeFakePiClient(makeSpec())
    const server = new PiAcpServer({
      launch: LAUNCH,
      rpcTimeoutMs: 1_000,
      sessionDirs: SESSION_DIRS,
      createPiClient: fake.createPiClient,
    })
    const app = server.register(acp.agent({ name: AGENT_NAME }))

    const message = await acp
      .client({ name: 'test-client' })
      .connectWith(app, async (context) => {
        const session = await context.buildSession(ABS_CWD).start()
        return session.nextUpdate()
      })

    expect(message).toMatchObject({
      kind: 'session_update',
      update: { sessionUpdate: 'available_commands_update', availableCommands: EXPECTED_COMMANDS },
    })
  })
})
