import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_NAME,
  BUILTIN_COMMANDS,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  META_KEY_BREAKPOINT_NAMESPACE,
  META_KEY_MESSAGE_ID,
  PI_SESSION_ARG,
  PROTOCOL_VERSION,
  SESSION_LIST_PAGE_SIZE,
  SESSION_TITLE_MAX_CHARS,
} from '../constants.js'
import { PiAcpServer } from '../server/PiAcpServer.js'
import {
  messageMapPathFor,
  readMessageMap,
  type SessionDirs,
  sessionDirForCwd,
  writeMessageMap,
} from '../session/sessionDirectory.js'
import { type FakePiSpec, makeFakePiClient } from './fixtures/fakePiClient.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const LAUNCH = { command: 'pi', args: ['--mode', 'rpc'], source: 'test' }
const MCP_EXTENSION_PATH = '/tmp/mcp-extension.mjs'
const TEMP_PREFIX = 'pi-acp-lifecycle-'
const HEADER_TIME = '2026-01-01T00:00:00.000Z'
const FILE_TIMESTAMP = '2026-01-01T00-00-00-000Z'
const CWD = '/workspace/project'
const OTHER_CWD = '/workspace/other'
const SESSION_ID = 'sess-1'
const MODEL = { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }
const COMMANDS = [{ name: 'review', description: 'Review code', source: 'prompt' }]
const HELLO_PROMPT = [{ type: 'text' as const, text: 'hi' }]
const INIT_REQUEST = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }
/** `acp.RequestError.resourceNotFound`; the SDK exports no code constant. */
const JSONRPC_RESOURCE_NOT_FOUND = -32_002

