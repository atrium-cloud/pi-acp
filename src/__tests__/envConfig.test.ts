import { describe, expect, it } from 'vitest'

import {
  DEFAULT_RPC_TIMEOUT_MS,
  ENV_HIDE_COMMANDS,
  ENV_IDLE_TIMEOUT_MS,
  ENV_PI_TIMING,
  ENV_RPC_TIMEOUT_MS,
  ENV_WARM_SPARE_MAX_AGE_MS,
  resolveHiddenCommands,
  resolveIdleTimeoutMs,
  resolveRpcTimeoutMs,
  resolveStartupTiming,
  resolveWarmSpareMaxAgeMs,
} from '../constants.js'

describe('resolveRpcTimeoutMs', () => {
  it('defaults when unset, empty, or blank', () => {
    expect(resolveRpcTimeoutMs({})).toBe(DEFAULT_RPC_TIMEOUT_MS)
    expect(resolveRpcTimeoutMs({ [ENV_RPC_TIMEOUT_MS]: '' })).toBe(DEFAULT_RPC_TIMEOUT_MS)
    expect(resolveRpcTimeoutMs({ [ENV_RPC_TIMEOUT_MS]: '   ' })).toBe(DEFAULT_RPC_TIMEOUT_MS)
  })

  it('accepts a positive integer up to the 32-bit ceiling, trimming space', () => {
    expect(resolveRpcTimeoutMs({ [ENV_RPC_TIMEOUT_MS]: '5000' })).toBe(5_000)
    expect(resolveRpcTimeoutMs({ [ENV_RPC_TIMEOUT_MS]: ' 250 ' })).toBe(250)
    expect(resolveRpcTimeoutMs({ [ENV_RPC_TIMEOUT_MS]: '2147483647' })).toBe(2_147_483_647)
  })

  it('rejects a non-integer, zero or negative, or over-32-bit value', () => {
    expect(() => resolveRpcTimeoutMs({ [ENV_RPC_TIMEOUT_MS]: '3.5' })).toThrow(/whole number/)
    expect(() => resolveRpcTimeoutMs({ [ENV_RPC_TIMEOUT_MS]: 'soon' })).toThrow(/whole number/)
    expect(() => resolveRpcTimeoutMs({ [ENV_RPC_TIMEOUT_MS]: '-5' })).toThrow(/whole number/)
    expect(() => resolveRpcTimeoutMs({ [ENV_RPC_TIMEOUT_MS]: '0' })).toThrow(/greater than zero/)
    expect(() => resolveRpcTimeoutMs({ [ENV_RPC_TIMEOUT_MS]: '9999999999' })).toThrow(/exceeds the maximum/)
  })
})

describe('resolveWarmSpareMaxAgeMs', () => {
  it('is off when unset, empty, or blank', () => {
    expect(resolveWarmSpareMaxAgeMs({})).toBeUndefined()
    expect(resolveWarmSpareMaxAgeMs({ [ENV_WARM_SPARE_MAX_AGE_MS]: '' })).toBeUndefined()
    expect(resolveWarmSpareMaxAgeMs({ [ENV_WARM_SPARE_MAX_AGE_MS]: '   ' })).toBeUndefined()
  })

  it('accepts a positive integer up to the 32-bit ceiling, trimming space', () => {
    expect(resolveWarmSpareMaxAgeMs({ [ENV_WARM_SPARE_MAX_AGE_MS]: '600000' })).toBe(600_000)
    expect(resolveWarmSpareMaxAgeMs({ [ENV_WARM_SPARE_MAX_AGE_MS]: ' 250 ' })).toBe(250)
    expect(resolveWarmSpareMaxAgeMs({ [ENV_WARM_SPARE_MAX_AGE_MS]: '2147483647' })).toBe(2_147_483_647)
  })

  it('rejects a non-integer, zero or negative, or over-32-bit value, naming the setting', () => {
    expect(() => resolveWarmSpareMaxAgeMs({ [ENV_WARM_SPARE_MAX_AGE_MS]: '3.5' })).toThrow(
      `${ENV_WARM_SPARE_MAX_AGE_MS}="3.5" must be a whole number of milliseconds`,
    )
    expect(() => resolveWarmSpareMaxAgeMs({ [ENV_WARM_SPARE_MAX_AGE_MS]: 'soon' })).toThrow(/whole number/)
    expect(() => resolveWarmSpareMaxAgeMs({ [ENV_WARM_SPARE_MAX_AGE_MS]: '-5' })).toThrow(/whole number/)
    expect(() => resolveWarmSpareMaxAgeMs({ [ENV_WARM_SPARE_MAX_AGE_MS]: '0' })).toThrow(/greater than zero/)
    expect(() => resolveWarmSpareMaxAgeMs({ [ENV_WARM_SPARE_MAX_AGE_MS]: '9999999999' })).toThrow(/exceeds the maximum/)
  })
})

