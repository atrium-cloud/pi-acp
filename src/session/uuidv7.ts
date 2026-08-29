import { randomFillSync } from 'node:crypto'

// Pi mints its session ids as RFC 9562 UUIDv7 (from a package it depends on only
// for development), so a session file this adapter writes carries the same shape:
// a 48-bit big-endian Unix millisecond prefix, the version 7 nibble, the RFC
// variant bits, and random everywhere else.

// ── Constants ─────────────────────────────────────────────────────────────────

const UUID_BYTE_LENGTH = 16
const TIMESTAMP_HIGH_OFFSET = 0
const TIMESTAMP_LOW_OFFSET = 2
/** The 48-bit timestamp is split across a 16-bit and a 32-bit write, since a
 * 48-bit value overflows the bitwise operators. */
const TIMESTAMP_LOW_MODULUS = 0x1_0000_0000
const VERSION_BYTE_INDEX = 6
const VERSION_7 = 0x70
const LOW_NIBBLE_MASK = 0x0f
const VARIANT_BYTE_INDEX = 8
const VARIANT_RFC = 0x80
const VARIANT_VALUE_MASK = 0x3f
const HEX_BASE = 16
const HEX_DIGITS_PER_BYTE = 2
const HEX_PAD = '0'
/** The canonical 8-4-4-4-12 grouping, in bytes. */
const GROUP_BYTE_LENGTHS: readonly number[] = [4, 2, 2, 2, 6]
const GROUP_SEPARATOR = '-'

// ── Generator ─────────────────────────────────────────────────────────────────

export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = new Uint8Array(UUID_BYTE_LENGTH)
  randomFillSync(bytes)
  const view = new DataView(bytes.buffer)
  view.setUint16(TIMESTAMP_HIGH_OFFSET, Math.floor(nowMs / TIMESTAMP_LOW_MODULUS))
  view.setUint32(TIMESTAMP_LOW_OFFSET, nowMs % TIMESTAMP_LOW_MODULUS)
  view.setUint8(VERSION_BYTE_INDEX, (view.getUint8(VERSION_BYTE_INDEX) & LOW_NIBBLE_MASK) | VERSION_7)
  view.setUint8(VARIANT_BYTE_INDEX, (view.getUint8(VARIANT_BYTE_INDEX) & VARIANT_VALUE_MASK) | VARIANT_RFC)
  return format(view)
}

function format(view: DataView): string {
  const groups: string[] = []
  let index = 0
  for (const byteLength of GROUP_BYTE_LENGTHS) {
    let group = ''
    for (const end = index + byteLength; index < end; index++) {
      group += view.getUint8(index).toString(HEX_BASE).padStart(HEX_DIGITS_PER_BYTE, HEX_PAD)
    }
    groups.push(group)
  }
  return groups.join(GROUP_SEPARATOR)
}
