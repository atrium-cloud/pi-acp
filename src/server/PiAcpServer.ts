import * as acp from '@agentclientprotocol/sdk'
import type {
  AgentContext,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
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
} from '../constants.js'
import type { PiLaunch } from '../pi/errors.js'
import type { CreatePiClient, SessionConnection } from '../session/SessionConnection.js'
import { establishSession } from '../session/sessionSetup.js'
import { toRequestError } from './errors.js'

export interface PiAcpServerOptions {
  readonly launch: PiLaunch
  readonly rpcTimeoutMs: number
  /** Injectable for tests; defaults to spawning a real Pi RPC subprocess. */
  readonly createPiClient?: CreatePiClient | undefined
}

export class PiAcpServer {
  private readonly options: PiAcpServerOptions
  private readonly sessions = new Map<string, SessionConnection>()
  private stopped = false

  constructor(options: PiAcpServerOptions) {
    this.options = options
  }

  register(app: acp.AgentApp): acp.AgentApp {
    return app
      .onRequest(acp.methods.agent.initialize, (context) => this.initialize(context.params))
      .onRequest(acp.methods.agent.authenticate, () => this.authenticate())
      .onRequest(acp.methods.agent.session.new, (context) => this.guard(() => this.newSession(context)))
      .onRequest(acp.methods.agent.session.setConfigOption, (context) =>
        this.guard(() => this.setConfigOption(context)),
      )
  }

  /** Stops every session subprocess; called once the client connection closes.
   * `stopped` closes the window where a `session/new` still in flight would
   * register a subprocess into the just-cleared map and orphan it. */
  async stopAllSessions(): Promise<void> {
    this.stopped = true
    const connections = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(connections.map((connection) => connection.stop()))
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: AGENT_NAME, title: AGENT_TITLE, version: AGENT_VERSION },
      // Text and resource_link are ACP baseline (no capability flag); only what
      // is actually implemented is advertised, and nothing else is yet.
      agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
    }
  }

  async newSession(context: { params: NewSessionRequest; client: AgentContext }): Promise<NewSessionResponse> {
    const established = await establishSession(context.params, {
      launch: this.options.launch,
      rpcTimeoutMs: this.options.rpcTimeoutMs,
      notifier: context.client,
      createPiClient: this.options.createPiClient,
    })
    if (this.stopped || this.sessions.has(established.sessionId)) {
      await established.connection.stop()
      throw new acp.RequestError(
        JSONRPC_INTERNAL_ERROR,
        this.stopped
          ? 'the client connection closed during session setup'
          : `Pi returned a duplicate session id "${established.sessionId}"`,
      )
    }
    this.sessions.set(established.sessionId, established.connection)
    established.connection.announceCommands(established.availableCommands)
    return { sessionId: established.sessionId, configOptions: established.configOptions }
  }

  async setConfigOption(context: {
    params: SetSessionConfigOptionRequest
  }): Promise<SetSessionConfigOptionResponse> {
    const params = context.params
    const connection = this.sessions.get(params.sessionId)
    if (connection === undefined) {
      throw new acp.RequestError(JSONRPC_INVALID_PARAMS, `unknown session "${params.sessionId}"`)
    }
    if ('type' in params && params.type === 'boolean') {
      throw new acp.RequestError(JSONRPC_INVALID_PARAMS, 'boolean config options are not offered')
    }
    if (typeof params.value !== 'string') {
      throw new acp.RequestError(JSONRPC_INVALID_PARAMS, 'a config option value must be a string')
    }
    const configOptions = await connection.applyConfigOption(params.configId, params.value)
    return { configOptions }
  }

  /** No auth methods are advertised, so the client must never call this. It is
   * invalid_params, not method_not_found: authenticate IS handled, but any
   * methodId is invalid when the set of offered methods is empty. */
  authenticate(): never {
    throw new acp.RequestError(
      JSONRPC_INVALID_PARAMS,
      `${AGENT_NAME}: no authentication methods are advertised; Pi resolves credentials from its own environment`,
    )
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
