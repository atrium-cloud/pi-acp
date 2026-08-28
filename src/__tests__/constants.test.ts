import type { RpcCommand, RpcExtensionUIRequest, RpcResponse } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

import { AGENT_NAME, AGENT_VERSION, PROTOCOL_VERSION, SUPPORTED_PI_MIN } from '../constants.js'

describe('constants', () => {
  it('identifies the adapter from package.json', () => {
    expect(AGENT_NAME).toBe('pi-acp')
    expect(AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('speaks ACP v1 only', () => {
    expect(PROTOCOL_VERSION).toBe(1)
  })

  it('pins a stable Pi floor', () => {
    expect(SUPPORTED_PI_MIN).toMatch(/^\d+\.\d+\.\d+$/)
  })

  // The upstream RPC types are the compile-time tripwire for Pi drift: this
  // is a type-level assertion that the pinned package still exports them with
  // the shapes the adapter will consume (docs/todos.md, Open decisions).
  it('resolves the upstream RPC types', () => {
    const command: RpcCommand = { id: 'req-1', type: 'get_state' }
    const response: RpcResponse = { id: 'req-1', type: 'response', command: 'get_state', success: false, error: 'x' }
    const request: RpcExtensionUIRequest = {
      type: 'extension_ui_request',
      id: 'ui-1',
      method: 'select',
      title: 'Allow?',
      options: ['Allow', 'Deny'],
      timeout: 1_000,
    }
    expect(command.type).toBe('get_state')
    expect(response.success).toBe(false)
    expect(request.method).toBe('select')
  })
})
