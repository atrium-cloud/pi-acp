import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext, AvailableCommand, McpServer } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_NAME,
  BUILTIN_COMMANDS,
  CONFIG_ID_MODEL,
  CONFIG_ID_THOUGHT_LEVEL,
  ENV_MCP_SERVERS,
  extensionNotifyLogLine,
  JSONRPC_INVALID_PARAMS,
  PI_SESSION_ARG,
} from '../constants.js'
import { PiAcpServer } from '../server/PiAcpServer.js'
import type { SessionDirs } from '../session/sessionDirectory.js'
import { establishSession, parseArgumentHint } from '../session/sessionSetup.js'
import {
  type FakeCommand,
  type FakePiSpec,
  makeFakePiClient,
  REVIEW_TEMPLATE_PATH,
  UNREAD_SOURCE_INFO,
} from './fixtures/fakePiClient.js'

const LAUNCH = { command: 'pi', args: ['--mode', 'rpc'], source: 'test' }
const TEMPLATE_DIR_PREFIX = 'pi-acp-templates-'
const TEMPLATE_FILE_NAME = 'review.md'
const MISSING_FILE_NAME = 'missing.md'
const HINTED_TEMPLATE = '---\ndescription: Review code\nargument-hint: "[focus]"\n---\nReview $1\n'
const BOM = String.fromCodePoint(0xfe_ff)

