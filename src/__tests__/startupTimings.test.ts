import { describe, expect, it } from 'vitest'

import { parsePiStartupTimings } from '../pi/startupTimings.js'

const MAIN_HEADER = '--- Startup Timings: main ---'
const EXTENSIONS_HEADER = '--- Startup Timings: extensions ---'
const GATE_PATH = '/tmp/pi-acp-123/permission-gate.ts'
const ODD_PATH = '/srv/ext: odd/mcp.mjs'

/** A block exactly as Pi's `printTimingGroup` writes it through `console.error`. */
function block(header: string, lines: readonly string[]): string {
  return ['', header, ...lines, '-'.repeat(header.length), '', ''].join('\n')
}

const MAIN_BLOCK = block(MAIN_HEADER, ['  parseArgs: 2ms', '  createAgentSessionRuntime: 140ms', '  TOTAL: 142ms'])
const MAIN = { parseArgs: 2, createAgentSessionRuntime: 140, TOTAL: 142 }

const EXTENSIONS_BLOCK = block(EXTENSIONS_HEADER, [
  `  ${GATE_PATH} module import: 41ms`,
  `  ${GATE_PATH} factory: 1ms`,
  `  ${ODD_PATH} module import: 7ms`,
  '  TOTAL: 49ms',
])
const EXTENSIONS = {
  [`${GATE_PATH} module import`]: 41,
  [`${GATE_PATH} factory`]: 1,
  [`${ODD_PATH} module import`]: 7,
  TOTAL: 49,
}

describe('parsePiStartupTimings', () => {
  it('reads one block in Pi exact format, TOTAL kept as a label', () => {
    expect(parsePiStartupTimings(MAIN_BLOCK)).toStrictEqual({ main: MAIN })
  })

  it('reads both namespaces, anchoring path labels on the trailing count', () => {
    expect(parsePiStartupTimings(`${MAIN_BLOCK}${EXTENSIONS_BLOCK}`)).toStrictEqual({ main: MAIN, extensions: EXTENSIONS })
  })

  it('skips stderr noise before, between, inside, and after the blocks', () => {
    const stderr = [
      'Warning: no models match pattern "x"\n',
      '  stray: 9ms\n',
      MAIN_BLOCK,
      '[mcp] probe connected\n',
      EXTENSIONS_BLOCK.replace(`  ${GATE_PATH} factory`, `extension says hi\n  ${GATE_PATH} factory`),
      'trailing line\n',
    ].join('')
    expect(parsePiStartupTimings(stderr)).toStrictEqual({ main: MAIN, extensions: EXTENSIONS })
  })

  it('reads CRLF line endings', () => {
    expect(parsePiStartupTimings(MAIN_BLOCK.replaceAll('\n', '\r\n'))).toStrictEqual({ main: MAIN })
  })

  it('keeps the last block when a namespace repeats', () => {
    const later = block(MAIN_HEADER, ['  parseArgs: 5ms', '  TOTAL: 5ms'])
    expect(parsePiStartupTimings(`${MAIN_BLOCK}${later}`)).toStrictEqual({ main: { parseArgs: 5, TOTAL: 5 } })
  })

  it('drops a block whose footer has not arrived and one whose header was cut off', () => {
    const unterminated = ['', MAIN_HEADER, '  parseArgs: 2ms', ''].join('\n')
    expect(parsePiStartupTimings(unterminated)).toBeNull()
    const headless = EXTENSIONS_BLOCK.slice(EXTENSIONS_BLOCK.indexOf(GATE_PATH))
    expect(parsePiStartupTimings(`${headless}${MAIN_BLOCK}`)).toStrictEqual({ main: MAIN })
  })

  it('returns null when no block is present', () => {
    expect(parsePiStartupTimings('')).toBeNull()
    expect(parsePiStartupTimings('Warning: something\n  label: 3ms\n----\n')).toBeNull()
  })
})
