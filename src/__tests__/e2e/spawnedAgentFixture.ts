/**
 * The live-tier fixture: spawn the BUILT adapter as a subprocess, drive it as a
 * real ACP client over stdio, and tear it and its scratch session store down.
 *
 * The subject is `dist/index.js`, not the TypeScript sources: the bundle is what
 * ships and what clients execute, so a tier that never loads it would miss the
 * entry and transport breakage it exists to catch (.rules requires a dist smoke
 * run for transport changes).
 *
 * Credentials come from the host. Pi resolves its provider auth and model list
 * from its own agent dir, and there is no non-interactive way to hand a stored
 * credential to a scratch one, so this tier runs on a machine whose Pi is
 * already authorized and passes no key of its own. What it does isolate is the
 * session store: `PI_CODING_AGENT_SESSION_DIR` points both Pi and the adapter at
 * one flat scratch directory, so a live run never writes into the developer's
 * real sessions.
 */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import * as acp from '@agentclientprotocol/sdk'
import type {
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
} from '@agentclientprotocol/sdk'
import { vi } from 'vitest'

import {
  CONFIG_ID_MODEL,
  ENV_PI_AGENT_DIR,
  ENV_PI_SESSION_DIR,
  ENV_RPC_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SIGTERM_GRACE_MS,
} from '../../constants.js'
import { E2E_MODEL_VALUE_ID } from './e2eGate.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const E2E_CLIENT_NAME = 'pi-acp-e2e-client'
const SCRATCH_PREFIX = 'pi-acp-e2e-'
const SESSION_DIRNAME = 'pi-sessions'
const WORKSPACE_DIRNAME = 'workspace'

/** dist/index.js, relative to this file (src/__tests__/e2e). */
const DIST_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js')

/** An explicit `node`, never `process.execPath`: vitest may run under bun, and
 * the adapter launches Pi with its own `process.execPath`, which under bun dies
 * at startup. */
const NODE_COMMAND = 'node'

/** The adapter's own variables and Pi's agent and session directories, dropped
 * wholesale from the child environment rather than letting host config (a Pi
 * binary override, a session-dir override, a stale RPC timeout) steer this tier.
 * Pi's unprefixed variables are left alone: they configure the host install this
 * tier deliberately runs against. What the tier needs is re-added below. */
const HERMETIC_ENV_PREFIXES: readonly string[] = ['PI_ACP_', 'PI_CODING_AGENT_']

/** Pi's cold start outlasts the adapter's default 30s round-trip bound on a
 * CI-class VM, so the child gets a wider one. */
const E2E_RPC_TIMEOUT_MS = '120000'

/** Permission round-trips fail closed here exactly as they do in the snapshot
 * tier: an unanswered request is a denial, never an allow. */
const FAIL_CLOSED_PERMISSION: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }

/** Redaction applied to every captured child log line before it can reach a test
 * report: .rules forbids logging secrets, and the host key this tier runs on is
 * live in the Pi process, which can name it in a request error. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /(authorization:\s*bearer\s+)\S+/gi,
  // Everything after the marker goes: keeping a few characters of an `sk-` key
  // would still publish part of the real secret.
  /(sk-)[A-Za-z0-9_-]+/g,
  /((?:api[_-]?key|token)["'\s:=]+)\S+/gi,
]
const REDACTED = '$1<redacted>'

const POLL_INTERVAL_MS = 50

export interface ScratchPaths {
  readonly sessionDir: string
  readonly workspace: string
}

export type PermissionAnswer = (request: RequestPermissionRequest) => RequestPermissionResponse

export interface SpawnedAgentOptions {
  /** Extra child environment, applied last. */
  readonly env?: Readonly<Record<string, string>>
  /** Run against an existing session dir instead of a fresh one — what a
   * second-process load needs, since a stored session only exists in the store
   * that created it. Paths passed in are NOT removed on stop; whoever made them
   * owns them. */
  readonly paths?: ScratchPaths
  /** Scripted answer for a permission request; absent means fail closed. */
  readonly onPermission?: PermissionAnswer
}