let root: string
let dirs: SessionDirs

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), TEMP_PREFIX))
  dirs = { mode: 'perCwd', root }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ── Fixtures (Pi's own session file format) ───────────────────────────────────

function header(id: string, cwd: string): unknown {
  return { type: 'session', version: 3, id, timestamp: HEADER_TIME, cwd }
}

function sessionInfo(name: string): unknown {
  return { type: 'session_info', id: 'info', parentId: null, timestamp: HEADER_TIME, name }
}

function message(role: string, content: unknown, timestamp?: number): unknown {
  return {
    type: 'message',
    id: 'entry',
    parentId: null,
    timestamp: HEADER_TIME,
    message: { role, content, ...(timestamp === undefined ? {} : { timestamp }) },
  }
}

/** A message entry with a real place in the tree, for the breakpoint cut. */
function treeMessage(id: string, parentId: string | null, role: string, content: string): unknown {
  return { type: 'message', id, parentId, timestamp: HEADER_TIME, message: { role, content } }
}

function writeSession(cwd: string, id: string, entries: readonly unknown[] = []): string {
  const dir = sessionDirForCwd(root, cwd)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${FILE_TIMESTAMP}_${id}.jsonl`)
  writeFileSync(path, [header(id, cwd), ...entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  return path
}

function makeSpec(overrides: Partial<FakePiSpec> = {}): FakePiSpec {
  return {
    state: { sessionId: SESSION_ID, thinkingLevel: 'low', model: MODEL },
    models: [MODEL],
    levels: ['low'],
    commands: COMMANDS,
    ...overrides,
  }
}

function makeServer(spec: FakePiSpec = makeSpec()): {
  fake: ReturnType<typeof makeFakePiClient>
  server: PiAcpServer
  client: AgentContext
  notify: ReturnType<typeof vi.fn>
} {
  const fake = makeFakePiClient(spec)
  const server = new PiAcpServer({
    launch: LAUNCH,
    rpcTimeoutMs: 1_000,
    sessionDirs: dirs,
    mcpExtensionPath: MCP_EXTENSION_PATH,
    createPiClient: fake.createPiClient,
  })
  const notify = vi.fn(async () => {})
  return { fake, server, client: { notify } as unknown as AgentContext, notify }
}

async function startSession(server: PiAcpServer, client: AgentContext, cwd = CWD): Promise<void> {
  await server.newSession({ params: { cwd, mcpServers: [] }, client })
}

/** Lets the deferred `available_commands_update` macrotask run. */
async function flushAnnouncements(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// ── session/list ──────────────────────────────────────────────────────────────

describe('session/list', () => {
  function writeNumbered(count: number): void {
    for (let index = 0; index < count; index++) {
      writeSession(CWD, `s${index}`, [message('user', 'hi', index + 1)])
    }
  }

  it('pages by offset and omits nextCursor on the last page', async () => {
    const extra = 5
    writeNumbered(SESSION_LIST_PAGE_SIZE + extra)
    const { server } = makeServer()

    const first = await server.listSessions({ params: { cwd: CWD } })
    expect(first.sessions).toHaveLength(SESSION_LIST_PAGE_SIZE)
    expect(first.nextCursor).toBe(String(SESSION_LIST_PAGE_SIZE))
    // Newest first: the highest message timestamp leads.
    expect(first.sessions[0]?.sessionId).toBe(`s${SESSION_LIST_PAGE_SIZE + extra - 1}`)

    const second = await server.listSessions({ params: { cwd: CWD, cursor: String(SESSION_LIST_PAGE_SIZE) } })
    expect(second.sessions).toHaveLength(extra)
    expect('nextCursor' in second).toBe(false)
    expect(second.sessions.map((session) => session.sessionId)).not.toContain(first.sessions[0]?.sessionId)
  })

  it('omits nextCursor when the store holds exactly one full page', async () => {
    writeNumbered(SESSION_LIST_PAGE_SIZE)
    const { server } = makeServer()

    const response = await server.listSessions({ params: { cwd: CWD } })
    expect(response.sessions).toHaveLength(SESSION_LIST_PAGE_SIZE)
    expect('nextCursor' in response).toBe(false)
  })

  it('returns an empty last page for a cursor past the end', async () => {
    writeNumbered(2)
    const { server } = makeServer()

    const response = await server.listSessions({ params: { cwd: CWD, cursor: '99' } })
    expect(response.sessions).toEqual([])
    expect('nextCursor' in response).toBe(false)
  })

  it('rejects a relative cwd and a non-numeric cursor', async () => {
    const { server } = makeServer()
    await expect(server.listSessions({ params: { cwd: 'relative/path' } })).rejects.toMatchObject({
      code: JSONRPC_INVALID_PARAMS,
    })
    await expect(server.listSessions({ params: { cursor: 'opaque' } })).rejects.toMatchObject({
      code: JSONRPC_INVALID_PARAMS,
    })
    await expect(server.listSessions({ params: { cursor: '-1' } })).rejects.toMatchObject({
      code: JSONRPC_INVALID_PARAMS,
    })
  })

  it('titles from the name, else the bounded first line, else null', async () => {
    const longLine = 'x'.repeat(SESSION_TITLE_MAX_CHARS + 10)
    writeSession(CWD, 'named', [sessionInfo('Renamed session'), message('user', 'ignored', 3_000)])
    writeSession(CWD, 'derived', [message('user', `first line\nsecond line`, 2_000)])
    writeSession(CWD, 'long', [message('user', longLine, 1_000)])
    writeSession(CWD, 'bare', [])
    const { server } = makeServer()

    const sessions = await server.listSessions({ params: { cwd: CWD } })
    const titles = new Map(sessions.sessions.map((session) => [session.sessionId, session.title]))
    expect(titles.get('named')).toBe('Renamed session')
    expect(titles.get('derived')).toBe('first line')
    expect(titles.get('long')).toBe('x'.repeat(SESSION_TITLE_MAX_CHARS))
    expect(titles.get('bare')).toBeNull()
  })

  it('reports the cwd and the last activity as an ISO timestamp', async () => {
    writeSession(CWD, SESSION_ID, [message('user', 'hi', 5_000)])
    const { server } = makeServer()

    const response = await server.listSessions({ params: { cwd: CWD } })
    expect(response.sessions).toEqual([
      { sessionId: SESSION_ID, cwd: CWD, title: 'hi', updatedAt: new Date(5_000).toISOString() },
    ])
  })
})

// ── session/resume ────────────────────────────────────────────────────────────

describe('session/resume', () => {
  it('opens the stored file with --session and answers with the config options', async () => {
    const path = writeSession(CWD, SESSION_ID, [message('user', 'earlier', 1_000)])
    const { fake, server, client, notify } = makeServer()

    const response = await server.resumeSession({ params: { sessionId: SESSION_ID, cwd: CWD }, client })

    expect(response.configOptions?.map((option) => option.id)).toEqual(['model', 'thought_level'])
    expect(fake.spawns).toEqual([{ cwd: CWD, args: [PI_SESSION_ARG, path] }])
    await flushAnnouncements()
    expect(notify).toHaveBeenCalledWith(acp.methods.client.session.update, {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [...BUILTIN_COMMANDS, { name: 'review', description: 'Review code' }],
      },
    })
  })

  it('fails fast and stops the subprocess when Pi reports another session id', async () => {
    writeSession(CWD, 'stored-id')
    const { fake, server, client } = makeServer()

    await expect(
      server.resumeSession({ params: { sessionId: 'stored-id', cwd: CWD }, client }),
    ).rejects.toMatchObject({ code: JSONRPC_INTERNAL_ERROR })
    expect(fake.wasStopped()).toBe(true)
  })

  it('reports an unknown session as resource_not_found', async () => {
    const { fake, server, client } = makeServer()
    await expect(server.resumeSession({ params: { sessionId: 'absent', cwd: CWD }, client })).rejects.toMatchObject({
      code: JSONRPC_RESOURCE_NOT_FOUND,
    })
    expect(fake.spawns).toEqual([])
  })

  it('refuses a session whose header cwd is another directory, before spawning', async () => {
    // Placed in this cwd's directory (the encoding is lossy) but owned by another.
    const dir = sessionDirForCwd(root, CWD)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${FILE_TIMESTAMP}_${SESSION_ID}.jsonl`), `${JSON.stringify(header(SESSION_ID, OTHER_CWD))}\n`)
    const { fake, server, client } = makeServer()

    await expect(server.resumeSession({ params: { sessionId: SESSION_ID, cwd: CWD }, client })).rejects.toMatchObject({
      code: JSONRPC_INVALID_PARAMS,
      message: expect.stringContaining(OTHER_CWD),
    })
    expect(fake.spawns).toEqual([])
  })

  it('refuses a session stored under another cwd directory as belonging elsewhere, not as missing', async () => {
    writeSession(OTHER_CWD, SESSION_ID)
    const { fake, server, client } = makeServer()

    await expect(server.resumeSession({ params: { sessionId: SESSION_ID, cwd: CWD }, client })).rejects.toMatchObject({
      code: JSONRPC_INVALID_PARAMS,
      message: expect.stringContaining(OTHER_CWD),
    })
    expect(fake.spawns).toEqual([])
  })

  it('rejects a relative cwd without reading the store', async () => {
    const { fake, server, client } = makeServer()
    await expect(
      server.resumeSession({ params: { sessionId: SESSION_ID, cwd: 'relative/path' }, client }),
    ).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS })
    expect(fake.spawns).toEqual([])
  })

  it('reuses a live session and re-announces its commands instead of opening a second subprocess', async () => {
    writeSession(CWD, SESSION_ID)
    const { fake, server, client, notify } = makeServer()
    await startSession(server, client)
    await flushAnnouncements()
    notify.mockClear()

    const response = await server.resumeSession({ params: { sessionId: SESSION_ID, cwd: CWD }, client })

    expect(response.configOptions).toBeDefined()
    expect(fake.spawns).toHaveLength(1)
    await flushAnnouncements()
    expect(notify).toHaveBeenCalledWith(
      acp.methods.client.session.update,
      expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: 'available_commands_update' }) }),
    )
  })

  it('refuses to resume a live session into a different cwd', async () => {
    const { server, client } = makeServer()
    await startSession(server, client)

    await expect(
      server.resumeSession({ params: { sessionId: SESSION_ID, cwd: OTHER_CWD }, client }),
    ).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS, message: expect.stringContaining(CWD) })
  })
})

