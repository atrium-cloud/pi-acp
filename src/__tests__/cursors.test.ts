import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import { describe, expect, it } from 'vitest'

import { CURSOR_ID_PREFIX } from '../constants.js'
import { cursorEntityOf, cursorIdForEntry, entryIdOfCursor } from '../turn/cursors.js'

const ENTRY_ID = 'a1b2c3d4'
const TEXT = { type: 'text', text: 'hi' } as const

describe('cursor ids', () => {
  it('round trips a Pi entry id', () => {
    expect(cursorIdForEntry(ENTRY_ID)).toBe(`${CURSOR_ID_PREFIX}${ENTRY_ID}`)
    expect(entryIdOfCursor(cursorIdForEntry(ENTRY_ID))).toBe(ENTRY_ID)
  })

  it.each([ENTRY_ID, CURSOR_ID_PREFIX, `after:${ENTRY_ID}`])('reads %j as no cursor', (cursorId) => {
    expect(entryIdOfCursor(cursorId)).toBeUndefined()
  })
})

describe('cursorEntityOf', () => {
  it.each<[SessionUpdate, ReturnType<typeof cursorEntityOf>]>([
    [{ sessionUpdate: 'user_message_chunk', content: TEXT, messageId: 'u1' }, { type: 'user_message', messageId: 'u1' }],
    [{ sessionUpdate: 'agent_message_chunk', content: TEXT, messageId: 'm1' }, { type: 'agent_message', messageId: 'm1' }],
    [{ sessionUpdate: 'agent_thought_chunk', content: TEXT, messageId: 't1' }, { type: 'agent_thought', messageId: 't1' }],
    [{ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'ls' }, { type: 'tool_call', toolCallId: 'call-1' }],
    [{ sessionUpdate: 'agent_message_chunk', content: TEXT }, undefined],
    [{ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' }, undefined],
  ])('reads %j as %j', (update, entity) => {
    expect(cursorEntityOf(update)).toEqual(entity)
  })
})
