import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, type Mock, type MockInstance, vi } from 'vitest'

import { AGENT_NAME, BUILTIN_COMMANDS, extensionNotifyLogLine, NOTICE_SEVERITY_DEFAULT, PROTOCOL_VERSION } from '../constants.js'
import type { RpcNotifyRequest } from '../pi/PiRpcClient.js'
import { PiAcpServer } from '../server/PiAcpServer.js'
import { type SessionDirs, sessionDirForCwd } from '../session/sessionDirectory.js'
import { type AcpTestFixture, createAcpTestFixture, defaultFakePiSpec, TEST_SESSION_ID } from './acpTestFixture.js'
import { type FakePiSpec, makeFakePiClient } from './fixtures/fakePiClient.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const CWD = '/workspace/project'
const LAUNCH = { command: 'pi', args: ['--mode', 'rpc'], source: 'test' }
const MCP_EXTENSION_PATH = '/tmp/pi-acp-test-mcp-extension.mjs'
const SESSION_DIRS: SessionDirs = { mode: 'flat', dir: '/tmp/pi-acp-sessions' }
const RPC_TIMEOUT_MS = 1_000
const HEADER_TIME = '2026-01-01T00:00:00.000Z'
const FILE_TIMESTAMP = '2026-01-01T00-00-00-000Z'

const NOTICES_CAPABILITIES: acp.ClientCapabilities = { session: { notices: {} } }
const MESSAGE = 'MCP server probe failed: connect ECONNREFUSED'
const SECOND_MESSAGE = 'MCP server docs failed: 401 Unauthorized'
const HISTORY = [
  { role: 'user', content: 'what changed?', timestamp: 1 },
  { role: 'assistant', content: [{ type: 'text', text: 'the parser' }], timestamp: 2 },
]

const COMMANDS_UPDATE = {
  sessionUpdate: 'available_commands_update',
  availableCommands: [...BUILTIN_COMMANDS, { name: 'review', description: 'Review code' }],
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let fixture: AcpTestFixture | null = null
/** Every notify is logged, sent as a notice or not. */
let errorLog: MockInstance<typeof console.error>

beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await fixture?.close()
  fixture = null
  vi.restoreAllMocks()
})

function initRequest(clientCapabilities: acp.ClientCapabilities): acp.InitializeRequest {
  return { protocolVersion: PROTOCOL_VERSION, clientCapabilities }
}

function notifyRequest(message: string, notifyType?: RpcNotifyRequest['notifyType']): RpcNotifyRequest {
  return {
    type: 'extension_ui_request',
    id: 'ui-notify',
    method: 'notify',
    message,
    ...(notifyType === undefined ? {} : { notifyType }),
  }
}

function notice(title: string, severity: string): acp.SessionUpdate {
  return { sessionUpdate: 'notice', severity, title }
}

/** Initializes, opens a session, lets the command snapshot land, and clears the
 * transcript, so a test sees only what its own notify sends. */
async function startSession(clientCapabilities: acp.ClientCapabilities): Promise<AcpTestFixture> {
  fixture = createAcpTestFixture()
  await fixture.client.request(acp.methods.agent.initialize, initRequest(clientCapabilities))
  await fixture.client.request(acp.methods.agent.session.new, { cwd: CWD, mcpServers: [] })
  await fixture.flushAnnouncements()
  fixture.clearTranscript()
  return fixture
}

function updates(scenario: AcpTestFixture): unknown[] {
  return scenario.transcript().map((entry) => (entry.params as acp.SessionNotification).update)
}

/** A server whose client is a recording stub, so a test can see exactly when a
 * notification is sent rather than when it lands. */