// ── session/load ──────────────────────────────────────────────────────────────

describe('session/load', () => {
  const HISTORY = [
    { role: 'user', content: 'what changed?', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'the parser' }], timestamp: 2 },
  ]

  it('sends every replayed update before the response', async () => {
    writeSession(CWD, SESSION_ID, [message('user', 'what changed?', 1_000)])
    const fake = makeFakePiClient(makeSpec({ messages: HISTORY }))
    const server = new PiAcpServer({
      launch: LAUNCH,
      rpcTimeoutMs: 1_000,
      sessionDirs: dirs,
      mcpExtensionPath: MCP_EXTENSION_PATH,
      createPiClient: fake.createPiClient,
    })
    const app = server.register(acp.agent({ name: AGENT_NAME }))

    const timeline: string[] = []
    const response = await acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, (context) => {
        timeline.push(context.params.update.sessionUpdate)
      })
      .connectWith(app, async (context) => {
        await context.request(acp.methods.agent.initialize, INIT_REQUEST)
        const loaded = await context.request(acp.methods.agent.session.load, {
          sessionId: SESSION_ID,
          cwd: CWD,
          mcpServers: [],
        })
        timeline.push('response')
        return loaded
      })

    expect(timeline.slice(0, 3)).toEqual(['user_message_chunk', 'agent_message_chunk', 'response'])
    expect(response.configOptions?.map((option) => option.id)).toEqual(['model', 'thought_level'])
    expect(fake.spawns[0]?.args).toContain(PI_SESSION_ARG)
  })

  it('replays from the live subprocess without opening a second one', async () => {
    const { fake, server, client, notify } = makeServer(makeSpec({ messages: HISTORY }))
    await startSession(server, client)
    await flushAnnouncements()
    notify.mockClear()

    await server.loadSession({ params: { sessionId: SESSION_ID, cwd: CWD, mcpServers: [] }, client })

    expect(fake.spawns).toHaveLength(1)
    expect(notify.mock.calls.map((call) => (call[1] as acp.SessionNotification).update.sessionUpdate)).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
    ])
  })
})

