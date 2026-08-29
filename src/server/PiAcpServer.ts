import * as acp from '@agentclientprotocol/sdk'
import type { InitializeRequest, InitializeResponse } from '@agentclientprotocol/sdk'

import { AGENT_NAME, AGENT_TITLE, AGENT_VERSION, JSONRPC_INVALID_PARAMS, PROTOCOL_VERSION } from '../constants.js'
import type { PiLaunch } from '../pi/errors.js'

export interface PiAcpServerOptions {
  readonly launch: PiLaunch
}

export class PiAcpServer {
  private readonly options: PiAcpServerOptions

  constructor(options: PiAcpServerOptions) {
    this.options = options
  }

  register(app: acp.AgentApp): acp.AgentApp {
    return app
      .onRequest(acp.methods.agent.initialize, (context) => this.initialize(context.params))
      .onRequest(acp.methods.agent.authenticate, () => this.authenticate())
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

  /** No auth methods are advertised, so the client must never call this. It is
   * invalid_params, not method_not_found: authenticate IS handled, but any
   * methodId is invalid when the set of offered methods is empty. */
  authenticate(): never {
    throw new acp.RequestError(
      JSONRPC_INVALID_PARAMS,
      `${AGENT_NAME}: no authentication methods are advertised; Pi resolves credentials from its own environment`,
    )
  }
}
