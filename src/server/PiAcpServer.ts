import { unlink } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import * as acp from '@agentclientprotocol/sdk/unstable'
import type {
  AgentContext,
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
} from '@agentclientprotocol/sdk/unstable'

import {
  AGENT_NAME,
  AGENT_TITLE,
  AGENT_VERSION,
  CATALOG_REFRESH_INTERVAL_MS,
  CATALOG_REFRESH_STARTUP_DELAY_MS,
  ENV_MANUAL_SESSION_TITLES,
  ENV_PROVIDER_MODELS,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  LAUNCH_ENV_METHOD,
  LAUNCH_ENV_NAME_PATTERN,
  LAUNCH_ENV_VALUE_PATTERN,
  META_KEY_LAUNCH_ENV,
  META_KEY_LAUNCH_ENV_NAMESPACE,
  parseManualSessionTitles,
  parseProviderModels,
  PROTOCOL_VERSION,
  type ProviderModels,
  SESSION_ENTRY_TYPE_HEADER,
  SESSION_LIST_CURSOR_PATTERN,
  SESSION_LIST_PAGE_SIZE,
} from '../constants.js'
import type { PiLaunch } from '../pi/errors.js'
import { startupTimingLogLine } from '../pi/startupTimings.js'
import {
  branchEntriesBefore,
  branchUserEntryIds,
  findSessionFile,
  listSessions as listStoredSessions,
  readSessionEntries,
  readSessionInfo,
  type SessionDirs,
  type SessionFileEntry,
  type SessionFileInfo,
  settledEntries,
  writeForkFile,
} from '../session/sessionDirectory.js'
import { CatalogRefresher } from '../session/catalogRefresh.js'
import type { CreatePiClient, LaunchEnvironment, SessionConnection } from '../session/SessionConnection.js'
import {
  defaultCreatePiClient,
  type EstablishedSession,
  establishSession,
  piExtensionArgs,
  type SessionSetupDeps,
  type SessionSetupRequest,
  validateSessionRequest,
  withLaunchEnv,
} from '../session/sessionSetup.js'
import { deriveTitle } from '../session/title.js'
import { WarmSpare } from '../session/warmSpare.js'
import { entryIdOfCursor } from '../turn/cursors.js'
import { flattenPromptContent } from '../turn/promptContent.js'
import { toRequestError } from './errors.js'

export interface PiAcpServerOptions {
  readonly launch: PiLaunch
  readonly rpcTimeoutMs: number
  /** Pi's own on-disk session store, resolved once at startup. */
  readonly sessionDirs: SessionDirs
  /** Absolute path to the permission gate extension (`-e`); omitted in tests. */
  readonly gateExtensionPath?: string | undefined
  /** Absolute path to the MCP extension, loaded only by a session whose request
   * carries `mcpServers`. */
  readonly mcpExtensionPath: string
  /** Command names left out of every session's advertised commands. */
  readonly hiddenCommands: ReadonlySet<string>
  /** Provider ids whose models are left out of every session's model list until
   * a launch env request replaces the list; undefined hides none. */
  readonly hiddenProviders?: ReadonlySet<string> | undefined
  /** The start-time `PI_ACP_PROVIDER_MODELS`, kept until a launch env request sets
   * or unsets it; undefined narrows nothing. */
  readonly providerModels?: ProviderModels | undefined
  /** The start-time `PI_ACP_MANUAL_SESSION_TITLES`, kept until a launch env request
   * sets or unsets it; absent leaves automatic naming on. */
  readonly manualSessionTitles?: boolean | undefined
  readonly logStartupTiming: boolean
  /** Injectable for tests; defaults to spawning a real Pi RPC subprocess. */
  readonly createPiClient?: CreatePiClient | undefined
  /** The warm spare's age cap; undefined leaves the spare off. */
  readonly warmSpareMaxAgeMs?: number | undefined
  /** How long a session idles before its subprocess is stopped; undefined leaves
   * idle teardown off. */
  readonly idleTimeoutMs?: number | undefined
  /** Absolute path to the catalog refresh extension; absent leaves the refresher off. */
  readonly catalogRefreshExtensionPath?: string | undefined
  /** Injectable for tests; CATALOG_REFRESH_STARTUP_DELAY_MS when unset. */
  readonly catalogRefreshStartupDelayMs?: number | undefined
  /** Injectable for tests; CATALOG_REFRESH_INTERVAL_MS when unset. */
  readonly catalogRefreshIntervalMs?: number | undefined
}

/** A registered session, its subprocess live or stopped at idle. The setup
 * request rides along so a warm spare refilled after a prompt starts like it. */
