import * as acp from '@agentclientprotocol/sdk'
import type { AgentContext, SessionUpdate } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { JsonAgentSessionEvent } from '../pi/types.js'
import { TurnHandler } from '../turn/TurnHandler.js'

const SESSION_ID = 'sess-1'

function makeTurn(graceMs = 10_000) {
  const notify = vi.fn(async (_method: string, _params: { sessionId: string; update: SessionUpdate }) => {})
  const notifier = { notify } as unknown as AgentContext
  const turn = new TurnHandler({ notifier, sessionId: SESSION_ID, graceMs })
  return { turn, notify }
}

const evt = (event: Record<string, unknown>): JsonAgentSessionEvent => event as unknown as JsonAgentSessionEvent
const messageUpdate = (sub: Record<string, unknown>): JsonAgentSessionEvent =>
  evt({ type: 'message_update', usage: {}, assistantMessageEvent: sub })

function chunkCall(sessionUpdate: string, text: string) {
  return [acp.methods.client.session.update, { sessionId: SESSION_ID, update: { sessionUpdate, content: { type: 'text', text } } }]
}

describe('TurnHandler', () => {
  it('streams a text delta and ends a plain turn end_turn', async () => {
    const { turn, notify } = makeTurn()
    turn.handleEvent(evt({ type: 'agent_start' }))
    turn.handleEvent(messageUpdate({ type: 'text_delta', contentIndex: 0, delta: 'Hello' }))
    turn.handleEvent(evt({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }))
    turn.handleEvent(evt({ type: 'agent_settled' }))

    await expect(turn.settled).resolves.toBe('end_turn')
    expect(notify).toHaveBeenCalledWith(...chunkCall('agent_message_chunk', 'Hello'))
  })

  it('routes thinking deltas to thought chunks and text deltas to message chunks', async () => {
    const { turn, notify } = makeTurn()
    turn.handleEvent(evt({ type: 'agent_start' }))
    turn.handleEvent(messageUpdate({ type: 'thinking_delta', contentIndex: 0, delta: 'pondering' }))
    turn.handleEvent(messageUpdate({ type: 'text_delta', contentIndex: 1, delta: 'answer' }))
    turn.handleEvent(evt({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }))
    turn.handleEvent(evt({ type: 'agent_settled' }))

    await expect(turn.settled).resolves.toBe('end_turn')
    expect(notify).toHaveBeenCalledWith(...chunkCall('agent_thought_chunk', 'pondering'))
    expect(notify).toHaveBeenCalledWith(...chunkCall('agent_message_chunk', 'answer'))
  })

  it('throws a RequestError carrying Pi\'s message on an errored turn', async () => {
    const { turn } = makeTurn()
    turn.handleEvent(evt({ type: 'agent_start' }))
    turn.handleEvent(evt({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'provider exploded' } }))
    turn.handleEvent(evt({ type: 'agent_settled' }))

    await expect(turn.settled).rejects.toMatchObject({ name: 'RequestError', code: -32_603, message: 'provider exploded' })
  })

  it('maps a length stop reason to max_tokens', async () => {
    const { turn } = makeTurn()
    turn.handleEvent(evt({ type: 'agent_start' }))
    turn.handleEvent(evt({ type: 'message_end', message: { role: 'assistant', stopReason: 'length' } }))
    turn.handleEvent(evt({ type: 'agent_settled' }))
    await expect(turn.settled).resolves.toBe('max_tokens')
  })

  it('resolves cancelled when cancel precedes settlement', async () => {
    const { turn } = makeTurn()
    turn.handleEvent(evt({ type: 'agent_start' }))
    turn.cancel()
    turn.handleEvent(evt({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } }))
    turn.handleEvent(evt({ type: 'agent_settled' }))
    await expect(turn.settled).resolves.toBe('cancelled')
  })

  it('reports a protocol error when the prompt starts no turn', async () => {
    const { turn } = makeTurn(15)
    turn.armStartTimer()
    await expect(turn.settled).rejects.toMatchObject({ code: -32_603, message: expect.stringMatching(/no turn/) })
  })

  it('fails the turn with the subprocess exit cause', async () => {
    const { turn } = makeTurn()
    turn.handleEvent(evt({ type: 'agent_start' }))
    turn.fail(new Error('pi exited: code 1, signal null'))
    await expect(turn.settled).rejects.toThrow(/pi exited: code 1/)
  })

  it('rejects a turn that settles with no stop reason rather than reporting end_turn', async () => {
    const { turn } = makeTurn()
    turn.handleEvent(evt({ type: 'agent_start' }))
    turn.handleEvent(evt({ type: 'agent_settled' }))
    await expect(turn.settled).rejects.toMatchObject({ code: -32_603, message: expect.stringMatching(/without a stop reason/) })
  })

  it('streams a tool call as tool_call then tool_call_update through to completed', async () => {
    const { turn, notify } = makeTurn()
    turn.handleEvent(evt({ type: 'agent_start' }))
    turn.handleEvent(evt({ type: 'tool_execution_start', toolCallId: 'x', toolName: 'read', args: { path: '/f' } }))
    turn.handleEvent(evt({ type: 'tool_execution_update', toolCallId: 'x', toolName: 'read', args: { path: '/f' }, partialResult: { content: [{ type: 'text', text: 'reading' }] } }))
    turn.handleEvent(evt({ type: 'tool_execution_end', toolCallId: 'x', toolName: 'read', result: { content: [{ type: 'text', text: 'file body' }] }, isError: false }))

    const updates = notify.mock.calls.map((call) => call[1].update)
    expect(updates[0]).toMatchObject({ sessionUpdate: 'tool_call', toolCallId: 'x', kind: 'read', status: 'in_progress' })
    expect(updates[1]).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'x', content: [{ type: 'content', content: { type: 'text', text: 'reading' } }] })
    expect(updates[2]).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'completed' })
  })

  it('exposes the cached input for a running tool and diffs an edit from it at the end', async () => {
    const { turn, notify } = makeTurn()
    turn.handleEvent(evt({ type: 'agent_start' }))
    const args = { path: '/a', edits: [{ oldText: 'x', newText: 'y' }] }
    turn.handleEvent(evt({ type: 'tool_execution_start', toolCallId: 'e1', toolName: 'edit', args }))
    expect(turn.announcedToolCall('e1')).toEqual({ toolName: 'edit', args })
    expect(turn.announcedToolCall('nope')).toBeUndefined()
    turn.handleEvent(evt({ type: 'tool_execution_end', toolCallId: 'e1', toolName: 'edit', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false }))
    expect(turn.announcedToolCall('e1')).toBeUndefined()

    const updates = notify.mock.calls.map((call) => call[1].update)
    expect(updates[0]).toMatchObject({ sessionUpdate: 'tool_call', toolCallId: 'e1' })
    expect(updates[1]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'e1',
      status: 'completed',
      content: [{ type: 'diff', path: '/a', oldText: 'x', newText: 'y' }],
    })
  })

  it('re-issues the abort when a cancel landed before the turn started', async () => {
    const requestAbort = vi.fn()
    const notify = vi.fn(async () => {})
    const turn = new TurnHandler({ notifier: { notify } as unknown as AgentContext, sessionId: SESSION_ID, requestAbort })
    turn.cancel()
    expect(requestAbort).not.toHaveBeenCalled()
    turn.handleEvent(evt({ type: 'agent_start' }))
    expect(requestAbort).toHaveBeenCalledTimes(1)
    turn.handleEvent(evt({ type: 'agent_settled' }))
    await expect(turn.settled).resolves.toBe('cancelled')
  })

  it('abandons an in-flight turn as cancelled without waiting for Pi', async () => {
    const { turn } = makeTurn()
    turn.handleEvent(evt({ type: 'agent_start' }))
    turn.abandon()
    await expect(turn.settled).resolves.toBe('cancelled')
  })

  it('ignores an abandon of an already-settled turn', async () => {
    const { turn } = makeTurn()
    turn.handleEvent(evt({ type: 'agent_start' }))
    turn.handleEvent(evt({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }))
    turn.handleEvent(evt({ type: 'agent_settled' }))
    turn.abandon()
    await expect(turn.settled).resolves.toBe('end_turn')
  })

  it('emits the full content on *_end when no delta streamed for that index', async () => {
    const { turn, notify } = makeTurn()
    turn.handleEvent(evt({ type: 'agent_start' }))
    turn.handleEvent(evt({ type: 'message_start', message: { role: 'assistant' } }))
    turn.handleEvent(messageUpdate({ type: 'text_end', contentIndex: 0, content: 'whole answer' }))
    turn.handleEvent(evt({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }))
    turn.handleEvent(evt({ type: 'agent_settled' }))

    await expect(turn.settled).resolves.toBe('end_turn')
    expect(notify).toHaveBeenCalledWith(...chunkCall('agent_message_chunk', 'whole answer'))
  })

  it('clears the streamed-index set on message_start so a later index re-emits on end', async () => {
    const { turn, notify } = makeTurn()
    turn.handleEvent(evt({ type: 'agent_start' }))
    turn.handleEvent(evt({ type: 'message_start', message: { role: 'assistant' } }))
    turn.handleEvent(messageUpdate({ type: 'text_delta', contentIndex: 0, delta: 'partial' }))
    // A new assistant message restarts contentIndex at 0; the fallback must fire again.
    turn.handleEvent(evt({ type: 'message_start', message: { role: 'assistant' } }))
    turn.handleEvent(messageUpdate({ type: 'text_end', contentIndex: 0, content: 'second message' }))
    turn.handleEvent(evt({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }))
    turn.handleEvent(evt({ type: 'agent_settled' }))

    await expect(turn.settled).resolves.toBe('end_turn')
    expect(notify).toHaveBeenCalledWith(...chunkCall('agent_message_chunk', 'partial'))
    expect(notify).toHaveBeenCalledWith(...chunkCall('agent_message_chunk', 'second message'))
  })
})
