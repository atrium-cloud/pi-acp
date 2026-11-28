import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'

import { CURSOR_ID_PREFIX } from '../constants.js'

/** An entity a client holds under an id, which a cursor can be anchored to. */
export type CursorEntity =
  | { readonly type: 'user_message' | 'agent_message' | 'agent_thought'; readonly messageId: string }
  | { readonly type: 'tool_call'; readonly toolCallId: string }

type ChunkKind = 'agent_message_chunk' | 'agent_thought_chunk'

/** The cursor before the user message Pi stores as `entryId`. The id is derived
 * from Pi's own entry id, so it survives restarts and needs no storage here. */
export function cursorIdForEntry(entryId: string): string {
  return `${CURSOR_ID_PREFIX}${entryId}`
}

/** The Pi user entry `cursorId` lies before, or undefined for an id that is no cursor. */
export function entryIdOfCursor(cursorId: string): string | undefined {
  return cursorId.startsWith(CURSOR_ID_PREFIX) && cursorId.length > CURSOR_ID_PREFIX.length
    ? cursorId.slice(CURSOR_ID_PREFIX.length)
    : undefined
}

/** Announces the fork cursor before user entry `entryId`, placed relative to an
 * entity the client holds: `before` the replayed user message itself, or `after`
 * the last entity ahead of a live prompt, which v1 never reports to its sender. */
export function forkCursorUpdate(entryId: string, entity: CursorEntity, position: 'before' | 'after'): SessionUpdate {
  return {
    sessionUpdate: 'cursor_update',
    cursorId: cursorIdForEntry(entryId),
    capabilities: { fork: {} },
    anchor: { ...entity, position },
  }
}

/** The anchorable entity `update` reports, if it reports one. */
export function cursorEntityOf(update: SessionUpdate): CursorEntity | undefined {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      return typeof update.messageId === 'string' ? { type: 'user_message', messageId: update.messageId } : undefined
    case 'agent_message_chunk':
      return typeof update.messageId === 'string' ? { type: 'agent_message', messageId: update.messageId } : undefined
    case 'agent_thought_chunk':
      return typeof update.messageId === 'string' ? { type: 'agent_thought', messageId: update.messageId } : undefined
    case 'tool_call':
      return { type: 'tool_call', toolCallId: update.toolCallId }
    case 'tool_call_update':
    case 'plan':
    case 'plan_update':
    case 'plan_removed':
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'usage_update':
    case 'notice':
    case 'compaction_update':
    case 'compaction_summary_chunk':
    case 'prompt_suggestions_update':
    case 'cursor_update':
    case 'subagent_update':
    case 'session_message':
    case 'session_message_chunk':
      return undefined
  }
  const unhandled: never = update
  return unhandled
}

/** Message ids for the chunks of one Pi assistant message at a time. Thought and
 * text are separate ACP messages, so the id changes whenever the kind does. */
export class ChunkMessageIds {
  private current: { readonly kind: ChunkKind; readonly messageId: string } | null = null

  constructor(private readonly mint: () => string) {}

  startMessage(): void {
    this.current = null
  }

  idFor(kind: ChunkKind): string {
    if (this.current?.kind !== kind) this.current = { kind, messageId: this.mint() }
    return this.current.messageId
  }
}