interface LiveSession {
  readonly connection: SessionConnection
  readonly setup: SessionSetupRequest
}

export class PiAcpServer {
  private readonly options: PiAcpServerOptions
  private readonly sessions = new Map<string, LiveSession>()
  private readonly warmSpare: WarmSpare | undefined
  private readonly catalogRefresher: CatalogRefresher | undefined
  private stopped = false
  private clientSupportsNotices = false
  private clientSupportsCursors = false
  /** Replaced whole by each launch env request; every later Pi launch reads it. */
  private launchEnvironment: LaunchEnvironment

  constructor(options: PiAcpServerOptions) {
    this.options = options
    this.launchEnvironment = {
      env: {},
      unset: [],
      hiddenProviders: options.hiddenProviders,
      providerModels: options.providerModels,
      manualSessionTitles: options.manualSessionTitles === true,
    }
    this.warmSpare = options.warmSpareMaxAgeMs === undefined ? undefined : new WarmSpare(options.warmSpareMaxAgeMs)
    const createPiClient = options.createPiClient ?? defaultCreatePiClient
    this.catalogRefresher =
      options.catalogRefreshExtensionPath === undefined
        ? undefined
        : new CatalogRefresher({
            launch: options.launch,
            rpcTimeoutMs: options.rpcTimeoutMs,
            cwd: process.cwd(),
            sessionExtensionArgs: piExtensionArgs(options),
            extensionPath: options.catalogRefreshExtensionPath,
            startupDelayMs: options.catalogRefreshStartupDelayMs ?? CATALOG_REFRESH_STARTUP_DELAY_MS,
            intervalMs: options.catalogRefreshIntervalMs ?? CATALOG_REFRESH_INTERVAL_MS,
            createPiClient: (refreshOptions) => createPiClient(withLaunchEnv(refreshOptions, this.launchEnvironment)),
          })
    this.catalogRefresher?.start()
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
      .onRequest(
        LAUNCH_ENV_METHOD,
        (params) => parseLaunchEnvRequest(params, this.options),
        (context) => this.setLaunchEnvironment(context.params),
      )
  }

  /** Stops every session subprocess, the warm spare and the catalog refresher;
   * called once the client connection closes. `stopped` closes the window where a
   * `session/new` still in flight would register a subprocess into the
   * just-cleared map and orphan it. */
  async stopAllSessions(): Promise<void> {
    this.stopped = true
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all([
      ...sessions.map((session) => session.connection.stop()),
      this.warmSpare?.stop(),
      this.catalogRefresher?.stop(),
    ])
  }

