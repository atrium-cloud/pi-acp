#!/usr/bin/env node

import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'

import { AGENT_NAME, AGENT_VERSION, resolveRpcTimeoutMs } from './constants.js'
import { materializeMcpExtension } from './mcp/extension.js'
import { materializeGate } from './permissions/gate.js'
import { resolvePiLaunch } from './pi/launch.js'
import { PiAcpServer } from './server/PiAcpServer.js'
import { resolveSessionDirs } from './session/sessionDirectory.js'

// The SDK resolves `connection.closed` for both a clean stdin EOF and a
// transport failure, distinguishing them only by the abort reason: a clean
// close synthesizes exactly this message, an error close carries the real
// error (SDK jsonrpc `close()`).
const CLEAN_CLOSE_MESSAGE = 'ACP connection closed'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function main(): Promise<void> {
  if (process.argv.includes('--version')) {
    console.log(`${AGENT_NAME} ${AGENT_VERSION}`)
    return
  }

  const server = new PiAcpServer({
    launch: resolvePiLaunch(process.env),
    rpcTimeoutMs: resolveRpcTimeoutMs(process.env),
    // The subprocess inherits this environment, so both sides resolve the same
    // store; a later env change does not move it under a running adapter.
    sessionDirs: resolveSessionDirs(process.env),
    // Written once at startup; every session loads it with `-e`.
    gateExtensionPath: materializeGate(),
    // Written alongside the gate; loaded only by a session that asked for MCP.
    mcpExtensionPath: materializeMcpExtension(),
  })

  // The SDK speaks Web streams; first arg is the writable (stdout).
  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))

  const connection = server.register(acp.agent({ name: AGENT_NAME })).connect(stream)
  await connection.closed

  // The transport close reason is the diagnostic that matters, so teardown is
  // caught and logged rather than allowed to throw over it.
  const reason = connection.signal.reason
  try {
    await server.stopAllSessions()
  } catch (teardownError) {
    console.error(`[${AGENT_NAME}] session teardown failed: ${errorMessage(teardownError)}`)
  }
  if (reason instanceof Error && reason.message !== CLEAN_CLOSE_MESSAGE) throw reason
}

main().catch((error: unknown) => {
  console.error(`[${AGENT_NAME}] fatal: ${errorMessage(error)}`)
  process.exit(1)
})
