/**
 * Snapshot-test harness for the adapter: scripted Pi RPC events in, recorded ACP
 * transcript out. No network and no real Pi subprocess.
 *
 * Both ends of the adapter are stood in for:
 *   - `makeFakePiClient` replaces the RPC transport, so a test scripts Pi's
 *     responses, pushes session events, and drives extension UI requests.
 *   - A recording ACP client app is connected to the real agent app in process,
 *     so requests and notifications travel the real SDK protocol layer rather
 *     than a hand-rolled mock connection.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk'

import { AGENT_NAME } from '../constants.js'
import { PiAcpServer } from '../server/PiAcpServer.js'
import type { SessionDirs } from '../session/sessionDirectory.js'
import { type FakePiClient, type FakePiSpec, makeFakePiClient } from './fixtures/fakePiClient.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_CLIENT_NAME = 'pi-acp-test-client'
const TEMP_PREFIX = 'pi-acp-fixture-'
const LAUNCH = { command: 'pi', args: ['--mode', 'rpc'], source: 'test' }
const MCP_EXTENSION_PATH = '/tmp/pi-acp-test-mcp-extension.mjs'
const RPC_TIMEOUT_MS = 1_000

/** The id the fake Pi reports for every session it opens. */
export const TEST_SESSION_ID = 'sess-1'
export const TEST_MODEL = { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }
export const TEST_THINKING_LEVEL = 'low'
export const TEST_COMMANDS = [{ name: 'review', description: 'Review code', source: 'prompt' }]

/** Permission round-trips fail closed, so a test that scripts no answer gets a
 * denial rather than an allow. */
const DEFAULT_PERMISSION_RESPONSE: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }

// ── Recorded ACP transcript ───────────────────────────────────────────────────

export type AcpRecordKind = 'notification' | 'request'

/** One client-bound message the adapter sent, in arrival order. */
export interface AcpRecord {
  readonly kind: AcpRecordKind
  readonly method: string
  readonly params: unknown
}

/** Replaces the value of every field named (or dotted-path addressed) in
 * `fieldsToAnonymize` with the field name, so a transcript carrying generated
 * ids stays snapshot-stable. */
function anonymizeValue(value: unknown, path: readonly string[], fieldsToAnonymize: ReadonlySet<string>): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((item, index) => anonymizeValue(item, [...path, String(index)], fieldsToAnonymize))
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => {
      const nextPath = [...path, key]
      if (fieldsToAnonymize.has(key) || fieldsToAnonymize.has(nextPath.join('.'))) return [key, key]
      return [key, anonymizeValue(nested, nextPath, fieldsToAnonymize)]
    }),
  )
}

// ── Fake Pi defaults ──────────────────────────────────────────────────────────

/** One model, one thinking level, one prompt command: enough for both config
 * options to be offered and for a command announcement to be non-empty. */
export function defaultFakePiSpec(): FakePiSpec {
  return {
    state: { sessionId: TEST_SESSION_ID, thinkingLevel: TEST_THINKING_LEVEL, model: TEST_MODEL },
    models: [TEST_MODEL],
    levels: [TEST_THINKING_LEVEL],
    commands: TEST_COMMANDS,
  }
}

// ── Fixture ───────────────────────────────────────────────────────────────────

export interface AcpTestFixture {
  /** The fake Pi wired into the server: `emit`, `requestUi`, `calls`, `spawns`. */
  readonly fake: FakePiClient
  /** The real server under test. */
  readonly server: PiAcpServer
  /** Agent-side methods as the client sees them (initialize, session/*). */
  readonly client: acp.ClientContext
  /** Client-side methods as the agent sees them, for driving a client-bound
   * round-trip without a whole turn behind it. */
  readonly agent: acp.AgentContext
  /** The temp Pi session store this fixture's server reads; removed by `close`. */
  readonly sessionRoot: string

  /** Client-bound messages recorded so far, oldest first. */
  transcript(ignoredFields?: readonly string[]): readonly AcpRecord[]
  clearTranscript(): void

  /** Lets the deferred `available_commands_update` macrotask run; it is sent a
   * macrotask after the `session/new` response, never before it. */
  flushAnnouncements(): Promise<void>

  /** A promise that never settles models a user leaving the dialog open. */
  setPermissionResponse(response: RequestPermissionResponse | Promise<RequestPermissionResponse>): void

  close(): Promise<void>
}

export function createAcpTestFixture(spec: Partial<FakePiSpec> = {}): AcpTestFixture {
  const fake = makeFakePiClient({ ...defaultFakePiSpec(), ...spec })
  const sessionRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX))
  const sessionDirs: SessionDirs = { mode: 'perCwd', root: sessionRoot }
  const server = new PiAcpServer({
    launch: LAUNCH,
    rpcTimeoutMs: RPC_TIMEOUT_MS,
    sessionDirs,
    mcpExtensionPath: MCP_EXTENSION_PATH,
    createPiClient: fake.createPiClient,
  })

  const records: AcpRecord[] = []
  const record = (kind: AcpRecordKind, method: string, params: unknown): void => {
    records.push({ kind, method, params })
  }

  let permissionResponse: RequestPermissionResponse | Promise<RequestPermissionResponse> = DEFAULT_PERMISSION_RESPONSE

  // Only the two client methods the adapter actually calls are handled; any
  // other must surface as a protocol error rather than a silent success.
  const clientApp = acp
    .client({ name: TEST_CLIENT_NAME })
    .onNotification(acp.methods.client.session.update, (context) => {
      record('notification', acp.methods.client.session.update, context.params)
    })
    .onRequest(acp.methods.client.session.requestPermission, (context) => {
      record('request', acp.methods.client.session.requestPermission, context.params)
      return permissionResponse
    })

  const agentContexts: acp.AgentContext[] = []
  const agentApp = server.register(acp.agent({ name: AGENT_NAME })).onConnect((connection) => {
    agentContexts.push(connection.client)
  })

  const connection = clientApp.connect(agentApp)
  const agent = agentContexts[0]
  if (agent === undefined) throw new Error('acp test fixture: the agent connect handler did not run')

  return {
    fake,
    server,
    client: connection.agent,
    agent,
    sessionRoot,

    transcript(ignoredFields: readonly string[] = []): readonly AcpRecord[] {
      const fields = new Set(ignoredFields)
      return records.map((entry) => ({
        kind: entry.kind,
        method: entry.method,
        params: anonymizeValue(entry.params, [], fields),
      }))
    },
    clearTranscript(): void {
      records.length = 0
    },
    async flushAnnouncements(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    setPermissionResponse(response: RequestPermissionResponse | Promise<RequestPermissionResponse>): void {
      permissionResponse = response
    },
    async close(): Promise<void> {
      // Stopped before the connection closes, so no fake session outlives the
      // fixture with a turn still waiting on events nobody will send.
      await server.stopAllSessions()
      connection.close()
      rmSync(sessionRoot, { recursive: true, force: true })
    },
  }
}