export interface SpawnedAgent {
  /** The scratch `PI_CODING_AGENT_SESSION_DIR` sessions are stored in. */
  readonly sessionDir: string
  /** The scratch workspace sessions are opened at. */
  readonly workspace: string
  readonly child: ChildProcessWithoutNullStreams
  /** Agent-side ACP methods (initialize, session/*), as a client sees them. */
  readonly agent: acp.ClientContext
  /** Every `session/update` received, in arrival order. */
  readonly updates: readonly SessionNotification[]
  /** Every `session/request_permission` received, in arrival order. */
  readonly permissionRequests: readonly RequestPermissionRequest[]
  /** The updates received for one session, in arrival order. */
  sessionUpdates(sessionId: string): SessionUpdate[]
  /** Accumulated `agent_message_chunk` text for one session. */
  agentText(sessionId: string): string
  /** Wait until the accumulated agent text for `sessionId` matches. */
  waitForText(sessionId: string, matches: (text: string) => boolean, timeoutMs: number): Promise<string>
  /** Wait until one of `sessionId`'s updates matches, and return it. */
  waitForUpdate(sessionId: string, matches: (update: SessionUpdate) => boolean, timeoutMs: number): Promise<SessionUpdate>
  /** Answers the next permission requests; `null` restores fail-closed. A shared
   * boot reuses one client, so a case that scripts an answer resets it. */
  answerPermissions(handler: PermissionAnswer | null): void
  /** Captured child stderr, secret-scrubbed. */
  logDump(): string
  /** Close the connection, stop the child (SIGTERM then SIGKILL), remove the
   * scratch it owns. Safe to call twice. */
  stop(): Promise<void>
}

function scrub(text: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, REDACTED), text)
}

/** Scratch for one live run: an isolated flat session store plus the workspace
 * sessions are opened at. The caller owns `root` and must remove it — the
 * fixture only cleans up scratch it created itself. */
export function createScratchPaths(): { readonly root: string; readonly sessionDir: string; readonly workspace: string } {
  // Symlinks resolved here: Pi writes the header cwd from its own `process.cwd()`
  // without resolving them, while the adapter compares with `path.resolve`, which
  // does not either. A temp dir behind a symlink (macOS `/var` → `/private/var`)
  // would make the two spellings differ and fail a load for no real reason.
  const root = realpathSync(mkdtempSync(join(tmpdir(), SCRATCH_PREFIX)))
  const sessionDir = join(root, SESSION_DIRNAME)
  const workspace = join(root, WORKSPACE_DIRNAME)
  mkdirSync(sessionDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  return { root, sessionDir, workspace }
}

/** Spawn the built adapter against the host's Pi credentials and a scratch
 * session store, with no ACP wiring of its own. */
function spawnAgentProcess(
  sessionDir: string,
  workspace: string,
  options: SpawnedAgentOptions = {},
): ChildProcessWithoutNullStreams {
  // The one prefixed variable that is carried over rather than scrubbed: it
  // names the Pi install whose stored credentials this tier authenticates
  // against. Unset on the host means Pi's own default agent dir.
  const hostAgentDir = process.env[ENV_PI_AGENT_DIR]
  return spawn(NODE_COMMAND, [DIST_ENTRY], {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !HERMETIC_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))),
      ),
      ...(hostAgentDir === undefined ? {} : { [ENV_PI_AGENT_DIR]: hostAgentDir }),
      [ENV_PI_SESSION_DIR]: sessionDir,
      [ENV_RPC_TIMEOUT_MS]: E2E_RPC_TIMEOUT_MS,
      ...options.env,
    },
  })
}

/** SIGTERM, then SIGKILL if the child is still up after the grace window. */
async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  // A child killed by a signal reports `signalCode`, not an exit code, and
  // `killed` only records kills sent through this handle; without the signal
  // check an already-dead adapter would be waited on forever.
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => {
      resolveExit()
    })
  })
  child.kill('SIGTERM')
  const killer = setTimeout(() => {
    child.kill('SIGKILL')
  }, SIGTERM_GRACE_MS)
  try {
    await exited
  } finally {
    clearTimeout(killer)
  }
}

