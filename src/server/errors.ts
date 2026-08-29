import * as acp from '@agentclientprotocol/sdk'

import { JSONRPC_INTERNAL_ERROR } from '../constants.js'

/** Any non-`RequestError` thrown from a handler reaches the wire as literal
 * "Internal error" with the real text buried in `data`. This preserves the
 * message: a `RequestError` (a deliberate protocol error) passes through, and a
 * transport error (`PiSpawnError`, `PiRpcTimeoutError`, …) becomes an
 * internal-error `RequestError` carrying its message. */
export function toRequestError(error: unknown): acp.RequestError {
  if (error instanceof acp.RequestError) return error
  return new acp.RequestError(JSONRPC_INTERNAL_ERROR, asMessage(error))
}

export function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