// ── session/fork ──────────────────────────────────────────────────────────────

describe('session/fork', () => {
  /** A UUIDv7 in canonical form: version 7 and the RFC variant nibbles pinned. */
  const MINTED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const TOOL_CALL = { type: 'toolCall', id: 'call', parentId: null, timestamp: HEADER_TIME, toolName: 'bash' }

  /** The file a spawn opened with `--session`, plus the cwd it ran in. */
  function forkSpawn(fake: ReturnType<typeof makeFakePiClient>, index: number): { cwd: string; path: string } {
    const spawn = fake.spawns[index]
    if (spawn === undefined) throw new Error(`no spawn at index ${index}`)
    const path = spawn.args[spawn.args.indexOf(PI_SESSION_ARG) + 1]
    if (path === undefined) throw new Error(`the spawn at index ${index} carries no session file`)
    return { cwd: spawn.cwd, path }
  }

  function readEntries(path: string): Array<Record<string, unknown>> {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  it('writes the fork file, opens it with --session, and registers the new session', async () => {
    const parentPath = writeSession(CWD, SESSION_ID, [
      sessionInfo('Parent name'),
      message('user', 'earlier', 1_000),
      message('assistant', 'done', 2_000),
    ])
    const { fake, server, client, notify } = makeServer(makeSpec({ sessionIdFromSessionFile: true }))

    const response = await server.forkSession({ params: { sessionId: SESSION_ID, cwd: CWD }, client })

    expect(response.sessionId).toMatch(MINTED_ID)
    expect(response.configOptions?.map((option) => option.id)).toEqual(['model', 'thought_level'])

    const spawn = forkSpawn(fake, 0)
    expect(spawn.cwd).toBe(CWD)
    expect(spawn.path.startsWith(sessionDirForCwd(root, CWD))).toBe(true)
    expect(basename(spawn.path).endsWith(`_${response.sessionId}.jsonl`)).toBe(true)

    // The whole tree is copied verbatim, so the fork carries the parent's name.
    const entries = readEntries(spawn.path)
    expect(entries[0]).toMatchObject({ id: response.sessionId, cwd: CWD, parentSession: parentPath })
    expect(entries.slice(1)).toEqual([
      sessionInfo('Parent name'),
      message('user', 'earlier', 1_000),
      message('assistant', 'done', 2_000),
    ])

    await flushAnnouncements()
    expect(notify).toHaveBeenCalledWith(acp.methods.client.session.update, {
      sessionId: response.sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [...BUILTIN_COMMANDS, { name: 'review', description: 'Review code' }],
      },
    })
    await expect(server.closeSession({ params: { sessionId: response.sessionId } })).resolves.toEqual({})
  })

  it('forks into another cwd, landing the file under that cwd directory', async () => {
    const parentPath = writeSession(CWD, SESSION_ID, [message('user', 'earlier', 1_000)])
    const { fake, server, client } = makeServer(makeSpec({ sessionIdFromSessionFile: true }))

    const response = await server.forkSession({ params: { sessionId: SESSION_ID, cwd: OTHER_CWD }, client })

    const spawn = forkSpawn(fake, 0)
    expect(spawn.cwd).toBe(OTHER_CWD)
    expect(spawn.path.startsWith(sessionDirForCwd(root, OTHER_CWD))).toBe(true)
    expect(readEntries(spawn.path)[0]).toEqual({
      type: 'session',
      version: 3,
      id: response.sessionId,
      timestamp: expect.any(String),
      cwd: OTHER_CWD,
      parentSession: parentPath,
    })
  })

  it('forks a live parent from its last settled turn, leaving the in-flight one out', async () => {
    const { fake, server, client } = makeServer(makeSpec({ sessionIdFromSessionFile: true }))
    await startSession(server, client)
    writeSession(CWD, SESSION_ID, [
      message('user', 'settled', 1_000),
      message('assistant', 'answered', 2_000),
      message('user', 'in flight', 3_000),
      TOOL_CALL,
    ])

    const turn = server.prompt({
      params: { sessionId: SESSION_ID, prompt: HELLO_PROMPT },
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    await server.forkSession({ params: { sessionId: SESSION_ID, cwd: CWD }, client })

    expect(readEntries(forkSpawn(fake, 1).path).slice(1)).toEqual([
      message('user', 'settled', 1_000),
      message('assistant', 'answered', 2_000),
    ])

    await expect(server.closeSession({ params: { sessionId: SESSION_ID } })).resolves.toEqual({})
    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('reports an unknown parent, and a parent Pi never flushed, as resource_not_found', async () => {
    const { fake, server, client } = makeServer()

    await expect(server.forkSession({ params: { sessionId: 'absent', cwd: CWD }, client })).rejects.toMatchObject({
      code: JSONRPC_RESOURCE_NOT_FOUND,
    })

    await startSession(server, client)
    await expect(server.forkSession({ params: { sessionId: SESSION_ID, cwd: CWD }, client })).rejects.toMatchObject({
      code: JSONRPC_RESOURCE_NOT_FOUND,
    })
    expect(fake.spawns).toHaveLength(1)
  })

  it('rejects a relative cwd without reading the store', async () => {
    const { fake, server, client } = makeServer()
    await expect(
      server.forkSession({ params: { sessionId: SESSION_ID, cwd: 'relative/path' }, client }),
    ).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS })
    expect(fake.spawns).toEqual([])
  })

  it('fails fast, stops the subprocess and removes the fork file when Pi opens the fork under another id', async () => {
    writeSession(CWD, SESSION_ID, [message('user', 'earlier', 1_000)])
    const { fake, server, client } = makeServer()

    await expect(server.forkSession({ params: { sessionId: SESSION_ID, cwd: CWD }, client })).rejects.toMatchObject({
      code: JSONRPC_INTERNAL_ERROR,
    })
    expect(fake.wasStopped()).toBe(true)
    expect(existsSync(forkSpawn(fake, 0).path)).toBe(false)
  })

  // ── Breakpoint forks ────────────────────────────────────────────────────────

  const FIRST_MESSAGE_ID = 'm1'
  const SECOND_MESSAGE_ID = 'm2'
  const FIRST_PROMPT = treeMessage('u1', null, 'user', 'first')
  const FIRST_ANSWER = treeMessage('a1', 'u1', 'assistant', 'answer one')
  const SECOND_PROMPT = treeMessage('u2', 'a1', 'user', 'second')
  const SECOND_ANSWER = treeMessage('a2', 'u2', 'assistant', 'answer two')
  const PARENT_TREE = [FIRST_PROMPT, FIRST_ANSWER, SECOND_PROMPT, SECOND_ANSWER]

  /** A parent whose two prompts are both recorded in its sidecar. */
  function writeRecordedParent(): string {
    const parentPath = writeSession(CWD, SESSION_ID, PARENT_TREE)
    writeMessageMap(messageMapPathFor(parentPath), { [FIRST_MESSAGE_ID]: 'u1', [SECOND_MESSAGE_ID]: 'u2' })
    return parentPath
  }

  function forkAt(server: PiAcpServer, client: AgentContext, sessionId: string, messageId: string) {
    return server.forkSession({
      params: {
        sessionId,
        cwd: CWD,
        _meta: { [META_KEY_BREAKPOINT_NAMESPACE]: { [META_KEY_MESSAGE_ID]: messageId } },
      },
      client,
    })
  }

  it('carries the recorded breakpoints into a head-only fork', async () => {
    writeRecordedParent()
    const { fake, server, client } = makeServer(makeSpec({ sessionIdFromSessionFile: true }))

    const response = await server.forkSession({ params: { sessionId: SESSION_ID, cwd: CWD }, client })

    // No cut, so every recorded breakpoint survives into the fork's sidecar.
    expect(readMessageMap(messageMapPathFor(forkSpawn(fake, 0).path))).toEqual({
      [FIRST_MESSAGE_ID]: 'u1',
      [SECOND_MESSAGE_ID]: 'u2',
    })
    await expect(server.closeSession({ params: { sessionId: response.sessionId } })).resolves.toEqual({})
  })

  it('drops breakpoints whose entries a head-only fork of a live parent leaves out', async () => {
    const { fake, server, client } = makeServer(makeSpec({ sessionIdFromSessionFile: true }))
    await startSession(server, client)
    const parentPath = writeSession(CWD, SESSION_ID, [
      treeMessage('u1', null, 'user', 'settled'),
      treeMessage('a1', 'u1', 'assistant', 'answered'),
      treeMessage('u2', 'a1', 'user', 'in flight'),
    ])
    writeMessageMap(messageMapPathFor(parentPath), { [FIRST_MESSAGE_ID]: 'u1', [SECOND_MESSAGE_ID]: 'u2' })

    const turn = server.prompt({
      params: { sessionId: SESSION_ID, prompt: HELLO_PROMPT },
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    const response = await server.forkSession({ params: { sessionId: SESSION_ID, cwd: CWD }, client })

    // The in-flight prompt stays out of the fork, so its breakpoint does too.
    expect(readMessageMap(messageMapPathFor(forkSpawn(fake, 1).path))).toEqual({ [FIRST_MESSAGE_ID]: 'u1' })

    await expect(server.closeSession({ params: { sessionId: SESSION_ID } })).resolves.toEqual({})
    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' })
    await expect(server.closeSession({ params: { sessionId: response.sessionId } })).resolves.toEqual({})
  })

  it('cuts the parent at the named prompt and carries the surviving map into the fork', async () => {
    writeRecordedParent()
    const { fake, server, client } = makeServer(makeSpec({ sessionIdFromSessionFile: true }))

    const response = await forkAt(server, client, SESSION_ID, SECOND_MESSAGE_ID)

    const forkPath = forkSpawn(fake, 0).path
    // The ancestors of the named prompt, that prompt excluded.
    expect(readEntries(forkPath).slice(1)).toEqual([FIRST_PROMPT, FIRST_ANSWER])
    expect(readMessageMap(messageMapPathFor(forkPath))).toEqual({ [FIRST_MESSAGE_ID]: 'u1' })
    await expect(server.closeSession({ params: { sessionId: response.sessionId } })).resolves.toEqual({})
  })

  it('forks that fork at the earlier breakpoint, leaving a header-only file', async () => {
    writeRecordedParent()
    const { fake, server, client } = makeServer(makeSpec({ sessionIdFromSessionFile: true }))

    const first = await forkAt(server, client, SESSION_ID, SECOND_MESSAGE_ID)
    const second = await forkAt(server, client, first.sessionId, FIRST_MESSAGE_ID)

    const secondPath = forkSpawn(fake, 1).path
    // The first prompt is the root, so its ancestor path is empty.
    expect(readEntries(secondPath)).toHaveLength(1)
    expect(existsSync(messageMapPathFor(secondPath))).toBe(false)
    await expect(server.closeSession({ params: { sessionId: first.sessionId } })).resolves.toEqual({})
    await expect(server.closeSession({ params: { sessionId: second.sessionId } })).resolves.toEqual({})
  })

  it('rejects a message id no sidecar records, without spawning', async () => {
    writeSession(CWD, SESSION_ID, PARENT_TREE)
    const { fake, server, client } = makeServer(makeSpec({ sessionIdFromSessionFile: true }))

    await expect(forkAt(server, client, SESSION_ID, SECOND_MESSAGE_ID)).rejects.toMatchObject({
      code: JSONRPC_INVALID_PARAMS,
      message: expect.stringContaining(SECOND_MESSAGE_ID),
    })
    expect(fake.spawns).toEqual([])
  })

  it('rejects a message id the sidecar does not hold, without spawning', async () => {
    const parentPath = writeSession(CWD, SESSION_ID, PARENT_TREE)
    writeMessageMap(messageMapPathFor(parentPath), { [FIRST_MESSAGE_ID]: 'u1' })
    const { fake, server, client } = makeServer(makeSpec({ sessionIdFromSessionFile: true }))

    await expect(forkAt(server, client, SESSION_ID, SECOND_MESSAGE_ID)).rejects.toMatchObject({
      code: JSONRPC_INVALID_PARAMS,
      message: expect.stringContaining('not recorded'),
    })
    expect(fake.spawns).toEqual([])
  })

  it('rejects a message id mapped to an entry that is not a user message', async () => {
    const parentPath = writeSession(CWD, SESSION_ID, PARENT_TREE)
    writeMessageMap(messageMapPathFor(parentPath), { [SECOND_MESSAGE_ID]: 'a1' })
    const { fake, server, client } = makeServer(makeSpec({ sessionIdFromSessionFile: true }))

    await expect(forkAt(server, client, SESSION_ID, SECOND_MESSAGE_ID)).rejects.toMatchObject({
      code: JSONRPC_INVALID_PARAMS,
      message: expect.stringContaining('a1'),
    })
    expect(fake.spawns).toEqual([])
  })

  it('removes the fork file and its sidecar when Pi opens the fork under another id', async () => {
    writeRecordedParent()
    const { fake, server, client } = makeServer()

    await expect(forkAt(server, client, SESSION_ID, SECOND_MESSAGE_ID)).rejects.toMatchObject({
      code: JSONRPC_INTERNAL_ERROR,
    })
    const forkPath = forkSpawn(fake, 0).path
    expect(existsSync(forkPath)).toBe(false)
    expect(existsSync(messageMapPathFor(forkPath))).toBe(false)
  })
})

// ── session/close ─────────────────────────────────────────────────────────────

describe('session/close', () => {
  it('resolves a prompt in flight as cancelled and drops the session', async () => {
    const { fake, server, client } = makeServer(
      makeSpec({ onPrompt: (emit) => emit({ type: 'agent_start' } as never) }),
    )
    await startSession(server, client)

    const turn = server.prompt({
      params: { sessionId: SESSION_ID, prompt: HELLO_PROMPT },
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    await expect(server.closeSession({ params: { sessionId: SESSION_ID } })).resolves.toEqual({})

    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' })
    expect(fake.wasStopped()).toBe(true)
    await expect(
      server.prompt({ params: { sessionId: SESSION_ID, prompt: HELLO_PROMPT }, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS, message: expect.stringContaining('unknown session') })
  })

  it('rejects an unknown session with invalid params', async () => {
    const { server } = makeServer()
    await expect(server.closeSession({ params: { sessionId: 'absent' } })).rejects.toMatchObject({
      code: JSONRPC_INVALID_PARAMS,
    })
  })
})

// ── session/delete ────────────────────────────────────────────────────────────

describe('session/delete', () => {
  it('unlinks the stored file', async () => {
    const path = writeSession(CWD, SESSION_ID, [message('user', 'hi', 1_000)])
    const { server } = makeServer()

    await expect(server.deleteSession({ params: { sessionId: SESSION_ID } })).resolves.toEqual({})
    expect(existsSync(path)).toBe(false)
  })

  it('removes the breakpoint sidecar alongside the file', async () => {
    const path = writeSession(CWD, SESSION_ID, [message('user', 'hi', 1_000)])
    writeMessageMap(messageMapPathFor(path), { m1: 'u1' })
    const { server } = makeServer()

    await expect(server.deleteSession({ params: { sessionId: SESSION_ID } })).resolves.toEqual({})
    expect(existsSync(messageMapPathFor(path))).toBe(false)
  })

  it('closes a live session before unlinking', async () => {
    const path = writeSession(CWD, SESSION_ID)
    const { fake, server, client } = makeServer()
    await startSession(server, client)

    await server.deleteSession({ params: { sessionId: SESSION_ID } })

    expect(fake.wasStopped()).toBe(true)
    expect(existsSync(path)).toBe(false)
    await expect(
      server.prompt({ params: { sessionId: SESSION_ID, prompt: HELLO_PROMPT }, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS })
  })

  it('reports a missing file as resource_not_found and leaves a live session running', async () => {
    const { fake, server, client } = makeServer()
    await startSession(server, client)

    await expect(server.deleteSession({ params: { sessionId: SESSION_ID } })).rejects.toMatchObject({
      code: JSONRPC_RESOURCE_NOT_FOUND,
    })
    expect(fake.wasStopped()).toBe(false)
    // Still registered: close would be invalid_params on a dropped session.
    await expect(server.closeSession({ params: { sessionId: SESSION_ID } })).resolves.toEqual({})
  })

  it('surfaces an ambiguous id as an internal error naming the candidates', async () => {
    const first = writeSession(CWD, SESSION_ID)
    const second = writeSession(OTHER_CWD, SESSION_ID)
    const { server } = makeServer()
    const app = server.register(acp.agent({ name: AGENT_NAME }))

    const error = await acp.client({ name: 'test-client' }).connectWith(app, async (context) => {
      await context.request(acp.methods.agent.initialize, INIT_REQUEST)
      return await context
        .request(acp.methods.agent.session.delete, { sessionId: SESSION_ID })
        .then(() => undefined, (caught: unknown) => caught)
    })

    expect(error).toMatchObject({ code: JSONRPC_INTERNAL_ERROR })
    expect((error as Error).message).toContain('matches 2 session files')
    expect(existsSync(first) && existsSync(second)).toBe(true)
  })
})