/**
 * Spawn the built adapter and connect to it as an ACP client.
 *
 * `initialize` runs here: every case needs it, and a handshake failure should
 * surface as the fixture failing with the child's log rather than as a confusing
 * method error inside the first test.
 */
export async function createSpawnedAgent(options: SpawnedAgentOptions = {}): Promise<SpawnedAgent> {
  // The scratch this fixture created itself, and therefore removes on stop;
  // paths handed in belong to the caller and are left alone.
  let ownedRoot: string | null = null
  let paths: ScratchPaths
  if (options.paths === undefined) {
    const scratch = createScratchPaths()
    ownedRoot = scratch.root
    paths = { sessionDir: scratch.sessionDir, workspace: scratch.workspace }
  } else {
    paths = options.paths
  }
  const child = spawnAgentProcess(paths.sessionDir, paths.workspace, options)

  const logLines: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    logLines.push(scrub(chunk))
  })

  const updates: SessionNotification[] = []
  const permissionRequests: RequestPermissionRequest[] = []
  let permissionAnswer: PermissionAnswer | null = options.onPermission ?? null
  const clientApp = acp
    .client({ name: E2E_CLIENT_NAME })
    .onNotification(acp.methods.client.session.update, (context) => {
      updates.push(context.params)
    })
    .onRequest(acp.methods.client.session.requestPermission, (context) => {
      permissionRequests.push(context.params)
      return permissionAnswer?.(context.params) ?? FAIL_CLOSED_PERMISSION
    })

  const connection = clientApp.connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))

  let stopped = false
  const sessionUpdates = (sessionId: string): SessionUpdate[] =>
    updates.filter((notification) => notification.sessionId === sessionId).map((notification) => notification.update)
  const agentText = (sessionId: string): string =>
    sessionUpdates(sessionId)
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => (update.content.type === 'text' ? update.content.text : ''))
      .join('')

  const fixture: SpawnedAgent = {
    sessionDir: paths.sessionDir,
    workspace: paths.workspace,
    child,
    agent: connection.agent,
    updates,
    permissionRequests,
    sessionUpdates,
    agentText,
    async waitForText(sessionId, matches, timeoutMs) {
      return await vi.waitFor(
        () => {
          const text = agentText(sessionId)
          if (!matches(text)) throw new Error(`agent text has not matched yet: ${JSON.stringify(text)}`)
          return text
        },
        { timeout: timeoutMs, interval: POLL_INTERVAL_MS },
      )
    },
    async waitForUpdate(sessionId, matches, timeoutMs) {
      return await vi.waitFor(
        () => {
          const match = sessionUpdates(sessionId).find(matches)
          if (match === undefined) throw new Error(`no update has matched yet for session ${sessionId}`)
          return match
        },
        { timeout: timeoutMs, interval: POLL_INTERVAL_MS },
      )
    },
    answerPermissions(handler) {
      permissionAnswer = handler
    },
    logDump: () => logLines.join(''),
    async stop() {
      if (stopped) return
      stopped = true
      connection.close()
      await stopChild(child)
      if (ownedRoot !== null) rmSync(ownedRoot, { recursive: true, force: true })
    },
  }

  try {
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
  } catch (error) {
    await fixture.stop()
    throw new Error(`e2e: the spawned adapter failed to initialize: ${String(error)}\n${scrub(logLines.join(''))}`)
  }

  return fixture
}

/** Opens a session at the scratch workspace and pins the live model through the
 * adapter's own `session/set_config_option`, never by writing Pi config. */
export async function openPinnedSession(
  agent: SpawnedAgent,
  options: { readonly cwd?: string; readonly mcpServers?: readonly McpServer[] } = {},
): Promise<string> {
  const created = await agent.agent.request(acp.methods.agent.session.new, {
    cwd: options.cwd ?? agent.workspace,
    mcpServers: [...(options.mcpServers ?? [])],
  })
  await agent.agent.request(acp.methods.agent.session.setConfigOption, {
    sessionId: created.sessionId,
    configId: CONFIG_ID_MODEL,
    value: E2E_MODEL_VALUE_ID,
  })
  return created.sessionId
}
