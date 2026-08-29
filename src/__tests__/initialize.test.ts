import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { AGENT_NAME, AGENT_TITLE, AGENT_VERSION, JSONRPC_INVALID_PARAMS, PROTOCOL_VERSION } from '../constants.js'
import { PiAcpServer } from '../server/PiAcpServer.js'

function makeServer(): PiAcpServer {
  return new PiAcpServer({ launch: { command: 'pi', args: ['--mode', 'rpc'], source: 'test' } })
}

const INIT_REQUEST = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }

function callInitialize(server: PiAcpServer): Promise<acp.InitializeResponse> {
  const app = server.register(acp.agent({ name: AGENT_NAME }))
  return acp
    .client({ name: 'test-client' })
    .connectWith(app, (context) => context.request(acp.methods.agent.initialize, INIT_REQUEST))
}

describe('initialize (over an ACP connection)', () => {
  it('advertises honest minimal capabilities', async () => {
    const result = await callInitialize(makeServer())
    expect(result).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: AGENT_NAME, title: AGENT_TITLE, version: AGENT_VERSION },
      agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
    })
  })
})

describe('authenticate', () => {
  it('rejects with invalid-params because no auth methods are advertised', () => {
    const error = (() => {
      try {
        makeServer().authenticate()
        return undefined
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(acp.RequestError)
    expect(error).toMatchObject({ code: JSONRPC_INVALID_PARAMS })
    expect((error as acp.RequestError).message).toMatch(/no authentication methods are advertised/)
  })

  it('rejects over the wire with the invalid-params code and message intact', async () => {
    const app = makeServer().register(acp.agent({ name: AGENT_NAME }))
    const error = await acp
      .client({ name: 'test-client' })
      .connectWith(app, (context) =>
        context.request(acp.methods.agent.authenticate, { methodId: 'whatever' }).then(
          () => undefined,
          (caught: unknown) => caught,
        ),
      )
    expect(error).toMatchObject({ code: JSONRPC_INVALID_PARAMS })
    expect((error as Error).message).toMatch(/no authentication methods are advertised/)
  })
})