function makeSpec(): FakePiSpec {
  return {
    state: { sessionId: 'sess-1', thinkingLevel: 'low', model: { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' } },
    models: [
      { provider: 'openrouter', id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' },
      { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
    ],
    levels: ['off', 'low', 'high'],
    commands: [
      { name: 'review', description: 'Review code', source: 'prompt', sourceInfo: { path: REVIEW_TEMPLATE_PATH } },
      { name: 'skill:summarize', source: 'skill', sourceInfo: UNREAD_SOURCE_INFO },
      { name: 'extcmd', description: 'ext', source: 'extension', sourceInfo: UNREAD_SOURCE_INFO },
      // Two extensions registering one name; Pi dispatches on the disambiguated form.
      { name: 'review:1', description: 'first', source: 'extension', sourceInfo: UNREAD_SOURCE_INFO },
      { name: 'review:2', source: 'extension', sourceInfo: UNREAD_SOURCE_INFO },
    ],
  }
}

const EXPECTED_OPTIONS = [
  {
    type: 'select',
    id: CONFIG_ID_MODEL,
    name: 'Model',
    category: CONFIG_ID_MODEL,
    currentValue: 'claude-sonnet-5',
    options: [
      {
        group: 'openrouter',
        name: 'openrouter',
        options: [{ value: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' }],
      },
      {
        group: 'anthropic',
        name: 'anthropic',
        options: [{ value: 'claude-sonnet-5', name: 'Claude Sonnet 5' }],
      },
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
  ...BUILTIN_COMMANDS,
  { name: 'review', description: 'Review code' },
  { name: 'skill:summarize', description: '' },
  { name: 'extcmd', description: 'ext' },
  { name: 'review:1', description: 'first' },
  { name: 'review:2', description: '' },
]

const stubNotifier = { notify: vi.fn(async () => {}) } as unknown as AgentContext

function makeDeps(fake: ReturnType<typeof makeFakePiClient>) {
  return {
    launch: LAUNCH,
    rpcTimeoutMs: 1_000,
    notifier: stubNotifier,
    clientSupportsNotices: false,
    mcpExtensionPath: MCP_EXTENSION_PATH,
    hiddenCommands: new Set<string>(),
    createPiClient: fake.createPiClient,
  }
}

const ABS_CWD = '/tmp/pi-acp-session'
const SESSION_DIRS: SessionDirs = { mode: 'flat', dir: '/tmp/pi-acp-sessions' }
const SESSION_FILE = '/tmp/pi-acp-sessions/2026-01-01T00-00-00-000Z_sess-1.jsonl'
const GATE_PATH = '/tmp/gate.ts'
const MCP_EXTENSION_PATH = '/tmp/mcp-extension.mjs'
const STDIO_SERVER: McpServer = {
  name: 'probe',
  command: '/usr/bin/probe',
  args: ['--serve'],
  env: [{ name: 'TOKEN', value: 's3cret' }],
}
const STDIO_SPEC = {
  name: 'probe',
  config: { type: 'stdio', command: '/usr/bin/probe', args: ['--serve'], env: { TOKEN: 's3cret' }, exposure: 'direct' },
}

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
    // Strict, so an `input: undefined` fails too: `review`'s template declares no
    // hint, and Pi gives a skill or extension command none.
    expect(established.availableCommands).toStrictEqual(EXPECTED_COMMANDS)
    expect(established.availableCommands.slice(0, BUILTIN_COMMANDS.length)).toStrictEqual([
      { name: 'name', description: 'Set session display name', input: { hint: '<name>' } },
      { name: 'session', description: 'Show session info and stats' },
      { name: 'compact', description: 'Manually compact the session context' },
    ])
  })

  it('drops a Pi command a built-in shadows, from any source, but keeps its disambiguated form', async () => {
    const fake = makeFakePiClient({
      ...makeSpec(),
      commands: [
        { name: 'name', description: 'template', source: 'prompt', sourceInfo: UNREAD_SOURCE_INFO },
        { name: 'session', description: 'ext', source: 'extension', sourceInfo: UNREAD_SOURCE_INFO },
        { name: 'compact:1', description: 'first', source: 'extension', sourceInfo: UNREAD_SOURCE_INFO },
        { name: 'compact:2', source: 'extension', sourceInfo: UNREAD_SOURCE_INFO },
      ],
    })
    const established = await establishSession({ cwd: ABS_CWD, mcpServers: [] }, makeDeps(fake))
    expect(established.availableCommands).toEqual([
      ...BUILTIN_COMMANDS,
      { name: 'compact:1', description: 'first' },
      { name: 'compact:2', description: '' },
    ])
  })

  it('hides a listed Pi command and a listed adapter built-in by exact name', async () => {
    const fake = makeFakePiClient(makeSpec())
    const established = await establishSession(
      { cwd: ABS_CWD, mcpServers: [] },
      { ...makeDeps(fake), hiddenCommands: new Set(['extcmd', 'compact', 'review:1']) },
    )
    expect(established.availableCommands).toStrictEqual([
      ...BUILTIN_COMMANDS.filter((command) => command.name !== 'compact'),
      { name: 'review', description: 'Review code' },
      { name: 'skill:summarize', description: '' },
      { name: 'review:2', description: '' },
    ])
  })

  it('rejects a relative cwd with invalid params', async () => {
    const fake = makeFakePiClient(makeSpec())
    await expect(establishSession({ cwd: 'relative/path', mcpServers: [] }, makeDeps(fake))).rejects.toMatchObject({
      code: -32_602,
    })
  })

  it('rejects additionalDirectories', async () => {
    const fake = makeFakePiClient(makeSpec())
    await expect(
      establishSession({ cwd: ABS_CWD, mcpServers: [], additionalDirectories: ['/other'] }, makeDeps(fake)),
    ).rejects.toThrow(/additionalDirectories/)
  })

  it('loads the MCP extension with a second -e and hands the translated specs over the environment', async () => {
    const fake = makeFakePiClient(makeSpec())
    await establishSession(
      { cwd: ABS_CWD, mcpServers: [STDIO_SERVER] },
      { ...makeDeps(fake), gateExtensionPath: GATE_PATH },
    )
    expect(fake.spawns).toEqual([
      {
        cwd: ABS_CWD,
        args: ['-e', GATE_PATH, '-e', MCP_EXTENSION_PATH],
        env: { [ENV_MCP_SERVERS]: JSON.stringify([STDIO_SPEC]) },
      },
    ])
  })

  it('passes neither the extension nor the environment when the request carries no servers', async () => {
    const fake = makeFakePiClient(makeSpec())
    await establishSession({ cwd: ABS_CWD, mcpServers: [] }, { ...makeDeps(fake), gateExtensionPath: GATE_PATH })
    expect(fake.spawns).toEqual([{ cwd: ABS_CWD, args: ['-e', GATE_PATH] }])
    expect(fake.spawns[0]?.env).toBeUndefined()
  })

  it('rejects the acp transport with invalid params before anything is spawned', async () => {
    const fake = makeFakePiClient(makeSpec())
    const servers = [{ type: 'acp', name: 'inproc', serverId: 'x' }] as unknown as McpServer[]
    await expect(establishSession({ cwd: ABS_CWD, mcpServers: servers }, makeDeps(fake))).rejects.toMatchObject({
      code: JSONRPC_INVALID_PARAMS,
    })
    expect(fake.spawns).toEqual([])
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

  it('logs a notify rather than sending a notice when the client did not advertise notices', async () => {
    const fake = makeFakePiClient(makeSpec())
    await establishSession({ cwd: ABS_CWD, mcpServers: [] }, makeDeps(fake))
    const notify = vi.mocked(stubNotifier.notify)
    notify.mockClear()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    fake.notify({ type: 'extension_ui_request', id: 'ui-notify', method: 'notify', message: 'heads up', notifyType: 'warning' })
    expect(notify).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(extensionNotifyLogLine('heads up'))
    errorSpy.mockRestore()
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

describe('prompt template argument hints', () => {
  let templateDir: string

  beforeEach(() => {
    templateDir = mkdtempSync(join(tmpdir(), TEMPLATE_DIR_PREFIX))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(templateDir, { recursive: true, force: true })
  })

  function writeTemplate(content: string): string {
    const path = join(templateDir, TEMPLATE_FILE_NAME)
    writeFileSync(path, content, 'utf8')
    return path
  }

  function reviewCommand(path: string, source = 'prompt'): FakeCommand {
    return { name: 'review', description: 'Review code', source, sourceInfo: { path } }
  }

  /** Pi's commands as advertised, past the built-ins. */
  async function advertise(commands: FakeCommand[]): Promise<AvailableCommand[]> {
    const fake = makeFakePiClient({ ...makeSpec(), commands })
    const established = await establishSession({ cwd: ABS_CWD, mcpServers: [] }, makeDeps(fake))
    return established.availableCommands.slice(BUILTIN_COMMANDS.length)
  }

  it('advertises a quoted argument-hint as the input hint', async () => {
    const path = writeTemplate(HINTED_TEMPLATE)
    expect(await advertise([reviewCommand(path)])).toStrictEqual([
      { name: 'review', description: 'Review code', input: { hint: '[focus]' } },
    ])
  })

  it('advertises an unquoted argument-hint verbatim', async () => {
    const path = writeTemplate('---\nargument-hint: <file> [focus]\n---\nReview $1\n')
    expect(await advertise([reviewCommand(path)])).toStrictEqual([
      { name: 'review', description: 'Review code', input: { hint: '<file> [focus]' } },
    ])
  })

  it('reads the hint through a BOM and CRLF line endings', async () => {
    const path = writeTemplate(`${BOM}---\r\nargument-hint: <file>\r\n---\r\nReview $1\r\n`)
    expect(await advertise([reviewCommand(path)])).toStrictEqual([
      { name: 'review', description: 'Review code', input: { hint: '<file>' } },
    ])
  })

  it.each([
    ['no frontmatter', 'Review $1\n'],
    ['an empty argument-hint', '---\nargument-hint: ""\n---\nReview $1\n'],
    ['a non-string argument-hint', '---\nargument-hint: 3\n---\nReview $1\n'],
  ])('advertises no input for a template with %s', async (_case, content) => {
    const path = writeTemplate(content)
    expect(await advertise([reviewCommand(path)])).toStrictEqual([{ name: 'review', description: 'Review code' }])
  })

  it.each(['skill', 'extension'])('never gives %s commands an input, even over a hinted file', async (source) => {
    const path = writeTemplate(HINTED_TEMPLATE)
    expect(await advertise([reviewCommand(path, source)])).toStrictEqual([
      { name: 'review', description: 'Review code' },
    ])
  })

  it('establishes the session when a template cannot be read, logging one line that names it', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const missing = join(templateDir, MISSING_FILE_NAME)

    expect(await advertise([reviewCommand(missing)])).toStrictEqual([{ name: 'review', description: 'Review code' }])

    expect(errorSpy).toHaveBeenCalledOnce()
    const [line] = errorSpy.mock.calls[0] ?? []
    expect(line).toMatch(new RegExp(`^\\[${AGENT_NAME}\\] command mapping: `))
    expect(line).toContain(missing)
  })

  it('logs frontmatter that does not parse without echoing the template', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const path = writeTemplate('---\nargument-hint: <file>: [focus]\n---\nReview $1\n')

    expect(await advertise([reviewCommand(path)])).toStrictEqual([{ name: 'review', description: 'Review code' }])

    expect(errorSpy).toHaveBeenCalledOnce()
    const [line] = errorSpy.mock.calls[0] ?? []
    expect(line).toContain(path)
    expect(line).not.toContain('<file>')
  })

  it('keeps a YAML warning off stderr and reads the hint as Pi does', async () => {
    const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const path = writeTemplate('---\nargument-hint: !unknown-tag <file>\n---\nReview $1\n')

    expect(await advertise([reviewCommand(path)])).toStrictEqual([
      { name: 'review', description: 'Review code', input: { hint: '<file>' } },
    ])
    expect(warningSpy).not.toHaveBeenCalled()
  })

  it('never reads the template of a command a built-in shadows', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const shadowed = { name: 'name', source: 'prompt', sourceInfo: { path: join(templateDir, MISSING_FILE_NAME) } }

    expect(await advertise([shadowed])).toStrictEqual([])
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('never reads the template of a hidden command', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const hidden = reviewCommand(join(templateDir, MISSING_FILE_NAME))
    const fake = makeFakePiClient({ ...makeSpec(), commands: [hidden] })

    const established = await establishSession(
      { cwd: ABS_CWD, mcpServers: [] },
      { ...makeDeps(fake), hiddenCommands: new Set([hidden.name]) },
    )

    expect(established.availableCommands).toStrictEqual(BUILTIN_COMMANDS)
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('parseArgumentHint', () => {
  const PARSE_TABLE: [content: string, hint: string | undefined][] = [
    ['---\nargument-hint: <file>\n---\nReview $1', '<file>'],
    ['---\nargument-hint: <file>\n---', '<file>'],
    [`${BOM}---\r\nargument-hint: <file>\r\n---\r\n`, '<file>'],
    ['---\rargument-hint: <file>\r---\r', '<file>'],
    ['Review $1', undefined],
    [' ---\nargument-hint: <file>\n---\n', undefined],
    ['---\nargument-hint: <file>\n', undefined],
    ['---\n---\nReview $1', undefined],
    ['---\nargument-hint: ""\n---\n', undefined],
    ['---\nargument-hint: 3\n---\n', undefined],
    ['---\nargument-hint: [file, focus]\n---\n', undefined],
    ['---\njust a scalar\n---\n', undefined],
    ['---\n- file\n- focus\n---\n', undefined],
    ['---\n~\n---\n', undefined],
    ['---\ndescription: Review code\n---\nargument-hint: <file>\n', undefined],
  ]

  it.each(PARSE_TABLE)('parses %j as %j', (content, hint) => {
    expect(parseArgumentHint(content)).toBe(hint)
  })

  it('throws on frontmatter that is not valid YAML', () => {
    expect(() => parseArgumentHint('---\nargument-hint: <file>: [focus]\n---\n')).toThrow()
  })
})

describe('session/new over the wire', () => {
  function connectOnce(spec: FakePiSpec, hiddenCommands: ReadonlySet<string> = new Set()): Promise<unknown> {
    const fake = makeFakePiClient(spec)
    const server = new PiAcpServer({
      launch: LAUNCH,
      rpcTimeoutMs: 1_000,
      sessionDirs: SESSION_DIRS,
      mcpExtensionPath: MCP_EXTENSION_PATH,
      hiddenCommands,
      createPiClient: fake.createPiClient,
    })
    const app = server.register(acp.agent({ name: AGENT_NAME }))

    return acp
      .client({ name: 'test-client' })
      .connectWith(app, async (context) => {
        const session = await context.buildSession(ABS_CWD).start()
        return session.nextUpdate()
      })
  }

  it('delivers available_commands_update after the response so the SDK client routes it', async () => {
    const message = await connectOnce(makeSpec())

    expect(message).toMatchObject({
      kind: 'session_update',
      update: { sessionUpdate: 'available_commands_update', availableCommands: EXPECTED_COMMANDS },
    })
  })

  it('leaves the server-wide hidden commands out of available_commands_update', async () => {
    const message = await connectOnce(makeSpec(), new Set(['session', 'extcmd']))

    expect(message).toMatchObject({
      kind: 'session_update',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: EXPECTED_COMMANDS.filter((command) => command.name !== 'session' && command.name !== 'extcmd'),
      },
    })
  })

  it('carries a template argument hint through to the client', async () => {
    const templateDir = mkdtempSync(join(tmpdir(), TEMPLATE_DIR_PREFIX))
    try {
      const path = join(templateDir, TEMPLATE_FILE_NAME)
      writeFileSync(path, HINTED_TEMPLATE, 'utf8')
      const commands = [{ name: 'review', description: 'Review code', source: 'prompt', sourceInfo: { path } }]

      const message = await connectOnce({ ...makeSpec(), commands })

      expect(message).toMatchObject({
        kind: 'session_update',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            ...BUILTIN_COMMANDS,
            { name: 'review', description: 'Review code', input: { hint: '[focus]' } },
          ],
        },
      })
    } finally {
      rmSync(templateDir, { recursive: true, force: true })
    }
  })
})
