import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_NAME,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  PI_SESSION_ARG,
  PROTOCOL_VERSION,
  SESSION_LIST_PAGE_SIZE,
  SESSION_TITLE_MAX_CHARS,
} from '../constants.js'
import { PiAcpServer } from '../server/PiAcpServer.js'
import { type SessionDirs, sessionDirForCwd } from '../session/sessionDirectory.js'
import { type FakePiSpec, makeFakePiClient } from './fixtures/fakePiClient.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const LAUNCH = { command: 'pi', args: ['--mode', 'rpc'], source: 'test' }
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
        availableCommands: [{ name: 'review', description: 'Review code' }],
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