describe('resolveIdleTimeoutMs', () => {
  it('is off when unset, empty, or blank', () => {
    expect(resolveIdleTimeoutMs({})).toBeUndefined()
    expect(resolveIdleTimeoutMs({ [ENV_IDLE_TIMEOUT_MS]: '' })).toBeUndefined()
    expect(resolveIdleTimeoutMs({ [ENV_IDLE_TIMEOUT_MS]: '   ' })).toBeUndefined()
  })

  it('accepts a positive integer up to the 32-bit ceiling, trimming space', () => {
    expect(resolveIdleTimeoutMs({ [ENV_IDLE_TIMEOUT_MS]: '900000' })).toBe(900_000)
    expect(resolveIdleTimeoutMs({ [ENV_IDLE_TIMEOUT_MS]: ' 250 ' })).toBe(250)
    expect(resolveIdleTimeoutMs({ [ENV_IDLE_TIMEOUT_MS]: '2147483647' })).toBe(2_147_483_647)
  })

  it('rejects a non-integer, zero or negative, or over-32-bit value, naming the setting', () => {
    expect(() => resolveIdleTimeoutMs({ [ENV_IDLE_TIMEOUT_MS]: '3.5' })).toThrow(
      `${ENV_IDLE_TIMEOUT_MS}="3.5" must be a whole number of milliseconds`,
    )
    expect(() => resolveIdleTimeoutMs({ [ENV_IDLE_TIMEOUT_MS]: 'soon' })).toThrow(/whole number/)
    expect(() => resolveIdleTimeoutMs({ [ENV_IDLE_TIMEOUT_MS]: '-5' })).toThrow(/whole number/)
    expect(() => resolveIdleTimeoutMs({ [ENV_IDLE_TIMEOUT_MS]: '0' })).toThrow(/greater than zero/)
    expect(() => resolveIdleTimeoutMs({ [ENV_IDLE_TIMEOUT_MS]: '9999999999' })).toThrow(/exceeds the maximum/)
  })
})

describe('resolveStartupTiming', () => {
  it('is on only for the exact value Pi checks', () => {
    expect(resolveStartupTiming({ [ENV_PI_TIMING]: '1' })).toBe(true)
    for (const value of [undefined, '', '0', 'true', ' 1', '1 ']) {
      expect(resolveStartupTiming(value === undefined ? {} : { [ENV_PI_TIMING]: value })).toBe(false)
    }
  })
})

describe('resolveHiddenCommands', () => {
  it('hides nothing when unset, empty, or only separators and space', () => {
    expect(resolveHiddenCommands({})).toEqual(new Set())
    expect(resolveHiddenCommands({ [ENV_HIDE_COMMANDS]: '' })).toEqual(new Set())
    expect(resolveHiddenCommands({ [ENV_HIDE_COMMANDS]: ' , ,, ' })).toEqual(new Set())
  })

  it('trims each name and drops empty entries', () => {
    expect(resolveHiddenCommands({ [ENV_HIDE_COMMANDS]: ' mcp , llama,,' })).toEqual(new Set(['mcp', 'llama']))
  })

  it('keeps names verbatim, including a disambiguated form and case', () => {
    expect(resolveHiddenCommands({ [ENV_HIDE_COMMANDS]: 'review:1,Compact' })).toEqual(new Set(['review:1', 'Compact']))
  })
})
