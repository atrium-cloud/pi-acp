import { existsSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ENV_PI_BIN, PI_RPC_MODE_ARGS } from '../constants.js'
import { BUNDLED_PI_SOURCE, resolvePiLaunch } from '../pi/launch.js'

describe('resolvePiLaunch', () => {
  it('runs a PI_ACP_PI_BIN binary in RPC mode', () => {
    const launch = resolvePiLaunch({ [ENV_PI_BIN]: '/opt/pi/bin/pi' })
    expect(launch).toEqual({ command: '/opt/pi/bin/pi', args: PI_RPC_MODE_ARGS, source: ENV_PI_BIN })
  })

  it('treats an empty PI_ACP_PI_BIN as unset', () => {
    expect(resolvePiLaunch({ [ENV_PI_BIN]: '' }).source).toBe(BUNDLED_PI_SOURCE)
  })

  it('otherwise runs the dependency RPC entry under the current Node', () => {
    const launch = resolvePiLaunch({})
    expect(launch.command).toBe(process.execPath)
    expect(launch.source).toBe(BUNDLED_PI_SOURCE)
    const [entry, ...rest] = launch.args
    expect(rest).toEqual([])
    if (entry === undefined) throw new Error('no entry path')
    expect(isAbsolute(entry)).toBe(true)
    expect(basename(entry)).toBe('rpc-entry.js')
    expect(existsSync(entry)).toBe(true)
  })
})
