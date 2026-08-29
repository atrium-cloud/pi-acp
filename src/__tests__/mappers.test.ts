import { describe, expect, it } from 'vitest'

import {
  configOptionUpdate,
  sessionInfoUpdate,
  toolCallEnded,
  toolCallProgress,
  toolCallStarted,
  usageUpdate,
} from '../turn/mappers.js'

describe('tool call mappers', () => {
  it('announces a path tool as an in_progress tool_call with a location', () => {
    expect(toolCallStarted({ toolCallId: 't1', toolName: 'read', args: { path: '/repo/a.ts' } })).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'read /repo/a.ts',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: '/repo/a.ts' },
      locations: [{ path: '/repo/a.ts' }],
    })
  })

  it('titles a bash call by its command and omits locations (no path)', () => {
    expect(toolCallStarted({ toolCallId: 't2', toolName: 'bash', args: { command: 'echo hi\nsecond' } })).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'bash: echo hi',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'echo hi\nsecond' },
    })
  })

  it('maps an unknown tool to kind other', () => {
    expect(toolCallStarted({ toolCallId: 't3', toolName: 'mytool', args: {} })).toMatchObject({ kind: 'other' })
  })

  it('emits partial content as a tool_call_update, and nothing when empty', () => {
    expect(toolCallProgress('t2', { content: [{ type: 'text', text: 'partial out' }] })).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      content: [{ type: 'content', content: { type: 'text', text: 'partial out' } }],
    })
    expect(toolCallProgress('t2', { content: [] })).toBeUndefined()
    expect(toolCallProgress('t2', undefined)).toBeUndefined()
  })

  it('completes a tool with its result text and raw output', () => {
    expect(
      toolCallEnded({ toolCallId: 't2', toolName: 'bash', result: { content: [{ type: 'text', text: 'done' }] }, isError: false, args: { command: 'x' } }),
    ).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text: 'done' }] },
      content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
    })
  })

  it('marks an errored tool failed', () => {
    expect(
      toolCallEnded({ toolCallId: 't4', toolName: 'bash', result: { content: [] }, isError: true, args: {} }),
    ).toMatchObject({ status: 'failed' })
  })

  it('renders an edit as one diff block per edit entry, from the cached input', () => {
    const update = toolCallEnded({
      toolCallId: 't5',
      toolName: 'edit',
      result: { content: [{ type: 'text', text: 'edited' }], details: { patch: 'IGNORED' } },
      isError: false,
      args: { path: '/repo/a.ts', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] },
    })
    expect(update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't5',
      status: 'completed',
      content: [
        { type: 'diff', path: '/repo/a.ts', oldText: 'a', newText: 'b' },
        { type: 'diff', path: '/repo/a.ts', oldText: 'c', newText: 'd' },
      ],
    })
  })
})

describe('usage and session mappers', () => {
  it('builds a usage_update with an amount+currency cost', () => {
    expect(usageUpdate(1200, 200_000, 0.42)).toEqual({
      sessionUpdate: 'usage_update',
      used: 1200,
      size: 200_000,
      cost: { amount: 0.42, currency: 'USD' },
    })
  })

  it('builds session_info_update and config_option_update', () => {
    expect(sessionInfoUpdate('My Session')).toEqual({ sessionUpdate: 'session_info_update', title: 'My Session' })
    expect(configOptionUpdate([])).toEqual({ sessionUpdate: 'config_option_update', configOptions: [] })
  })
})
