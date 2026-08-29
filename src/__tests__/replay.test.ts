import { describe, expect, it } from 'vitest'

import type { ReplayMessage } from '../session/replay.js'
import { replayUpdates } from '../session/replay.js'
import { toolCallEnded } from '../turn/mappers.js'

const msg = (message: Record<string, unknown>): ReplayMessage => message as unknown as ReplayMessage

const user = (content: unknown): ReplayMessage => msg({ role: 'user', content, timestamp: 1 })
const assistant = (content: unknown[]): ReplayMessage => msg({ role: 'assistant', content, timestamp: 2 })
const toolResult = (fields: Record<string, unknown>): ReplayMessage =>
  msg({ role: 'toolResult', isError: false, timestamp: 3, ...fields })

describe('replayUpdates', () => {
  it('replays a string user message as one text chunk', () => {
    expect(replayUpdates([user('hello pi')])).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello pi' } },
    ])
  })

  it('replays user content blocks in order, mapping an image to an ACP image block', () => {
    const updates = replayUpdates([
      user([
        { type: 'text', text: 'look at this' },
        { type: 'image', data: 'YmFzZTY0', mimeType: 'image/png' },
        { type: 'text', text: 'and this' },
      ]),
    ])
    expect(updates).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'look at this' } },
      { sessionUpdate: 'user_message_chunk', content: { type: 'image', data: 'YmFzZTY0', mimeType: 'image/png' } },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'and this' } },
    ])
  })

  it('splits assistant text and thinking into message and thought chunks', () => {
    const updates = replayUpdates([
      assistant([
        { type: 'thinking', thinking: 'pondering' },
        { type: 'text', text: 'answer' },
      ]),
    ])
    expect(updates).toEqual([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'pondering' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
    ])
  })

  it('announces and completes a tool call that has a stored result', () => {
    const updates = replayUpdates([
      assistant([{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: '/repo/a.ts' } }]),
      toolResult({
        toolCallId: 't1',
        toolName: 'read',
        content: [{ type: 'text', text: 'file body' }],
        details: { lines: 1 },
      }),
    ])
    expect(updates).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'read /repo/a.ts',
        kind: 'read',
        status: 'in_progress',
        rawInput: { path: '/repo/a.ts' },
        locations: [{ path: '/repo/a.ts' }],
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        rawOutput: { content: [{ type: 'text', text: 'file body' }], details: { lines: 1 } },
        content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
      },
    ])
  })

  it('rebuilds an edit into the same diff blocks the live path produces', () => {
    const args = { path: '/repo/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }
    const result = { content: [{ type: 'text', text: 'edited' }], details: { patch: 'IGNORED' } }
    const updates = replayUpdates([
      assistant([{ type: 'toolCall', id: 't2', name: 'edit', arguments: args }]),
      toolResult({ toolCallId: 't2', toolName: 'edit', ...result }),
    ])
    expect(updates[1]).toEqual(
      toolCallEnded({ toolCallId: 't2', toolName: 'edit', result, isError: false, args }),
    )
  })

  it('carries usage and addedToolNames into the replayed raw output', () => {
    const updates = replayUpdates([
      assistant([{ type: 'toolCall', id: 't3', name: 'bash', arguments: { command: 'ls' } }]),
      toolResult({
        toolCallId: 't3',
        toolName: 'bash',
        content: [{ type: 'text', text: 'a.ts' }],
        details: {},
        usage: { input: 1, output: 2 },
        addedToolNames: ['grep'],
      }),
    ])
    expect(updates[1]).toMatchObject({
      rawOutput: {
        content: [{ type: 'text', text: 'a.ts' }],
        details: {},
        usage: { input: 1, output: 2 },
        addedToolNames: ['grep'],
      },
    })
  })

  it('marks a stored error result failed', () => {
    const updates = replayUpdates([
      assistant([{ type: 'toolCall', id: 't4', name: 'bash', arguments: { command: 'nope' } }]),
      toolResult({
        toolCallId: 't4',
        toolName: 'bash',
        content: [{ type: 'text', text: 'command not found' }],
        isError: true,
      }),
    ])
    expect(updates[1]).toMatchObject({ status: 'failed' })
  })

  it('omits a tool call whose result the history does not hold', () => {
    const updates = replayUpdates([
      assistant([
        { type: 'text', text: 'running' },
        { type: 'toolCall', id: 'orphan', name: 'bash', arguments: { command: 'sleep 100' } },
      ]),
    ])
    expect(updates).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'running' } }])
  })

  it('omits a result whose call is gone', () => {
    const updates = replayUpdates([
      toolResult({ toolCallId: 'lost', toolName: 'edit', content: [{ type: 'text', text: 'edited' }] }),
    ])
    expect(updates).toEqual([])
  })

  it('matches each result to its own call when results arrive out of call order', () => {
    const updates = replayUpdates([
      assistant([
        { type: 'toolCall', id: 'a', name: 'read', arguments: { path: '/repo/a.ts' } },
        { type: 'toolCall', id: 'b', name: 'read', arguments: { path: '/repo/b.ts' } },
      ]),
      toolResult({ toolCallId: 'b', toolName: 'read', content: [{ type: 'text', text: 'b body' }] }),
      toolResult({ toolCallId: 'a', toolName: 'read', content: [{ type: 'text', text: 'a body' }] }),
    ])
    expect(updates.map((update) => [update.sessionUpdate, 'toolCallId' in update ? update.toolCallId : null])).toEqual([
      ['tool_call', 'a'],
      ['tool_call', 'b'],
      ['tool_call_update', 'b'],
      ['tool_call_update', 'a'],
    ])
    expect(updates[0]).toMatchObject({ rawInput: { path: '/repo/a.ts' } })
    expect(updates[1]).toMatchObject({ rawInput: { path: '/repo/b.ts' } })
  })

  it('preserves transcript order across roles', () => {
    const updates = replayUpdates([
      user('first'),
      assistant([{ type: 'text', text: 'second' }]),
      user('third'),
      assistant([{ type: 'thinking', thinking: 'fourth' }]),
    ])
    expect(updates.map((update) => update.sessionUpdate)).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
      'user_message_chunk',
      'agent_thought_chunk',
    ])
  })

  it('skips the Pi-only history roles', () => {
    const updates = replayUpdates([
      msg({ role: 'bashExecution', command: 'ls', output: 'a.ts', exitCode: 0, cancelled: false, truncated: false, timestamp: 1 }),
      msg({ role: 'custom', customType: 'note', content: 'injected', display: true, timestamp: 2 }),
      msg({ role: 'branchSummary', summary: 'branched', fromId: 'sess-0', timestamp: 3 }),
      msg({ role: 'compactionSummary', summary: 'compacted', tokensBefore: 100, timestamp: 4 }),
    ])
    expect(updates).toEqual([])
  })

  it('returns nothing for an empty history', () => {
    expect(replayUpdates([])).toEqual([])
  })
})
