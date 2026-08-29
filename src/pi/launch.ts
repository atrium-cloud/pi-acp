import { fileURLToPath } from 'node:url'

import { ENV_PI_BIN, PI_RPC_ENTRY_SPECIFIER, PI_RPC_MODE_ARGS } from '../constants.js'
import type { PiLaunch } from './errors.js'

export const BUNDLED_PI_SOURCE = `bundled ${PI_RPC_ENTRY_SPECIFIER}`

/** `PI_ACP_PI_BIN` runs a user-supplied `pi`; otherwise the Pi package this
 * adapter depends on is launched through its RPC entry under the current
 * Node. That entry hardcodes `--mode rpc`, so the mode args belong here, not
 * on the client. */
export function resolvePiLaunch(env: NodeJS.ProcessEnv = process.env): PiLaunch {
  const override = env[ENV_PI_BIN]
  if (override !== undefined && override !== '') {
    return { command: override, args: [...PI_RPC_MODE_ARGS], source: ENV_PI_BIN }
  }
  const entry = fileURLToPath(import.meta.resolve(PI_RPC_ENTRY_SPECIFIER))
  return { command: process.execPath, args: [entry], source: BUNDLED_PI_SOURCE }
}