  initialize(params: InitializeRequest): InitializeResponse {
    this.clientSupportsNotices = (params.clientCapabilities?.session?.notices ?? null) !== null
    this.clientSupportsCursors = (params.clientCapabilities?.session?.cursors ?? null) !== null
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: AGENT_NAME, title: AGENT_TITLE, version: AGENT_VERSION },
      // Text and resource_link are ACP baseline (no capability flag). Image and
      // embedded context are inlined by session/prompt; audio is not supported.
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        // HTTP is served by Pi's own built-in MCP support, which rejects SSE; the
        // experimental `acp` transport has no client to proxy to and is refused.
        mcpCapabilities: { http: true, sse: false },
        sessionCapabilities: {
          list: {},
          resume: {},
          fork: {},
          close: {},
          delete: {},
        },
        _meta: { [META_KEY_LAUNCH_ENV_NAMESPACE]: { [META_KEY_LAUNCH_ENV]: {} } },
      },
    }
  }

  /** Every later Pi launch takes `environment`. A session's subprocess started on
   * the previous one is stopped once idle, and its next request wakes it on this
   * one; the warm spare is dropped. */
  setLaunchEnvironment(environment: LaunchEnvironment): Record<string, never> {
    // A parent replays its applies, so a request matching the current state restarts nothing.
    if (sameLaunchEnvironment(this.launchEnvironment, environment)) return {}
    this.launchEnvironment = environment
    this.warmSpare?.discard()
    for (const session of this.sessions.values()) session.connection.relaunchIfStale()
    return {}
  }

  async newSession(context: { params: NewSessionRequest; client: AgentContext }): Promise<NewSessionResponse> {
    const startedAt = performance.now()
    const request = context.params
    const spare = this.warmSpare === undefined ? null : await this.warmSpare.take(request)
    if (spare !== null) {
      const session = await this.registerSession(spare.established, request)
      session.connection.announceCommands()
      if (this.options.logStartupTiming) {
        const totalMs = Math.round(performance.now() - startedAt)
        console.error(startupTimingLogLine(spare.established.sessionId, { mode: 'take', ageMs: spare.ageMs, totalMs }))
      }
      return { sessionId: spare.established.sessionId, configOptions: spare.configOptions }
    }
    const established = await establishSession(request, this.setupDeps(context.client))
    const session = await this.registerSession(established, request)
    session.connection.announceCommands()
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
      sessions: page.map((info) => toSessionInfo(info, this.launchEnvironment.manualSessionTitles)),
      ...(nextOffset < sessions.length ? { nextCursor: String(nextOffset) } : {}),
    }
  }

  async resumeSession(context: {
    params: ResumeSessionRequest
    client: AgentContext
  }): Promise<ResumeSessionResponse> {
    const session = await this.openSession(context.params, context.client)
    session.connection.announceCommands()
    return { configOptions: session.connection.configOptions }
  }

  async loadSession(context: { params: LoadSessionRequest; client: AgentContext }): Promise<LoadSessionResponse> {
    const session = await this.openSession(context.params, context.client)
    // ACP puts the replayed history before the response, so this is awaited here
    // rather than deferred the way available_commands_update is.
    await session.connection.replayHistory()
    session.connection.announceCommands()
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

    const cursorId = request.cursorId ?? undefined
    // Read before the file: Pi appends the user entry before reporting it, so a
    // true flag means the snapshot holds that entry. A false one at worst copies
    // a prompt Pi has just appended, unanswered.
    const parentHasUnsettledTurn = this.sessions.get(request.sessionId)?.connection.hasUnsettledTurnInStore ?? false
    const parentEntries = await readSessionEntries(parentPath)
    const entries =
      cursorId === undefined
        ? settledEntries(parentEntries, parentHasUnsettledTurn)
        : cursorCut(parentEntries, cursorId, request.sessionId)
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
    const session = await this.registerSession(established, request)
    session.connection.announceCommands()
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

  async prompt(context: { params: PromptRequest; signal: AbortSignal; client: AgentContext }): Promise<PromptResponse> {
    const session = this.sessions.get(context.params.sessionId)
    if (session === undefined) throw invalidParams(`unknown session "${context.params.sessionId}"`)
    const prompt = flattenPromptContent(context.params.prompt)
    const { stopReason, usage } = await session.connection.runPrompt(prompt, context.signal)
    // Only once a prompt resolves, never at create or for a prompt refused
    // mid-turn, so the spawn stays off a running turn's CPU.
    this.warmSpare?.refill(session.setup, this.setupDeps(context.client))
    return { stopReason, ...(usage === undefined ? {} : { usage }) }
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
    return await this.registerSession(established, request)
  }

  private async registerSession(established: EstablishedSession, request: SessionSetupRequest): Promise<LiveSession> {
    if (this.stopped || this.sessions.has(established.sessionId)) {
      await established.connection.stop()
      throw new acp.RequestError(
        JSONRPC_INTERNAL_ERROR,
        this.stopped
          ? 'the client connection closed during session setup'
          : `Pi returned a duplicate session id "${established.sessionId}"`,
      )
    }
    const session: LiveSession = {
      connection: established.connection,
      setup: { cwd: request.cwd, mcpServers: request.mcpServers },
    }
    this.sessions.set(established.sessionId, session)
    if (this.options.idleTimeoutMs !== undefined) session.connection.enableIdleTeardown(this.options.idleTimeoutMs)
    // A launch env that arrived while this one was starting was not sent to it.
    session.connection.relaunchIfStale()
    return session
  }

  private setupDeps(client: AgentContext): SessionSetupDeps {
    return {
      launch: this.options.launch,
      rpcTimeoutMs: this.options.rpcTimeoutMs,
      notifier: client,
      clientSupportsNotices: this.clientSupportsNotices,
      clientSupportsCursors: this.clientSupportsCursors,
      gateExtensionPath: this.options.gateExtensionPath,
      mcpExtensionPath: this.options.mcpExtensionPath,
      hiddenCommands: this.options.hiddenCommands,
      launchEnvironment: () => this.launchEnvironment,
      logStartupTiming: this.options.logStartupTiming,
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

/** All three keys are required, and each replaces its whole part of the state.
 * The params carry key material, so a refusal names the key and never a value.
 * `PI_ACP_PROVIDER_MODELS` or `PI_ACP_MANUAL_SESSION_TITLES` in neither `env` nor
 * `unset` keeps the start-time value Pi inherits. */
function parseLaunchEnvRequest(
  params: unknown,
  inherited: Pick<PiAcpServerOptions, 'providerModels' | 'manualSessionTitles'>,
): LaunchEnvironment {
  const record: Record<string, unknown> = isRecord(params) ? params : {}
  const env = record['env']
  const unset = record['unset']
  const hideProviders = record['hideProviders']
  if (!isEnvMap(env)) throw invalidParams(`${LAUNCH_ENV_METHOD}: env must map variable names to string values`)
  if (!isStringList(unset) || !unset.every(isEnvName)) {
    throw invalidParams(`${LAUNCH_ENV_METHOD}: unset must be an array of variable names`)
  }
  if (!isStringList(hideProviders)) throw invalidParams(`${LAUNCH_ENV_METHOD}: hideProviders must be an array of strings`)
  const refuse = (message: string): acp.RequestError => invalidParams(`${LAUNCH_ENV_METHOD}: env ${message}`)
  const providerModels = Object.hasOwn(env, ENV_PROVIDER_MODELS)
    ? parseProviderModels(env[ENV_PROVIDER_MODELS], refuse)
    : unset.includes(ENV_PROVIDER_MODELS)
      ? undefined
      : inherited.providerModels
  const manualSessionTitles = Object.hasOwn(env, ENV_MANUAL_SESSION_TITLES)
    ? parseManualSessionTitles(env[ENV_MANUAL_SESSION_TITLES], refuse)
    : !unset.includes(ENV_MANUAL_SESSION_TITLES) && inherited.manualSessionTitles === true
  return { env, unset, hiddenProviders: new Set(hideProviders), providerModels, manualSessionTitles }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isEnvName(name: string): boolean {
  return LAUNCH_ENV_NAME_PATTERN.test(name)
}

function isEnvMap(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([name, entry]) => isEnvName(name) && typeof entry === 'string' && LAUNCH_ENV_VALUE_PATTERN.test(entry),
    )
  )
}

/** `unset` and the hide list compare as sets; an absent hide list hides none. */
function sameLaunchEnvironment(left: LaunchEnvironment, right: LaunchEnvironment): boolean {
  const names = Object.keys(left.env)
  return (
    names.length === Object.keys(right.env).length &&
    names.every((name) => left.env[name] === right.env[name]) &&
    sameSet(new Set(left.unset), new Set(right.unset)) &&
    sameSet(left.hiddenProviders ?? new Set(), right.hiddenProviders ?? new Set())
  )
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((entry) => right.has(entry))
}

/** The parent entries a fork at `cursorId` keeps: the ancestor path of the user
 * entry the cursor lies before, that entry excluded. Unlike the whole-session
 * copy this drops entries off the kept path, so an abandoned Pi-side branch does
 * not travel. Only a user entry on the current branch has a cursor, the branch
 * ending at the file's last entry as Pi reads it; any other id is refused,
 * never forked whole. */
function cursorCut(
  entries: readonly SessionFileEntry[],
  cursorId: string,
  sessionId: string,
): readonly SessionFileEntry[] {
  const entryId = entryIdOfCursor(cursorId)
  const leafId = entries.filter((entry) => entry.type !== SESSION_ENTRY_TYPE_HEADER).at(-1)?.id
  if (entryId === undefined || typeof leafId !== 'string' || !branchUserEntryIds(entries, leafId).includes(entryId)) {
    throw invalidParams(`cursor "${cursorId}" is not one session "${sessionId}" announced`)
  }
  return branchEntriesBefore(entries, entryId)
}

function toSessionInfo(info: SessionFileInfo, manualSessionTitles: boolean): SessionInfo {
  return {
    sessionId: info.id,
    cwd: info.cwd,
    title: sessionTitle(info, manualSessionTitles),
    updatedAt: info.modified.toISOString(),
  }
}

/** Pi's own session picker shows the name when there is one and the opening user
 * message otherwise; `null` for a session with neither, or with no name under
 * manual session titles. */
function sessionTitle(info: SessionFileInfo, manualSessionTitles: boolean): string | null {
  if (info.name !== undefined) return info.name
  if (manualSessionTitles || info.firstMessage === undefined) return null
  return deriveTitle(info.firstMessage) || null
}

/** An empty header cwd never matches: `resolve("")` is the adapter's own cwd. */
function samePath(left: string, right: string): boolean {
  return left !== '' && right !== '' && resolve(left) === resolve(right)
}

function invalidParams(message: string): acp.RequestError {
  return new acp.RequestError(JSONRPC_INVALID_PARAMS, message)
}