function makeServer(spec: Partial<FakePiSpec> = {}): {
  fake: ReturnType<typeof makeFakePiClient>
  server: PiAcpServer
  client: AgentContext
  notify: Mock<(method: string, params: acp.SessionNotification) => Promise<void>>
} {
  const fake = makeFakePiClient({ ...defaultFakePiSpec(), ...spec })
  const server = new PiAcpServer({
    launch: LAUNCH,
    rpcTimeoutMs: RPC_TIMEOUT_MS,
    sessionDirs: SESSION_DIRS,
    mcpExtensionPath: MCP_EXTENSION_PATH,
    createPiClient: fake.createPiClient,
  })
  server.initialize(initRequest(NOTICES_CAPABILITIES))
  const notify = vi.fn(async (_method: string, _params: acp.SessionNotification) => {})
  return { fake, server, client: { notify } as unknown as AgentContext, notify }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function writeStoredSession(root: string): void {
  const dir = sessionDirForCwd(root, CWD)
  mkdirSync(dir, { recursive: true })
  const entries = [
    { type: 'session', version: 3, id: TEST_SESSION_ID, timestamp: HEADER_TIME, cwd: CWD },
    { type: 'message', id: 'entry', parentId: null, timestamp: HEADER_TIME, message: { role: 'user', content: 'what changed?', timestamp: 1 } },
  ]
  writeFileSync(join(dir, `${FILE_TIMESTAMP}_${TEST_SESSION_ID}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
}

// ── A client that advertised notices ──────────────────────────────────────────

describe('extension notify with a client that advertised session.notices', () => {
  it.each(['info', 'warning', 'error'] as const)('sends a %s notify as a notice of that severity, titled by the message, and logs it', async (severity) => {
    const scenario = await startSession(NOTICES_CAPABILITIES)

    scenario.fake.notify(notifyRequest(MESSAGE, severity))
    await scenario.flushAnnouncements()

    expect(scenario.transcript()).toEqual([
      {
        kind: 'notification',
        method: acp.methods.client.session.update,
        params: { sessionId: TEST_SESSION_ID, update: notice(MESSAGE, severity) },
      },
    ])
    expect(errorLog).toHaveBeenCalledWith(extensionNotifyLogLine(MESSAGE))
  })

  it("sends a notify that names no type at Pi's default severity", async () => {
    const scenario = await startSession(NOTICES_CAPABILITIES)

    scenario.fake.notify(notifyRequest(MESSAGE))
    await scenario.flushAnnouncements()

    expect(updates(scenario)).toEqual([notice(MESSAGE, NOTICE_SEVERITY_DEFAULT)])
  })

  it.each(['', ' \n\t '])('only logs a blank notify (%j), since a notice needs a title', async (message) => {
    const scenario = await startSession(NOTICES_CAPABILITIES)

    scenario.fake.notify(notifyRequest(message, 'warning'))
    await scenario.flushAnnouncements()

    expect(updates(scenario)).toEqual([])
    expect(errorLog).toHaveBeenCalledWith(extensionNotifyLogLine(message))
  })

  it('sends a notify after the announcement at once', async () => {
    const { fake, server, client, notify } = makeServer()
    await server.newSession({ params: { cwd: CWD, mcpServers: [] }, client })
    await flush()
    notify.mockClear()

    fake.notify(notifyRequest(MESSAGE, 'warning'))

    expect(notify).toHaveBeenCalledWith(acp.methods.client.session.update, {
      sessionId: TEST_SESSION_ID,
      update: notice(MESSAGE, 'warning'),
    })
  })

  it('holds startup notifies until after the session/new response and the command snapshot, in order', async () => {
    const fake = makeFakePiClient({
      ...defaultFakePiSpec(),
      onStart: (piNotify) => {
        piNotify(notifyRequest(MESSAGE, 'warning'))
        piNotify(notifyRequest(SECOND_MESSAGE, 'error'))
      },
    })
    const server = new PiAcpServer({
      launch: LAUNCH,
      rpcTimeoutMs: RPC_TIMEOUT_MS,
      sessionDirs: SESSION_DIRS,
      mcpExtensionPath: MCP_EXTENSION_PATH,
      createPiClient: fake.createPiClient,
    })
    const app = server.register(acp.agent({ name: AGENT_NAME }))

    // The SDK session router drops an update for a session whose response it has
    // not seen, so a notice sent too early would leave this waiting forever.
    const received = await acp.client({ name: 'test-client' }).connectWith(app, async (context) => {
      await context.request(acp.methods.agent.initialize, initRequest(NOTICES_CAPABILITIES))
      const session = await context.buildSession(CWD).start()
      return [await session.nextUpdate(), await session.nextUpdate(), await session.nextUpdate()]
    })

    expect(received).toEqual([
      expect.objectContaining({ kind: 'session_update', update: COMMANDS_UPDATE }),
      expect.objectContaining({ kind: 'session_update', update: notice(MESSAGE, 'warning') }),
      expect.objectContaining({ kind: 'session_update', update: notice(SECOND_MESSAGE, 'error') }),
    ])
  })

  it('holds a session/load startup notify until after the replay, the response and the command snapshot', async () => {
    fixture = createAcpTestFixture({
      messages: HISTORY,
      onStart: (piNotify) => piNotify(notifyRequest(MESSAGE, 'warning')),
    })
    writeStoredSession(fixture.sessionRoot)
    await fixture.client.request(acp.methods.agent.initialize, initRequest(NOTICES_CAPABILITIES))

    await fixture.client.request(acp.methods.agent.session.load, { sessionId: TEST_SESSION_ID, cwd: CWD, mcpServers: [] })
    const beforeAnnouncement = updates(fixture)
    await fixture.flushAnnouncements()

    expect(beforeAnnouncement.map((update) => (update as acp.SessionUpdate).sessionUpdate)).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
    ])
    expect(updates(fixture).slice(beforeAnnouncement.length)).toEqual([COMMANDS_UPDATE, notice(MESSAGE, 'warning')])
  })

  it('drops a startup notify when the session closes before it is announced', async () => {
    const { server, client, notify } = makeServer({ onStart: (piNotify) => piNotify(notifyRequest(MESSAGE, 'warning')) })
    await server.newSession({ params: { cwd: CWD, mcpServers: [] }, client })
    await server.closeSession({ params: { sessionId: TEST_SESSION_ID } })
    await flush()

    expect(notify).not.toHaveBeenCalled()
  })

  it('drops a notify once the subprocess has died', async () => {
    const { fake, server, client, notify } = makeServer()
    await server.newSession({ params: { cwd: CWD, mcpServers: [] }, client })
    await flush()
    notify.mockClear()

    fake.exit(new Error('fake pi: exited'))
    fake.notify(notifyRequest(MESSAGE, 'error'))
    await flush()

    expect(notify).not.toHaveBeenCalled()
  })
})

// ── A client that did not ─────────────────────────────────────────────────────

describe('extension notify with a client that did not advertise session.notices', () => {
  it.each<acp.ClientCapabilities>([{}, { session: null }, { session: {} }, { session: { notices: null } }])(
    'logs the notify and sends no notice (%j)',
    async (clientCapabilities) => {
      const scenario = await startSession(clientCapabilities)

      scenario.fake.notify(notifyRequest(MESSAGE, 'warning'))
      await scenario.flushAnnouncements()

      expect(updates(scenario)).toEqual([])
      expect(errorLog).toHaveBeenCalledWith(extensionNotifyLogLine(MESSAGE))
    },
  )
})
