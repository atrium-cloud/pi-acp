import { readFileSync, rmSync } from 'node:fs'
import { basename, dirname } from 'node:path'

import { describe, expect, it } from 'vitest'

import { GATE_DIR_PREFIX } from '../constants.js'
import { materializeExtension } from '../pi/extensionFile.js'

const GATE_SOURCE = 'export default function () {}\n'
const OVERRIDES_SOURCE = 'export default function (pi) { pi.on("session_start", () => {}) }\n'

describe('materializeExtension', () => {
  it('writes every extension of one process into one directory not named by the pid', () => {
    const gate = materializeExtension('gate.mjs', GATE_SOURCE)
    const overrides = materializeExtension('overrides.mjs', OVERRIDES_SOURCE)

    expect(dirname(overrides)).toBe(dirname(gate))
    expect(basename(dirname(gate)).startsWith(GATE_DIR_PREFIX)).toBe(true)
    // Every sandboxed adapter is pid 1, so a pid-named directory would be shared.
    expect(basename(dirname(gate))).not.toBe(`${GATE_DIR_PREFIX}${process.pid}`)
    expect(readFileSync(gate, 'utf8')).toBe(GATE_SOURCE)
    expect(readFileSync(overrides, 'utf8')).toBe(OVERRIDES_SOURCE)
    rmSync(gate, { force: true })
    rmSync(overrides, { force: true })
  })
})
