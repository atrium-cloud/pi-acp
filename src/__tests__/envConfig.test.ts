import { describe, expect, it } from 'vitest'

import { DEFAULT_RPC_TIMEOUT_MS, ENV_RPC_TIMEOUT_MS, resolveRpcTimeoutMs } from '../constants.js'

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
