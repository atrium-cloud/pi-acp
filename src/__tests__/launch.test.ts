import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ENV_NODE_COMPILE_CACHE, ENV_PI_BIN, NODE_COMPILE_CACHE_DIR_NAME, PI_RPC_MODE_ARGS } from '../constants.js'
import { BUNDLED_PI_SOURCE, piLaunchLogLine, resolvePiLaunch } from '../pi/launch.js'

describe('piLaunchLogLine', () => {
  it('logs source, command and args as JSON, keeping each arg whole', () => {
    const launch = { command: '/opt/my pi/bin/pi', args: ['--mode', 'rpc'], source: ENV_PI_BIN }
    expect(piLaunchLogLine(launch)).toBe(
      '[pi-acp] Pi launch {"source":"PI_ACP_PI_BIN","command":"/opt/my pi/bin/pi","args":["--mode","rpc"]}',
    )
  })

  it('logs the launch env when there is one', () => {
    const launch = {
      command: '/usr/bin/node',
      args: ['/pi/rpc-entry.js'],
      source: 'bundled',
      env: { NODE_COMPILE_CACHE: '/tmp/node-compile-cache' },
    }
    expect(piLaunchLogLine(launch)).toBe(
      '[pi-acp] Pi launch {"source":"bundled","command":"/usr/bin/node","args":["/pi/rpc-entry.js"],"env":{"NODE_COMPILE_CACHE":"/tmp/node-compile-cache"}}',
    )
  })
})

describe('resolvePiLaunch', () => {
  it('runs a PI_ACP_PI_BIN binary in RPC mode, with no env of its own', () => {
    const launch = resolvePiLaunch({ [ENV_PI_BIN]: '/opt/pi/bin/pi' })
    expect(launch).toStrictEqual({ command: '/opt/pi/bin/pi', args: [...PI_RPC_MODE_ARGS], source: ENV_PI_BIN })
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

  it("points the bundled launch at Node's default compile cache when NODE_COMPILE_CACHE is unset or empty", () => {
    const expected = { [ENV_NODE_COMPILE_CACHE]: join(tmpdir(), NODE_COMPILE_CACHE_DIR_NAME) }
    expect(resolvePiLaunch({}).env).toStrictEqual(expected)
    expect(resolvePiLaunch({ [ENV_NODE_COMPILE_CACHE]: '' }).env).toStrictEqual(expected)
  })

  it('adds no env to the bundled launch when NODE_COMPILE_CACHE is already set', () => {
    const launch = resolvePiLaunch({ [ENV_NODE_COMPILE_CACHE]: '/srv/cache' })
    expect(launch).toStrictEqual({ command: process.execPath, args: launch.args, source: BUNDLED_PI_SOURCE })
  })
})
