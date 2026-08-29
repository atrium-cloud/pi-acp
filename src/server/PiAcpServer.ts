import { unlink } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'
import type {
  AgentContext,
  AvailableCommand,
  CancelNotification,
  CloseSessionRequest,
  CloseSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionInfo,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk'

import {
  AGENT_NAME,
  AGENT_TITLE,
  AGENT_VERSION,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  PROTOCOL_VERSION,
  SESSION_LIST_CURSOR_PATTERN,
  SESSION_LIST_PAGE_SIZE,
} from '../constants.js'
import type { PiLaunch } from '../pi/errors.js'
import {
  findSessionFile,
  listSessions as listStoredSessions,
  readSessionEntries,
  readSessionInfo,
  type SessionDirs,
  type SessionFileInfo,
  settledEntries,
  writeForkFile,
} from '../session/sessionDirectory.js'
import type { CreatePiClient, SessionConnection } from '../session/SessionConnection.js'
import {
  type EstablishedSession,
  establishSession,
  type SessionSetupDeps,
  validateSessionRequest,
} from '../session/sessionSetup.js'
import { deriveTitle } from '../session/title.js'
import { flattenPromptContent } from '../turn/promptContent.js'
import { toRequestError } from './errors.js'

export interface PiAcpServerOptions {
  readonly launch: PiLaunch
  readonly rpcTimeoutMs: number
  /** Pi's own on-disk session store, resolved once at startup. */
  readonly sessionDirs: SessionDirs
  /** Absolute path to the permission gate extension (`-e`); omitted in tests. */
  readonly gateExtensionPath?: string | undefined
  /** Injectable for tests; defaults to spawning a real Pi RPC subprocess. */
  readonly createPiClient?: CreatePiClient | undefined
}

/** A session with a live Pi subprocess. The commands ride along so a resume or
 * load that reuses the subprocess can re-announce them without a round-trip. */
interface LiveSession {
  readonly connection: SessionConnection
  readonly commands: readonly AvailableCommand[]
}

export class PiAcpServer {
  private readonly options: PiAcpServerOptions
  private readonly sessions = new Map<string, LiveSession>()
  private stopped = false

  constructor(options: PiAcpServerOptions) {
    this.options = options
  }

  register(app: acp.AgentApp): acp.AgentApp {
    return app
      .onRequest(acp.methods.agent.initialize, (context) => this.initialize(context.params))
      .onRequest(acp.methods.agent.authenticate, () => this.authenticate())
      .onRequest(acp.methods.agent.session.new, (context) => this.guard(() => this.newSession(context)))
      .onRequest(acp.methods.agent.session.list, (context) => this.guard(() => this.listSessions(context)))
      .onRequest(acp.methods.agent.session.resume, (context) => this.guard(() => this.resumeSession(context)))
      .onRequest(acp.methods.agent.session.load, (context) => this.guard(() => this.loadSession(context)))
      .onRequest(acp.methods.agent.session.fork, (context) => this.guard(() => this.forkSession(context)))
      .onRequest(acp.methods.agent.session.close, (context) => this.guard(() => this.closeSession(context)))
      .onRequest(acp.methods.agent.session.delete, (context) => this.guard(() => this.deleteSession(context)))
      .onRequest(acp.methods.agent.session.setConfigOption, (context) =>
        this.guard(() => this.setConfigOption(context)),
      )
      .onRequest(acp.methods.agent.session.prompt, (context) => this.guard(() => this.prompt(context)))
      .onNotification(acp.methods.agent.session.cancel, (context) => {
        this.cancel(context.params)
      })
  }

  /** Stops every session subprocess; called once the client connection closes.
   * `stopped` closes the window where a `session/new` still in flight would
   * register a subprocess into the just-cleared map and orphan it. */
  async stopAllSessions(): Promise<void> {
    this.stopped = true
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map((session) => session.connection.stop()))
  }

  initialize(_params: InitializeRequest): InitializeResponse {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: AGENT_NAME, title: AGENT_TITLE, version: AGENT_VERSION },
      // Text and resource_link are ACP baseline (no capability flag). Image and
      // embedded context are inlined by session/prompt; audio is not supported.
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, fork: {}, close: {}, delete: {} },
      },
    }
  }

  async newSession(context: { params: NewSessionRequest; client: AgentContext }): Promise<NewSessionResponse> {
    const established = await establishSession(context.params, this.setupDeps(context.client))
    const session = await this.registerSession(established)
    session.connection.announceCommands(session.commands)
    return { sessionId: established.sessionId, configOptions: established.configOptions }
  }

  /** Pages over the store as it reads right now: the cursor is a plain offset
   * into the freshly sorted list, so a session added between pages can shift the
   * window. Pi has no stable list cursor to anchor to. */
  async listSessions(context: { params: ListSessionsRequest }): Promise<ListSessionsResponse> {
    const params = context.params
    const cwd = params.cwd ?? undefined
    if (cwd !== undefined && !isAbsolute(cwd)) throw invalidParams(`cwd must be an absolute path, got "${cwd}"`)
    const cursor = params.cursor ?? undefined
    if (cursor !== undefined && !SESSION_LIST_CURSOR_PATTERN.test(cursor)) {
      throw invalidParams(`cursor must be a whole-number offset, got "${cursor}"`)
    }

    const offset = cursor === undefined ? 0 : Number(cursor)
    const sessions = await listStoredSessions({ dirs: this.options.sessionDirs, cwd })
    const page = sessions.slice(offset, offset + SESSION_LIST_PAGE_SIZE)
    const nextOffset = offset + page.length
    return {
      sessions: page.map(toSessionInfo),
      ...(nextOffset < sessions.length ? { nextCursor: String(nextOffset) } : {}),
    }
  }

  async resumeSession(context: {
    params: ResumeSessionRequest
    client: AgentContext
  }): Promise<ResumeSessionResponse> {
    const session = await this.openSession(context.params, context.client)
    session.connection.announceCommands(session.commands)
    return { configOptions: session.connection.configOptions }
  }

  async loadSession(context: { params: LoadSessionRequest; client: AgentContext }): Promise<LoadSessionResponse> {
    const session = await this.openSession(context.params, context.client)
    // ACP puts the replayed history before the response, so this is awaited here
    // rather than deferred the way available_commands_update is.
    await session.connection.replayHistory()
    session.connection.announceCommands(session.commands)
    return { configOptions: session.connection.configOptions }
  }

  /** The adapter materializes the fork's file itself rather than handing Pi the
   * parent: Pi's own fork copies the parent verbatim, in-flight turn included,
   * and its RPC fork replaces the session inside the parent's own subprocess.
   * The result is opened like any stored session, so the fork is live and
   * promptable when this returns. */
  async forkSession(context: { params: ForkSessionRequest; client: AgentContext }): Promise<ForkSessionResponse> {
    const request = context.params
    validateSessionRequest(request)

    // Same lookup as an open; no header-cwd equality, since forking a session
    // into another project directory is the point of the method.
    const parentPath =
      (await findSessionFile({ dirs: this.options.sessionDirs, id: request.sessionId, cwd: request.cwd })) ??
      (await findSessionFile({ dirs: this.options.sessionDirs, id: request.sessionId }))
    // A parent that never flushed a turn has no file, so from the store it does
    // not exist — the same reading `session/resume` and `session/delete` take.
    if (parentPath === null) throw acp.RequestError.resourceNotFound(request.sessionId)

    const parent = this.sessions.get(request.sessionId)
    const entries = settledEntries(await readSessionEntries(parentPath), parent?.connection.hasActiveTurn ?? false)
    const fork = writeForkFile({ dirs: this.options.sessionDirs, parentPath, entries, cwd: request.cwd })

    let established: EstablishedSession
    try {
      established = await establishSession(request, this.setupDeps(context.client), {
        kind: 'open',
        sessionFile: fork.path,
        expectedSessionId: fork.id,
      })
    } catch (error) {
      // The client never receives the id, so a file left behind would be a
      // listable, resumable session nobody asked for.
      await unlink(fork.path)
      throw error
    }
    const session = await this.registerSession(established)
    session.connection.announceCommands(session.commands)
    return { sessionId: established.sessionId, configOptions: established.configOptions }
  }

  async closeSession(context: { params: CloseSessionRequest }): Promise<CloseSessionResponse> {
    const sessionId = context.params.sessionId
    const session = this.sessions.get(sessionId)
    if (session === undefined) throw invalidParams(`unknown session "${sessionId}"`)
    // Dropped before the teardown so a concurrent request sees it gone rather
    // than reaching a subprocess that is already stopping.
    this.sessions.delete(sessionId)
    await session.connection.close()
    return {}
  }

  async deleteSession(context: { params: DeleteSessionRequest }): Promise<DeleteSessionResponse> {
    const sessionId = context.params.sessionId
    // The file is located first: a delete that cannot find it must leave a live
    // session running. No cwd, so this scans the whole store.
    const sessionFile = await findSessionFile({ dirs: this.options.sessionDirs, id: sessionId })
    if (sessionFile === null) throw acp.RequestError.resourceNotFound(sessionId)

    const session = this.sessions.get(sessionId)
    if (session !== undefined) {
      this.sessions.delete(sessionId)
      await session.connection.close()
    }
    await unlink(sessionFile)
    return {}
  }

  async setConfigOption(context: {
    params: SetSessionConfigOptionRequest
  }): Promise<SetSessionConfigOptionResponse> {
    const params = context.params
    const session = this.sessions.get(params.sessionId)
    if (session === undefined) throw invalidParams(`unknown session "${params.sessionId}"`)
    if ('type' in params && params.type === 'boolean') {
      throw invalidParams('boolean config options are not offered')
    }
    if (typeof params.value !== 'string') {
      throw invalidParams('a config option value must be a string')
    }
    const configOptions = await session.connection.applyConfigOption(params.configId, params.value)
    return { configOptions }
  }

  async prompt(context: { params: PromptRequest; signal: AbortSignal }): Promise<PromptResponse> {
    const session = this.sessions.get(context.params.sessionId)
    if (session === undefined) throw invalidParams(`unknown session "${context.params.sessionId}"`)
    const prompt = flattenPromptContent(context.params.prompt)
    const stopReason = await session.connection.runPrompt(prompt, context.signal)
    return { stopReason }
  }

  cancel(params: CancelNotification): void {
    this.sessions.get(params.sessionId)?.connection.cancel()
  }

  /** No auth methods are advertised, so the client must never call this. It is
   * invalid_params, not method_not_found: authenticate IS handled, but any
   * methodId is invalid when the set of offered methods is empty. */
  authenticate(): never {
    throw invalidParams(
      `${AGENT_NAME}: no authentication methods are advertised; Pi resolves credentials from its own environment`,
    )
  }

  /** The shared `session/resume` and `session/load` path. A live id is reused
   * rather than opened twice: Pi takes no lock on the file, so a second
   * subprocess on it would interleave appends. */
  private async openSession(
    request: ResumeSessionRequest | LoadSessionRequest,
    client: AgentContext,
  ): Promise<LiveSession> {
    validateSessionRequest(request)

    const live = this.sessions.get(request.sessionId)
    if (live !== undefined) {
      if (!samePath(live.connection.cwd, request.cwd)) {
        throw invalidParams(
          `session "${request.sessionId}" is open for cwd "${live.connection.cwd}", not "${request.cwd}"`,
        )
      }
      return live
    }

    // The request cwd narrows the scan; a miss there falls back to the whole
    // store so a session that belongs to another cwd is refused as such rather
    // than reported missing.
    const sessionFile =
      (await findSessionFile({ dirs: this.options.sessionDirs, id: request.sessionId, cwd: request.cwd })) ??
      (await findSessionFile({ dirs: this.options.sessionDirs, id: request.sessionId }))
    if (sessionFile === null) throw acp.RequestError.resourceNotFound(request.sessionId)

    // Pi adopts the header cwd on `--session` without checking the process cwd,
    // so the equality is enforced here, before anything is spawned.
    const stored = await readSessionInfo(sessionFile)
    if (stored === null) throw acp.RequestError.resourceNotFound(request.sessionId)
    if (!samePath(stored.cwd, request.cwd)) {
      throw invalidParams(
        `session "${request.sessionId}" belongs to cwd "${stored.cwd}", not "${request.cwd}"`,
      )
    }

    const established = await establishSession(request, this.setupDeps(client), {
      kind: 'open',
      sessionFile,
      expectedSessionId: request.sessionId,
    })
    return await this.registerSession(established)
  }

  private async registerSession(established: EstablishedSession): Promise<LiveSession> {
    if (this.stopped || this.sessions.has(established.sessionId)) {
      await established.connection.stop()
      throw new acp.RequestError(
        JSONRPC_INTERNAL_ERROR,
        this.stopped
          ? 'the client connection closed during session setup'
          : `Pi returned a duplicate session id "${established.sessionId}"`,
      )
    }
    const session: LiveSession = { connection: established.connection, commands: established.availableCommands }
    this.sessions.set(established.sessionId, session)
    return session
  }

  private setupDeps(client: AgentContext): SessionSetupDeps {
    return {
      launch: this.options.launch,
      rpcTimeoutMs: this.options.rpcTimeoutMs,
      notifier: client,
      gateExtensionPath: this.options.gateExtensionPath,
      createPiClient: this.options.createPiClient,
    }
  }

  /** Maps a transport error thrown from a handler onto a message-preserving
   * `RequestError`; a `RequestError` (a deliberate protocol error) passes through. */
  private async guard<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op()
    } catch (error) {
      throw toRequestError(error)
    }
  }
}

function toSessionInfo(info: SessionFileInfo): SessionInfo {
  return {
    sessionId: info.id,
    cwd: info.cwd,
    title: sessionTitle(info),
    updatedAt: info.modified.toISOString(),
  }
}

/** Pi's own session picker shows the name when there is one and the opening user
 * message otherwise; `null` for a session with neither. */
function sessionTitle(info: SessionFileInfo): string | null {
  if (info.name !== undefined) return info.name
  if (info.firstMessage === undefined) return null
  return deriveTitle(info.firstMessage) || null
}

/** An empty header cwd never matches: `resolve("")` is the adapter's own cwd. */
function samePath(left: string, right: string): boolean {
  return left !== '' && right !== '' && resolve(left) === resolve(right)
}

function invalidParams(message: string): acp.RequestError {
  return new acp.RequestError(JSONRPC_INVALID_PARAMS, message)
}
