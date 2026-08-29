import { describe, expect, it } from 'vitest'

import { uuidv7 } from '../session/uuidv7.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const CANONICAL_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CANONICAL_LENGTH = 36
const VERSION_INDEX = 14
const VARIANT_INDEX = 19
const HEX_BASE = 16

/** The 48-bit big-endian timestamp: the first two groups of the canonical form. */
function timestampOf(id: string): number {
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), HEX_BASE)
}

describe('uuidv7', () => {
  it('is the canonical 36-character form with the version 7 and RFC variant nibbles', () => {
    for (const id of [uuidv7(), uuidv7(0), uuidv7(Date.parse('2026-08-29T12:34:56.789Z'))]) {
      expect(id).toHaveLength(CANONICAL_LENGTH)
      expect(id).toMatch(CANONICAL_FORM)
      expect(id[VERSION_INDEX]).toBe('7')
      expect(['8', '9', 'a', 'b']).toContain(id[VARIANT_INDEX])
    }
  })

  it('encodes the millisecond timestamp in the leading 48 bits', () => {
    const now = Date.parse('2026-08-29T12:34:56.789Z')
    expect(timestampOf(uuidv7(now))).toBe(now)
    expect(timestampOf(uuidv7(0))).toBe(0)
  })

  it('defaults to the current clock', () => {
    const before = Date.now()
    const encoded = timestampOf(uuidv7())
    expect(encoded).toBeGreaterThanOrEqual(before)
    expect(encoded).toBeLessThanOrEqual(Date.now())
  })

  it('sorts later mints after earlier ones and never repeats', () => {
    const earlier = uuidv7(1_700_000_000_000)
    const later = uuidv7(1_700_000_000_001)
    expect(earlier < later).toBe(true)

    const minted = new Set(Array.from({ length: 100 }, () => uuidv7()))
    expect(minted.size).toBe(100)
  })
})
